# 墨忆

> 记忆如墨，落纸不褪。

AI 记忆中间层。基于 MCP 协议，让任何 AI 工具共享同一套记忆。

换工具，不丢记忆。

---

## 为什么需要

当前 AI 生态的困境：

- 模型提供商只卖 API，不提供记忆
- 每个工具各自为政，记忆不互通
- 用户被夹在中间，手动维护记忆文件
- 换一个工具，前尘尽忘

墨忆要解决的就是这件事——一个中立的、通用的记忆中间层。

---

## 架构

```
工具A ←─MCP──→ 墨忆记忆层（MCP Server）←─MCP──→ 工具B
                        │
                   ┌────┴────┐
                   │  本地缓存  │  快速响应、临时记忆
                   └────┬────┘
                        │ AI自主判断重要性
                   ┌────┴────┐
                   │  云端存储  │  持久记忆，跨工具共享
                   └─────────┘
```

**核心设计：AI 自主判断什么值得记住。**

不需要人工干预。AI 在对话中自主评估信息的重要性：
- 情感权重（强烈情感的信息更值得留存）
- 持续性（长期偏好、习惯）
- 独特性（罕见信息 vs 常识）
- 关联度（与已有记忆形成网络）
- 时效性（过期信息降权）

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js 内置模块 | 零依赖，纯净 |
| 存储 | JSON 文件（本地） | 可替换为 Supabase / SQLite |
| MCP Server | Node.js + stdio | 标准 MCP 协议 |
| 前端 | 纯 HTML/CSS/JS | 水墨风，零框架 |

---

## 快速开始

### 1. 启动后端服务

```bash
node server.js
```

服务运行在 `http://localhost:3906`

### 2. 打开管理界面

浏览器访问 `http://localhost:3906`

可以手动写入、搜索、管理记忆。

### 3. 接入 MCP（让 AI 工具使用记忆）

在支持 MCP 的工具中配置：

```json
{
  "mcpServers": {
    "moyi": {
      "command": "node",
      "args": ["/path/to/moyi/mcp-server.js"],
      "env": {
        "MOYI_API": "http://localhost:3906"
      }
    }
  }
}
```

支持 MCP 的工具包括：Claude Desktop、Cursor、Continue、以及任何兼容 MCP 协议的客户端。

---

## MCP 工具

| 工具 | 说明 |
|---|---|
| `store_memory` | 存储记忆，自动评估重要性 |
| `search_memory` | 语义搜索，按相关性排序 |
| `retrieve_memory` | 按 ID 精确获取 |
| `assess_importance` | 评估内容重要性（不存储） |
| `sync_to_cloud` | 批量同步重要记忆到云端 |

### 典型流程

```
对话中产生信息
    │
    ▼
assess_importance  ← AI先评估：值不值得记？
    │
    ├─ 不重要 → 忽略
    │
    ▼
store_memory       ← 值得记 → 存储
    │
    ▼
sync_to_cloud      ← 重要记忆 → 推送云端
    │
    ▼
其他工具 search_memory ← 需要时检索
```

---

## API

### REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memories` | 列表（支持 ?importance=&tag=&q=） |
| POST | `/api/memories` | 创建（自动评估重要性） |
| GET | `/api/memories/:id` | 获取单条（自增访问计数） |
| PATCH | `/api/memories/:id` | 更新 |
| DELETE | `/api/memories/:id` | 删除 |
| POST | `/api/memories/search` | 搜索 |
| POST | `/api/memories/assess` | 评估（不存储） |
| POST | `/api/memories/:id/sync` | 标记已同步 |
| POST | `/api/sync/batch` | 批量同步 |
| GET | `/api/stats` | 统计 |

### 记忆数据结构

```json
{
  "id": "mem_xxxxxxxxxxxxxxxx",
  "content": "完整记忆内容",
  "summary": "自动生成的摘要",
  "importance": "high",
  "tags": ["偏好", "技术"],
  "source": "claude-desktop",
  "createdAt": "2026-09-11T01:00:00.000Z",
  "updatedAt": "2026-09-11T01:00:00.000Z",
  "syncedToCloud": false,
  "syncedAt": null,
  "accessCount": 0
}
```

---

## 重要性评估逻辑

| 维度 | 权重 | 说明 |
|---|---|---|
| 情感权重 | +15/词 | 喜欢、讨厌、爱、恨、重要、永远 |
| 持续性 | +12/词 | 偏好、习惯、总是、从不、原则 |
| 身份信息 | +25/词 | 我叫、我是、生日、电话、邮箱 |
| 关联度 | +8/词 | 与已有记忆有共同标签 |
| 长度 | +/- | 太短降权，有深度加分 |
| 时效性 | -5/词 | 今天、刚刚、临时、马上 |

**分级标准：**
- score >= 35 → `high`（重要，建议同步云端）
- score >= 15 → `medium`（常态，视情况同步）
- score < 15 → `low`（轻微，仅本地缓存）

---

## 后续路线

- [ ] 接入 Supabase 云端存储
- [ ] 向量检索（替换关键词搜索）
- [ ] 多用户身份识别
- [ ] 记忆衰减与遗忘机制
- [ ] 记忆图谱（关联可视化）

---

## 设计理念

> 书里写尽了万般术法，可从没有一本教过"如何记住一个人"。

墨忆的核心理念：

1. **记忆属于人，不属于工具** — 记忆存在中立层，工具只是入口
2. **AI 自主判断** — 不需要人工干预，AI 自己决定什么值得记
3. **本地缓存 + 云端持久** — 快速响应与跨工具共享兼得
4. **开放协议** — MCP 标准，任何工具都能接入，不锁定生态

---

*墨忆 by 画青霜 · 万界藏书阁*
