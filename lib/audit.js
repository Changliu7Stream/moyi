/**
 * 墨忆 — 审计日志与注册限速
 *
 * 两件事都刻意做成进程内存态，原因写在这里，不假装成持久方案：
 *   1. 墨忆要能在 Vercel 这类无状态函数环境里跑，落盘的日志在实例回收时就没了，
 *      写文件反而制造「以为有留痕」的错觉；
 *   2. 真要做合规级留痕，应该往独立的 append-only 存储写（例如另一张
 *      只有后端密钥能写、谁都读不了的表，或对象存储）。这里只做运维够用的
 *      近期窗口，并在 /admin/audit 的响应里明确说明它是易失的。
 *
 * 内存上限：环形缓冲，最多 MOYI_AUDIT_CAPACITY 条（默认 2000），
 * 单条约 200B，最坏情况 <1MB，不会因为长期运行而涨。
 */

const crypto = require('crypto');

const CAPACITY = Math.min(50000, Math.max(100, parseInt(process.env.MOYI_AUDIT_CAPACITY, 10) || 2000));

/** 环形缓冲：events[head] 是下一次写入的位置 */
const events = new Array(CAPACITY);
let head = 0;
let count = 0;
let seq = 0;

/**
 * 记录一条审计事件。
 * detail 只允许放「放进日志也不会害事」的字段：调用方负责不要传密钥原文。
 * 这里再兜一层，任何形似密钥的值一律脱敏，防止将来有人顺手把 api_key 塞进来。
 */
function audit(actor, action, detail) {
  const ev = {
    seq: ++seq,
    ts: new Date().toISOString(),
    actor: redactStr(actor || 'anonymous'),
    action: redactStr(action || ''),
    detail: redact(detail),
  };
  events[head] = ev;
  head = (head + 1) % CAPACITY;
  if (count < CAPACITY) count++;
  return ev;
}

const SECRETISH = /^(api_key|apikey|key|token|secret|password|master_code|authorization)$/i;

function redactStr(s) {
  const str = String(s == null ? '' : s);
  // moyi_xxxx 形态的密钥即使出现在自由文本里也拦掉
  return str.replace(/moyi_[0-9a-f]{8,}/gi, m => m.slice(0, 9) + '…(redacted)');
}

function redact(d) {
  if (d == null) return undefined;
  if (typeof d !== 'object') return typeof d === 'string' ? redactStr(d) : d;
  if (Array.isArray(d)) return d.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = SECRETISH.test(k) ? '«redacted»' : redact(v);
  }
  return out;
}

/** 最近 n 条，按时间倒序（新的在前）。 */
function recentEvents(n = 200) {
  const limit = Math.min(CAPACITY, Math.max(1, parseInt(n, 10) || 200));
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (head - 1 - i + CAPACITY * 2) % CAPACITY;
    if (events[idx]) out.push(events[idx]);
    if (out.length >= limit) break;
  }
  return out;
}

function auditStats() {
  const byAction = {};
  for (const ev of recentEvents(CAPACITY)) {
    byAction[ev.action] = (byAction[ev.action] || 0) + 1;
  }
  return {
    buffered: count,
    capacity: CAPACITY,
    total_recorded: seq,
    dropped: Math.max(0, seq - count),
    ephemeral: true,
    by_action: byAction,
  };
}

// ── 限速 ─────────────────────────────────────────────
/**
 * 滑动窗口计数。键是「调用方标识 + 动作」，值是按分钟分桶的计数。
 * 桶按分钟对齐，超过窗口的桶自动失效，不需要后台清理任务
 * （但闲置的键会在每次访问时顺手清掉，否则长期下来键会无限增长）。
 */
const windows = new Map();
const PRUNE_EVERY = 1024;
let touches = 0;

function windowAdd(mapKey, limit, windowMs) {
  const now = Date.now();
  const bucketMs = 60000;
  let buckets = windows.get(mapKey);
  if (!buckets) { buckets = []; windows.set(mapKey, buckets); }
  const cutoff = now - windowMs;
  // 丢弃过期桶
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (buckets[i].t + bucketMs < cutoff) buckets.splice(i, 1);
  }
  const cur = buckets.length && buckets[buckets.length - 1].t + bucketMs > now
    ? buckets[buckets.length - 1]
    : (buckets.push({ t: Math.floor(now / bucketMs) * bucketMs, n: 0 }), buckets[buckets.length - 1]);
  cur.n++;
  const total = buckets.reduce((s, b) => s + b.n, 0);

  if (++touches % PRUNE_EVERY === 0) {
    for (const [k, bs] of windows) {
      if (!bs.some(b => b.t + bucketMs >= cutoff)) windows.delete(k);
    }
  }
  return { allowed: total <= limit, used: total, limit, reset_in_ms: Math.max(0, cutoff + bucketMs - now) };
}

/** 取调用方标识：优先 X-Forwarded-For 的第一跳，退回 socket。 */
function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  const ip = (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  // 匿名化：留前 3 段（IPv4）/前 4 组（IPv6），避免把完整来源地址长期留在内存里
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

/**
 * 注册限速。默认每来源每小时 10 次、每天 30 次。
 * 注册接口是公开的（领钥匙就要用），不能关掉，只能限速。
 */
function allowRegister(req) {
  const perHour = Math.max(1, parseInt(process.env.MOYI_REGISTER_PER_HOUR, 10) || 10);
  const perDay = Math.max(perHour, parseInt(process.env.MOYI_REGISTER_PER_DAY, 10) || 30);
  const k = clientKey(req);
  const h = windowAdd('reg:h:' + k, perHour, 3600000);
  if (!h.allowed) return { allowed: false, reason: 'hourly', retry_after_ms: h.reset_in_ms, limit: perHour };
  const d = windowAdd('reg:d:' + k, perDay, 86400000);
  if (!d.allowed) return { allowed: false, reason: 'daily', retry_after_ms: d.reset_in_ms, limit: perDay };
  return { allowed: true };
}

/**
 * 认证失败限速：挡住拿随机 key 穷举撞库。
 *
 * 关键：只统计**失败**次数，成功请求一律先放行、成功后清零。
 * 早期版本把每次认证请求都计进去，结果默认 30/15min 变成了一个「正常用户
 * 半小时只能发 30 个请求」的假限速——一次 npm test 就会自己触发 429。
 */
function authGate(req) {
  const limit = Math.max(1, parseInt(process.env.MOYI_AUTH_FAIL_PER_15MIN, 10) || 30);
  const key = 'auth:' + clientKey(req);
  const bs = windows.get(key) || [];
  const cutoff = Date.now() - 900000;
  const used = bs.filter(b => b.t + 60000 >= cutoff).reduce((s, b) => s + b.n, 0);
  if (used >= limit) {
    return { allowed: false, reason: 'auth_fail', limit, retry_after_ms: 900000 };
  }
  return { allowed: true };
}
function authFailed(req) {
  windowAdd('auth:' + clientKey(req), Number.MAX_SAFE_INTEGER, 900000);
}
function clearAuthFail(req) {
  windows.delete('auth:' + clientKey(req));
}

/** 仅测试用：清空所有窗口与缓冲。 */
function _reset() {
  windows.clear();
  events.fill(undefined);
  head = 0; count = 0; seq = 0; touches = 0;
}

module.exports = {
  audit, recentEvents, auditStats,
  allowRegister, authGate, authFailed, clearAuthFail, clientKey,
  _reset,
};
