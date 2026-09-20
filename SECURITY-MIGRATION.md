# 墨忆 — 安全加固与迁移指南

面向两类读者：**新部署**（照第一部分配即可）和**从 v3.0/v3.1 升级**（务必按第二部分的顺序执行）。

## 一、必须满足的安全前提

### 1. 服务端凭据只能是环境变量，且必须是高权限 key

存储层完全靠环境变量注入，仓库内不再内置任何可用默认值：

```
MOYI_DB_URL=<PostgREST 基址>
MOYI_DB_TOKEN=<service_role key / 签名 JWT>
MOYI_CODE=<你自己的长随机掌柜口令>
```

把**低权限的 anon/public key 配到服务端**是本项目最常见的错误配置：
表一旦开启 RLS 而策略只面向高权限角色，anon 的每一条读都会被静默拒绝，
服务层把它包装成空数组，表现是「所有记忆凭空消失」，而不是报错。

### 2. master 口令绝不能有代码内兜底值

历史上这里有过一个写死在源码里的兜底口令，公开仓库里任何人都能读到，
等于全站管理员密码印在说明书封底。现在：**不设置掌柜口令，任何人都只能注册成普通 agent**；
带了 `master_code` 但服务端没配置时，会在 stderr 与审计日志里显式记录「提权被忽略」。

回归测试锁死了这一点（旧口令必须只能拿到 `role:"agent"`）。

### 3. 其余已修的薄弱点

- **未认证可达 `/agents*` 路由**：旧判定条件取反写错，未登录时被放行。
- **用户输入直接拼进 PostgREST 查询串**：`importance`/`synced`/`q`/路径 ID 无校验，
  已改为白名单 + `safeId()`。
- **CORS `*` + 允许任意头**：任意网页可借浏览器诱导请求，现由 `MOYI_ALLOWED_ORIGINS` 控制。
- **`access_count` 读-改-写竞态**：并发读同一条会互相覆盖计数，改用 `increment_access()` RPC 原子自增。
- **静态目录穿越**：旧代码只 `replace(/\.\./g,'')`，`....//` 变形可绕过。
- **`mcp-server.js` 写死 `http.request`**：`MOYI_API` 指向 https 时静默连不上。
- **错误响应回显 `e.message`**：泄露实现细节，现统一为可读提示 + 服务端日志。
- **注册接口公开无限速**：现按 IP 滑窗限速，见 README「注册限速与审计日志」。

### 4. 管理台（v3.3 起）的额外前提

管理台带来三张新表：`admins`、`admin_sessions`、`settings`。它们和 `memories` 的安全性质不同：

- `admins.password_hash` 是**可离线暴破的包裹**（scrypt 参数随哈希一起存）。
  谁能读到这一列，谁就能在自己的机器上慢慢试。因此：
  - **PostgREST 的地址只能对墨忆服务本身开放。** 自托管栈的角色授权
    （`docker/init/10-roles.sql`）把 `admins` / `admin_sessions` / `settings` 授给了
    `web_anon`——因为这一栈不开 RLS、隔离在服务层。这不是疏漏而是那条既定前提的延续：
    **PostgREST 落到公网 = 管理员口令哈希一起漏出去**，比原来的「全库记忆公开」更糟。
    要把管理面暴露到不可信网络，请在 `admins` / `admin_sessions` 上自己写策略，
    或改走下面 Supabase 那份带 RLS 的 SQL。
- `settings` 里的 `setup_locked` 一行是引导安装的锁。**删掉它等于重新打开安装页**——
  任何人都能立一个新的管理员。迁移、恢复备份时不要把这一行清掉。
- Supabase 路线下这三张表建在 `sql/vector-search.sql` 的第 2 步，
  **开了 RLS 且不建任何面向 anon 的策略**：即 anon key 完全读不到 `admins`。
  服务端用 service_role key 读写它们，这是唯一预期的通路。
- 忘记管理员口令时没有远程重置接口，也不该有。恢复办法是直接改库：

  ```sql
  -- 用新口令重新生成哈希（参数须与库里格式一致：scrypt$N$r$p$salt$hash）
  -- 最快的路径是本地跑一段 Node：
  --   node -e "const c=require('./lib/console.js');c.hashPassword('新口令').then(console.log)"
  UPDATE public.admins
     SET password_hash = '<上一步输出>',
         session_version = <当前值 + 1>,
         disabled = false
   WHERE username = '你的管理员名';
  ```

  推高 `session_version` 是为了顺手作废该账号遗留的全部会话。
  若整个实例连一个可用超管都不剩（例如误删），先手工插一行 `role='super'` 的管理员再登录。

## 二、升级迁移步骤 —— 顺序很重要

⚠️ **先换 key，再开 RLS。** 若先开 RLS，仍在用低权限 key 的服务会瞬间全场 401，
而空结果会被上层当成「没有记忆」，表现为数据凭空消失且不带任何报错。按以下顺序可避免。

