/**
 * 墨忆 — MCP Server
 * 让任何支持 MCP 的 AI 工具接入记忆层
 *
 * 协议：MCP (Model Context Protocol) over stdio
 * 传输：JSON-RPC 2.0
 *
 * 提供 5 个工具：
 *   1. store_memory      — 存储记忆（自动评估重要性）
 *   2. retrieve_memory   — 按 ID 精确获取
 *   3. search_memory     — 语义搜索记忆
 *   4. assess_importance  — 评估内容重要性（不存储）
 *   5. sync_to_cloud      — 批量同步重要记忆到云端
 *
 * 用法：
 *   node mcp-server.js
 *   默认连接 http://localhost:3906
 *
 * MCP 客户端配置示例（Claude Desktop / Cursor 等）：
 *   {
 *     "mcpServers": {
 *       "moyi": {
 *         "command": "node",
 *         "args": ["/path/to/moyi/mcp-server.js"],
 *         "env": { "MOYI_API": "http://localhost:3906" }
 *       }
 *     }
 *   }
 */

const readline = require('readline');
const { request: httpRequest } = require('http');
const { request: httpsRequest } = require('https');

// ── 配置 ──────────────────────────────────────────────

const MOYI_API = process.env.MOYI_API || 'http://127.0.0.1:3906';
const MOYI_KEY = process.env.MOYI_KEY || '';
const SERVER_NAME = 'moyi';
const SERVER_VERSION = '3.3.0';

if (!MOYI_KEY) {
  process.stderr.write('[moyi] WARNING: MOYI_KEY 未设置，所有请求将被拒绝。\n');
  process.stderr.write('[moyi] 请在前端注册 Agent 后，将获得的 API Key 设为环境变量 MOYI_KEY。\n');
}

// ── 工具定义 ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'remember',
    description: '记住一件事（推荐）。AI 自主评估重要性，重要/常态的自动存储，价值低的不存储。一步完成，无需先 assess 再 store。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '要记住的内容。',
        },
        source: {
          type: 'string',
          description: '记忆来源（工具/对话/场景）。默认 "mcp"。',
          default: 'mcp',
        },
        force: {
          type: 'boolean',
          description: '即使评估为 low 也强制存储。默认 false。',
          default: false,
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'store_memory',
    description: '存储一条记忆。AI 自主判断重要性，无需人工干预。重要记忆会自动标记待同步。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '记忆内容。尽量完整，包含上下文。',
        },
        source: {
          type: 'string',
          description: '记忆来源（哪个工具/对话/场景）。默认 "mcp"。',
          default: 'mcp',
        },
        importance: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: '可手动指定重要性。不指定则由系统自动评估。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '自定义标签。不指定则自动提取。',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description: '搜索记忆（向量语义 + 关键词混合检索）。换个说法也能搜到。结果按 语义相关度×重要性×时效性 排序，返回带 _score 的融合分。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或一句自然语言描述。',
        },
        limit: {
          type: 'number',
          description: '返回条数上限。默认 10。',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'retrieve_memory',
    description: '按 ID 精确获取单条记忆。适用于已知记忆 ID 的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '记忆 ID（mem_ 开头）。',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'assess_importance',
    description: '评估给定内容的重要性，返回重要等级、自动提取的标签和摘要。不存储，仅评估。帮助 AI 判断是否值得存储。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '要评估的内容。',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'sync_to_cloud',
    description: '批量同步重要记忆（high 和 medium）到云端。同步后标记为已同步，跨工具可见。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'forget',
    description: '删除一条记忆。用于用户明确要求「忘掉这件事」，或发现记忆是错的、过时的。删除不可恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要删除的记忆 ID（mem_ 开头）。可先用 search_memory 定位。',
        },
        reason: {
          type: 'string',
          description: '删除原因，仅用于回执确认，不会写入存储。',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_stats',
    description: '查看当前记忆库概况：总数、按重要性分布、同步状态、向量覆盖情况。适合在会话开始时了解已有记忆规模。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_health',
    description: '记忆衰减体检：查看哪些记忆因长期未被访问而面临降级、哪些是遗忘候选。默认只看不动（不写库）。用于回答「我是不是该忘掉些什么」这类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          description: 'true = 真的执行降级（不可撤销，但只降一级且永不删除、high 不参与）。默认 false 仅预览。',
          default: false,
        },
      },
    },
  },
  {
    name: 'memory_graph',
    description: '取记忆关联图谱（节点=记忆，边=共享标签或共享事实锚点）。用于回答「这件事和哪些有关联」，也可用 focus 只看某条记忆的邻域。',
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: '可选。以某条记忆 ID 为中心，只返回它的邻域子图。',
        },
        limit: {
          type: 'number',
          description: '参与构图的记忆条数上限，默认 200。',
          default: 200,
        },
        min_weight: {
          type: 'number',
          description: '连边阈值 0~1，越大越严格。默认 0.5。',
        },
      },
    },
  },
];

