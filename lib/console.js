/**
 * 墨忆 — 管理控制台核心（管理员账号 / 会话 / 实例设置 / 引导安装）
 *
 * 三条刻意的设计决定，先写在这里，免得后来人以为是偷懒：
 *
 * 1. **管理员（admin）和 Agent 是两套身份，两张表。**
 *    Agent 是「工具」，拿 API Key 走 MCP，只能看见自己的记忆；
 *    管理员是「人」，拿密码登录管理面板，管的是 Agent 而不是记忆内容。
 *    把两者塞进同一张表只靠 role 区分，迟早写出「某个 Agent 的 key 能登管理面板」
 *    这类越权，所以这里从存储层就是分开的。
 *
 * 2. **会话是不透明 token + 服务端存哈希，不是自签 JWT。**
 *    零依赖下自签 JWT 也能做（见 scripts/gen-jwt.js），但那样退出登录无法真正
 *    作废一个会话，改密码也不会踢掉旧会话。存哈希的代价只是每次多一个走索引的
 *    查询 —— 而 Agent 认证本来就在做同样的事。
 *
 * 3. **口令哈希用 Node 内置 scrypt，不引入 bcrypt。**
 *    本项目的技术选型是「零运行时依赖」，crypto.scrypt 是内置的且强度足够。
 *    参数（N/r/p）随哈希一起存，格式自带版本号，将来调参不用重算全库。
 *
 * 密码学注意：verifyPassword 用 timingSafeEqual，且长度不等时先补齐再比，
 * 避免把哈希长度当成侧信道。
 */

const crypto = require('crypto');

// ── 口令哈希 ─────────────────────────────────────────
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
// scrypt 的 maxmem 必须显式放宽，否则 N=16384 会直接抛「missing error」
const SCRYPT_MEM = 64 * 1024 * 1024;
const HASH_PREFIX = 'scrypt';

function scrypt(password, salt, N, r, p, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen,
      { N, r, p, maxmem: Math.max(SCRYPT_MEM, 128 * N * r * p * 2) },
      (err, dk) => err ? reject(err) : resolve(dk));
  });
}

/** 存储格式：scrypt$N$r$p$salt_b64$hash_b64 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const dk = await scrypt(password, salt, N, r, p, keylen);
  return [HASH_PREFIX, N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const [, sN, sr, sp, sSalt, sHash] = parts;
  const N = parseInt(sN, 10), r = parseInt(sr, 10), p = parseInt(sp, 10);
  if (!(N >= 2 && r >= 1 && p >= 1)) return false;
  let salt, want;
  try {
    salt = Buffer.from(sSalt, 'base64');
    want = Buffer.from(sHash, 'base64');
  } catch { return false; }
  if (!salt.length || !want.length) return false;
  let got;
  try {
    got = await scrypt(password, salt, N, r, p, want.length);
  } catch { return false; }
  if (got.length !== want.length) {
    // 长度不同也不能直接 return false —— 那会让「哈希长度」可被计时区分出来。
    // 补齐（或截断）到相同长度后再比，结果一样是 false，但分支形态一致。
    const pad = want.length - got.length;
    got = pad > 0
      ? Buffer.concat([got, Buffer.alloc(pad)], want.length)
      : got.subarray(0, want.length);
  }
  return crypto.timingSafeEqual(got, want);
}

/** 口令策略：宁可用嘴说明，也不要弱密码出现在一个能管所有 Agent 的账号上 */
function checkPasswordPolicy(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 10) return '密码至少 10 个字符';
  if (s.length > 512) return '密码过长（上限 512 字符）';
  if (/^(.)\1+$/.test(s)) return '密码不能是同一字符重复';
  const weak = ['password', '12345678', 'qwertyui', 'adminadmin', 'changeme', 'moyimoyi'];
  if (weak.some(w => s.toLowerCase() === w)) return '密码过于常见，换一个';
  return null;
}

function checkUsername(name) {
  const s = String(name == null ? '' : name).trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,32}$/.test(s)) return '用户名需为 2–32 个字符（字母、数字、_、- 或中文）';
  return null;
}

// ── 会话 ─────────────────────────────────────────────
const SESSION_TTL_MS = Math.min(
  30 * 24 * 3600 * 1000,
  Math.max(60 * 1000, parseInt(process.env.MOYI_SESSION_DAYS, 10) * 24 * 3600 * 1000 || 7 * 24 * 3600 * 1000)
);

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(tok) {
  return crypto.createHash('sha256').update(String(tok)).digest('hex');
}
function sessionExpiresAt(now) {
  return new Date((now || Date.now()) + SESSION_TTL_MS).toISOString();
}

