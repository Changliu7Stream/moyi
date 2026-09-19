/**
 * 内存版 PostgREST mock —— 仅用于测试，不连任何真实数据库。
 * 实现了 lib/moyi.js 用到的查询子集：eq/in/ilike/is.null/tags.cs/order/limit/select。
 */
const http = require('http');
const crypto = require('crypto');

// 单调递增时间戳，保证 order=created_at 的测试结果是确定的
let _seq = 0;
const nextTs = () => new Date(Date.now() - (1000 - (_seq++))).toISOString();

const db = { agents: [], memories: [], admins: [], admin_sessions: [], settings: [] };
// 引导安装那一段测试需要一个「干净的空实例」，而它跑在最后，
// 此时主 mock 里已经有几十个 agent 和上百条记忆了。
// 只在这几个表上支持 ?__clear=1（记忆与 agent 清不得，D2 的除名用例还指着它们）。
const CLEARABLE = ['admins', 'admin_sessions', 'settings'];
// 被临时「删掉」的表（模拟迁移 SQL 未执行）
const NOTABLE = new Set();
// 模拟真实库上的唯一约束：撞了要回 409（引导安装拿它当 CAS 用）
const UNIQUE = {
  admins: [['username', r => r.username]],
  settings: [['key', r => r.key]],
};
let FAIL_MODE = false;
function send401(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: '42501', message: 'permission denied for table (RLS in effect)' }));
}

function parseQuery(url) {
  const out = [];
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) { out.push({ k, v }); continue; }
    out.push({ k, v });
  }
  return out;
}

function logicTree(str) {
  // 解析 or=(a,b,and(c,d)) 形式；仅支持测试所需深度
  str = str.replace(/^\(/, '').replace(/\)$/, '');
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(p => p.trim());
}

