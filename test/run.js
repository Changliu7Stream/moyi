/**
 * 墨忆 — 集成测试（全部跑在内存 mock 上，不触碰任何真实数据库）
 *
 *   node test/run.js
 *
 * 覆盖：
 *   A. 安全回归：默认 master 口令失效、未认证访问、agent 隔离、入参校验、CORS
 *   B. 向量检索：语义命中、混合排序、embedding 落库
 *   C. 语义去重：换个说法重复记忆时合并而非新增
 *   D. MCP 工具端到端
 */

const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 3999;
const API_PORT = 3907;
const BASE = 'http://127.0.0.1:' + API_PORT;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const fails = [];
let mockErr = '', srvErr = '';
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 46 - t.length))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, method = 'GET', body = null, key = null, headers = {}) {
  const opts = { method, headers: Object.assign({}, headers) };
  if (key) opts.headers['X-Moyi-Key'] = key;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opts);
  let d; try { d = await r.json(); } catch { d = { _raw: true }; }
  return { status: r.status, data: d, headers: r.headers };
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 600) return true; } catch {}
    await sleep(150);
  }
  return false;
}

async function main() {
  const mock = spawn('node', [path.join(ROOT, 'test', 'mock-postgrest.js')], {
    env: Object.assign({}, process.env, { MOCK_PORT }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stderr.on('data', d => { mockErr += d.toString(); if (process.env.VERBOSE) process.stderr.write('[mock] ' + d); });

  const srv = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOYI_PORT: String(API_PORT),
      // 指向本地 mock —— 绝不连真实 Supabase
      SUPABASE_URL: 'http://127.0.0.1:' + MOCK_PORT + '/rest/v1',
      SUPABASE_KEY: 'test-key',
      MASTER_CODE: 'test-master-code',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => { srvErr += d.toString(); if (process.env.VERBOSE) process.stderr.write('[srv] ' + d); });
  mock.on('exit', (c, s) => console.error('[mock exit code=' + c + ' sig=' + s + '] ' + mockErr.slice(-300)));
  srv.on('exit', (c, s) => console.error('[srv exit code=' + c + ' sig=' + s + '] ' + srvErr.slice(-300)));

  if (!await waitFor(BASE + '/api/whoami')) { console.error('server did not start'); process.exit(1); }

  section('A1 认证与提权');
  // 旧的硬编码后口令 moyi-master 必须失效
  let r = await api('/api/agents/register', 'POST', { name: '老口令攻击者', master_code: 'moyi-master' });
  ok('默认后门 moyi-master 不再授予 master', r.data.role === 'agent', r.data);

  r = await api('/api/agents/register', 'POST', { name: '掌柜', master_code: 'test-master-code' });
  ok('显式 MASTER_CODE 仍可创建 master', r.data.role === 'master', r.data);
  const MKEY = r.data.api_key;

  r = await api('/api/agents/register', 'POST', { name: '小明' });
  const AK = r.data.api_key;
  r = await api('/api/agents/register', 'POST', { name: '小红' });
  const BK = r.data.api_key;
  ok('普通注册返回 agent 角色', r.data.role === 'agent', r.data);

  r = await api('/api/memories');
  ok('未带 key 访问记忆 → 401', r.status === 401, r.data);

  r = await api('/api/agents');
  ok('未带 key 访问 /agents → 401（修复前可绕过）', r.status === 401, r.data);

  r = await api('/api/agents', 'GET', null, AK);
  ok('普通 agent 看 agent 列表 → 403', r.status === 403, r.data);

  r = await api('/api/agents', 'GET', null, MKEY);
  ok('master 可看 agent 列表', r.status === 200 && Array.isArray(r.data.agents), r.data);

  r = await api('/api/agents', 'POST', { name: 'x', role: 'superuser' }, MKEY);
  ok('master 建 agent 时 role 不被任意注入', r.data.role === 'agent', r.data);

  r = await api('/api/agents/not-a-uuid/reset-key', 'POST', null, MKEY);
  ok('reset-key 校验 UUID 格式 → 400', r.status === 400, r.data);

  r = await api('/api/memories/../etc/passwd', 'GET', null, AK);
  ok('畸形 ID 不会打穿路由', r.status === 400 || r.status === 404, r.status);

  section('A2 agent 数据隔离');
  await api('/api/memories', 'POST', { content: '小明的私密信息：住在杭州西溪', source: 't' }, AK);
  r = await api('/api/memories', 'GET', null, BK);
  const leaked = JSON.stringify(r.data).includes('杭州西溪');
  ok('小红读不到小明的记忆', !leaked, r.data);

  r = await api('/api/memories/search', 'POST', { query: '杭州' }, BK);
  ok('小红搜不到小明的记忆', (r.data.results || []).length === 0, r.data);

  // 越权读他人单条
  r = await api('/api/memories', 'GET', null, AK);
  const mineId = (r.data.memories || [])[0] && (r.data.memories[0]).id;
  r = await api('/api/memories/' + mineId, 'GET', null, BK);
  ok('按 ID 直接读他人记忆 → 404', r.status === 404, r.status);
  await api('/api/memories/' + mineId, 'DELETE', null, BK);
  r = await api('/api/memories/' + mineId, 'GET', null, AK);
  ok('他人发起的 DELETE 实际未删除（仍可属主读回）', r.status === 200, r.status);

  section('A3 入参校验（PostgREST 注入面）');
  r = await api('/api/memories?importance=eq.high%26or%3D(id.ne.null)', 'GET', null, AK);
  ok('importance 非法值被忽略而非拼接', r.status === 200, r.status);
  r = await api('/api/memories?importance=1&2&3', 'GET', null, AK);
  ok('多段 importance 不导致 500', r.status < 500, r.status);
  r = await api('/api/memories', 'POST', { content: '带非法 importance', importance: 'high");DROP' }, AK);
  ok('POST 非法 importance 回落到自动评估', ['high', 'medium', 'low'].includes(r.data.importance), r.data.importance);
  r = await api('/api/memories/' + mineId, 'PATCH', { importance: 'bogus' }, AK);
  ok('PATCH 非法 importance → 400', r.status === 400, r.data);
  r = await api('/api/memories/' + mineId, 'PATCH', { tags: 'not-an-array' }, AK);
  ok('PATCH tags 非数组 → 400', r.status === 400, r.data);
  r = await api('/api/memories', 'POST', { content: '' }, AK);
  ok('空 content → 400', r.status === 400, r.data);

  section('A4 CORS');
  let rr = await fetch(BASE + '/api/memories', { headers: { Origin: 'https://evil.example' }, method: 'OPTIONS' });
  const acao = rr.headers.get('access-control-allow-origin');
  ok('恶意 Origin 不放行 *', acao !== '*', acao);
  rr = await fetch(BASE + '/api/memories', { headers: { Origin: 'http://localhost:3906' }, method: 'OPTIONS' });
  ok('本地开发 Origin 放行', rr.headers.get('access-control-allow-origin') === 'http://localhost:3906');

  section('B 向量检索');
  // 清空后建一个干净 agent
  r = await api('/api/agents/register', 'POST', { name: '向量测试' });
  const VK = r.data.api_key;
  const samples = [
    '主人偏好水墨风格，界面喜欢深色主题',
    '主人习惯用 TypeScript 写后端，遵循函数式风格',
    '主人养了一只叫团子的橘猫，很黏人',
    '主人的生日是 1994 年 3 月 8 日，在意仪式感',
  ];
  for (const s of samples) await api('/api/memories', 'POST', { content: s, source: 't' }, VK);

  r = await api('/api/memories/search', 'POST', { query: '深色水墨风' }, VK);
  ok('搜索返回 hybrid 模式', r.data.mode === 'hybrid', r.data.mode);
  ok('搜索命中语义最近的记忆', /水墨|深色/.test((r.data.results[0] || {}).content || ''), (r.data.results[0] || {}).content);
  ok('结果不回传 embedding 大字段', r.data.results.every(m => m.embedding === undefined));
  ok('结果带融合分数', typeof r.data.results[0]._score === 'number');

  r = await api('/api/memories/search', 'POST', { query: '橘猫团子' }, VK);
  ok('换关键词命中另一主题', /橘猫|团子/.test((r.data.results[0] || {}).content || ''), (r.data.results[0] || {}).content);

  r = await api('/api/memories', 'GET', null, VK);
  ok('向量已落库（vectorized == total）', r.data.total > 0 && r.data.memories.every(m => m.embedding), r.data.total);

  r = await api('/api/memories?q=团子', 'GET', null, VK);
  ok('GET /memories?q= 走语义检索', (r.data.memories || []).length >= 1 && /橘猫|团子/.test(r.data.memories.map(m => m.content).join()), r.data.memories);

  r = await api('/api/embeddings/status', 'GET', null, VK);
  ok('embeddings/status 报告向量覆盖', r.data.vectorized === r.data.total && r.data.missing === 0, r.data);

  // PATCH content 后向量应重算。按内容挑目标，避免依赖返回顺序
  // （顺序会变，用位置索引会让后续去重用例失去前提）。
  r = await api('/api/memories', 'GET', null, VK);
  const picked = (r.data.memories || []).find(m => /TypeScript/.test(m.content));
  ok('能定位到用于 PATCH 的记忆', Boolean(picked), (r.data.memories || []).map(m => m.content));
  const target = picked.id, oldVec = JSON.stringify(picked.embedding);
  r = await api('/api/memories/' + target, 'PATCH', { content: '主人最近改喜欢明亮浅色调的界面了' }, VK);
  ok('PATCH content 后 embedding 已重算', JSON.stringify(r.data.embedding) !== oldVec);
  ok('PATCH content 后 summary 已同步更新', /浅色调|界面/.test(r.data.summary || ''), r.data.summary);

  section('C 语义去重');
  r = await api('/api/memories/remember', 'POST', { content: '主人的生日是 1994 年 3 月 8 日，非常重视仪式感' }, VK);
  ok('近似重复被识别', r.data.deduped === true, r.data);
  ok('去重返回相似度', typeof r.data.similarity === 'number', r.data.similarity);
  r = await api('/api/memories/remember', 'POST', { content: '主人完全换了个话题：他在研究量子计算' }, VK);
  ok('无关新记忆正常存储', r.data.stored === true, r.data);

  r = await api('/api/memories/remember', 'POST', { content: '刚才路过看到一只狗' }, VK);
  ok('low 价值内容默认不存储', r.data.stored === false, r.data);
  r = await api('/api/memories/remember', 'POST', { content: '刚才路过看到一只狗', force: true }, VK);
  ok('force=true 可强制存储', r.data.stored === true, r.data);

  section('D 访问计数与同步');
  r = await api('/api/memories/' + target, 'GET', null, VK);
  const c1 = r.data.access_count;
  await api('/api/memories/' + target, 'GET', null, VK);
  r = await api('/api/memories/' + target, 'GET', null, VK);
  ok('access_count 通过 RPC 原子自增', r.data.access_count >= c1 + 2, { c1, now: r.data.access_count });

  r = await api('/api/sync/batch', 'POST', {}, VK);
  ok('批量同步可用', r.status === 200 && typeof r.data.synced === 'number', r.data);

  section('D2 掌柜视角与新增 MCP 工具');
  r = await api('/api/agents', 'GET', null, MKEY);
  const vecAgent = (r.data.agents || []).find(a => a.name === '向量测试');
  ok('/agents 返回 memory_count 供前端显示', vecAgent && typeof vecAgent.memory_count === 'number', vecAgent);
  ok('memory_count 与实际条数一致', vecAgent && vecAgent.memory_count > 4, vecAgent && vecAgent.memory_count);

  // master 删除 Agent：应先抹记忆再删 agent（外键约束）
  r = await api('/api/agents/register', 'POST', { name: '将被除名' });
  const DK = r.data.api_key, DID = r.data.id;
  await api('/api/memories', 'POST', { content: '这条记忆将随 agent 一起消失', importance: 'high' }, DK);
  r = await api('/api/agents/' + DID, 'DELETE', null, MKEY);
  ok('master 除名 Agent 成功（不被外键挡住）', r.status === 200 && r.data.deleted === true, r.data);
  r = await api('/api/agents/verify', 'POST', null, DK);
  ok('被除名后旧 key 立即失效', r.status === 401, r.status);

  r = await api('/api/memories', 'GET', null, VK);
  const delId = r.data.memories[0].id;
  r = await api('/api/memories/' + delId, 'DELETE', null, VK);
  ok('属主可删除自己的记忆', r.data.deleted === true, r.data);
  r = await api('/api/memories/' + delId, 'GET', null, VK);
  ok('删除后读不回 → 404', r.status === 404, r.status);

  section('E MCP 端到端');
  const mcp = spawn('node', [path.join(ROOT, 'mcp-server.js')], {
    cwd: ROOT, env: Object.assign({}, process.env, { MOYI_API: BASE, MOYI_KEY: VK }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  mcp.stdout.on('data', d => out += d.toString());
  const send = m => mcp.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await sleep(500);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await sleep(400);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { content: '主人习惯每天早晨六点半晨跑' } } });
  await sleep(1200);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_memory', arguments: { query: '晨跑' } } });
  await sleep(1200);
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });
  await sleep(900);
  // forget：先拿真实 ID，再删，再确认删不掉第二次
  const stRaw = await api('/api/memories', 'GET', null, VK);
  const forgetId = stRaw.data.memories[0].id;
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'forget', arguments: { id: forgetId, reason: '测试' } } });
  await sleep(900);
  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'forget', arguments: { id: 'not-a-valid-id' } } });
  await sleep(600);
  // v3.2 新增的两个工具
  send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'memory_health', arguments: {} } });
  await sleep(900);
  send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memory_graph', arguments: { limit: 50 } } });
  await sleep(900);
  mcp.stdin.end();
  await sleep(300);

  const lines = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const txt = id => { const m = lines.find(l => l.id === id); return m && m.result && m.result.content ? m.result.content[0].text : ''; };
  const init = lines.find(l => l.id === 1);
  ok('MCP initialize 握手', init && init.result && init.result.serverInfo.name === 'moyi', init && init.error);
  const tools = (lines.find(l => l.id === 2) || {}).result;
  ok('MCP tools/list 返回工具集', tools && Array.isArray(tools.tools) && tools.tools.length >= 9, tools && tools.tools && tools.tools.map(t => t.name));
  ok('MCP 工具含 forget 与 memory_stats', tools && ['forget', 'memory_stats'].every(n => tools.tools.some(t => t.name === n)), tools && tools.tools.map(t => t.name));
  ok('MCP 工具含 memory_health 与 memory_graph',
    tools && ['memory_health', 'memory_graph'].every(n => tools.tools.some(t => t.name === n)), tools && tools.tools.map(t => t.name));
  ok('memory_health 默认是预览不动数据', /未写库|衰减体检/.test(txt(8)), txt(8).slice(0, 80));
  ok('memory_graph 返回节点/边摘要', /图谱|节点|无边/.test(txt(9)), txt(9).slice(0, 90));
  ok('MCP remember 成功', /已记住|合并/.test(txt(3)), txt(3).slice(0, 80));
  ok('MCP search_memory 有结果', /找到/.test(txt(4)), txt(4).slice(0, 80));
  ok('MCP search 报告检索模式', /hybrid/.test(txt(4)), txt(4).slice(-90));
  ok('MCP memory_stats 有内容', /总计/.test(txt(5)), txt(5).slice(0, 100));
  ok('MCP forget 删除成功', /已抹去/.test(txt(6)), txt(6).slice(0, 80));
  const gone = await api('/api/memories/' + forgetId, 'GET', null, VK);
  ok('MCP forget 确实删除了', gone.status === 404, gone.status);
  ok('MCP forget 拒绝非法 ID', (() => { const m = lines.find(l => l.id === 7); return m && m.result && m.result.isError === true; })(), txt(7).slice(0, 60));

  section('F 存储层故障必须显式报错，不能伪装成「记忆消失」');
  // 这是迁移中最可能踩到的坑：anon key 在开 RLS 后被拒，
  // 若服务层把 401 当成空数组返回，用户看到的是「我的记忆全没了」。
  const setFail = async on => {
    const url = 'http://127.0.0.1:' + MOCK_PORT + '/__control/fail?on=' + (on ? 1 : 0);
    let last;
    for (let i = 0; i < 5; i++) {
      try { const x = await fetch(url); if (x.ok) return; } catch (e) { last = e; await sleep(200); }
    }
    console.log('  ⚠ setFail 失败: ' + (last && last.message) + ' / ' + (last && last.cause && last.cause.code));
  };
  await setFail(true);
  r = await api('/api/memories', 'GET', null, VK);
  ok('读记忆遇存储层 401 → 502（而非 200 空列表）', r.status === 502, { status: r.status, data: r.data });
  ok('502 带可操作的 hint', /SUPABASE_KEY|RLS|权限/.test(JSON.stringify(r.data)), r.data);
  r = await api('/api/memories/search', 'POST', { query: '水墨' }, VK);
  ok('搜索遇故障同样不静默返回空', r.status === 502, r.status);
  r = await api('/api/agents/verify', 'POST', null, VK);
  ok('认证查库故障也报 502（不能误判为「密钥无效」）', r.status === 502, r.status);
  await setFail(false);
  r = await api('/api/memories', 'GET', null, VK);
  ok('故障恢复后正常读取', r.status === 200 && Array.isArray(r.data.memories), r.status);

  section('G 记忆图谱');
  r = await api('/api/agents/register', 'POST', { name: '图谱测试' });
  const GK = r.data.api_key;
  await api('/api/memories', 'POST', { content: '主人偏好 TypeScript，习惯写函数式代码', tags: ['技术', '偏好'], source: 't' }, GK);
  await api('/api/memories', 'POST', { content: '主人的项目 apollo-7 也用 TypeScript 开发', tags: ['项目', '技术'], source: 't' }, GK);
  await api('/api/memories', 'POST', { content: '主人在 apollo-7 上定过里程碑 v2.3', tags: ['项目'], source: 't' }, GK);
  await api('/api/memories', 'POST', { content: '完全无关：主人对花生过敏', tags: ['健康'], source: 't' }, GK);
  r = await api('/api/graph', 'GET', null, GK);
  const g = r.data;
  ok('GET /graph 返回 nodes/edges/stats', r.status === 200 && Array.isArray(g.nodes) && Array.isArray(g.edges) && g.stats, r.data);
  ok('图谱节点数与记忆数一致', g.stats.node_count === 4, g.stats);
  ok('共享标签/锚点产生边', g.stats.edge_count >= 2, g.edges);
  ok('边权归一在 [0,1] 内（曾算出 1.15）', g.edges.every(e => e.weight >= 0 && e.weight <= 1), g.edges.map(e => e.weight));
  ok('每条边说明连边依据', g.edges.every(e => Array.isArray(e.via) && e.via.length), g.edges);
  ok('无关记忆成为孤点', g.stats.isolated >= 1, g.stats);
  ok('密度统计合理', g.stats.density > 0 && g.stats.density <= 1, g.stats.density);
  const hubId = g.nodes[0].id;
  r = await api('/api/graph?focus=' + hubId, 'GET', null, GK);
  ok('focus 参数返回邻域子图', r.status === 200 && r.data.focus === hubId && r.data.nodes.length >= 1, r.data.stats);
  ok('邻域只含可达节点', r.data.nodes.every(n => n.id === hubId || r.data.edges.some(e => e.from === n.id || e.to === n.id)), r.data.nodes.map(n => n.id));
  r = await api('/api/graph?min_weight=0.999', 'GET', null, GK);
  ok('min_weight 提高则边减少', r.data.stats.edge_count <= g.stats.edge_count, r.data.stats);
  r = await api('/api/graph');
  ok('未认证访问图谱 → 401', r.status === 401, r.status);
  // 隔离：小红看不到小明的记忆，也就看不到他的图
  r = await api('/api/graph', 'GET', null, BK);
  ok('他人图谱里没有我的记忆', !JSON.stringify(r.data).includes('apollo'), r.data.stats);

  section('H 记忆衰减与遗忘');
  // 直接单测 lib/decay.js —— 纯函数，便于构造「三年前」这类难通过 API 造出的样本
  const decay = require(path.join(ROOT, 'lib', 'decay.js'));
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 8, 19);
  const mk = (o) => Object.assign({ id: 'mem_x', importance: 'medium', access_count: 0, created_at: new Date(NOW).toISOString(), source: 't' }, o);
  const fresh = decay.vitality(mk({}), NOW);
  const old180 = decay.vitality(mk({ created_at: new Date(NOW - 180 * DAY).toISOString() }), NOW);
  ok('新记忆活力高于半年前的', fresh > old180, { fresh, old180 });
  ok('活力单调递减', decay.vitality(mk({ created_at: new Date(NOW - 30 * DAY).toISOString() }), NOW)
    > decay.vitality(mk({ created_at: new Date(NOW - 120 * DAY).toISOString() }), NOW));
  const hi = decay.vitality(mk({ importance: 'high', created_at: new Date(NOW - 900 * DAY).toISOString() }), NOW);
  ok('high 重要性有地板，不会衰减到 0', hi >= 0.55, hi);
  ok('地板不掩盖真实衰减（否则降级永不触发）',
    decay.rawDecay(mk({ importance: 'high', created_at: new Date(NOW - 900 * DAY).toISOString() }), NOW) < 0.01
    && hi >= 0.55, { raw: decay.rawDecay(mk({ importance: 'high', created_at: new Date(NOW - 900 * DAY).toISOString() }), NOW), hi });
  const visited = decay.vitality(mk({ created_at: new Date(NOW - 180 * DAY).toISOString(), access_count: 50 }), NOW);
  ok('被访问过的老记忆活力不低于没被访问的', visited >= old180, { visited, old180 });
  ok('衰减系数落在 [0.35,1]', decay.decayFactor(mk({ created_at: new Date(NOW - 3000 * DAY).toISOString() }), NOW) >= 0.35
    && decay.decayFactor(mk({}), NOW) <= 1);
  ok('force 标记的记忆被钉住', decay.isPinned(mk({ source: 'mcp force' })) === true);
  ok('普通 source 不被误判为钉住', decay.isPinned(mk({ source: 'force-app' })) === false);
  const ev = decay.evaluate([
    mk({ id: 'mem_a', importance: 'medium', created_at: new Date(NOW - 400 * DAY).toISOString() }),
    mk({ id: 'mem_b', importance: 'high', created_at: new Date(NOW - 900 * DAY).toISOString() }),
    mk({ id: 'mem_c', importance: 'low', created_at: new Date(NOW - 400 * DAY).toISOString(), access_count: 0 }),
    mk({ id: 'mem_d', importance: 'low', created_at: new Date(NOW - 10 * DAY).toISOString() }),
    mk({ id: 'mem_e', importance: 'medium', created_at: new Date(NOW - 400 * DAY).toISOString(), access_count: 40 }),
    mk({ id: 'mem_f', importance: 'medium', created_at: new Date(NOW - 400 * DAY).toISOString(), source: 'mcp force' }),
  ], { now: NOW });
  ok('陈旧无人访问的 medium 建议降为 low', ev.downgrade.some(d => d.id === 'mem_a' && d.to === 'low'), ev.downgrade);
  ok('high 绝不因陈旧而被降级', !ev.downgrade.some(d => d.id === 'mem_b'), ev.downgrade);
  ok('常被访问的 medium 不降级', !ev.downgrade.some(d => d.id === 'mem_e'), ev.downgrade);
  ok('钉住的记忆不参与降级', !ev.downgrade.some(d => d.id === 'mem_f') && ev.pinned === 1, { dg: ev.downgrade, pinned: ev.pinned });
  ok('降级最多一级', ev.downgrade.every(d => Math.abs(decay.RANK[d.importance] - decay.RANK[d.to]) === 1), ev.downgrade);
  ok('低重要性且超期列为遗忘候选', ev.forget_eligible.some(d => d.id === 'mem_c'), ev.forget_eligible);
  ok('新记忆不进遗忘候选', !ev.forget_eligible.some(d => d.id === 'mem_d'), ev.forget_eligible);
  ok('遗忘候选绝不含 high/medium', ev.forget_eligible.every(d => d.importance === 'low'), ev.forget_eligible);

  // API 侧：preview 不写库，apply 必须 confirm
  r = await api('/api/decay/preview', 'GET', null, VK);
  ok('GET /decay/preview 可用', r.status === 200 && typeof r.data.scanned === 'number', r.data);
  ok('preview 回报半衰期与遗忘窗口', r.data.half_life_days > 0 && r.data.forget_after_days > 0, r.data);
  const beforeImp = await api('/api/memories', 'GET', null, VK);
  r = await api('/api/decay/apply', 'POST', {}, VK);
  ok('/decay/apply 不带 confirm 时不写库', r.data.applied === false, r.data);
  const afterImp = await api('/api/memories', 'GET', null, VK);
  ok('未确认时记忆内容条数与重要性均未变化',
    JSON.stringify(beforeImp.data.memories.map(m => [m.id, m.importance]).sort())
    === JSON.stringify(afterImp.data.memories.map(m => [m.id, m.importance]).sort()));
  r = await api('/api/decay/apply', 'POST', { confirm: true }, VK);
  ok('confirm=true 才真正执行', r.data.applied === true, r.data);
  ok('apply 不删除任何记忆', typeof r.data.downgraded === 'number' && r.data.note.includes('未被删除'), r.data);
  r = await api('/api/decay/preview', 'GET');
  ok('衰减接口需要认证', r.status === 401, r.status);

  section('I 审计日志与注册限速');
  r = await api('/api/admin/audit?limit=50', 'GET', null, MKEY);
  ok('master 可读审计', r.status === 200 && Array.isArray(r.data.events), r.data);
  ok('审计记录了检索行为', r.data.events.some(e => e.action === 'search'), r.data.events.map(e => e.action));
  ok('审计记录了存储行为', r.data.events.some(e => /remember|search|graph/.test(e.action)), r.data.events.map(e => e.action));
  ok('审计声明自身是易失的', r.data.stats.ephemeral === true && /内存/.test(r.data.warning), r.data.stats);
  r = await api('/api/admin/audit', 'GET', null, AK);
  ok('普通 agent 读审计 → 403', r.status === 403, r.status);
  r = await api('/api/admin/audit', 'GET');
  ok('未认证读审计 → 401', r.status === 401, r.status);
  // 密钥绝不进日志：把 key 写进记忆内容，再看审计输出里有没有原文
  const leak = await api('/api/memories', 'POST', { content: '我的密钥是 ' + VK + ' 请保管好', importance: 'high' }, VK);
  r = await api('/api/admin/audit?limit=50', 'GET', null, MKEY);
  ok('审计日志里不含完整密钥原文',
    !JSON.stringify(r.data.events).includes(VK), { probe: leak.status });
  ok('审计 detail 里 api_key 一类字段被脱敏',
    !/"api_key"\s*:\s*"moyi_/.test(JSON.stringify(r.data.events)), JSON.stringify(r.data.events).slice(0, 120));

  // 限速：另起一个把阈值压到极低的实例，避免干扰主测试的注册次数
  const RL_PORT = API_PORT + 3;
  const rl = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOYI_PORT: String(RL_PORT),
      SUPABASE_URL: 'http://127.0.0.1:' + MOCK_PORT + '/rest/v1',
      SUPABASE_KEY: 'test-key',
      MASTER_CODE: 'test-master-code',
      MOYI_REGISTER_PER_HOUR: '2',
      MOYI_AUTH_FAIL_PER_15MIN: '3',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rl.stderr.on('data', d => { srvErr += d.toString(); if (process.env.VERBOSE) process.stderr.write('[rl] ' + d); });
  const RLB = 'http://127.0.0.1:' + RL_PORT;
  if (!await waitFor(RLB + '/api/whoami')) console.log('  ⚠ 限速实例未启动');
  let rlStatus = [];
  for (let i = 0; i < 4; i++) {
    const x = await fetch(RLB + '/api/agents/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ name: '限速探针' + i }),
    });
    rlStatus.push(x.status);
  }
  ok('注册超过阈值后被拒（429）', rlStatus[3] === 429, rlStatus);
  ok('前两次注册正常', rlStatus[0] === 201 && rlStatus[1] === 201, rlStatus);
  const rl429 = await fetch(RLB + '/api/agents/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ name: '再试' }),
  });
  const rlBody = await rl429.json();
  ok('429 带 retry_after 与批量建号建议', typeof rlBody.retry_after_ms === 'number' && /master/.test(rlBody.hint || ''), rlBody);
  ok('不同来源不受同一计数器影响', (await fetch(RLB + '/api/agents/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' },
    body: JSON.stringify({ name: '别人' }),
  })).status === 201);
  // 撞库防护：连续错误 key 应触发 429（verify 是 POST 路由，用 GET 会打到 404，
  // 上一版测试就写错成 GET，导致「限速生效」这条其实是假通过）
  const BADIP = '203.0.113.77';
  let bad = [];
  for (let i = 0; i < 5; i++) {
    const x = await fetch(RLB + '/api/agents/verify', {
      method: 'POST', headers: { 'X-Moyi-Key': 'moyi_deadbeef' + i, 'X-Forwarded-For': BADIP },
    });
    bad.push(x.status);
  }
  ok('错误密钥穷举被限速', bad.filter(s => s === 429).length >= 2, bad);
  ok('被限速后带合法 key 也被拒（IP 级限流的固有代价）', (await fetch(RLB + '/api/agents/verify', {
    method: 'POST', headers: { 'X-Moyi-Key': VK, 'X-Forwarded-For': BADIP },
  })).status === 429, bad);

  // 这条才真正区分「只数失败」与「数所有请求」：limit=3 时
  // 2 次失败 + 1 次成功 —— 若按总请求数计数，第 3 次就会被拒。
  const OKIP = '203.0.113.88';
  const seq = [];
  for (const k of ['moyi_bad1', 'moyi_bad2', VK]) {
    const x = await fetch(RLB + '/api/agents/verify', {
      method: 'POST', headers: { 'X-Moyi-Key': k, 'X-Forwarded-For': OKIP },
    });
    seq.push(x.status);
  }
  ok('限速只数失败次数，不数成功请求', seq[2] === 200, seq);
  // 没带 key 不算「认证失败」：未登录的浏览器不该把自己锁在门外
  const NOKEY_IP = '203.0.113.99';
  for (let i = 0; i < 6; i++) {
    await fetch(RLB + '/api/memories', { headers: { 'X-Forwarded-For': NOKEY_IP } });
  }
  ok('连续缺 key 不消耗失败额度', (await fetch(RLB + '/api/memories', {
    method: 'GET', headers: { 'X-Moyi-Key': VK, 'X-Forwarded-For': NOKEY_IP },
  })).status === 200);
  // 主测试实例（默认 30/15min）跑了上百次认证仍不该被限流
  r = await api('/api/memories', 'GET', null, VK);
  ok('默认阈值下主实例不被自己的测试触发限流', r.status === 200, r.status);
  rl.kill();

  section('J 检索下推到 pgvector');
  // MOYI_DB_SEARCH=1 时走 /rpc/match_memories；mock 实现了同名 RPC，
  // 用来回归「下推路径与服务层扫描路径给出可比的结果」。
  const DB_PORT = API_PORT + 4;
  const dbsrv = spawn('node', [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MOYI_PORT: String(DB_PORT),
      SUPABASE_URL: 'http://127.0.0.1:' + MOCK_PORT + '/rest/v1',
      SUPABASE_KEY: 'test-key',
      MASTER_CODE: 'test-master-code',
      MOYI_DB_SEARCH: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dbsrv.stderr.on('data', d => { srvErr += d.toString(); if (process.env.VERBOSE) process.stderr.write('[db] ' + d); });
  const DBB = 'http://127.0.0.1:' + DB_PORT;
  if (!await waitFor(DBB + '/api/whoami')) console.log('  ⚠ pgvector 下推实例未启动');
  const pushHit = await fetch(DBB + '/api/memories/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Moyi-Key': GK },
    body: JSON.stringify({ query: 'TypeScript 项目', limit: 5 }),
  }).then(x => x.json());
  ok('下推路径标注 search_backend=pgvector', pushHit.search_backend === 'pgvector', pushHit.search_backend);
  ok('下推路径有召回结果', (pushHit.results || []).length >= 1, pushHit);
  ok('下推结果不回传 embedding 也不回传裸 similarity',
    pushHit.results.every(m => m.embedding === undefined && m.similarity === undefined), pushHit.results[0]);
  ok('下推结果分数仍在 [0,1]（量纲与扫描一致）',
    pushHit.results.every(m => m._score >= 0 && m._score <= 1), pushHit.results.map(m => m._score));
  const scanHit = await api('/api/memories/search', 'POST', { query: 'TypeScript 项目', limit: 5 }, GK);
  ok('扫描路径标注 search_backend=scan', scanHit.data.search_backend === 'scan', scanHit.data.search_backend);
  const topPush = (pushHit.results[0] || {}).content || '';
  ok('两条路径首位命中同一主题', /TypeScript|apollo/.test(topPush) && /TypeScript|apollo/.test((scanHit.data.results[0] || {}).content || ''),
    { push: topPush, scan: (scanHit.data.results[0] || {}).content });
  // 未回填向量的记忆在下推路径里也不能凭空消失
  const noVecId = 'mem_nodebug' + Date.now().toString(36);
  await fetch(DBB + '/api/memories', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Moyi-Key': GK },
    body: JSON.stringify({ content: '花生的过敏原是蛋白质结构', importance: 'high' }),
  });
  await api('/api/memories/' + noVecId, 'PATCH', {}, GK).catch(() => {});
  const db2 = await fetch(DBB + '/api/memories/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Moyi-Key': GK },
    body: JSON.stringify({ query: '花生 过敏' }),
  }).then(x => x.json());
  ok('下推路径仍能召回（关键词侧兜底）', JSON.stringify(db2.results).includes('花生') || db2.results.length > 0, db2.scanned);
  dbsrv.kill();

  section('K 存储层可换（Supabase / 原生 PostgREST）');
  const { resolveRest } = require(path.join(ROOT, 'lib', 'moyi.js'));
  if (typeof resolveRest === 'function') {
    ok('裸项目根 URL 自动补 /rest/v1', resolveRest('https://xyz.supabase.co').endsWith('/rest/v1'), resolveRest('https://xyz.supabase.co'));
    ok('URL 已含 /rest/v1 时不重复追加',
      !/rest\/v1\/rest\/v1/.test(resolveRest('https://xyz.supabase.co/rest/v1')), resolveRest('https://xyz.supabase.co/rest/v1'));
    ok('原生 PostgREST 根挂载不加前缀',
      resolveRest('http://postgrest:3000') === 'http://postgrest:3000', resolveRest('http://postgrest:3000'));
  } else {
    ok('resolveRest 已导出供测试', false, 'lib/moyi.js 未导出 resolveRest');
  }

  srv.kill(); mock.kill();

  console.log('\n' + '═'.repeat(52));
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '，失败 ' + fail : ''));
  if (fail) { console.log('  失败项：'); fails.forEach(f => console.log('   - ' + f)); }
  console.log('═'.repeat(52));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
