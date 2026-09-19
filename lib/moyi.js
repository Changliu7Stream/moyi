/**
 * 墨忆 v3 — 共享业务逻辑
 * server.js（本地）与 api/index.js（Vercel）共用
 */

const crypto = require('crypto');
const {
  embed, cosine, parseVector, toVectorLiteral, embedInfo, providerMode,
  factsConflict, lexicalOverlap, DIM,
} = require('./embeddings.js');
const { audit, auditStats, recentEvents, allowRegister, authGate, authFailed, clearAuthFail } = require('./audit.js');
const { buildGraph, neighborhood } = require('./graph.js');
const { vitality, decayFactor, evaluate: evaluateDecay } = require('./decay.js');

// ── 配置 ─────────────────────────────────────────────
// 存储层凭据只能来自环境变量，仓库里不留任何可用的连接串或密钥。
//
// 后端可选（两者都是 PostgREST 协议，墨忆只依赖这一层）：
//   postgrest —— 自托管原生 PostgreSQL + PostgREST（Docker 栈，默认）
//   supabase  —— Supabase 托管（需要 /rest/v1 路径前缀）
// SUPABASE_URL / SUPABASE_KEY 作为别名继续接受，便于从旧部署平移。
const BACKEND = (process.env.MOYI_DB_BACKEND || 'postgrest').toLowerCase();
const SUPA_URL = process.env.MOYI_DB_URL || process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.MOYI_DB_TOKEN || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY || '';
// 原生 PostgREST 挂在根路径，Supabase 挂在 /rest/v1 下。
// 用 MOYI_DB_PREFIX 可显式覆盖（例如自建时加了反向代理前缀）。
// 未显式设置时按 URL 推断：*.supabase.co → /rest/v1。
// 这一步不能省：否则只配了 SUPABASE_URL 的老部署在升级后会直接打不到表。
function inferPrefix(url) {
  if (process.env.MOYI_DB_PREFIX !== undefined) return process.env.MOYI_DB_PREFIX;
  // URL 里已经写了路径前缀就别再追加，否则 /rest/v1/rest/v1 直接 404。
  // 这个坑很典型：有人 SUPABASE_URL 填项目根，有人习惯把 /rest/v1 一起填上。
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { pathname = ''; }
  if (/\/rest\/v1\/?$/.test(pathname)) return '';
  if (BACKEND === 'supabase') return '/rest/v1';
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  return /\.supabase\.(co|in)$/i.test(host) ? '/rest/v1' : '';
}
/**
 * 由存储层 URL 推算最终 REST 基址。独立成函数是为了能被测试直接调用：
 * 这是「换后端」最容易出错的一处，写错就是全站 404。
 */
function resolveRest(url) {
  return String(url || '').replace(/\/+$/, '') + inferPrefix(url).replace(/\/+$/, '');
}
const REST = resolveRest(SUPA_URL);

// 默认 master 口令已移除。未显式设置 MASTER_CODE 时，无人能注册成 master。
const MASTER_CODE = process.env.MOYI_CODE || process.env.MASTER_CODE || '';

// 语义去重阈值（用 test/dedupe-calibration 的实测样本校准）：
//   provider 模式语义可靠，向量门槛 0.90、字面 0.60；
//   本地哈希向量区分度不足（「改生日」cos 0.97 > 「语序调整」0.91），
//   所以向量门槛放到 0.70、字面门槛提到 0.88，并叠加事实冲突护栏。
const DEDUPE_VEC = Number(process.env.MOYI_DEDUPE_VEC || 0.90);
const DEDUPE_VEC_LOCAL = Number(process.env.MOYI_DEDUPE_VEC_LOCAL || 0.70);
const DEDUPE_LEX = Number(process.env.MOYI_DEDUPE_LEX || 0.88);
const DEDUPE_LEX_PROVIDER = Number(process.env.MOYI_DEDUPE_LEX_PROVIDER || 0.60);

// 报错时按后端给出对应的变量名，避免自托管用户去翻 Supabase 文档。
const ENV_URL = BACKEND === 'supabase' ? 'SUPABASE_URL' : 'MOYI_DB_URL';
const ENV_KEY = BACKEND === 'supabase' ? 'SUPABASE_KEY' : 'MOYI_DB_TOKEN';

function missingConfig() {
  const miss = [];
  if (!SUPA_URL) miss.push(ENV_URL);
  if (!SUPA_KEY) miss.push(ENV_KEY);
  return miss;
}

// ── 存储层请求（PostgREST 协议：Supabase 或自托管原生 PostgREST）──
async function supa(p, method = 'GET', body = null, prefer = null) {
  if (!SUPA_URL || !SUPA_KEY) {
    return { status: 500, data: { error: '服务端未配置 ' + ENV_URL + ' / ' + ENV_KEY } };
  }
  const headers = {
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
  };
  // apikey 是 Supabase 网关的约定，原生 PostgREST 没有这个头，多发无害但没必要。
  if (BACKEND === 'supabase') headers['apikey'] = SUPA_KEY;
  if (prefer) headers['Prefer'] = prefer;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(REST + p, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, data: json };
}