function matchFilter(row, cond) {
  if (cond.startsWith('and(') || cond.startsWith('or(')) {
    const inner = logicTree(cond.slice(cond.indexOf('(')));
    if (cond.startsWith('or')) return inner.some(c => matchFilter(row, c));
    return inner.every(c => matchFilter(row, c));
  }
  const seg = cond.split('.');
  const col = seg[0];
  let op = seg[1];
  let val = seg.slice(2).join('.');
  if (op === 'not') { op = seg[2]; val = seg.slice(3).join('.'); return !matchFilter(row, [col, op, val].filter(Boolean).join('.')); }
  const cell = row[col];
  switch (op) {
    case 'eq': return String(cell) === val;
    case 'neq': return String(cell) !== val;
    case 'in': {
      const list = val.replace(/^\(/, '').replace(/\)$/, '').split(',');
      return list.includes(String(cell));
    }
    case 'ilike': {
      const re = new RegExp('^' + val.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      return typeof cell === 'string' && re.test(cell);
    }
    case 'like': {
      const re = new RegExp('^' + val.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return typeof cell === 'string' && re.test(cell);
    }
    case 'is': return val === 'null' ? cell == null : cell != null;
    case 'cs': {
      const want = val.replace(/^[{]/, '').replace(/[}]$/, '').split(',');
      return Array.isArray(cell) && want.every(w => cell.includes(w));
    }
    default: return true;
  }
}

/** 'col.op.val' 或 'or.(a,b)' → 判定一行是否匹配 */
function matchCond(row, cond) {
  const dot = cond.indexOf('.');
  const key = cond.slice(0, dot);
  const expr = cond.slice(dot + 1);
  if (key === 'or' || key === 'and') return matchFilter(row, key + expr);
  return matchFilter(row, key + '.' + expr);
}

/** pgvector 文本字面量 '[a,b,c]' → number[] */
function parseVec(lit) {
  if (typeof lit !== 'string') return null;
  const s = lit.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!s) return null;
  const arr = s.split(',').map(Number);
  return arr.every(Number.isFinite) ? arr : null;
}
function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function applySelect(rows, sel) {
  if (!sel || sel === '*') return rows;
  const cols = sel.split(',');
  return rows.map(r => {
    const o = {};
    cols.forEach(c => { if (r[c] !== undefined) o[c] = r[c]; });
    return o;
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // 测试控制面：模拟 Supabase 故障（轮换密钥后 anon key 被拒的情形）
  if (u.pathname === '/__control/fail') {
    FAIL_MODE = u.searchParams.get('on') !== '0';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ fail: FAIL_MODE }));
  }
  if (u.pathname === '/__control/reset-admin') {
    for (const t of CLEARABLE) db[t] = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ cleared: CLEARABLE }));
  }
  // 模拟「迁移 SQL 没跑，表不存在」：真实 PostgREST 对未知关系回 404。
  // 引导安装那段必须回归这个形态 —— 没跑 SQL 时不能出现一个能提交的安装页。
  if (u.pathname === '/__control/notable') {
    const t = u.searchParams.get('table');
    if (u.searchParams.get('on') === '0') NOTABLE.delete(t); else NOTABLE.add(t);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ not_found: [...NOTABLE] }));
  }
  if (FAIL_MODE) return send401(res);
  const table = u.pathname.replace(/^\/rest\/v1\//, '').replace(/^\//, '');
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  if (table === 'rpc' || table.startsWith('rpc/')) {
    const fn = table.split('/')[1];
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      let args = {}; try { args = JSON.parse(b || '{}'); } catch {}
      if (fn === 'increment_access') {
        const m = db.memories.find(x => x.id === args.p_id);
        if (m) { m.access_count = (m.access_count || 0) + 1; return send(200, { ok: true }); }
        return send(404, { error: 'not found' });
      }
      if (fn === 'match_memories') {
        // match_agent_id 为 null = 全局记忆模式下不按 agent 过滤（与 SQL 里的
        // `match_agent_id is null or agent_id = match_agent_id` 对齐）
        // 模拟 pgvector 的余弦近邻召回：真实实现走 HNSW 索引，
        // 这里只需在「返回形态」与「排序语义」上与之一致，供服务层下推路径回归。
        const q = parseVec(args.query_embedding);
        const aid = args.match_agent_id === undefined ? null : args.match_agent_id;
        const cnt = Number(args.match_count) || 20;
        const min = args.min_similarity != null ? Number(args.min_similarity) : 0.1;
        if (!q) return send(400, { error: 'query_embedding 不是合法向量' });
        const hits = db.memories
          .filter(m => (aid === null || String(m.agent_id) === String(aid)) && m.embedding)
          .map(m => {
            const v = parseVec(m.embedding);
            const sim = v ? cos(q, v) : -1;
            const row = Object.assign({}, m); delete row.embedding;
            row.similarity = sim;
            return row;
          })
          .filter(m => m.similarity > min)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, cnt);
        return send(200, hits);
      }
      return send(404, { error: 'no such function: ' + fn });
    });
    return;
  }
  const t = u.pathname.split('/').filter(Boolean).pop();
  if (NOTABLE.has(t)) return send(404, { code: '42P01', message: 'relation "public.' + t + '" does not exist' });
  if (!db[t]) return send(404, { error: 'table not found: ' + t });

  const params = parseQuery(u);
  const conds = params.filter(p => !['select', 'order', 'limit', 'offset'].includes(p.k)).map(p => p.k + '.' + p.v);
  const select = (params.find(p => p.k === 'select') || {}).v;
  const limit = Number((params.find(p => p.k === 'limit') || {}).v || 0);
  const order = (params.find(p => p.k === 'order') || {}).v;

  const prefer = req.headers['prefer'] || '';

  if (req.method === 'GET') {
    let rows = db[t].filter(r => conds.every(c => matchCond(r, c)));
    if (order) {
      const [col, dir] = order.split('.');
      rows.sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
    }
    if (limit) rows = rows.slice(0, limit);
    return send(200, applySelect(rows, select));
  }
  if (req.method === 'POST') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      // 模拟 Postgres gen_random_uuid()，保证与真实 Supabase 的 id 形态一致
      if (!body.id && ['agents', 'admins', 'admin_sessions'].includes(t)) body.id = crypto.randomUUID();
      // 模拟列默认值：真实 schema 里 disabled 是 NOT NULL DEFAULT false，
      // 缺了它 `disabled=eq.false` 这个过滤会把所有行都筛掉（最后超管的护栏因此误判）
      if (t === 'admins' && body.disabled === undefined) body.disabled = false;
      if (t === 'admins' && body.session_version === undefined) body.session_version = 0;
      const dup = (UNIQUE[t] || []).find(([col, get]) =>
        db[t].some(r => String(get(r)) === String(get(body))));
      if (dup) {
        // PostgREST 的 upsert：撞唯一约束时改成更新既有行，而不是报错
        if (prefer.includes('resolution=merge-duplicates')) {
          const hit = db[t].find(r => String(dup[1](r)) === String(dup[1](body)));
          Object.assign(hit, body, { id: hit.id });
          return send(204, '');
        }
        return send(409, { code: '23505', message: 'duplicate key value violates unique constraint ' + dup[0] });
      }
      if (!body.created_at) body.created_at = nextTs();
      if (t === 'memories') {
        // 外键：agent_id 必须存在
        if (!db.agents.find(a => a.id === body.agent_id)) {
          return send(400, { code: '23503', message: 'foreign key violation' });
        }
      }
      db[t].push(body);
      if (prefer.includes('return=representation')) return send(201, [body]);
      send(201, body);
    });
    return;
  }
  if (req.method === 'PATCH') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const patch = JSON.parse(b || '{}');
      const hits = db[t].filter(r => conds.every(c => matchCond(r, c)));
      hits.forEach(h => Object.assign(h, patch));
      if (prefer.includes('return=representation')) return send(200, applySelect(hits, select));
      send(204, '');
    });
    return;
  }
  if (req.method === 'DELETE') {
    // 安全护栏：无过滤条件时拒绝，避免误删整表
    if (!conds.length) return send(400, { error: 'mock refuses unfiltered DELETE' });
    const hit = db[t].filter(r => conds.every(c => matchCond(r, c)));
    db[t] = db[t].filter(r => !conds.every(c => matchCond(r, c)));
    // PostgREST 语义：Prefer: return=representation 时回被删的行，
    // 服务层靠「空数组」判断「条件没命中任何行」（例如删了别人的记忆）。
    if (prefer.includes('return=representation')) return send(200, applySelect(hit, select));
    send(204, '');
    return;
  }
  send(405, { error: 'method' });
});

server.listen(Number(process.env.MOCK_PORT || 3999), '127.0.0.1', () => {
  process.stderr.write('[mock] PostgREST mock on ' + (process.env.MOCK_PORT || 3999) + '\n');
});

module.exports = { db, server };
