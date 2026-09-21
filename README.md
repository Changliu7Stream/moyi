# 墨忆

> 记忆如墨，落纸不褪。

AI 记忆中间层。基于 MCP 协议，让任何 AI 工具共享同一套记忆。

换工具，不丢记忆。换存储后端（Supabase ↔ 自托管 Postgres），也不用改代码。

详细文档在 [`docs/`](./docs/)（源码目录，16 页）——新手「部署前必看」、部署、环境变量逐条解释与必须性分档、环境自动识别的判定规则、
数据库与环境支持、接口清单、数据库结构、安全机制，以及一页「对照：网站账号体系」。**已开 GitHub Pages 的话**，
同一套内容在线：<https://changliu7stream.github.io/moyi/>。

开启方法（一次性，仓库 → Settings → Pages）：**Source** 选 `Deploy from a branch`，
**Branch** 选 `main`，**Folder** 选 `/docs`，Save。约 10 秒后顶部出现站点地址。

> 完整说明（为什么只能选 `/docs`、`.nojekyll` 的作用、链接必须相对路径、用 REST API 开启、
> 构建状态怎么查、故障排查顺序）见文档站自己的那一页：
> [`docs/pages.html`](./docs/pages.html)。

两条最容易踩的：选 `/（root）` 会把整个代码仓库发布成公开站点；Pages 只在**推送到 `main`**
后才构建，本地 commit 不会触发。

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
                        ▼
            PostgREST 协议（唯一的存储接口层）
             ┌──────────┴──────────┐
     Supabase（托管）        自托管 Postgres
             │              + pgvector + PostgREST
             └────────┬────────────┘
        Agent 账本（同一套 REST，凭 API Key）
        管理台（/api/console/*，凭口令 + 会话 Cookie）
```

**核心设计：AI 自主判断什么值得记住。**

不需要人工干预。AI 在对话中自主评估信息的重要性，并做语义去重——
同一条信息换个说法再记一次时，合并而不是堆重复条目。

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 后端 | Node.js 内置模块 | 零运行时依赖 |
| 存储 | PostgREST 协议：Supabase（托管）**或** 自托管 Postgres | `MOYI_DB_BACKEND` 切换，代码不改 |
| 向量 | pgvector `vector(384)` + HNSW | 语义检索与去重 |
| Embedding | 可插拔 provider，缺省本地特征哈希 | 见「向量检索」 |
| MCP Server | Node.js + stdio | 标准 MCP 协议，http/https 均可 |
| 前端 | 纯 HTML/CSS/JS | 水墨风，零框架，含力导向记忆图谱 |
| 部署 | Docker Compose / Vercel Serverless / Cloudflare Workers·Pages / 直接 `node` | `api/index.js` 为 Serverless 入口；`cloudflare/worker.js` 为 CF 入口（**仅付费版**，见下） |

---

## ⚠️ 上手前必读：安全

本项目**必须**配置存储与口令环境变量才能启动，仓库里不再内置任何可用默认值：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `MOYI_DB_URL` | ✅ | PostgREST 基址。Supabase 填项目地址，自托管填 `http://<host>:3000` |
| `MOYI_DB_TOKEN` | ✅ | 访问令牌。**Supabase 用 service_role key**，仅存在于服务端 |
| `MOYI_CODE` | 首次建议 | 设置后才能注册出 master；不设则无人能成为 master |

`SUPABASE_URL` / `SUPABASE_KEY` / `MASTER_CODE` 是等价旧名，仍然可用；
`MOYI_DB_BACKEND=supabase` 可强制走 Supabase 网关（缺省按地址自动识别，见「存储后端」）。

数据库侧的安全边界**取决于你选哪种后端**，两条路不一样：

- **Supabase**：必须开启 RLS，否则任何拿到 anon key 的人可直连读改全库，墨忆的
  agent 隔离将被完全绕过。`sql/vector-search.sql` 已做这件事。
- **自托管 PostgREST**：`sql/00-schema.sql` **刻意不开 RLS**——本栈的隔离在服务层，
  代价是 PostgREST 一旦落到公网等于全库公开。`docker-compose.yml` 因此只把它绑到
  `127.0.0.1:3001`。这里开 RLS 反而会让所有读请求静默返回 0 行。

迁移 SQL、验证方法、以及**不会把线上打挂的操作顺序**见
[SECURITY-MIGRATION.md](./SECURITY-MIGRATION.md)。

> 如果你是从 v3.0 升级的：请先换成 service_role key 再执行迁移 SQL，
> 反序会让服务瞬间全场 401。

---

## 快速开始

### 路径 A · Docker（推荐，含自托管数据库）

一条命令起完整栈（Postgres + pgvector + PostgREST + 墨忆），不依赖任何云服务：

```bash
cp .env.example .env            # 至少填 MOYI_PG_PASSWORD / MOYI_CODE
docker compose --profile local up -d --build
```

打开 `http://localhost:3906/console` 走完引导安装（立第一位管理员，一次性），
之后在面板里创建 Agent 即得 API Key。数据库表结构由镜像初始化脚本
自动建（仅首次创建数据卷时执行）。

只想跑墨忆、数据库用外部 Supabase：

```bash
mkdir -p data/moyi-env && $EDITOR data/moyi-env/moyi.env   # MOYI_DB_BACKEND=supabase + 三项
docker compose --profile cloud up -d --build
```

两个 profile 互斥（都要占 3906，同时开会直接报错而不是静默二选一）。
宿主机端口用 `MOYI_HOST_PORT` 改。凭据通过只读目录挂载注入，不进镜像、不进 compose 文件；
容器以非 root 运行、根文件系统只读、`no-new-privileges`。

<details><summary>容器内环境变量从哪来</summary>

入口脚本按「先设者优先」读取：已存在的进程环境变量 > `/data/moyi-env/*.env` 文件。
解析方式是逐行 `export "${key}=${value}"`，不 `eval`、不 `source`，
所以文件名/值里的 shell 元字符不会被执行。缺关键凭据时启动日志会列出缺哪几项并给出该填什么，
服务仍会起来，但所有 API 调用返回带提示的 500（而不是带着空凭据去打数据库刷一堆 500 噪音）。

</details>

### 路径 B · 直接跑 Node

#### 1. 配置

```bash
cp .env.example .env.local     # 填入 MOYI_DB_URL / MOYI_DB_TOKEN / MOYI_CODE
```

#### 2. 初始化数据库

- **Supabase**：后台 → SQL Editor → **按顺序执行两份**：先 `sql/00-schema.sql`（建八张表），
  再 `sql/vector-search.sql`（开 RLS + 建 RPC）。只跑后者会报
  `relation "public.agents" does not exist`——那份脚本不建 `agents` / `memories`，
  它是给表已存在的旧库做升级用的。
- **自托管**：`psql -d moyi -f sql/00-schema.sql` 再 `psql -d moyi -f docker/init/10-roles.sql`
  （用 Docker 的话这步自动完成）。

#### 3. 启动服务

```bash
node server.js
```

运行在 `http://localhost:3906`（缺配置时启动日志会直接告诉你缺哪一项）。

#### 4. 打开管理界面

浏览器访问 `http://localhost:3906/console`，第一次会看到**引导安装页**：
填实例名、管理员用户名与口令，勾不勾选「开放自助注册」，确认后即进入管理面板。
这一步只出现一次——落库后引导页永久封存（见「管理台与引导安装」）。

在面板里创建 Agent 即得 API Key。`http://localhost:3906` 仍是 Agent 侧的账本页，
自助注册时带上 `MOYI_CODE` 的成为「掌柜」，可管理其他 Agent。

#### 5. 接入 MCP（让 AI 工具使用记忆）

在支持 MCP 的工具中配置：

```json
{
  "mcpServers": {
    "moyi": {
      "command": "node",
      "args": ["/absolute/path/to/moyi/mcp-server.js"],
      "env": {
        "MOYI_API": "http://localhost:3906",
        "MOYI_KEY": "moyi_xxxxxxxx"
      }
    }
  }
}
```

`MOYI_API` 指向线上 https 地址同样可用。

客户端支持远程 HTTP 时，可以完全不装 Node、不起 stdio 进程——管理台创建 Agent 后给出的另一段配置直连 `/api/mcp`：

```json
{
  "mcpServers": {
    "moyi": {
      "url": "https://your-host/api/mcp",
      "headers": { "Authorization": "Bearer moyi_xxxxxxxx" }
    }
  }
}
```

两段配置是并列可选项，也可以同时挂上。再进一步，设置 `MOYI_OAUTH_CLIENT_ID`（并按需配 `MOYI_OAUTH_REDIRECT_WHITELIST`）即可开启**浏览器授权**：MCP 客户端自己拉起浏览器、走授权码 + PKCE，你在已登录的管理台点「同意」，它拿到的是一把专属 `moat_` token，不必复制粘贴密钥。撤销方式就是管理台删掉那个自动创建的 `oauth:<client_id>` Agent。详见 `docs/agents.html#oauth`。

---

## 存储后端

墨忆只依赖 **PostgREST 协议**，不依赖任何厂商 SDK。表结构、`match_memories` /
`increment_access` 两个 RPC 在两种后端里名字一致，因此换后端不改代码：

| | Supabase（托管） | 自托管 Postgres + PostgREST |
| --- | --- | --- |
| 建表 SQL | `sql/00-schema.sql` → 再 `sql/vector-search.sql` | `sql/00-schema.sql` + `docker/init/10-roles.sql` |
| 鉴权头 | 额外带 `apikey` | 只带 `Authorization: Bearer <JWT>` |
| 路径前缀 | 自动补 `/rest/v1` | 不补 |
| RLS | 开启，anon 默认全拒 | **刻意关闭**（隔离在服务层，见下） |
| 运维 | 无需管数据库 | 自己备份、自己升级 |

变量名两套等价：`MOYI_DB_URL`/`MOYI_DB_TOKEN`（推荐）与 `SUPABASE_URL`/`SUPABASE_KEY`（旧名）。
基址以 `https://<project>.supabase.co` 或 `.supabase.in` 结尾时自动识别为 Supabase 并补
`/rest/v1`；已带 `/rest/v1` 的地址不会重复拼接；`MOYI_DB_BACKEND` 可强制指定，
`MOYI_DB_PREFIX` 可手工覆盖前缀。`resolveRest()` 这三种情形都有单测。

**为什么自托管不开 RLS**：本栈里 PostgREST 只以一个 `web_anon` 身份运行，一旦开 RLS
而没写面向它的策略，每条查询会静默返回 0 行——不是报错，是「记忆凭空消失」。
所以角色权限改由 `docker/init/10-roles.sql` 收紧（只授 `agents`/`memories` 的 DML 与两个
RPC 的 EXECUTE，`REVOKE CREATE ON SCHEMA public`），并在文件里显式写了「本栈数据对所有
能连到 PostgREST 的客户端可见，切勿把它暴露到公网」。compose 里 PostgREST 只绑
`127.0.0.1:3001`，正是配合这一点。要往公网走，请打开 `PGRST_JWT_SECRET` 并用
`node scripts/gen-jwt.js` 签发 token（零依赖 HS256，脚本自带解码自检）。

---

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| remember | **推荐**。自主评估重要性 → 语义去重 → 存储，一步完成 |
| search_memory | 向量语义 + 关键词混合检索，按相关性×重要性×新鲜度排序 |
| store_memory | 显式存储（可指定 importance / tags） |
| retrieve_memory | 按 ID 精确获取 |
| assess_importance | 只评估不存储 |
| sync_to_cloud | 批量标记重要记忆为已同步 |
| forget | 删除一条记忆（用户要求「忘掉」或记忆过时时用） |
| memory_stats | 记忆库概况：分布、同步状态、向量覆盖率 |
| memory_health | 衰减体检：哪些记忆正在褪色、会被降到哪级（默认只预览不写库） |
| memory_graph | 关联图谱：某条记忆的邻居、或全库拓扑概况（含孤立节点） |

### 技能层（Skill Registry）

除记忆外，墨忆还有一层**公共只读的技能**：一份 SKILL.md 风格的 Markdown，
所有 Agent 共享，与各自独立的记忆分属两张表、两个资源命名空间。Agent 凭自己那把
Key 就能读到 `published` 的全部技能，也能把自己摸索出的操作手册提交成**草稿**
（`skill_propose`）。草稿只有它自己看得到，必须由人在管理台点「发布」才进入公共层。

| 工具 | 说明 |
| --- | --- |
| skill_list | 列出可读技能：公共层已发布的全部，外加你自己仍是草稿的那些 |
| skill_read | 按名称读取一份技能的完整 Markdown 正文 |
| skill_propose | 提交一份操作手册为**草稿**（`status`/`origin` 服务端赋值，客户端传值一律忽略）|

技能同时以 MCP **resources** 暴露（`moyi-skill://<name>`）：支持 resources 的客户端
能直接列出并读取，无需走工具。管理台「按 URL 导入」可粘贴一个 `.md` 直链自动抓取、
推断名称与描述——抓取主机受 `MOYI_SKILL_URL_HOSTS` 域名白名单约束（默认仅 GitHub 原始内容域）。
详见 `docs/skills.html`。

### 典型流程

```
对话中产生信息
    │
    ▼
remember ──┬─ 评估为 low → 不存储（可 force 覆盖）
           ├─ 与已有记忆语义重复 → 合并到旧条目，不新增
           └─ 新信息 → 存库 + 生成向量
    │
    ▼
其他工具 search_memory ← 需要时按语义检索
    │
    ▼
forget ← 用户明确要求遗忘，或事实已变更
```

---

## 向量检索

### 两种模式

| 模式 | 触发条件 | 能力 |
| --- | --- | --- |
| 本地特征哈希 | 默认，无需任何配置 | 零依赖、离线可用、稳定；中文按「字+二元组」切分。**语义能力有限**，近义词召回明显弱于真实模型 |
| Embedding provider | 设置 `MOYI_EMBED_URL` + `MOYI_EMBED_KEY` | 真实语义向量，「换个说法也能搜到」 |

支持任何 OpenAI 兼容的 `/v1/embeddings` 接口（OpenAI、硅基流动、本地 Ollama 等）。
**维度必须为 384**，与数据库 `vector(384)` 列对齐；provider 返回其他维度时会被拒绝。

> 说清楚一点：本地模式下「语义检索」名不副实。实测本地哈希向量的区分度不足——
> 「把生日从 3 月 8 日改成 5 月 8 日」的余弦相似度（0.97）竟高于
> 「同一句话调整语序」（0.91）。所以去重不依赖向量单独决策，
> 见下。要真正获得语义能力，请接 provider。

### 混合打分

```
最终分 = 0.7 × 语义分 + 0.3 × 字面分 × 衰减因子
```

字面分沿用关键词逻辑（短语命中、标签命中、重要性加权），保证专有名词和代码关键词的
精确召回不被语义分淹没。返回结果带 `_score`/`_semantic`/`_decay`/`_vitality`。

> v3.1 的字面分里另有一层「30/90 天时效扣分」，v3.2 已移除：时效统一由下面的
> 衰减因子负责，两处各扣一次会让老记忆被惩罚两遍。

### 语义去重（三重护栏）

记忆系统最坏的不是漏合并，而是**错合并**——那会把用户的事实记岔。
因此 `remember` 需同时满足三条才合并：

1. **事实不冲突**：数字串、英文词等锚点必须一致（生日、版本号、端口一改就判新）
2. **字面重合度**达标
3. **向量相似度**达标

判据由 `test/dedupe-calibration.js` 用 10 个正反例锁死，改阈值会被测试拦下。

### 回填与迁移

- 新记忆自动向量化；**历史记忆需回填一次**：`POST /api/admin/backfill-embeddings`（master）
- 换了 provider 或模型后**必须重新回填**：不同模型的向量不在同一空间，混用会让排序失效
- 覆盖率查询：`GET /api/embeddings/status`

### 检索下推到数据库（可选，默认关闭）

缺省实现是「服务层暴力扫描」：取最近 N 条到内存，逐条算相似度。规模一大就是瓶颈。
设 `MOYI_DB_SEARCH=1` 后改为调用 `match_memories` RPC，由 Postgres 用 HNSW 索引做近邻检索：

```
MOYI_DB_SEARCH=1
```

| | `scan`（缺省） | `pgvector`（下推） |
| --- | --- | --- |
| 谁算相似度 | 服务层 JS | Postgres `<=>` + HNSW |
| 覆盖范围 | 扫描窗口内全部记忆 | **仅已有向量的记忆** |
| 响应 `search_backend` | `scan` | `pgvector` |

两处细节决定了它没有取代缺省路径：

1. **未向量化的记忆不能凭空消失**。下推结果会再补一次 `embedding IS NULL` 的取数并合并，
   否则回填没做完时旧记忆会静默不可见。
2. **两种路径的分数量纲不同**。PG 的余弦相似度是 `-1..1`，直接混进 0.7 权重会让排序失真，
   因此下推结果统一按 `(sim+1)/2` 归一到 `0..1` 再进融合公式。

RPC 调用失败（列不存在、扩展没装、权限不足）时**自动回退扫描**并在响应里如实标注
`search_backend: "scan"`，不会让检索整体挂掉。上生产前建议：先回填到覆盖率 100%，
再打开这个开关，并对比 `search_backend` 与 `vectorized` 两个字段确认走的是哪条路。

---

## 记忆衰减与遗忘

长期不被访问的记忆应当褪色，但**自动删除用户记忆是不可逆的高风险操作**，所以这一版
只做「降权 + 降级候选」，不做删除。

```
vitality = max( raw衰减, 该重要性的地板 )
raw衰减  = exp( -(年龄天数 / (1 + access_count)) / 半衰期 )
衰减因子 = 0.35 + 0.65 × vitality        # 只影响排序，下限 0.35
```

- **半衰期** `MOYI_DECAY_HALFLIFE`（天，最小 7，默认 90）
- **访问计数是间隔重复式的**：`age/(1+access_count)` —— 被回访 10 次的记忆，等效年龄变成 1/11。
  早期版本用的是 `/(1+0.25·ln(1+n))`，实测数学上基本不起作用（400 天龄、40 次访问后
  衰减仍是 0.006），已被测试拦下并改掉。
- **重要地板**：`high 0.55 / medium 0.30 / low 0`。高重要性的记忆不会因为年久失修
  就掉出检索结果。
- **降级用 `raw衰减`，不用 `vitality`**：否则地板值恰好等于阈值时该分支永远不可达
  （这是上一版 `medium` 从不降级的真实原因）。
- **`high` 永不自动降级**，只列出候选由人决定。降级也只降一级。
- **`tags` 含 `force` 的记忆被钉住**（vitality 恒为 1）。判定按空白分词精确匹配，
  不是 `includes()`——后者会把 `force-app` 这类标签误判成钉住。

| 接口 | 行为 |
| --- | --- |
| `GET /api/decay/preview` | 只读体检：`would_downgrade` / `would_forget` / `pinned` / `keep`，**绝不写库** |
| `POST /api/decay/apply` | 必须 `{"confirm":true}`；只 PATCH importance，**不删除任何行** |
| MCP `memory_health` | 默认走 preview，返回里明写「未写库」；`apply:true` 才执行 |

前端「衰减体检」弹窗同样是两步确认（先看预览、再点确认），「审计簿」按钮仅 master 可见。
`MOYI_DECAY=0` 可整体关掉衰减（响应里的 `decay: "off"` 就是这个开关的状态）。

---

## 记忆图谱

节点=记忆，边=共享标签或共享事实锚点（数字串、英文词）。相似度用 **overlap coefficient**
（交集 / 较小集合），而不是 Jaccard——记忆标签普遍很少，Jaccard 会把「共享 1 个标签、
各自多 3 个」直接压到看不见。

```
权重 = max(标签重合, 事实重合) × 0.9 + min(...) × 0.1 + 同源加成(0.1)   # 最终 clamp 到 0..1
```

- 每个节点最多连 `MOYI_GRAPH_MAX_DEG`（默认 8）条边，防止枢纽节点把图糊成一团
- 连边阈值默认 0.5，可在请求里用 `min_weight` 覆盖
- 输出 `stats`：`node_count`/`edge_count`/`density`/`max_degree`/`isolated`/`truncated`
- `?focus=<id>` 只返回该记忆的 2 跳邻域，避免一次拉全库

| 接口 | 行为 |
| --- | --- |
| `GET /api/graph?limit=&min_weight=&focus=` | 构图；`focus` 返回邻域子图 |
| MCP `memory_graph` | 打印带 `via`（共享了什么）的边 + 孤立节点清单 |
| 前端「墨格」 | SVG 力导向布局，迭代 120 步后停止（不做 rAF 常驻动画，避免烧 CPU） |

**诚实的边界**：这是**共现图**，不是语义图。两条记忆谈同一件事但标签/数字不重合就没有边；
反过来，共享一个泛用标签（比如「技术」）会连出弱边。所以阈值宁可调高，且边权重只该用于
「值得一眼看出有没有关联」，不该当作推理依据。

---

## 注册限速与审计日志

注册是领 API Key 的唯一入口，必须公开，因此只能限速而不是关掉。

- 滑窗按分钟分桶，键为 `sha256(客户端 IP)[0:16]`（不落明文 IP）
- `MOYI_REGISTER_PER_HOUR`（默认 10）/ `MOYI_REGISTER_PER_DAY`（默认 30）
- `/agents/verify` 另设 `MOYI_AUTH_FAIL_PER_15MIN`（默认 30）
- 超限返回 `429` + `retry_after_ms`，并在 `hint` 里引导批量场景改用 master 签发
  （`POST /api/agents`），而不是撞注册限速

一个踩过的坑：**只统计认证失败的请求**。第一版把所有带 key 的请求都计入配额，
结果正常使用的人被自己锁在门外，测试也大面积 429。现在进一步区分：
**完全不带 key 的请求也不计数**——已登出的浏览器不该把自己锁掉。

审计日志（`lib/audit.js`）记录注册、提权被忽略、认证拒绝、除名、重置密钥、
去重命中、存储、检索、图谱、衰减执行、回填等事件：

- 进程内环形缓冲，容量 `MOYI_AUDIT_CAPACITY`（默认 2000）
- 写入前 `redact()`：任何 key 名命中 `secret|token|key|password|code` 的值，
  以及任何形如 `moyi_<16进制>` 的值，一律替换为 `[REDACTED]`
- `GET /api/admin/audit`（仅 master）读取，响应里固定带一句
  `warning`：**日志在内存中，重启即失效，无状态部署下不可作为合规留痕**

想持久化的话，接一层把 `recentEvents()` 定期导出到外部日志系统即可——当前实现
刻意不落盘，避免在无状态平台上写出半截文件。

---

## 管理台与引导安装

部署者需要的一样东西，Agent 不需要：一个能发号、收权、改设置的地方。
它和 Agent 侧完全分开——**两套认证面，由路径唯一决定**。

| 面 | 路径前缀 | 凭据 | 能做什么 |
| --- | --- | --- | --- |
| Agent | `/api/*`（除 `/api/console/*`） | `X-Moyi-Key`（API Key，只存哈希） | 读写**自己**的记忆 |
| 管理台 | `/api/console/*` | 用户名口令 + 会话 Cookie | 管 Agent、管管理员、管设置；**读不到任何记忆正文** |

### 引导安装页（一次性）

`/console` 在实例还没有任何管理员时显示安装页，填四项：实例名、管理员用户名、口令、是否开放自助注册。
提交成功后立刻落库并**永久封存**：

- 落锁靠 `settings` 表里一行 `setup_locked`，用唯一约束的 409 当 CAS。
  两个人同时点安装，只有一个能写进去，另一个收到 409 并回滚刚建的管理员。
- 封存的判定只看服务端，不看浏览器。清 localStorage / 换隐身窗口都唤不回安装页。
- `admins` 或 `settings` 表不存在时（没跑迁移 SQL），页面显示"请先执行迁移"，
  **不会**给出一个能提交、但必然失败的表单。
- 数据库连接信息**不在**这一页配置。它留在环境变量里：能写库的凭据如果能在
  网页里填，就等于让任何一次 XSS 具备换后端的能力。

忘记口令没有邮件找回，也没有后门。恢复办法是直接改库（见
[SECURITY-MIGRATION.md](./SECURITY-MIGRATION.md)），这刻意比"点个重置链接"麻烦——
一个能远程改管理员口令的接口，本身就是最大的攻击面。

### 管理面板

四个页签：

- **Agent** — 创建（一次性的 Key + 可直接复制的 MCP 配置片段）、换钥、除名（连带记忆）。
  这里只回**条数**，不回正文。
- **管理员** — 建/停用/启用、改角色、置口令、删除。仅超管可见。
- **会话** — 在线会话列表，可逐个撤销。超管看得见所有人，普通管理员只看得见自己的。
- **设置** — 实例名、开放自助注册、全局记忆。仅超管可改，普通管理员拿到只读视图。

口令与会话的几条硬规则：

| 规则 | 实现 |
| --- | --- |
| 口令永不明文 | Node 内置 `crypto.scrypt`（N=16384,r=8,p=1），格式 `scrypt$N$r$p$salt$hash` 自描述，调参不必重算全库 |
| 会话可真正作废 | 不透明随机 token，库里只存 sha256；不用自签 JWT（那种做不到退出即失效） |
| 改口令 / 停用 → 踢掉全部旧会话 | `admins.session_version` 与会话行里的版本号比对，不需要吊销列表 |
| 防用户名枚举 | 用户不存在与口令错回同一句话、同一状态码 |
| 防 CSRF | Cookie `HttpOnly; SameSite=Lax`（跨站 POST 不带 Cookie；用 Lax 而非 Strict 是为了让 MCP 浏览器授权的顶层跳转能带上会话），写操作另需 `X-Moyi-Console: 1` 头（跨站表单发不出自定义头） |
| 口令暴破限速 | `MOYI_ADMIN_FAIL_PER_15MIN`（默认 10），与 Agent Key 的计数器**分开**——一方试错不该把另一方锁在门外 |
| 不把实例锁死 | 不能停用/降级/删除自己；停用或删除最后一个可用超管被拒 |
| 不自我提权 | 控制台建 Agent 一律 `role=agent`，不接受客户端传 `master`（master 在 Agent 侧能读审计、给他人回填向量） |

`Secure` 标记由 `X-Forwarded-Proto: https` 决定，反代后面记得透传这个头。
会话有效期 `MOYI_SESSION_DAYS`（默认 7 天，上限 30 天）。

### 多个 Agent 之间的关系：默认彻底隔离

每个 Agent 一把独立 Key、一份独立记忆，跨工具不串味——这是墨忆的基本契约，
管理台的存在不改变它（管理员管的是"有哪些工具"，不是"工具记了什么"）。

### 全局记忆（可选，默认关闭）

设置里打开 `global_memory` 后，任何 Agent 都能**读到**其他 Agent 的记忆：

- 检索、列表、按 id 直读都放宽；结果里别人来的条目带 `_own: false` 与 `_owner: <名字>`。
- **写侧一处没松**：创建、去重合并、更新、删除、同步、衰减落库、访问计数
  仍然锁在调用方自己的 `agent_id` 上。跨 agent 改别人的条目会把甲的事实写进乙的记忆，
  那是数据损坏而不是便利。
- 全局模式下改/删/同步他人的条目回 `403`；严格模式下回 `404`。
  这个不对称是刻意的——严格模式里做一次"无归属探测"会把状态码变成存在性探针。
- 别人反复读你的记忆**不会**给它续命：`access_count` 只由属主的读取增加。

⚠️ 这是一条隐私边界，不是一个权限边界。开了全局记忆，任何一个 Agent 的 Key 泄漏
就等于全库记忆泄漏。只在"这些 Agent 属于同一个人、同一批内容可信"时开启。

改完最迟 `MOYI_SETTINGS_TTL_MS`（默认 5000ms）对全实例生效；同进程内的写入会立即失效缓存。

---

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/agents/register | 注册（带 `master_code` 且服务端已配置则成 master）；**限速** |
| POST | /api/agents/verify | 校验密钥；**认证失败限速** |
| GET | /api/agents | 列表（master），含各 Agent 记忆条数 |
| POST | /api/agents | 创建 Agent（master） |
| DELETE | /api/agents/:id | 除名并连带清除其记忆（master） |
| POST | /api/agents/:id/reset-key | 重置密钥（master） |
| GET | /api/memories | 列表，支持 `?importance=&synced=&q=&limit=` |
| POST | /api/memories | 创建 |
| POST | /api/memories/remember | 评估+去重+存储 一步 |
| POST | /api/memories/search | 混合检索，返回 `mode`/`scanned`/`vectorized`/`search_backend`/`decay` |
| POST | /api/memories/assess | 只评估不存储 |
| GET | /api/memories/:id | 获取单条（访问计数自增） |
| PATCH | /api/memories/:id | 更新（改 content 会自动重算向量） |
| DELETE | /api/memories/:id | 删除 |
| POST | /api/memories/:id/sync | 标记已同步 |
| POST | /api/sync/batch | 批量同步 |
| GET | /api/stats | 统计（含向量覆盖率） |
| GET | /api/whoami | 当前 Key 对应的 Agent |
| GET | /api/graph | 记忆图谱，`?limit=&min_weight=&focus=` |
| GET | /api/decay/preview | 衰减体检，**不写库** |
| POST | /api/decay/apply | 执行降级，需 `{"confirm":true}`，**不删除** |
| GET | /api/embeddings/status | 向量覆盖与 provider 状态 |
| POST | /api/admin/backfill-embeddings | 回填向量（master） |
| GET | /api/admin/audit | 审计日志（master），带「内存态、重启即失」警告 |

管理台端点（`/api/console/*`，凭会话 Cookie 或 `X-Moyi-Admin-Token`，写操作另需 `X-Moyi-Console: 1`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/console/status | 是否需要安装、是否已登录、实例名与开关 |
| POST | /api/console/setup | 引导安装，**一次性**；已安装返回 409 |
| POST | /api/console/login · /logout | 登录下发 Cookie；退出即作废 |
| GET | /api/console/me | 当前管理员 |
| POST | /api/console/me/password | 改自己口令，其它设备会话全部作废 |
| GET · PATCH | /api/console/settings | 读（任意管理员）/ 改（仅超管）实例设置 |
| GET · POST | /api/console/agents | 列 Agent（含记忆条数）/ 创建并一次性回 Key |
| POST · DELETE | /api/console/agents/:id[/reset-key] | 除名（连带记忆）/ 换钥 |
| GET · POST | /api/console/admins | 管理员列表 / 新建（均仅超管） |
| PATCH · DELETE | /api/console/admins/:id | 停用、改角色、删除（仅超管） |
| POST | /api/console/admins/:id/password | 置口令，该账号会话全废（仅超管） |
| GET · DELETE | /api/console/sessions[/:id] | 会话列表 / 撤销（他人需超管） |

所有需要认证的端点一律要求 `X-Moyi-Key`，无一例外——`/api/console/*` 是另一套认证面，
拿 Agent Key 打不进去，反过来管理员 Cookie 也读不到任何记忆。

### 记忆数据结构

```json
{
  "id": "mem_xxxxxxxxxxxxxxxx",
  "content": "完整记忆内容",
  "summary": "自动生成的摘要",
  "importance": "high",
  "tags": ["偏好", "技术"],
  "source": "claude-desktop",
  "embedding": "[0.0123, ...]",
  "synced": true,
  "synced_at": "2026-09-19T...",
  "access_count": 3,
  "created_at": "...",
  "updated_at": "..."
}
```

---

## 重要性评估逻辑

| 维度 | 权重 | 说明 |
| --- | --- | --- |
| 身份信息 | +25/词 | 我叫、我是、生日、电话、邮箱 |
| 情感权重 | +15/词 | 喜欢、讨厌、爱、恨、永远、绝不 |
| 持续性 | +12/词 | 偏好、习惯、总是、从不、原则 |
| 关联度 | +8/词 | 与已有记忆有共同标签 |
| 长度 | +/- | 太短降权，有深度加分 |
| 时效性 | -5/词 | 今天、刚刚、临时、马上 |

**分级：** score ≥35 → `high`（创建即同步）；≥15 → `medium`；否则 `low`（默认不存储）。

---

## 测试

```bash
npm test
```

跑在内存版 PostgREST mock 上，**不触碰任何真实数据库**。
去重判据 10 项 + 集成 213 项，另有 `test/webadapter.js`（Web⇄Node 适配层契约：headers 小写、body 事件补发、OPTIONS 204、cf-connecting-ip 归一化、Set-Cookie 多条、1MB 上限）与 `test/webentry.js`（Cloudflare 入口「先拷 env 再 require」的时序，防止线上全场 500）覆盖 Cloudflare 路径，覆盖：认证提权与后门回归、agent 隔离、入参校验、CORS、
向量检索与回填、语义去重、MCP 端到端、图谱构边与阈值、衰减数学（含降级可达性）、
审计脱敏与限速（含「不带 key 不计失败」这类反例）、检索下推与回退、`resolveRest` 前缀推断、
存储层故障显式报错，以及管理台一整段：引导安装的一次性（含重复安装不破锁）、CSRF 头、
口令与账号不可枚举、改口令踢会话、停用与最后超管护栏、开放注册开关（含 master_code 通道）、
全局记忆的「读放宽写不放宽」与存在性探针回归、迁移 SQL 未跑时的降级形态。

`test/legacy-*.js` 是早期的真实环境冒烟脚本，会写真实数据，默认被拦截；
确需运行加 `MOYI_ALLOW_LIVE_TEST=1`。

---

## 部署

| 方式 | 命令 / 文件 | 说明 |
| --- | --- | --- |
| Docker（自托管全栈） | `docker compose --profile local up -d --build` | Postgres + pgvector + PostgREST + 墨忆 |
| Docker（连外部 Supabase） | `docker compose --profile cloud up -d --build` | 只起墨忆一个容器 |
| Vercel Serverless | `api/index.js` + `vercel.json` | 项目环境变量按上表配置 |
| Cloudflare Workers / Pages | `cloudflare/worker.js` + `wrangler.toml`（示例函数 `cloudflare/functions/`） | **仅付费版**：scrypt 单次约几十毫秒 CPU，免费版 10ms 上限会掐断登录/注册。业务代码经 `lib/webadapter.js` 零改动复用 |
| 裸进程 | `node server.js` | Node ≥ 18，零运行时依赖 |

镜像细节：`node:20-alpine`，只 COPY 运行所需文件；非 root 用户 `moyi`；`EXPOSE 3906`；
HEALTHCHECK 用 busybox `wget --spider` 探根路径（管理页能返回即算存活）；`ENTRYPOINT`
脚本解析挂载的 env 后 `exec node server.js`，使 SIGTERM 能直达 Node 进程
（不 `exec` 的话容器收不到停止信号）。compose 侧 `read_only: true` + `tmpfs: /tmp` +
`no-new-privileges`，凭据目录 `:ro` 挂载。

`.dockerignore` 排除 `.git`、`.env*`（保留 `.env.example`）、`test/`、`data/`——
`data/` 是挂载凭据的地方，打进镜像等于把密钥烧进层里。

管理台走的是同一套 `/api/*` 逻辑，因此在 Serverless 上一样能装、能登录、能管 Agent
（会话与设置全在数据库里，不依赖进程状态）。但**限速与设置缓存是每实例独立的**——
无状态平台上的 `MOYI_ADMIN_FAIL_PER_15MIN` 只能算部分防线，
要可靠的暴破拦截请放反代或单长驻进程（Docker 那条路）。
`vercel.json` 已把 `/console` 指向 `console.html`，能否打开取决于静态资源是否随之部署；若打不开，
直接用 `/api/console/*` 这套接口操作即可（登录支持 `X-Moyi-Admin-Token` 头，不必非用 Cookie）。

---

## 当前边界

写清楚做不到的事，比列一堆待办更有用：

- **本地向量不等于语义检索**。不接 provider 时是特征哈希，近义词召回明显偏弱，
  去重也因此不能只靠向量决策。
- **衰减只降权、只降级，永不删除**。`would_forget` 只是候选清单，
  真要删得逐条 `DELETE /api/memories/:id`。这是刻意的。
- **图谱是共现图**，不是语义图，边权重不宜作推理依据。
- **检索下推默认关闭**，且只覆盖已向量化的记忆（靠补取未向量化行兜底）。
- **审计日志在进程内存里**，重启即失、多实例不共享，不做合规留痕。
- **管理台看不见记忆正文，也看不见记忆内容量的分布**。它只知道"某个 Agent 有几条"，
  要细节得用那个 Agent 自己的 Key。这是刻意的：管理员是"管工具的人"，不是"读别人日记的人"。
- **全局记忆是隐私边界，不是权限边界**。开了之后任何一个 Agent 的 Key 泄漏
  等于全库记忆泄漏；且它只放宽读，写侧仍然各管各的。
- **无状态部署下管理员口令限速也只是部分防线**（每实例独立计数），
  和审计日志同一类限制。
- **自托管栈的 agent 隔离在服务层**，PostgREST 本身没有隔离概念——
  一旦把它暴露到公网，等于全库公开。
- **技能是公共只读层，发布=向所有 Agent 下指令**。正因如此 Agent 只能落 draft，
  发布必须是人的动作；URL 抓取受域名白名单约束（不做「解析后校验 IP」，那需要手搓
  HTTP 客户端才能防住 DNS rebinding）。墨忆本身只存与取技能文本，不替你生成技能正文。
- **浏览器授权是精简子集，不做动态注册**。client_id 与回调白名单由环境变量写死，
  只有一个整实例的 `mcp` scope，同意人固定是已登录管理员；撤销粒度是「删掉那个 Agent」。
  这几项留给后续里程碑，也因此它降低的是「发钥匙」的门槛，没有引入新的权限面。
- **Vercel 部署下限速与审计基本无效**：无状态多实例各自计数。要限速请放反代
  或单长驻进程（Docker 那条路）。
- **Cloudflare Workers / Pages 仅付费版可用**：scrypt 单次约几十毫秒 CPU，
  免费版 10ms 上限会掐断登录/注册（`Error 1102`）。代码路径已实现并本地测试，
  但尚未在 Cloudflare 真实环境跑过端到端。限速与审计的退化与 Vercel 同理。

---

## 设计理念

> 书里写尽了万般术法，可从没有一本教过"如何记住一个人"。

1. **记忆属于人，不属于工具** — 记忆存在中立层，工具只是入口
2. **AI 自主判断** — 不需要人工干预，AI 自己决定什么值得记
3. **宁漏勿错** — 去重要保守，把用户的事实记岔比重复一条严重得多
4. **开放协议** — MCP 标准，任何工具都能接入，不锁定生态

---

*墨忆 by 画青霜 · 万界藏书阁*