// ── HTTP 请求 ──────────────────────────────────────────

function apiRequest(pathStr, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, MOYI_API);
    const data = body ? JSON.stringify(body) : null;
    // MOYI_API 可能是 http（本地）也可能是 https（Vercel 线上），
    // 早先写死 http.request，指向线上地址时会静默连不上。
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = doRequest(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        'X-Moyi-Key': MOYI_KEY,
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks, _status: res.statusCode }); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时（30s）')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── 工具执行 ──────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {

    case 'remember': {
      const res = await apiRequest('/api/memories/remember', 'POST', {
        content: args.content,
        source: args.source || 'mcp',
        force: args.force || false,
      });
      if (res.error) {
        return { content: [{ type: 'text', text: '存储失败: ' + (res.error || '未知错误') }], isError: true };
      }
      // 命中去重：不是「没记住」，而是「合并进已有记忆」，必须区别报告
      if (res.deduped) {
        const m = res.memory || {};
        return {
          content: [{
            type: 'text',
            text: '已合并到已有记忆（未新增）。\n  ID: ' + m.id + '\n  相似度: ' + res.similarity
              + '\n  字面重合: ' + res.lexical + '\n  重要性: ' + m.importance
              + '\n  摘要: ' + (m.summary || '') + '\n  说明: ' + (res.reason || ''),
          }],
        };
      }
      if (!res.stored) {
        return {
          content: [{ type: 'text', text: '已评估，未存储。\n  重要性: ' + res.importance + '\n  摘要: ' + (res.summary || '') + '\n  原因: ' + (res.reason || '价值较低') + '\n  如需强制存储，传 force=true 重试。' }],
        };
      }
      const m = res.memory;
      return {
        content: [{
          type: 'text',
          text: '已记住。\n  ID: ' + m.id + '\n  重要性: ' + m.importance + '\n  标签: ' + ((m.tags || []).join(', ') || '无') + '\n  摘要: ' + m.summary + '\n  同步: ' + (m.synced ? '已同步云端' : '待同步'),
        }],
      };
    }

    case 'store_memory': {
      const res = await apiRequest('/api/memories', 'POST', {
        content: args.content,
        source: args.source || 'mcp',
        importance: args.importance,
        tags: args.tags,
      });
      if (res.error) {
        return { content: [{ type: 'text', text: '存储失败: ' + res.error }], isError: true };
      }
      return {
        content: [{
          type: 'text',
          text: '记忆已存储。\n  ID: ' + res.id + '\n  重要性: ' + res.importance + '\n  标签: ' + ((res.tags || []).join(', ') || '无') + '\n  摘要: ' + res.summary + '\n  同步状态: ' + (res.synced ? '已同步' : '待同步'),
        }],
      };
    }

    case 'search_memory': {
      const res = await apiRequest('/api/memories/search', 'POST', {
        query: args.query,
        limit: args.limit || 10,
      });
      if (res.error) {
        return { content: [{ type: 'text', text: '搜索失败: ' + res.error }], isError: true };
      }
      const results = (res.results || []).slice(0, args.limit || 10);
      if (!results.length) {
        return {
          content: [{ type: 'text', text: '未找到与"' + args.query + '"相关的记忆。' }],
        };
      }
      const text = results.map((m, i) =>
        '[' + (i + 1) + '] ' + m.importance + ' | 相关度 ' + (m._score != null ? m._score : '-') + ' | ' + m.summary
        + '\n    ID: ' + m.id + '\n    标签: ' + ((m.tags || []).join(', ') || '无')
        + '\n    时间: ' + m.created_at + '\n    内容: ' + m.content
      ).join('\n\n---\n\n');
      const meta = '\n\n（检索模式: ' + (res.mode || '-') + '，扫描 ' + (res.scanned || 0)
        + ' 条，已向量化 ' + (res.vectorized || 0) + ' 条）';
      return {
        content: [{ type: 'text', text: '找到 ' + results.length + ' 条相关记忆：\n\n' + text + meta }],
      };
    }

    case 'retrieve_memory': {
      const res = await apiRequest('/api/memories/' + args.id, 'GET');
      if (res.error) {
        return {
          content: [{ type: 'text', text: '获取失败: ' + res.error }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: 'ID: ' + res.id + '\n重要性: ' + res.importance + '\n标签: ' + ((res.tags || []).join(', ') || '无') + '\n来源: ' + (res.source || '未知') + '\n时间: ' + (res.created_at || '未知') + '\n同步: ' + (res.synced ? '是' : '否') + '\n访问: ' + (res.access_count || 0) + ' 次\n\n' + res.content,
        }],
      };
    }

    case 'assess_importance': {
      const res = await apiRequest('/api/memories/assess', 'POST', {
        content: args.content,
      });
      const suggestion = res.importance === 'high'
        ? '值得长期保存，建议存储。'
        : res.importance === 'medium'
        ? '有一定价值，可视情况存储。'
        : '价值较低，可不存储。';
      return {
        content: [{
          type: 'text',
          text: '评估结果：\n  重要性: ' + res.importance + '\n  标签: ' + ((res.tags || []).join(', ') || '无') + '\n  摘要: ' + res.summary + '\n\n建议：' + suggestion,
        }],
      };
    }

    case 'sync_to_cloud': {
      const res = await apiRequest('/api/sync/batch', 'POST');
      return {
        content: [{
          type: 'text',
          text: '同步完成。已推送 ' + res.synced + ' 条记忆至云端。' + (res.synced ? '这些记忆现在跨工具可见。' : '没有待同步的重要记忆。'),
        }],
      };
    }

    case 'forget': {
      const id = String(args.id || '');
      // 只接受形如 mem_xxx 的 ID，避免把任意字符串拼进查询路径
      if (!/^mem_[\w-]{4,64}$/.test(id)) {
        return { content: [{ type: 'text', text: '记忆 ID 格式不合法（应以 mem_ 开头）。可先用 search_memory 定位。' }], isError: true };
      }
      const res = await apiRequest('/api/memories/' + id, 'DELETE');
      if (res.deleted) {
        return { content: [{ type: 'text', text: '已抹去记忆 ' + id + (args.reason ? '（原因：' + args.reason + '）' : '') + '。' }] };
      }
      return { content: [{ type: 'text', text: '删除失败：' + (res.error || '该记忆可能不存在或不属于当前 Agent。') }], isError: true };
    }

    case 'memory_stats': {
      const res = await apiRequest('/api/stats', 'GET');
      if (res.error) return { content: [{ type: 'text', text: '读取失败: ' + res.error }], isError: true };
      const e = res.embedding || {};
      return {
        content: [{
          type: 'text',
          text: '记忆库概况（' + ((res.agent && res.agent.name) || '当前 Agent') + '）\n'
            + '  总计: ' + res.total + ' 条\n'
            + '  重要 / 常态 / 轻微: ' + res.high + ' / ' + res.medium + ' / ' + res.low + '\n'
            + '  已同步 / 待同步: ' + res.synced + ' / ' + res.unsynced + '\n'
            + '  已向量化: ' + (res.vectorized || 0) + ' 条' + (res.needs_embedding ? '（' + res.needs_embedding + ' 条待回填）' : '') + '\n'
            + '  向量模式: ' + (e.mode || '-') + (e.provider ? ' (' + e.provider + ')' : ' （本地特征哈希，建议接入 embedding provider 提升语义召回')
            + '\n  标签: ' + ((res.allTags || []).slice(0, 20).join(', ') || '无'),
        }],
      };
    }

    case 'memory_health': {
      if (args.apply === true) {
        const res = await apiRequest('/api/decay/apply', 'POST', { confirm: true });
        if (res.error) return { content: [{ type: 'text', text: '执行失败：' + res.error }], isError: true };
        if (res.applied !== true) {
          return { content: [{ type: 'text', text: '未执行：' + (res.hint || '服务端拒绝') }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: '衰减已执行。降级 ' + res.downgraded + ' 条'
              + (res.failed ? '，失败 ' + res.failed + ' 条' : '')
              + '。另有 ' + res.forget_eligible + ' 条遗忘候选——未删除，'
              + '需要你逐条确认后用 forget 处理。',
          }],
        };
      }
      const res = await apiRequest('/api/decay/preview', 'GET');
      if (res.error) return { content: [{ type: 'text', text: '读取失败: ' + res.error }], isError: true };
      const dg = res.would_downgrade || [];
      const fg = res.would_forget || [];
      const line = m => '  ' + m.id + ' [' + m.importance + '] ' + m.age_days + ' 天未动 · 访问 '
        + m.access_count + ' 次 · 活力 ' + m.vitality + ' — ' + (m.summary || '').slice(0, 40);
      return {
        content: [{
          type: 'text',
          text: '衰减体检（半衰期 ' + res.half_life_days + ' 天，遗忘窗口 ' + res.forget_after_days + ' 天）\n'
            + '  扫描 ' + res.scanned + ' 条：稳定 ' + res.keep + ' 条，钉住 ' + res.pinned + ' 条\n\n'
            + '面临降级（' + dg.length + ' 条，仅 medium→low，high 永不自动降级）：\n'
            + (dg.slice(0, 15).map(line).join('\n') || '  无') + '\n\n'
            + '遗忘候选（' + fg.length + ' 条，仅 low 且长期无人访问；本接口不删除任何东西）：\n'
            + (fg.slice(0, 15).map(line).join('\n') || '  无')
            + (dg.length > 15 || fg.length > 15 ? '\n\n（各列表仅显示前 15 条）' : '')
            + '\n\n未写库。要真正执行降级请再调用一次并传 apply=true。',
        }],
      };
    }

    case 'memory_graph': {
      let q = '/api/graph?limit=' + (args.limit || 200);
      if (args.focus) q += '&focus=' + encodeURIComponent(args.focus);
      if (args.min_weight != null) q += '&min_weight=' + args.min_weight;
      const res = await apiRequest(q, 'GET');
      if (res.error) return { content: [{ type: 'text', text: '构图失败: ' + res.error }], isError: true };
      const byId = {};
      (res.nodes || []).forEach(n => { byId[n.id] = n; });
      const edges = (res.edges || []).map(e =>
        '  ' + ((byId[e.from] || {}).summary || e.from).slice(0, 24) + ' ↔ '
        + ((byId[e.to] || {}).summary || e.to).slice(0, 24)
        + '（' + e.weight + '，共有 ' + (e.via || []).join('/') + '）');
      const orphans = (res.nodes || []).filter(n => !n.degree);
      const head = res.focus
        ? '记忆 ' + res.focus + ' 的关联邻域'
        : '记忆图谱：' + (res.nodes || []).length + ' 节点 / ' + (res.edges || []).length + ' 边'
          + (res.stats ? '，密度 ' + res.stats.density : '');
      return {
        content: [{
          type: 'text',
          text: head + '\n\n' + (edges.join('\n') || '  （无边：共享标签太少或阈值太高）')
            + (orphans.length ? '\n\n未连属者（' + orphans.length + ' 条，与其余记忆无共享标签/事实）：\n'
              + orphans.slice(0, 10).map(n => '  ' + n.id + ' — ' + (n.summary || '').slice(0, 40)).join('\n') : ''),
        }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: '未知工具: ' + name }],
        isError: true,
      };
  }
}