// ── 密钥 ─────────────────────────────────────────────
function genKey() { return 'moyi_' + crypto.randomBytes(16).toString('hex'); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

/**
 * 判断一次 supa() 调用是否失败。
 * 原先各分支直接 `r.data || []`，Supabase 返回 401/404 时错误对象会被
 * 当成正常数据以 200 回传，故障被静默吞掉（例如轮换密钥后会表现为
 * 「记忆全部消失」而不是明确报错）。现统一显式检查。
 */
function dbFailed(r) {
  return !r || r.status >= 400;
}
function dbError(res, r) {
  const detail = r && r.data && (r.data.message || r.data.error);
  return json(res, 502, {
    error: '存储层请求失败（HTTP ' + (r ? r.status : '?') + '）',
    detail: detail || undefined,
    hint: '常见原因：' + ENV_KEY + ' 无权限（Supabase 开启 RLS 后 anon key 会被拒）、'
      + ENV_URL + ' 写错、表结构缺列。云端请执行 sql/vector-search.sql，'
      + '自托管请执行 sql/00-schema.sql + docker/init/10-roles.sql。',
  });
}

/** 存储层故障（401/404/5xx）。抛出后由 route() 统一转成 502。 */
class DbError extends Error {
  constructor(r) { super('storage layer failure'); this.r = r; }
}
/** 关键读取路径用它，避免把数据库错误静默变成「你的记忆全都消失了」。 */
function must(r) {
  if (dbFailed(r)) throw new DbError(r);
  return r;
}

// 限速只针对「带错了 key」的请求。
// 没带 key（未登录的前端、探活的爬虫、用户直接访问 API 根）不计入失败：
// 否则一个登在页面上的浏览器半小时内点满 30 次就会把自己锁在门外，
// 而这既不是攻击者关心的行为，也不是正常用户该有的体验。
function presentedKey(req) {
  const k = req.headers['x-moyi-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/, '');
  return Boolean(k);
}

// ── 认证 ─────────────────────────────────────────────
// 返回 agent 对象；无 key 或 key 不匹配返回 null；存储层故障抛 DbError。
async function authenticate(req) {
  const key = req.headers['x-moyi-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/, '');
  if (!key) return null;
  const r = must(await supa('/agents?api_key_hash=eq.' + hashKey(key) + '&select=id,name,role,created_at'));
  if (!Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}
function isMaster(agent) { return agent && agent.role === 'master'; }

// ── 入参白名单 ───────────────────────────────────────
// 这些值会被拼进 PostgREST 查询串，必须严格校验，不能信客户端。
const IMPORTANCE = new Set(['high', 'medium', 'low']);
function safeImportance(v) { return IMPORTANCE.has(v) ? v : null; }
function safeId(v) { return /^[\w-]{1,64}$/.test(String(v || '')) ? String(v) : null; }
function safeUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))
    ? String(v) : null;
}
// ── 记忆向量 ─────────────────────────────────────────
/** 为一条记忆生成向量；provider 不可用时自动降级，绝不因向量失败而丢记忆。 */
async function vectorFor(content) {
  try {
    const vec = await embed(content);
    return vec && vec.length === DIM ? toVectorLiteral(vec) : null;
  } catch { return null; }
}

/**
 * 语义去重。三条判据同时成立才合并：
 *   1) 事实不冲突（数字/拉丁锚点一致）——生日 3月8日 与 5月8日 绝不能合并；
 *   2) 字面重合度 >= 对应模式的 lexGate；
 *   3) 向量相似度 >= 门槛（provider 模式 0.90；本地哈希向量区分度低，用 0.70）。
 * 本地模式下向量近似随机（实测「改生日」cos 0.97 高于「语序调整」0.91），
 * 因此真正起作用的是事实护栏 + 字面重合，向量只作辅助。接入 embedding
 * provider 后语义召回能力才会明显提升。
 */
async function findSimilar(aid, content) {
  const usingProvider = providerMode();
  const vecGate = usingProvider ? DEDUPE_VEC : DEDUPE_VEC_LOCAL;
  const lexGate = usingProvider ? DEDUPE_LEX_PROVIDER : DEDUPE_LEX;
  const q = await embed(content);
  const r = must(await supa('/memories?agent_id=eq.' + aid + '&select=id,content,summary,importance,tags,created_at,embedding&order=created_at.desc&limit=500'));
  let best = null;
  for (const m of (r.data || [])) {
    // 护栏一：事实冲突直接排除（数字/英文锚点不一致）
    if (factsConflict(content, m.content)) continue;
    // 护栏二：字面重合度
    const lex = lexicalOverlap(content, m.content);
    if (lex < lexGate) continue;
    // 护栏三：向量相似度。本地模式下若目标尚无向量，不敢只凭字面合并。
    const v = parseVector(m.embedding);
    let sim = 0;
    if (v && v.length === DIM) {
      sim = cosine(q, v);
      if (sim < vecGate) continue;
    } else if (!usingProvider) {
      continue;
    }
    if (!best || lex > best.lexical) best = { memory: m, similarity: sim, lexical: lex };
  }
  return best;
}

// ── 重要性评估 ───────────────────────────────────────
function assessImportance(content, existingTags) {
  let score = 0;
  const t = (content || '').toLowerCase();
  const has = w => t.includes(w);
  const cnt = arr => arr.filter(has).length;
  score += cnt(['喜欢','讨厌','爱','恨','害怕','渴望','重要','必须','永远','绝不','痛','喜','怒','悲','惧']) * 15;
  score += cnt(['偏好','习惯','总是','每次','从不','一贯','风格','原则']) * 12;
  score += cnt(['我叫','我是','我的名字','我住','我工作','生日','电话','邮箱','地址','主人']) * 25;
  score += (existingTags || []).filter(tag => t.includes(tag)).length * 8;
  if (content.length < 10) score -= 10;
  if (content.length > 200) score += 5;
  score -= cnt(['今天','刚刚','刚才','临时','马上','稍后']) * 5;
  if (score >= 35) return 'high';
  if (score >= 15) return 'medium';
  return 'low';
}
function extractTags(content) {
  const kws = ['偏好','习惯','工作','生活','项目','技术','架构','设计','家庭','朋友','健康','计划','目标','问题','方案','想法','记忆','身份','工具','流程','规则','约定','秘密'];
  const t = (content || '').toLowerCase();
  return kws.filter(k => t.includes(k));
}
function summarize(content) {
  if (!content || content.length <= 80) return content || '';
  let c = content.slice(0, 80);
  const p = Math.max(c.lastIndexOf('。'),c.lastIndexOf('，'),c.lastIndexOf('、'),c.lastIndexOf('！'),c.lastIndexOf('？'),c.lastIndexOf('.'));
  if (p > 30) c = c.slice(0, p + 1);
  return c + '...';
}

// ── 混合搜索评分（关键词侧）─────────────────────────
// 刻意只做字面匹配，不再在这里掺入时效惩罚：
// 时效统一由 lib/decay.js 的 decayFactor 处理（它同时考虑 updated_at 与
// access_count，比原来「>30 天打 9 折」这种一刀切准确，也不会二次惩罚）。
function scoreSearch(mem, query) {
  let score = 0;
  const q = (query || '').toLowerCase().trim();
  if (!q) return 0;
  const content = (mem.content || '').toLowerCase();
  const summary = (mem.summary || '').toLowerCase();
  const tags = (mem.tags || []).join(' ').toLowerCase();
  if (content.includes(q)) score += 10;
  if (summary.includes(q)) score += 8;
  if (tags.includes(q)) score += 5;
  q.split(/[\s,，、]+/).filter(Boolean).forEach(w => {
    if (content.includes(w)) score += 3;
    if (tags.includes(w)) score += 4;
  });
  if (mem.importance === 'high') score *= 1.5;
  if (mem.importance === 'medium') score *= 1.2;
  return score;
}

function higherImportance(a, b) {
  const rank = { low: 0, medium: 1, high: 2 };
  return (rank[b] > rank[a] ? b : a) || 'low';
}

// 参与检索/去重的记忆条数上限。向量比对是 O(n) 暴力扫描，
// 记忆量上万后应改用 Supabase 端 pgvector RPC（见 sql/vector-search.sql）。
const SCAN_LIMIT = Math.min(5000, Math.max(200, parseInt(process.env.MOYI_SCAN_LIMIT, 10) || 1000));

async function scanMemories(aid) {
  const r = must(await supa('/memories?agent_id=eq.' + aid
    + '&select=id,content,summary,importance,tags,source,synced,access_count,created_at,updated_at,embedding'
    + '&order=created_at.desc&limit=' + SCAN_LIMIT));
  return r.data || [];
}

/**
 * 检索候选集的来源。
 *
 * 默认（MOYI_DB_SEARCH=0）走服务层暴力扫描：把该 agent 的 ≤SCAN_LIMIT 条全拉下来，
 * 逐条算余弦。记忆量小的时候无所谓，上万条就明显慢了。
 *
 * 打开 MOYI_DB_SEARCH=1 后改为下推到数据库：调用 match_memories() RPC，
 * 由 pgvector + HNSW 索引做近邻召回（见 sql/00-schema.sql / vector-search.sql）。
 *
 * 两个必须处理的边界，否则下推会造成「静默召回缺失」：
 *   1. 尚未回填 embedding 的行（embedding IS NULL）在 RPC 里根本不会出现，
 *      所以额外补一次小查询把无向量的行取回来合并 —— 老库没 backfill 完也照旧可搜。
 *   2. RPC 不存在（未执行迁移 SQL）时 PostgREST 返回 404，这里静默退回扫描模式，
 *      并在响应的 search_backend 字段里如实标注用的哪条路。
 */
const DB_SEARCH = process.env.MOYI_DB_SEARCH === '1';
const DB_MIN_SIM = Number(process.env.MOYI_DB_MIN_SIM || 0.05);
// RPC 不可用的进程级熔断：一次探测失败后不再每条查询都撞一遍 404
let rpcUnavailable = false;

async function rpcCandidates(aid, query, want) {
  if (rpcUnavailable) return null;
  const qv = await embed(query);
  if (!qv) return null;
  const r = await supa('/rpc/match_memories', 'POST', {
    query_embedding: toVectorLiteral(qv),
    match_agent_id: aid,
    match_count: Math.min(SCAN_LIMIT, Math.max(want * 3, 50)),
    min_similarity: DB_MIN_SIM,
  });
  if (r.status >= 400 || !Array.isArray(r.data)) {
    if (r.status === 404 || r.status === 400) rpcUnavailable = true;
    return null;
  }
  // RPC 不返回 embedding（也不需要：语义分已由 DB 算好）。
  // 归一化到 [0,1]，与服务层扫描路径的 (cos+1)/2 保持同一量纲，
  // 否则两种后端的 _score 不可比，前端调阈值会精神分裂。
  return r.data.map(m => Object.assign({}, m, {
    _semantic: Math.max(0, (Number(m.similarity) + 1) / 2),
  }));
}

async function fetchUnvectorized(aid, cap) {
  const r = await supa('/memories?agent_id=eq.' + aid
    + '&embedding=is.null&select=id,content,summary,importance,tags,source,synced,access_count,created_at,updated_at'
    + '&order=created_at.desc&limit=' + cap);
  return r.status < 400 && Array.isArray(r.data) ? r.data : [];
}

/**
 * 混合检索：向量语义分 + 关键词字面分，加权融合后排序，再乘时间衰减系数。
 *   语义分解决「换个说法搜不到」，字面分保证专有名词/代码关键词的精确命中。
 *   衰减只调排序、不剔除：MOYI_DECAY=0 可完全关掉（排查老库时对照用）。
 */
const DECAY_ON = process.env.MOYI_DECAY !== '0';

async function hybridSearch(aid, query, limit) {
  // 候选集：优先 DB 端近邻召回（需 MOYI_DB_SEARCH=1 且 RPC 可用），否则服务层扫描
  let all, backend;
  if (DB_SEARCH) {
    const viaRpc = await rpcCandidates(aid, query, limit);
    if (viaRpc) {
      const gap = await fetchUnvectorized(aid, Math.min(SCAN_LIMIT, 200));
      all = viaRpc.concat(gap);
      backend = 'pgvector';
    } else {
      all = await scanMemories(aid);
      backend = 'scan';
    }
  } else {
    all = await scanMemories(aid);
    backend = 'scan';
  }
  if (!all.length) return { results: [], total: 0, scanned: 0, mode: 'empty', search_backend: backend };

  const W_VEC = Number(process.env.MOYI_W_VEC || 0.7);
  const W_KW = Number(process.env.MOYI_W_KW || 0.3);
  const hasVector = all.some(m => m._semantic != null || parseVector(m.embedding));

  // pgvector 路径已经不再持有 embedding 列，只有 DB 算好的语义分
  const qv = backend === 'scan' ? await embed(query) : null;
  const maxKw = all.reduce((mx, m) => Math.max(mx, scoreSearch(m, query)), 0) || 1;
  let vecUsed = 0;
  const now = Date.now();

  const scored = all.map(m => {
    let sVec = 0;
    if (m._semantic != null) {
      sVec = m._semantic;
      vecUsed++;
    } else {
      const v = parseVector(m.embedding);
      if (v && qv && v.length === qv.length) {
        // 余弦 [-1,1] 压到 [0,1]
        sVec = Math.max(0, (cosine(qv, v) + 1) / 2);
        vecUsed++;
      }
    }
    const sKw = scoreSearch(m, query) / maxKw;
    const raw = hasVector ? (W_VEC * sVec + W_KW * sKw) : sKw;
    const decay = DECAY_ON ? decayFactor(m, now) : 1;
    const fused = raw * decay;
    const out = Object.assign({}, m, {
      _score: Number(fused.toFixed(4)),
      _decay: Number(decay.toFixed(3)),
      _vitality: Number(vitality(m, now).toFixed(3)),
    });
    delete out.embedding;   // 384 维向量不必回传给调用方
    delete out._semantic;
    delete out.similarity;
    return { memory: out, score: fused };
  }).filter(x => x.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: scored.map(x => x.memory),
    total: scored.length,
    scanned: all.length,
    vectorized: vecUsed,
    mode: hasVector ? 'hybrid' : 'keyword',
    search_backend: backend,
    decay: DECAY_ON ? 'on' : 'off',
    embedding: embedInfo(),
  };
}

/** 供 GET /memories?q= 复用：只回传 id 列表。 */
async function semanticIds(aid, query, limit) {
  const out = await hybridSearch(aid, query, limit);
  return (out.results || []).map(m => m.id);
}

/**
 * 访问计数原子自增。
 * 优先走 Postgres RPC（increment_access，见 sql/vector-search.sql）；
 * 未安装该函数时退回读-改-写，并在注释里承认这里有极小的并发窗口。
 */
async function bumpAccess(id) {
  const rpc = await supa('/rpc/increment_access', 'POST', { p_id: id });
  if (rpc.status < 400) return;
  const cur = await supa('/memories?id=eq.' + id + '&select=access_count');
  const row = cur.data && cur.data[0];
  if (!row) return;
  await supa('/memories?id=eq.' + id, 'PATCH', { access_count: (row.access_count || 0) + 1 });
}

async function countMissing(aid) {
  const r = await supa('/memories?agent_id=eq.' + aid + '&select=id&embedding=is.null&limit=5000');
  return (r.data || []).length;
}

// ── HTTP 辅助 ────────────────────────────────────────
/**
 * CORS 白名单。默认只放行同源与本地开发端口。
 * 生产环境用 MOYI_ALLOWED_ORIGINS="https://a.com,https://b.com" 显式配置。
 * 原先写死 * ：任何网页都能在浏览器里拿用户的 key 打这个 API。
 */
function allowedOrigin(req) {
  const list = (process.env.MOYI_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin) return null;
  if (list.includes('*')) return '*';
  const allow = new Set(list);
  allow.add('http://localhost:3906');
  allow.add('http://127.0.0.1:3906');
  return allow.has(origin) ? origin : null;
}
function corsHeaders(req) {
  const origin = allowedOrigin(req);
  if (!origin) return { 'Content-Type': 'application/json; charset=utf-8' };
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Moyi-Key',
    'Access-Control-Max-Age': '600',
  };
}
function parseBody(req) {
  return new Promise(res => {
    let b = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { req.destroy(); return res({}); }  // 1MB 上限
      b += c;
    });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
  });
}
function json(res, code, data) {
  res.writeHead(code, corsHeaders(res.__moyiReq || {}));
  res.end(JSON.stringify(data));
}

