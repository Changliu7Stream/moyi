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

const http = require('http');
const readline = require('readline');

// ── 配置 ──────────────────────────────────────────────

const MOYI_API = process.env.MOYI_API || 'http://127.0.0.1:3906';
const MOYI_KEY = process.env.MOYI_KEY || '';
const SERVER_NAME = 'moyi';
const SERVER_VERSION = '2.0.0';

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
    description: '搜索记忆。支持全文匹配和关键词分词。结果按相关性 + 重要性 + 时效性排序。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。',
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
];

// ── HTTP 请求 ──────────────────────────────────────────

function apiRequest(pathStr, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, MOYI_API);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
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
        catch { resolve({ raw: chunks }); }
      });
    });
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
      });
      const results = (res.results || []).slice(0, args.limit || 10);
      if (!results.length) {
        return {
          content: [{ type: 'text', text: '未找到与"' + args.query + '"相关的记忆。' }],
        };
      }
      const text = results.map((m, i) =>
        '[' + (i + 1) + '] ' + m.importance + ' | ' + m.summary + '\n    ID: ' + m.id + '\n    标签: ' + ((m.tags || []).join(', ') || '无') + '\n    时间: ' + m.created_at + '\n    内容: ' + m.content
      ).join('\n\n---\n\n');
      return {
        content: [{ type: 'text', text: '找到 ' + results.length + ' 条相关记忆：\n\n' + text }],
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