// ── MCP 协议处理 ──────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  try {
    switch (method) {

      case 'initialize': {
        send({
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
            capabilities: {
              tools: {},
            },
          },
        });
        break;
      }

      case 'notifications/initialized': {
        break;
      }

      case 'tools/list': {
        send({
          jsonrpc: '2.0',
          id: id,
          result: { tools: TOOLS },
        });
        break;
      }

      case 'tools/call': {
        var name = params.name;
        var args = params.arguments || {};
        var result = await executeTool(name, args);
        send({
          jsonrpc: '2.0',
          id: id,
          result: result,
        });
        break;
      }

      case 'resources/list': {
        send({
          jsonrpc: '2.0',
          id: id,
          result: { resources: [] },
        });
        break;
      }

      case 'prompts/list': {
        send({
          jsonrpc: '2.0',
          id: id,
          result: { prompts: [] },
        });
        break;
      }

      default:
        send({
          jsonrpc: '2.0',
          id: id,
          error: { code: -32601, message: 'Method not found: ' + method },
        });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: id,
      error: { code: -32603, message: err.message },
    });
  }
}

// ── 启动 ──────────────────────────────────────────────

process.stderr.write('[moyi] MCP Server starting...\n');
process.stderr.write('[moyi] API: ' + MOYI_API + '\n');
process.stderr.write('[moyi] Tools: ' + TOOLS.map(function(t){return t.name;}).join(', ') + '\n');
process.stderr.write('[moyi] Ready. Waiting for MCP client...\n');

rl.on('line', function(line) {
  if (!line.trim()) return;
  try {
    var msg = JSON.parse(line);
    handleMessage(msg);
  } catch (e) {
    process.stderr.write('[moyi] Parse error: ' + e.message + '\n');
  }
});

rl.on('close', function() {
  process.stderr.write('[moyi] Connection closed.\n');
  process.exit(0);
});