// ── 主路由 ───────────────────────────────────────────
// pathname: /api 之后的路径（如 /memories、/agents/register）
// 外层负责把存储层故障统一转成 502，而不是让调用方收到含糊的 500。
async function route(req, res, pathname, url) {
  try {
    return await routeInner(req, res, pathname, url);
  } catch (e) {
    if (e instanceof DbError) return dbError(res, e.r);
    throw e;
  }
}

async function routeInner(req, res, pathname, url) {
  res.__moyiReq = req;
  const u = url || new URL(req.url, 'http://localhost');
  const p = pathname || u.pathname.replace(/^\/api/, '') || '/';
  const method = req.method;

  // 服务端缺配置时立即报错，而不是带着空凭据去打 Supabase 产生 500 噪音
  const miss = missingConfig();
  if (miss.length) {
    return json(res, 500, {
      error: '服务端未配置：' + miss.join(' / '),
      hint: '请在 .env.local（本地）或 Vercel 环境变量（线上）中设置。参考 .env.example',
    });
  }

  if (method === 'OPTIONS') {
    const h = corsHeaders(req);
    delete h['Content-Type'];
    res.writeHead(204, h);
    return res.end();
  }

  // ── 公开：注册 ──
  if (p === '/agents/register' && method === 'POST') {
    // 注册是公开接口（领钥匙的唯一入口），不能关，只能限速。
    const rl = allowRegister(req);
    if (!rl.allowed) {
      audit('anonymous', 'register.rate_limited', { reason: rl.reason });
      return json(res, 429, {
        error: '注册过于频繁，请稍后再试',
        reason: rl.reason,
        limit: rl.limit,
        retry_after_ms: rl.retry_after_ms,
        hint: '如需批量创建 Agent，请先注册一个 master，再用 POST /agents 由 master 签发。',
      });
    }
    const b = await parseBody(req);
    if (!b.name || !b.name.trim()) return json(res, 400, { error: 'name 不能为空' });
    if (String(b.name).trim().length > 64) return json(res, 400, { error: 'name 过长（上限 64 字符）' });
    const key = genKey();
    // 只有显式配置了 MASTER_CODE 才可能产生 master；缺省不再有任何后门口令。
    const wantMaster = Boolean(MASTER_CODE) && b.master_code === MASTER_CODE;
    if (b.master_code && !MASTER_CODE && !wantMaster) {
      // 传了 master_code 但服务端没配置：明确告知，避免用户以为提权成功
      process.stderr.write('[moyi] 注册请求携带 master_code，但服务端未设置 MASTER_CODE 环境变量，按普通 agent 处理。\n');
      audit('anonymous', 'register.master_code_ignored_no_master_code_set');
    }
    const role = wantMaster ? 'master' : 'agent';
    const r = await supa('/agents', 'POST', { name: String(b.name).trim(), api_key_hash: hashKey(key), role }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '注册失败', detail: r.data });
    audit(r.data[0].id, 'register', { name: r.data[0].name, role, master_granted: wantMaster });
    return json(res, 201, { id: r.data[0].id, name: r.data[0].name, role: r.data[0].role, api_key: key, created_at: r.data[0].created_at, note: '此密钥仅显示一次，请妥善保存' });
  }

  // ── 公开：验证 ──
  if (p === '/agents/verify' && method === 'POST') {
    const gate = authGate(req);
    if (!gate.allowed) {
      return json(res, 429, { error: '密钥校验失败次数过多，请 15 分钟后再试', retry_after_ms: gate.retry_after_ms });
    }
    const agent = await authenticate(req);
    if (!agent) { if (presentedKey(req)) authFailed(req); audit('anonymous', 'verify.failed'); return json(res, 401, { error: '密钥无效' }); }
    clearAuthFail(req);
    return json(res, 200, agent);
  }

  // ── 以下全部需要认证 ──
  // 原实现在此处对 /agents* 路径放行（为兼容 GET/POST /agents 的判断），
  // 导致部分 agent 路由在未认证时可被访问。现统一要求认证，
  // master 权限在各自分支内用 isMaster 判断。
  const gate = authGate(req);
  if (!gate.allowed) {
    return json(res, 429, { error: '密钥校验失败次数过多，请 15 分钟后再试', retry_after_ms: gate.retry_after_ms });
  }
  const agent = await authenticate(req);
  if (!agent) {
    if (presentedKey(req)) authFailed(req);
    audit('anonymous', 'auth.rejected', { path: p });
    return json(res, 401, { error: '需要有效的 API Key（X-Moyi-Key 头）' });
  }
  clearAuthFail(req);
  const aid = agent.id;
  const who = agent.name || aid;

  // ── Agent 管理（master only）──
  if (p === '/agents' && method === 'GET') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可管理 Agent' });
    const r = must(await supa('/agents?select=id,name,role,created_at&order=created_at.desc'));
    const agents = r.data || [];
    // 前端要显示每个 Agent 的记忆条数。用一次 agent_id 列表聚合，
    // 避免 N+1 查询；上限 5000 条足够当前规模，超出时以 5000 计。
    const memR = must(await supa('/memories?select=agent_id&limit=5000'));
    const counts = {};
    for (const m of (memR.data || [])) counts[m.agent_id] = (counts[m.agent_id] || 0) + 1;
    agents.forEach(a => { a.memory_count = counts[a.id] || 0; });
    return json(res, 200, { agents, total: agents.length });
  }
  if (p === '/agents' && method === 'POST') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可创建 Agent' });
    const b = await parseBody(req);
    if (!b.name) return json(res, 400, { error: 'name 不能为空' });
    const key = genKey();
    // 由 master 创建时也限制角色，避免把任意字符串写进 role 列
    const role = b.role === 'master' ? 'master' : 'agent';
    const r = await supa('/agents', 'POST', { name: String(b.name).trim(), api_key_hash: hashKey(key), role }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '创建失败' });
    return json(res, 201, { id: r.data[0].id, name: r.data[0].name, role: r.data[0].role, api_key: key, note: '此密钥仅显示一次' });
  }
  const am1 = p.match(/^\/agents\/([\w-]+)$/);
  if (am1 && method === 'DELETE') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可删除 Agent' });
    const id = safeUuid(am1[1]);
    if (!id) return json(res, 400, { error: 'id 格式不合法' });
    if (id === aid) return json(res, 400, { error: '不能删除自己' });
    // 先抹掉该 agent 的记忆（外键约束下顺序很重要）
    await supa('/memories?agent_id=eq.' + id, 'DELETE');
    const r = await supa('/agents?id=eq.' + id, 'DELETE', null, 'return=minimal');
    if (r.status >= 400) return json(res, 400, { error: '除名失败', detail: r.data });
    audit(aid, 'agent.delete', { target: id, actor_name: who });
    return json(res, 200, { deleted: true, id });
  }
  const am2 = p.match(/^\/agents\/([\w-]+)\/reset-key$/);
  if (am2 && method === 'POST') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可重置密钥' });
    const id = safeUuid(am2[1]);
    if (!id) return json(res, 400, { error: 'id 格式不合法' });
    const key = genKey();
    const r = await supa('/agents?id=eq.' + id, 'PATCH', { api_key_hash: hashKey(key) }, 'return=representation');
    if (r.status >= 400 || !r.data || !r.data.length) return json(res, 404, { error: 'Agent 不存在' });
    // 只记录「谁给谁换了钥匙」，密钥本身绝不进日志
    audit(aid, 'agent.reset_key', { target: id, actor_name: who });
    return json(res, 200, { id: r.data[0].id, name: r.data[0].name, api_key: key, note: '旧密钥已失效，此密钥仅显示一次' });  }

  // ── 记忆（按 agent 严格隔离）──
  if (p === '/memories' && method === 'GET') {
    let q = '/memories?agent_id=eq.' + aid + '&select=*';
    const imp = safeImportance(u.searchParams.get('importance'));
    const synced = u.searchParams.get('synced');
    const kw = u.searchParams.get('q');
    const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 200));
    if (imp) q += '&importance=eq.' + imp;
    if (synced === 'true' || synced === 'false') q += '&synced=eq.' + synced;
    // q 走语义检索（带回关键词兜底），不再拼进 PostgREST 逻辑树
    if (kw && kw.trim()) {
      const ids = await semanticIds(aid, kw.trim(), limit);
      if (!ids.length) return json(res, 200, { memories: [], total: 0 });
      q += '&id=in.(' + ids.map(x => safeId(x) || 'x').join(',') + ')';
    }
    q += '&order=created_at.desc&limit=' + limit;
    const r = must(await supa(q));
    return json(res, 200, { memories: r.data || [], total: (r.data || []).length });
  }

  if (p === '/memories' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content || !String(b.content).trim()) return json(res, 400, { error: 'content 不能为空' });
    if (String(b.content).length > 20000) return json(res, 400, { error: 'content 过长（上限 20000 字符）' });
    const content = String(b.content);
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    const importance = safeImportance(b.importance) || assessImportance(content, existingTags);
    const tags = Array.isArray(b.tags) ? b.tags.slice(0, 12).map(t => String(t).slice(0, 32)) : extractTags(content);
    const summary = b.summary ? String(b.summary).slice(0, 200) : summarize(content);
    const id = 'mem_' + crypto.randomBytes(8).toString('hex');
    const embedding = await vectorFor(content);
    const synced = importance === 'high';
    const r = await supa('/memories', 'POST', { id, agent_id: aid, content, summary, importance, tags, source: String(b.source || 'mcp').slice(0, 64), synced, access_count: 0, embedding }, 'return=representation');
    return json(res, 201, r.data ? r.data[0] : { error: '创建失败', detail: r.data });
  }

  // remember：评估 + 去重 + 存储 一步完成（MCP 体验优化）
  if (p === '/memories/remember' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content || !String(b.content).trim()) return json(res, 400, { error: 'content 不能为空' });
    const content = String(b.content);
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    const importance = assessImportance(content, existingTags);
    const tags = extractTags(content);
    const summary = summarize(content);
    if (importance === 'low' && !b.force) {
      return json(res, 200, { stored: false, importance, tags, summary, reason: '价值较低，未存储。如需强制存储请传 force=true' });
    }

    // 语义去重：同一条信息换个说法再记一次时，合并而不是新增
    const dup = await findSimilar(aid, content);
    if (dup) {
      const dm = dup.memory;
      // 保留信息量更大的一条，并同步重算向量，避免向量与内容脱节
      const better = content.length > (dm.content || '').length;
      const mergedTags = [...new Set([...(dm.tags || []), ...tags])];
      const up = {
        tags: mergedTags,
        importance: higherImportance(dm.importance, importance),
        updated_at: new Date().toISOString(),
      };
      if (better) {
        up.content = content;
        up.summary = summary;
        const vec = await vectorFor(content);
        if (vec) up.embedding = vec;
      }
      const r = await supa('/memories?id=eq.' + safeId(dm.id) + '&agent_id=eq.' + aid, 'PATCH', up, 'return=representation');
      audit(aid, 'remember.deduped', { id: dm.id, similarity: Number(dup.similarity.toFixed(3)) });
      return json(res, 200, {
        stored: false,
        deduped: true,
        similarity: Number(dup.similarity.toFixed(4)),
        lexical: Number(dup.lexical.toFixed(4)),
        memory: r.data ? r.data[0] : dm,
        reason: '已有语义重复的记忆（相似度 ' + dup.similarity.toFixed(3)
          + '，字面重合 ' + dup.lexical.toFixed(3) + '），已合并而不是新增。',
      });
    }

    const id = 'mem_' + crypto.randomBytes(8).toString('hex');
    const embedding = await vectorFor(content);
    const synced = importance === 'high';
    // force=true 的记忆打上 force 标记：lib/decay.js 认这个标记，
    // 用户明确要求「一定要记住」的东西不允许被衰减机制降级。
    const srcTag = String(b.source || 'mcp').slice(0, 64) + (b.force ? ' force' : '');
    const r = await supa('/memories', 'POST', { id, agent_id: aid, content, summary, importance, tags, source: srcTag, synced, access_count: 0, embedding }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '存储失败' });
    audit(aid, 'remember.stored', { id, importance, vectorized: Boolean(embedding) });
    return json(res, 201, { stored: true, memory: r.data[0] });
  }

  if (p === '/memories/search' && method === 'POST') {
    const b = await parseBody(req);
    const kw = String(b.query || '').trim();
    if (!kw) return json(res, 200, { results: [], total: 0, mode: 'none' });
    const limit = Math.min(100, Math.max(1, parseInt(b.limit, 10) || 20));
    const out = await hybridSearch(aid, kw, limit);
    audit(aid, 'search', { hits: out.total, scanned: out.scanned, mode: out.mode });
    return json(res, 200, out);
  }

  // ── 记忆图谱（关联可视化）──
  if (p === '/graph' && method === 'GET') {
    const rows = await scanMemories(aid);
    const maxNodes = Math.min(600, Math.max(10, parseInt(u.searchParams.get('limit'), 10) || 200));
    const mw = parseFloat(u.searchParams.get('min_weight'));
    const graph = buildGraph(rows, {
      maxNodes,
      // 未传或非法值时给 undefined，让 buildGraph 用它自己的默认阈值
      minWeight: Number.isFinite(mw) ? Math.min(1, Math.max(0, mw)) : undefined,
    });
    const focus = u.searchParams.get('focus');
    const payload = focus && safeId(focus)
      ? Object.assign({ focus: safeId(focus) }, neighborhood(graph, safeId(focus), 2))
      : graph;
    audit(aid, 'graph', { nodes: (payload.nodes || []).length, edges: (payload.edges || []).length });
    return json(res, 200, payload);
  }

  // ── 衰减体检：默认只看不动（dry-run）──
  if (p === '/decay/preview' && method === 'GET') {
    const rows = await scanMemories(aid);
    const ev = evaluateDecay(rows);
    return json(res, 200, {
      half_life_days: Number(process.env.MOYI_DECAY_HALFLIFE || 90),
      forget_after_days: Number(process.env.MOYI_FORGET_AFTER_DAYS || 180),
      scanned: rows.length,
      pinned: ev.pinned,
      keep: ev.keep.length,
      would_downgrade: ev.downgrade,
      would_forget: ev.forget_eligible,
      note: '本接口不写库。降级需 POST /decay/apply，且必须带 confirm=true。',
    });
  }

  if (p === '/decay/apply' && method === 'POST') {
    const b = await parseBody(req);
    const rows = await scanMemories(aid);
    const ev = evaluateDecay(rows);
    let changed = 0, failed = 0;
    if (b.confirm === true) {
      // 显式确认后才落库；只降级不删除，high 也永远不会被降级到 low 以下
      for (const d of ev.downgrade) {
        const r = await supa('/memories?id=eq.' + safeId(d.id) + '&agent_id=eq.' + aid, 'PATCH',
          { importance: d.to, updated_at: new Date().toISOString() });
        if (r.status >= 400) failed++; else changed++;
      }
      audit(aid, 'decay.apply', { downgraded: changed, failed, candidates: ev.downgrade.length });
      return json(res, 200, {
        applied: true, downgraded: changed, failed,
        forget_eligible: ev.forget_eligible.length,
        note: '遗忘候选未被删除，仅列出。删除需逐条调用 DELETE /memories/:id。',
      });
    }
    return json(res, 200, {
      applied: false,
      would_downgrade: ev.downgrade.length,
      would_forget: ev.forget_eligible.length,
      hint: '传 confirm=true 才会写库（且只降级，不删除）。',
    });
  }

  // ── 审计日志（master only）──
  if (p === '/admin/audit' && method === 'GET') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可查看审计日志' });
    const n = Math.min(2000, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 200));
    return json(res, 200, {
      events: recentEvents(n),
      stats: auditStats(),
      warning: '审计日志保存在进程内存中，实例重启或扩缩容后即失效；无状态部署下不可作为合规留痕。',
    });
  }

  if (p === '/memories/assess' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content) return json(res, 400, { error: 'content 不能为空' });
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    return json(res, 200, { importance: assessImportance(b.content, existingTags), tags: extractTags(b.content), summary: summarize(b.content) });
  }

  if (p === '/stats' && method === 'GET') {
    const r = must(await supa('/memories?agent_id=eq.' + aid + '&select=importance,synced,tags,embedding'));
    const ms = r.data || [];
    const vectorized = ms.filter(m => m.embedding).length;
    return json(res, 200, {
      total: ms.length,
      high: ms.filter(m => m.importance === 'high').length,
      medium: ms.filter(m => m.importance === 'medium').length,
      low: ms.filter(m => m.importance === 'low').length,
      synced: ms.filter(m => m.synced).length,
      unsynced: ms.filter(m => !m.synced).length,
      vectorized,
      needs_embedding: ms.length - vectorized,
      allTags: [...new Set(ms.flatMap(m => m.tags || []))].sort(),
      agent: { id: agent.id, name: agent.name, role: agent.role },
      embedding: embedInfo(),
    });
  }

  if (p === '/sync/batch' && method === 'POST') {
    const r = await supa('/memories?agent_id=eq.' + aid + '&synced=eq.false&importance=in.(high,medium)&select=id');
    const ids = (r.data || []).map(m => safeId(m.id)).filter(Boolean);
    if (!ids.length) return json(res, 200, { synced: 0, ids: [] });
    await supa('/memories?id=in.(' + ids.join(',') + ')&agent_id=eq.' + aid, 'PATCH', { synced: true, synced_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return json(res, 200, { synced: ids.length, ids });
  }

  if (p === '/whoami' && method === 'GET') {
    return json(res, 200, agent);
  }

  // ── 向量回填 / 状态 ──
  if (p === '/embeddings/status' && method === 'GET') {
    const r = must(await supa('/memories?agent_id=eq.' + aid + '&select=id,embedding&limit=5000'));
    const ms = r.data || [];
    return json(res, 200, {
      total: ms.length,
      vectorized: ms.filter(m => m.embedding).length,
      missing: ms.filter(m => !m.embedding).length,
      ...embedInfo(),
    });
  }

  if (p === '/admin/backfill-embeddings' && method === 'POST') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可回填向量' });
    const b = await parseBody(req);
    const onlyMissing = b.overwrite !== true;
    const scope = b.agent_id ? safeUuid(b.agent_id) : aid;
    if (b.agent_id && !scope) return json(res, 400, { error: 'agent_id 格式不合法' });
    if (!isMaster(agent) && b.agent_id) return json(res, 403, { error: '仅 master 可回填他人记忆' });
    let url = '/memories?agent_id=eq.' + scope + '&select=id,content,embedding&limit=500&order=created_at.asc';
    if (onlyMissing) url += '&embedding=is.null';
    const r = await supa(url);
    const rows = r.data || [];
    let done = 0, failed = 0;
    for (const row of rows) {
      const vec = await vectorFor(row.content);
      if (!vec) { failed++; continue; }
      const up = await supa('/memories?id=eq.' + safeId(row.id), 'PATCH', { embedding: vec });
      if (up.status >= 400) failed++; else done++;
    }
    // 回填是写操作且可能被反复调用，留一条痕便于排查「谁在动全库」
    audit(aid, 'admin.backfill', { scope, updated: done, failed, overwrite: !onlyMissing });
    return json(res, 200, { scanned: rows.length, updated: done, failed, remaining: await countMissing(scope) });
  }

  // 单条操作
  const m1 = p.match(/^\/memories\/([\w-]+)$/);
  if (m1) {
    const id = safeId(m1[1]);
    if (!id) return json(res, 400, { error: '记忆 ID 格式不合法' });
    if (method === 'GET') {
      const r = must(await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id + '&select=*'));
      if (!r.data || !r.data.length) return json(res, 404, { error: '记忆不存在' });
      // 访问计数原子自增交给 RPC；无 RPC 时至少不会把并发的旧值写回去
      await bumpAccess(id);
      return json(res, 200, r.data[0]);
    }
    if (method === 'PATCH') {
      const b = await parseBody(req);
      const up = { updated_at: new Date().toISOString() };
      let needsReembed = false;
      if (b.content !== undefined) {
        up.content = String(b.content);
        up.summary = summarize(up.content);
        needsReembed = true;
      }
      if (b.summary !== undefined) up.summary = String(b.summary).slice(0, 200);
      if (b.importance !== undefined) {
        const imp = safeImportance(b.importance);
        if (!imp) return json(res, 400, { error: 'importance 只能是 high/medium/low' });
        up.importance = imp;
      }
      if (b.tags !== undefined) {
        if (!Array.isArray(b.tags)) return json(res, 400, { error: 'tags 必须是数组' });
        up.tags = b.tags.slice(0, 12).map(t => String(t).slice(0, 32));
      }
      if (b.synced !== undefined) up.synced = Boolean(b.synced);
      if (needsReembed) up.embedding = await vectorFor(up.content);
      const r = await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id, 'PATCH', up, 'return=representation');
      if (!r.data || !r.data.length) return json(res, r.status >= 400 ? 400 : 404, { error: '更新失败或记忆不存在' });
      return json(res, 200, r.data[0]);
    }
    if (method === 'DELETE') {
      await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id, 'DELETE');
      return json(res, 200, { deleted: true, id });
    }
  }

  const m2 = p.match(/^\/memories\/([\w-]+)\/sync$/);
  if (m2 && method === 'POST') {
    const id = safeId(m2[1]);
    if (!id) return json(res, 400, { error: '记忆 ID 格式不合法' });
    const r = await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id, 'PATCH', { synced: true, synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }, 'return=representation');
    return json(res, 200, r.data ? r.data[0] : { error: '同步失败' });
  }

  return json(res, 404, { error: '路径不存在: ' + p });
}

module.exports = {
  route, json, parseBody, supa, genKey, hashKey, authenticate, isMaster,
  assessImportance, extractTags, summarize, scoreSearch, hybridSearch,
  higherImportance, safeImportance, safeId, safeUuid, corsHeaders,
  resolveRest, SUPA_URL,
};