/**
 * 会话校验时的版本比对。
 * admins.session_version 与 admin_sessions.session_version 不一致即作废 ——
 * 这一位就是「改密码 / 停用账号 → 全部旧会话立刻失效」的实现，
 * 不需要额外的吊销列表。
 */
function sessionAlive(sess, admin) {
  if (!sess || !admin) return false;
  if (admin.disabled === true || admin.disabled === 'true') return false;
  return Number(sess.session_version) === Number(admin.session_version || 0);
}

const COOKIE_NAME = 'moyi_session';

function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readSessionToken(req) {
  const c = parseCookies(req);
  if (c[COOKIE_NAME]) return c[COOKIE_NAME];
  // 允许用头携带，方便 curl 与非浏览器客户端管理面板
  const h = String(req.headers['x-moyi-admin-token'] || '');
  return /^[A-Za-z0-9_\-]{20,128}$/.test(h) ? h : null;
}

/** Set-Cookie 的值，Secure 由请求协议决定（反向代理下看 X-Forwarded-Proto） */
function sessionCookie(token, req, maxAgeSec) {
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  const secure = proto === 'https' ? '; Secure' : '';
  const age = maxAgeSec == null ? Math.floor(SESSION_TTL_MS / 1000) : maxAgeSec;
  // SameSite=Lax（不是 Strict）：MCP 浏览器授权需要「客户端拉起系统浏览器 →
  // 顶层导航到 /api/oauth/authorize」，而 Strict 会在这一跳把会话 Cookie 拦掉，
  // 管理员就成了未登录、授权页无从点「同意」。Lax 仍会在跨站 POST/表单提交时
  // 不发 Cookie，且管理台所有写接口额外要求 X-Moyi-Console 自定义头（跨站
  // 导航根本设不了它），GET 均为只读——所以放宽到 Lax 不打开 CSRF 面。
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}

// ── 实例设置（settings 表是 key/value，便于 PostgREST 读写）──
const DEFAULT_SETTINGS = {
  instance_name: '墨忆',
  // 全局记忆：开启后所有 Agent 之间互相**只读**可见。写入/去重/删除不受影响。
  global_memory: '0',
  // 开放注册：关掉后只能由管理员或 master 发号，公开 /agents/register 返回 403
  open_register: '1',
};
// 白名单：PATCH settings 只接受这些键，杜绝客户端写进任意配置
const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
// 只有引导安装阶段能改的键，之后锁死（避免把已经建好的实例改回未初始化状态）
const BOOTSTRAP_ONLY = new Set(['setup_locked']);

function sanitizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(raw || {})) {
    if (!SETTING_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  if (out.global_memory !== '0' && out.global_memory !== '1') out.global_memory = '0';
  if (out.open_register !== '0' && out.open_register !== '1') out.open_register = '1';
  if (out.instance_name.length > 40) out.instance_name = out.instance_name.slice(0, 40);
  return out;
}

/** 把 settings 行数组折叠成对象（表里一行一个键） */
function rowsToSettings(rows) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  for (const r of (rows || [])) {
    // setup_locked 不在 DEFAULT_SETTINGS 里，但它是「装没装过」的唯一凭据，
    // 必须单独带出来 —— 早先按白名单一刀切过滤，导致落锁检查永远读到 undefined，
    // 引导页变成可以无限次重入的安装器。
    if (r.key === 'setup_locked') { out.setup_locked = true; out.setup_locked_at = r.value; continue; }
    if (SETTING_KEYS.has(r.key)) out[r.key] = String(r.value);
  }
  return out;
}

function globalMemoryOn(settings) {
  return settings && settings.global_memory === '1';
}
function openRegisterOn(settings) {
  return !settings || settings.open_register !== '0';
}

/**
 * 引导页的一次性写锁。
 *
 * 用 settings 里一行 `setup_locked` 做 CAS：PostgREST 的
 * resolution=ignore-duplicates 在行已存在时返回空 representation，
 * 据此判断「有人比我先按下了安装按钮」。
 * 不这么做的话，两个浏览器同时打开引导页会各自建出一个管理员。
 */
function setupLockRow() {
  return { key: 'setup_locked', value: new Date().toISOString() };
}

module.exports = {
  hashPassword, verifyPassword, checkPasswordPolicy, checkUsername,
  newSessionToken, hashToken, sessionExpiresAt, sessionAlive,
  COOKIE_NAME, parseCookies, readSessionToken, sessionCookie,
  DEFAULT_SETTINGS, SETTING_KEYS, BOOTSTRAP_ONLY,
  sanitizeSettings, rowsToSettings, globalMemoryOn, openRegisterOn,
  setupLockRow, SESSION_TTL_MS,
};