### 第 1 步 · 轮换凭据

任何进过公开仓库、进过前端、进过镜像层的 key，都应视为已泄露，直接轮换，不要抱侥幸。

- Supabase：Settings → API → **Rotate** 相应 key，并取出 service_role key。
- 自托管：改 `MOYI_PG_PASSWORD`；若启用了 `PGRST_JWT_SECRET`，用新密钥重新签发 JWT。

轮换后旧 key 即刻作废，请同步更新所有部署位置（`.env.local`、Vercel 环境变量、
Docker 挂载的 `data/moyi-env/*.env`）。

### 第 2 步 · 配置环境变量，让服务端改用高权限 key

```bash
cp .env.example .env.local      # 本地
```

Vercel：Settings → Environment Variables 配同样三项（Production + Preview）。
Docker：写进挂载的 env 目录，**不要**写进 compose 的 `environment` 或 Dockerfile。

### 第 3 步 · 跑迁移 SQL

- **Supabase** → SQL Editor 粘贴执行 `sql/vector-search.sql`
  （本文面向已有 `agents`/`memories` 的旧库；**全新 Supabase 库要先跑 `sql/00-schema.sql`**，
  否则第 18 行 `ALTER TABLE public.agents` 会报 `relation does not exist`）
- **自托管** → `psql -d moyi -f sql/00-schema.sql && psql -d moyi -f docker/init/10-roles.sql`
  （用 `docker compose --profile local` 时自动完成）

两者都是幂等的，可重复执行。内容：`agents`/`memories` 表与索引、`pgvector` 扩展 +
`vector(384)` 列 + HNSW 余弦索引、`increment_access()`、`match_memories()`。

**两者的 RLS 策略相反，这是有意的**：

| | RLS | 原因 |
| --- | --- | --- |
| `sql/vector-search.sql`（Supabase） | 开启，不建面向 anon 的策略 → 默认全拒 | 前端 key 可能泄露，必须在数据库侧兜住 |
| `sql/00-schema.sql` + `docker/init/10-roles.sql`（自托管） | **关闭** | 本栈 PostgREST 只以单一角色运行，开 RLS 会让每条读静默返回 0 行；权限改由角色 GRANT 收紧 |

自托管的代价是：**PostgREST 没有 agent 隔离概念，落到公网等于全库公开**。
`docker-compose.yml` 因此只把它绑在 `127.0.0.1:3001`。

已在本地 PostgreSQL 14.24 + pgvector 实测两套 SQL：RLS 开启后 anon `count(*)` 返回 **0**、
`delete` 影响 **0** 行，service_role 正常读写全部行；自托管侧 `web_anon` 可 CRUD 与调用两个 RPC，
但 `CREATE TABLE` 被拒。

### 第 4 步 · 部署新代码并复核各 Agent

旧兜底口令已失效，**数据库里 role 没变，你原有的 master Agent 仍然有效**。
但若它的 key 可能随凭据一起泄露过，用管理界面「重置密钥」换掉。

各工具（Claude Desktop / Cursor）配置里的 `MOYI_API` 若指向 https，现在能正常工作。

### 第 5 步 · 回填历史记忆的向量

已有旧记忆 `embedding` 为 null，检索时会退化为纯关键词模式。master 执行一次：

```bash
curl -X POST https://<你的域名>/api/admin/backfill-embeddings \
  -H "X-Moyi-Key: <master key>" -H "Content-Type: application/json" -d '{}'
```

用 `GET /api/embeddings/status` 看覆盖情况。配置了 embedding provider 后
**必须再回填一次**：不同模型的向量不在同一空间，混用会让语义排序失效。
如果打算打开检索下推（`MOYI_DB_SEARCH=1`），先把覆盖率做到 100%。

## 三、如何确认修好了

```bash
# 1) 任何内置兜底口令都必须不再是 master（示例：用一个猜测的口令注册）
curl -X POST <host>/api/agents/register -H 'Content-Type: application/json' \
  -d '{"name":"check","master_code":"guess-me"}'
# 期望 "role":"agent"

# 2) 未带 key 访问受保护路由必须 401
curl <host>/api/agents            # 期望 401（修复前会放行）

# 3) 用低权限 key 直连数据库必须读不到行
curl <DB基址>/<表前缀>/memories?select=content -H "apikey: <低权限key>" \
     -H "Authorization: Bearer <低权限key>"
# 期望 401 / 0 行

# 4) 注册限速必须生效（连打 12 次，第 11 次起应 429）
for i in $(seq 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST \
  <host>/api/agents/register -H 'Content-Type: application/json' -d "{\"name\":\"t$i\"}"; done
```

回归测试不触碰任何真实数据库（跑在内存 mock 上）：

```bash
npm test        # 去重判据 10 项 + 集成 213 项
```
