/**
 * 墨忆 — HTTP MCP 端点的协议层（Streamable HTTP / JSON-RPC over POST）
 *
 * 与 stdio 版 mcp-server.js 并列的第二种接入形态：
 *   - stdio：客户端 `command: node mcp-server.js`，进程内跑，打本地/远端 REST。
 *   - HTTP ：客户端 `url: <项目地址>/api/mcp` + `Authorization: Bearer <领钥>`，
 *            请求直接进墨忆后端，工具在这里执行。
 *
 * 认证沿用 Agent 面：route() 在派发进本模块前已完成 authenticate()，
 * 这里拿到的是已鉴权的 agent 上下文，绝不自己再信任客户端传的 role/id。
 *
 * 关键设计：每个工具的执行都是「用同一个领钥，内部自调用一次 route()」打到
 * 对应的既有 REST 端点（/memories/search 等）。好处是行为与 REST 严格一致、
 * 不复制业务逻辑；坏处的是一次 tools/call 多一次内部路由（含一次 authenticate
 * 打库）。对记忆这类低频写读完全可接受，换来的是「改 REST 不用同步改 MCP」。
 *
 * 工具命名：采用 memory_* 规范名，同时保留旧名作为别名（aliases），
 * 已接入的客户端不受影响。
 */
'use strict';

// ── 工具 → REST 调用 的映射表 ──────────────────────────
// rest(ctx, args) 返回 {method, path, body}，由 handler 内部自调用 route()。
const TOOLS = [
  {
    name: 'memory_save',
    description: '记住一件事（推荐）。自动评估重要性并做语义去重；低价值默认不存，传 force=true 强制存。',
    aliases: ['remember'],
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容。' },
        source: { type: 'string', description: '来源（工具/对话/场景），默认 "mcp"。' },
        force: { type: 'boolean', description: '即使评估为 low 也强制存储，默认 false。' },
      },
      required: ['content'],
    },
    rest: (a) => ({ method: 'POST', path: '/api/memories/remember',
      body: { content: a.content, source: a.source || 'mcp', force: !!a.force } }),
  },
  {
    name: 'memory_recall',
    description: '按 ID 精确取回单条记忆（含全文、标签、重要性、访问计数）。',
    aliases: ['retrieve_memory'],
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 ID（mem_ 开头）。' } },
      required: ['id'],
    },
    rest: (a) => {
      const id = String(a.id || '');
      if (!/^mem_[\w-]{4,64}$/.test(id)) return { error: '记忆 ID 格式不合法（应以 mem_ 开头）' };
      return { method: 'GET', path: '/api/memories/' + id };
    },
  },
  {
    name: 'memory_search',
    description: '语义 + 关键词混合检索，换个说法也能搜到；结果按 相关度×重要性×时效 融合排序。',
    aliases: ['search_memory'],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或一句自然语言。' },
        limit: { type: 'number', description: '返回条数上限，默认 10。' },
      },
      required: ['query'],
    },
    rest: (a) => ({ method: 'POST', path: '/api/memories/search',
      body: { query: a.query, limit: Math.min(100, Math.max(1, a.limit || 10)) } }),
  },
  {
    name: 'memory_forget',
    description: '删除一条记忆（不可恢复）。用于用户明确要求忘掉、或记忆已错/过时。',
    aliases: ['forget'],
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆 ID（mem_ 开头）。' },
        reason: { type: 'string', description: '删除原因，仅回执确认，不入库。' },
      },
      required: ['id'],
    },
    rest: (a) => {
      const id = String(a.id || '');
      if (!/^mem_[\w-]{4,64}$/.test(id)) return { error: '记忆 ID 格式不合法（应以 mem_ 开头）' };
      return { method: 'DELETE', path: '/api/memories/' + id };
    },
  },
  {
    name: 'memory_graph_query',
    description: '取记忆关联图谱（节点=记忆，边=共享标签/事实锚点）；传 focus 只看某条记忆邻域。',
    aliases: ['memory_graph'],
    inputSchema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: '以某条记忆 ID 为中心的邻域子图。' },
        limit: { type: 'number', description: '参与构图的记忆上限，默认 200。' },
        min_weight: { type: 'number', description: '连边阈值 0~1，越大越严格，默认 0.5。' },
      },
    },
    rest: (a) => {
      let q = '/api/graph?limit=' + Math.min(500, Math.max(1, a.limit || 200));
      if (a.focus) q += '&focus=' + encodeURIComponent(String(a.focus));
      if (a.min_weight != null) q += '&min_weight=' + encodeURIComponent(String(a.min_weight));
      return { method: 'GET', path: q };
    },
  },
  {
    name: 'memory_stats',
    description: '记忆库概况：总数、重要性分布、同步与向量覆盖、标签、检索作用域。',
    aliases: [],
    inputSchema: { type: 'object', properties: {} },
    rest: () => ({ method: 'GET', path: '/api/stats' }),
  },
  {
    name: 'memory_health',
    description: '衰减体检：哪些记忆将降级、哪些是遗忘候选。默认只看不动，apply=true 才执行降级。',
    aliases: ['memory_health_preview', 'memory_decay'],
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'true=真的执行降级（只降一级、不删、high 不参与）。默认 false 仅预览。' },
      },
    },
    rest: (a) => a.apply === true
      ? { method: 'POST', path: '/api/decay/apply', body: { confirm: true } }
      : { method: 'GET', path: '/api/decay/preview' },
  },
  {
    name: 'memory_scope_list',
    description: '查看当前实例的读取作用域与可见范围：全局记忆开关、本 Agent 可见记忆规模、成员 Agent 列表（master）。',
    aliases: [],
    inputSchema: { type: 'object', properties: {} },
    rest: () => ({ method: 'GET', path: '/api/stats' }),
    // 复用 /stats 的 scope 字段；scope 的丰富化在 handler 里做，见 formatResult。
  },
  {
    name: 'memory_audit_log',
    description: '近期审计事件（master only）。注意：审计保存在进程内存，实例重启/扩缩容后即失效，不作合规留痕。',
    aliases: [],
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 200，上限 2000。' } },
    },
    rest: (a) => ({ method: 'GET',
      path: '/api/admin/audit?limit=' + Math.min(2000, Math.max(1, a.limit || 200)) }),
  },
];

