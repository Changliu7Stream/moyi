/**
 * 墨忆 — 向量化模块
 *
 * 两种模式（自动选择，无需改代码）：
 *   1. 模型模式：配了 MOYI_EMBED_URL / MOYI_EMBED_KEY 时，调 OpenAI 兼容的
 *      /v1/embeddings 接口取真实语义向量。
 *   2. 本地模式（默认）：纯 JS 特征哈希，零依赖、离线可用、结果稳定。
 *      对中文按「字 + 二元组」切分，近义词命中率不如模型，但足以让
 *      「换个说法也能搜到」这件事跑起来。
 *
 * ⚠️ 维度必须是 384，与 Supabase memories.embedding 的 vector(384) 对齐。
 * ⚠️ 换 provider 或换模型后，旧向量与新向量不在同一空间，必须重新回填：
 *    POST /api/admin/backfill-embeddings
 */

const crypto = require('crypto');

const DIM = 384;
const cache = new Map();
const CACHE_MAX = 2048;
let lastEmbedError = null;

// ── 分词：中文按字与二元组，拉丁文按词 ────────────────
function tokenize(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = [];
  if (!s) return tokens;
  const cjk = s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  cjk.forEach(c => tokens.push(c));
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
  (s.match(/[a-z0-9]+/g) || []).forEach(w => tokens.push(w));
  return tokens;
}

// ── FNV-1a：把任意 token 稳定地散列到 [0, DIM) ───────
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 本地特征哈希向量：稀疏正负桶叠加，最后 L2 归一化。 */
function localEmbed(text) {
  const vec = new Array(DIM).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) return vec;
  const tf = new Map();
  tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
  for (const [tok, n] of tf) {
    const h = fnv1a(tok);
    const idx = h % DIM;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    // 二元组比单字更能表达语义，给更高权重
    const w = (1 + Math.log(n)) * (tok.length >= 2 ? 1.6 : 1.0);
    vec[idx] += sign * w;
  }
  return normalize(vec);
}

// ── 归一化与相似度 ──────────────────────────────────
function normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm) return vec.map(() => 0);
  return vec.map(v => +(v / norm).toFixed(6));
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** pgvector 读写：库内存的是 '[1,2,3]' 字符串，这里统一成 number[]。 */
function parseVector(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number) : null;
  } catch { return null; }
}
function toVectorLiteral(vec) {
  return '[' + vec.map(v => Number(v).toFixed(6)).join(',') + ']';
}

// ── 模型模式 ────────────────────────────────────────
function providerConfig() {
  const url = process.env.MOYI_EMBED_URL;
  const key = process.env.MOYI_EMBED_KEY;
  if (!url || !key) return null;
  return {
    url,
    key,
    model: process.env.MOYI_EMBED_MODEL || 'text-embedding-3-small',
    dim: Number(process.env.MOYI_EMBED_DIM || DIM),
  };
}

async function remoteEmbed(text, cfg) {
  const body = { model: cfg.model, input: text, dimensions: cfg.dim };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('embedding ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  const vec = json && json.data && json.data[0] && json.data[0].embedding;
  if (!Array.isArray(vec)) throw new Error('embedding 响应格式不符');
  if (vec.length !== DIM) {
    throw new Error('维度不匹配：provider 返回 ' + vec.length + ' 维，数据库列是 vector(' + DIM + ')');
  }
  return normalize(vec.map(Number));
}

/**
 * 取一段文本的向量。带进程内缓存（同一 query 反复搜不必重复算）。
 * provider 报错时降级到本地向量，而不是让整条请求挂掉。
 */
async function embed(text) {
  const key = crypto.createHash('sha1').update(text || '').digest('hex');
  if (cache.has(key)) return cache.get(key);
  let vec, mode;
  const cfg = providerConfig();
  if (cfg) {
    try { vec = await remoteEmbed(text, cfg); mode = 'provider'; }
    catch (e) {
      lastEmbedError = e.message;
      vec = localEmbed(text); mode = 'local';
    }
  } else {
    vec = localEmbed(text); mode = 'local';
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, vec);
  embed.lastMode = mode;
  return vec;
}

function embedInfo() {
  const cfg = providerConfig();
  return {
    dim: DIM,
    provider: cfg ? cfg.model : null,
    endpoint: cfg ? 'configured' : 'none',
    mode: cfg ? (embed.lastMode || 'provider') : 'local',
    last_error: lastEmbedError,
    cached: cache.size,
  };
}

/**
 * 抽取文本中的「事实锚点」：数字串、拉丁词、以及可能的专名。
 * 用于去重时的硬护栏——生日 3月8日 与 5月8日 语义再接近也不是同一条记忆。
 */
function facts(content) {
  const s = String(content || '');
  const nums = s.match(/\d+(?:\.\d+)?/g) || [];
  const latin = (s.match(/[a-zA-Z][a-zA-Z0-9_+-]{1,}/g) || []).map(w => w.toLowerCase());
  return { nums: new Set(nums), latin: new Set(latin) };
}

/**
 * 两条文本的事实是否冲突。冲突则绝不能判为重复。
 * 只在双方都含有同类锚点时比较，避免「一条有数字一条没有」被误伤。
 */
function factsConflict(a, b) {
  const fa = facts(a), fb = facts(b);
  const setDiff = (A, B) => A.size && B.size && [...A].some(x => !B.has(x));
  if (setDiff(fa.nums, fb.nums)) return true;
  if (setDiff(fa.latin, fb.latin)) return true;
  return false;
}

/** 字面重合度：较短文本的字符被较长文本覆盖的比例。 */
function lexicalOverlap(a, b) {
  const norm = x => new Set(String(x || '').replace(/\s+/g, ''));
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** 是否已接入真实 embedding 服务（影响去重等对语义质量敏感的判据）。 */
function providerMode() {
  return Boolean(providerConfig()) && embed.lastMode === 'provider';
}

module.exports = {
  DIM, embed, localEmbed, cosine, normalize, parseVector, toVectorLiteral,
  tokenize, providerConfig, providerMode, embedInfo,
  facts, factsConflict, lexicalOverlap,
};
