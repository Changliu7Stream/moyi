/**
 * 墨忆 v3 — 共享业务逻辑
 * server.js（本地）与 api/index.js（Vercel）共用
 */

const crypto = require('crypto');

// ── 配置 ─────────────────────────────────────────────
const SUPA_URL = process.env.SUPABASE_URL || 'https://iafpilpdxajuwpvupqpx.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhZnBpbHBkeGFqdXdwdnVwcXB4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMjQwMjgsImV4cCI6MjEwMjcwMDAyOH0.LLIWulSlyOIH3VO6nZGRqnkrGPhUfmZO25petgGp76s';
const REST = SUPA_URL + '/rest/v1';

// ── Supabase 请求 ────────────────────────────────────
async function supa(p, method = 'GET', body = null, prefer = null) {
  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
  };
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

// ── 认证 ─────────────────────────────────────────────
async function authenticate(req) {
  const key = req.headers['x-moyi-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/, '');
  if (!key) return null;
  const r = await supa('/agents?api_key_hash=eq.' + hashKey(key) + '&select=id,name,role,created_at');
  if (r.status >= 400 || !Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}
function isMaster(agent) { return agent && agent.role === 'master'; }

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

// ── 混合搜索评分 ─────────────────────────────────────
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
  const ageDays = (Date.now() - new Date(mem.created_at).getTime()) / 86400000;
  if (ageDays > 30) score *= 0.9;
  if (ageDays > 90) score *= 0.8;
  return score;
}

// ── HTTP 辅助 ────────────────────────────────────────
function parseBody(req) {
  return new Promise(res => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
  });
}
function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Moyi-Key,X-Moyi-Master-Key',
  });
  res.end(JSON.stringify(data));
}