// 展平成 name → tool（含别名），供 list/call 两处使用。
const BY_NAME = new Map();
for (const t of TOOLS) {
  BY_NAME.set(t.name, t);
  for (const al of (t.aliases || [])) if (!BY_NAME.has(al)) BY_NAME.set(al, t);
}

function listTools() {
  // 只暴露规范名，别名不重复占位（别名仍可被 tools/call 命中）。
  return TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * 执行一次 tools/call。
 * @param {string} rawName 客户端传来的工具名（可能是别名）
 * @param {object} args
 * @param {{agent:object, callRest:(method,path,body)=>Promise<object>}} ctx
 * @returns {Promise<{content:Array,isError?:boolean}>} 标准 MCP 工具结果
 */
async function callTool(rawName, args, ctx) {
  const tool = BY_NAME.get(rawName);
  if (!tool) return { content: [{ type: 'text', text: '未知工具: ' + rawName }], isError: true };
  args = args || {};

  // memory_audit_log：非 master 直接拒（不依赖 REST 的二次判定，给更清楚的提示）
  if (tool.name === 'memory_audit_log' && !(ctx.agent && ctx.agent.role === 'master')) {
    return { content: [{ type: 'text', text: '仅 master 可查看审计日志。' }], isError: true };
  }

  const spec = tool.rest(args);
  if (spec.error) return { content: [{ type: 'text', text: spec.error }], isError: true };

  let res;
  try { res = await ctx.callRest(spec.method, spec.path, spec.body); }
  catch (e) { return { content: [{ type: 'text', text: '调用失败: ' + e.message }], isError: true }; }

  return { content: [{ type: 'text', text: renderResult(tool, args, res) }] };
}

// ── 结果渲染（面向 AI 可读，不追求紧凑）──────────────
function renderResult(tool, args, r) {
  if (r && r.error) return (tool.name === 'memory_forget' ? '删除失败：' : '失败：')
    + r.error + (r.hint ? '（' + r.hint + '）' : '');

  switch (tool.name) {
    case 'memory_save': {
      if (r.deduped) {
        const m = r.memory || {};
        return '已合并到已有记忆（未新增）。\n  ID: ' + m.id + '\n  相似度: ' + r.similarity
          + '\n  字面重合: ' + r.lexical + '\n  摘要: ' + (m.summary || '');
      }
      if (!r.stored) return '已评估，未存储。\n  重要性: ' + r.importance + '\n  原因: '
        + (r.reason || '价值较低') + '\n  如需强制存储传 force=true。';
      const m = r.memory || {};
      return '已记住。\n  ID: ' + m.id + '\n  重要性: ' + m.importance
        + '\n  标签: ' + ((m.tags || []).join(', ') || '无') + '\n  摘要: ' + (m.summary || '');
    }
    case 'memory_recall':
      return 'ID: ' + r.id + '\n  重要性: ' + r.importance + '\n  标签: '
        + ((r.tags || []).join(', ') || '无') + '\n  访问: ' + (r.access_count || 0) + ' 次\n\n'
        + (r.content || '');
    case 'memory_search': {
      const rs = r.results || [];
      if (!rs.length) return '未找到与「' + (args.query || '') + '」相关的记忆。';
      return rs.map((m, i) => '[' + (i + 1) + '] ' + m.importance + ' | 相关度 '
        + (m._score != null ? m._score : '-') + ' | ' + (m.summary || '') + '\n    ID: ' + m.id
        + '\n    内容: ' + (m.content || '')).join('\n\n');
    }
    case 'memory_forget':
      return '已抹去记忆 ' + (args.id || '') + (args.reason ? '（原因：' + args.reason + '）' : '') + '。';
    case 'memory_graph_query': {
      const nodes = r.nodes || [], edges = r.edges || [];
      const byId = {}; nodes.forEach(n => { byId[n.id] = n; });
      const lines = edges.slice(0, 40).map(e => '  ' + ((byId[e.from] || {}).summary || e.from).slice(0, 24)
        + ' ↔ ' + ((byId[e.to] || {}).summary || e.to).slice(0, 24) + '（' + e.weight + '）');
      return (r.focus ? '记忆 ' + r.focus + ' 的关联邻域' : '记忆图谱：' + nodes.length + ' 节点 / ' + edges.length + ' 边')
        + '\n\n' + (lines.join('\n') || '  （无边）');
    }
    case 'memory_stats':
    case 'memory_scope_list': {
      const e = r.embedding || {};
      return '记忆库概况（' + ((r.agent && r.agent.name) || '当前 Agent') + '）\n'
        + '  总计: ' + r.total + ' 条 · 高/中/低: ' + r.high + '/' + r.medium + '/' + r.low + '\n'
        + '  已同步/待同步: ' + r.synced + '/' + r.unsynced + '\n'
        + '  向量: ' + (r.vectorized || 0) + ' 条已建' + (r.needs_embedding ? '（' + r.needs_embedding + ' 待回填）' : '')
        + ' · 模式 ' + (e.mode || '-') + (e.provider ? ' (' + e.provider + ')' : '') + '\n'
        + '  作用域: ' + (r.scope || '-');
    }
    case 'memory_health': {
      if (args.apply === true) {
        return '衰减已执行。降级 ' + r.downgraded + ' 条'
          + (r.failed ? '，失败 ' + r.failed + ' 条' : '') + '。另有 '
          + r.forget_eligible + ' 条遗忘候选（未删除，需逐条 forget）。';
      }
      return '衰减体检：扫描 ' + (r.scanned || 0) + ' 条，将降级 '
        + ((r.would_downgrade || []).length) + ' 条，遗忘候选 ' + ((r.would_forget || []).length)
        + ' 条。未写库，执行请传 apply=true。';
    }
    case 'memory_audit_log':
      return '近期审计事件 ' + ((r.events || []).length) + ' 条\n\n'
        + (r.events || []).slice(0, 40).map(ev => '  ' + ev.ts + ' [' + ev.actor + '] ' + ev.action
          + (ev.detail && Object.keys(ev.detail).length ? ' ' + JSON.stringify(ev.detail) : '')).join('\n')
        + '\n\n⚠️ ' + (r.warning || '审计为内存态，重启即失效。');
    default:
      return JSON.stringify(r);
  }
}

/**
 * 处理一条 JSON-RPC 消息，返回要回给客户端的对象（或 null 表示无需回复的通知）。
 * @param {object} msg JSON-RPC 请求
 * @param {object} ctx 同 callTool
 */
async function handleRpc(msg, ctx) {
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: (ctx.protocolVersion) || '2024-11-05',
        serverInfo: { name: 'moyi', version: ctx.version || '3.3.0' },
        capabilities: { tools: {} },
      } };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知不回包
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: listTools() } };
    case 'tools/call': {
      const p = msg.params || {};
      const result = await callTool(p.name, p.arguments || {}, ctx);
      return { jsonrpc: '2.0', id, result };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
  }
}

module.exports = { TOOLS, BY_NAME, listTools, callTool, handleRpc };