// ── 主路由 ───────────────────────────────────────────
// pathname: /api 之后的路径（如 /memories、/agents/register）
async function route(req, res, pathname, url) {
  const u = url || new URL(req.url, 'http://localhost');
  const p = pathname || u.pathname.replace(/^\/api/, '') || '/';
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Moyi-Key,X-Moyi-Master-Key',
    });
    return res.end();
  }

  // ── 公开：注册 ──
  if (p === '/agents/register' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.name || !b.name.trim()) return json(res, 400, { error: 'name 不能为空' });
    const key = genKey();
    const role = (b.master_code && b.master_code === (process.env.MASTER_CODE || 'moyi-master')) ? 'master' : 'agent';
    const r = await supa('/agents', 'POST', { name: b.name.trim(), api_key_hash: hashKey(key), role }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '注册失败', detail: r.data });
    return json(res, 201, { id: r.data[0].id, name: r.data[0].name, role: r.data[0].role, api_key: key, created_at: r.data[0].created_at, note: '此密钥仅显示一次，请妥善保存' });
  }

  // ── 公开：验证 ──
  if (p === '/agents/verify' && method === 'POST') {
    const agent = await authenticate(req);
    if (!agent) return json(res, 401, { error: '密钥无效' });
    return json(res, 200, agent);
  }

  // ── 以下需认证 ──
  const agent = await authenticate(req);
  if (!agent && p.startsWith('/agents') === false) {
    return json(res, 401, { error: '需要有效的 API Key（X-Moyi-Key 头）' });
  }
  const aid = agent ? agent.id : null;

  // ── Agent 管理（master only）──
  if (p === '/agents' && method === 'GET') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可管理 Agent' });
    const r = await supa('/agents?select=id,name,role,created_at&order=created_at.desc');
    return json(res, 200, { agents: r.data || [], total: (r.data || []).length });
  }
  if (p === '/agents' && method === 'POST') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可创建 Agent' });
    const b = await parseBody(req);
    if (!b.name) return json(res, 400, { error: 'name 不能为空' });
    const key = genKey();
    const role = b.role || 'agent';
    const r = await supa('/agents', 'POST', { name: b.name.trim(), api_key_hash: hashKey(key), role }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '创建失败' });
    return json(res, 201, { id: r.data[0].id, name: r.data[0].name, role: r.data[0].role, api_key: key, note: '此密钥仅显示一次' });
  }
  const am1 = p.match(/^\/agents\/([\w-]+)$/);
  if (am1 && method === 'DELETE') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可删除 Agent' });
    await supa('/agents?id=eq.' + am1[1], 'DELETE');
    return json(res, 200, { deleted: true, id: am1[1] });
  }
  const am2 = p.match(/^\/agents\/([\w-]+)\/reset-key$/);
  if (am2 && method === 'POST') {
    if (!isMaster(agent)) return json(res, 403, { error: '仅 master 可重置密钥' });
    const key = genKey();
    const r = await supa('/agents?id=eq.' + am2[1], 'PATCH', { api_key_hash: hashKey(key) }, 'return=representation');
    if (r.status >= 400 || !r.data || !r.data.length) return json(res, 404, { error: 'Agent 不存在' });
    return json(res, 200, { id: r.data[0].id, name: r.data[0].name, api_key: key, note: '旧密钥已失效，此密钥仅显示一次' });
  }

  // ── 记忆（按 agent 隔离）──
  if (p === '/memories' && method === 'GET') {
    let q = '/memories?agent_id=eq.' + aid + '&select=*';
    const imp = u.searchParams.get('importance');
    const synced = u.searchParams.get('synced');
    const kw = u.searchParams.get('q');
    if (imp) q += '&importance=eq.' + imp;
    if (synced === 'true') q += '&synced=eq.true';
    if (synced === 'false') q += '&synced=eq.false';
    if (kw) q += '&or=(content.ilike.*' + encodeURIComponent(kw) + '*,summary.ilike.*' + encodeURIComponent(kw) + '*)';
    q += '&order=created_at.desc&limit=200';
    const r = await supa(q);
    return json(res, 200, { memories: r.data || [], total: (r.data || []).length });
  }

  if (p === '/memories' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content) return json(res, 400, { error: 'content 不能为空' });
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    const importance = b.importance || assessImportance(b.content, existingTags);
    const tags = b.tags || extractTags(b.content);
    const summary = b.summary || summarize(b.content);
    const id = 'mem_' + crypto.randomBytes(8).toString('hex');
    // 自动同步策略：high 创建即同步，medium/low 待同步
    const synced = importance === 'high';
    const r = await supa('/memories', 'POST', { id, agent_id: aid, content: b.content, summary, importance, tags, source: b.source || 'mcp', synced, access_count: 0 }, 'return=representation');
    return json(res, 201, r.data ? r.data[0] : { error: '创建失败' });
  }

  // remember：评估 + 存储 一步完成（MCP 体验优化）
  if (p === '/memories/remember' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content) return json(res, 400, { error: 'content 不能为空' });
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    const importance = assessImportance(b.content, existingTags);
    const tags = extractTags(b.content);
    const summary = summarize(b.content);
    if (importance === 'low' && !b.force) {
      return json(res, 200, { stored: false, importance, tags, summary, reason: '价值较低，未存储。如需强制存储请传 force=true' });
    }
    const id = 'mem_' + crypto.randomBytes(8).toString('hex');
    const synced = importance === 'high';
    const r = await supa('/memories', 'POST', { id, agent_id: aid, content: b.content, summary, importance, tags, source: b.source || 'mcp', synced, access_count: 0 }, 'return=representation');
    if (r.status >= 400) return json(res, 400, { error: '存储失败' });
    return json(res, 201, { stored: true, memory: r.data[0] });
  }

  if (p === '/memories/search' && method === 'POST') {
    const b = await parseBody(req);
    const kw = (b.query || '').trim();
    if (!kw) return json(res, 200, { results: [], total: 0 });
    // 混合搜索：先 PostgREST ilike 粗筛，再 JS 精排
    const q = '/memories?agent_id=eq.' + aid + '&or=(content.ilike.*' + encodeURIComponent(kw) + '*,summary.ilike.*' + encodeURIComponent(kw) + '*)&limit=100';
    const r = await supa(q);
    const scored = (r.data || [])
      .map(m => ({ memory: m, score: scoreSearch(m, kw) }))
      .filter(x => x.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .map(x => x.memory);
    // 补充标签命中（ilike 没覆盖 tags.cs 的场景）
    if (scored.length < 10) {
      const tagR = await supa('/memories?agent_id=eq.' + aid + '&tags.cs.{' + encodeURIComponent(kw) + '}&limit=20');
      (tagR.data || []).forEach(m => {
        if (!scored.find(s => s.id === m.id)) scored.push(m);
      });
    }
    return json(res, 200, { results: scored.slice(0, 50), total: scored.length });
  }

  if (p === '/memories/assess' && method === 'POST') {
    const b = await parseBody(req);
    if (!b.content) return json(res, 400, { error: 'content 不能为空' });
    const tagsR = await supa('/memories?agent_id=eq.' + aid + '&select=tags&limit=500');
    const existingTags = [...new Set((tagsR.data || []).flatMap(m => m.tags || []))];
    return json(res, 200, { importance: assessImportance(b.content, existingTags), tags: extractTags(b.content), summary: summarize(b.content) });
  }

  if (p === '/stats' && method === 'GET') {
    const r = await supa('/memories?agent_id=eq.' + aid + '&select=importance,synced,tags');
    const ms = r.data || [];
    return json(res, 200, {
      total: ms.length,
      high: ms.filter(m => m.importance === 'high').length,
      medium: ms.filter(m => m.importance === 'medium').length,
      low: ms.filter(m => m.importance === 'low').length,
      synced: ms.filter(m => m.synced).length,
      unsynced: ms.filter(m => !m.synced).length,
      allTags: [...new Set(ms.flatMap(m => m.tags || []))].sort(),
      agent: { id: agent.id, name: agent.name, role: agent.role },
    });
  }

  if (p === '/sync/batch' && method === 'POST') {
    const r = await supa('/memories?agent_id=eq.' + aid + '&synced=eq.false&importance=in.(high,medium)&select=id');
    const ids = (r.data || []).map(m => m.id);
    if (!ids.length) return json(res, 200, { synced: 0, ids: [] });
    await supa('/memories?id=in.(' + ids.join(',') + ')', 'PATCH', { synced: true, updated_at: new Date().toISOString() });
    return json(res, 200, { synced: ids.length, ids });
  }

  if (p === '/whoami' && method === 'GET') {
    return json(res, 200, agent);
  }

  // 单条操作
  const m1 = p.match(/^\/memories\/([\w]+)$/);
  if (m1) {
    const id = m1[1];
    if (method === 'GET') {
      const r = await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id + '&select=*');
      if (!r.data || !r.data.length) return json(res, 404, { error: '记忆不存在' });
      await supa('/memories?id=eq.' + id, 'PATCH', { access_count: (r.data[0].access_count || 0) + 1 });
      return json(res, 200, r.data[0]);
    }
    if (method === 'PATCH') {
      const b = await parseBody(req);
      const up = { updated_at: new Date().toISOString() };
      if (b.content !== undefined) up.content = b.content;
      if (b.summary !== undefined) up.summary = b.summary;
      if (b.importance !== undefined) up.importance = b.importance;
      if (b.tags !== undefined) up.tags = b.tags;
      if (b.synced !== undefined) up.synced = b.synced;
      if (b.embedding !== undefined) up.embedding = b.embedding;
      const r = await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id, 'PATCH', up, 'return=representation');
      return json(res, 200, r.data ? r.data[0] : { error: '更新失败' });
    }
    if (method === 'DELETE') {
      await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + id, 'DELETE');
      return json(res, 200, { deleted: true, id });
    }
  }

  const m2 = p.match(/^\/memories\/([\w]+)\/sync$/);
  if (m2 && method === 'POST') {
    const r = await supa('/memories?agent_id=eq.' + aid + '&id=eq.' + m2[1], 'PATCH', { synced: true, updated_at: new Date().toISOString() }, 'return=representation');
    return json(res, 200, r.data ? r.data[0] : { error: '同步失败' });
  }

  return json(res, 404, { error: '路径不存在: ' + p });
}

module.exports = { route, json, parseBody, supa, genKey, hashKey, authenticate, isMaster, assessImportance, extractTags, summarize, scoreSearch, SUPA_URL };
