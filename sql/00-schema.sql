-- 墨忆 — 原生 PostgreSQL + pgvector 建表脚本
--
-- 本脚本面向原生 PostgREST 本地栈（不开 RLS）。
-- 若使用 Supabase，必须改用 sql/vector-search.sql（那份会开 RLS）。
--
-- 幂等：全部使用 IF NOT EXISTS / OR REPLACE，可重复执行。
--
-- ⚠️ 向量维度：默认 384（本地哈希向量 / bge-small）。接更大模型时，
--    只需把下面「维度常量」一处改掉，并与服务端 MOYI_EMBED_DIM 保持一致：
--      bge-small → 384    bge-base → 768    bge-large / bge-m3 → 1024
--    改维度后若库里已有旧向量，旧向量与新维度不在同一空间，
--    需要重建 embedding 列（见文件末尾的「改维度」说明）并回填。

-- ═══════════════════════════════════════════════════
-- pgvector 扩展
-- ═══════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS vector;

-- ═══════════════════════════════════════════════════
-- agents 表
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.agents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  api_key_hash text       NOT NULL,
  role        text        NOT NULL DEFAULT 'agent',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- master 的 hash 允许重复（多 master 场景），普通 agent 的 key 必须唯一
CREATE UNIQUE INDEX IF NOT EXISTS agents_api_key_hash_idx
  ON public.agents (api_key_hash) WHERE (role <> 'master');

-- ═══════════════════════════════════════════════════
-- memories 表
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.memories (
  id           text        PRIMARY KEY,
  agent_id     uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  content      text        NOT NULL,
  summary      text,
  importance   text        NOT NULL DEFAULT 'medium'
                             CHECK (importance IN ('high', 'medium', 'low')),
  tags         text[]      NOT NULL DEFAULT '{}',
  source       text,
  synced       boolean     NOT NULL DEFAULT false,
  synced_at    timestamptz,
  access_count integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

-- ── 维度常量（接更大 embedding 模型时只改这一处）──────────────
-- 384 = 本地哈希向量 / bge-small；768 = bge-base；1024 = bge-large / bge-m3。
-- 必须与服务端 MOYI_EMBED_DIM 完全一致，否则写入会被拒并静默降级本地向量。
DO $$
DECLARE v_dim int := 384;
BEGIN
  EXECUTE format('ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS embedding vector(%s)', v_dim);
  EXECUTE format('CREATE INDEX IF NOT EXISTS memories_embedding_idx ON public.memories USING hnsw (embedding vector_cosine_ops)');
END $$;

-- 按 agent + 时间排序
CREATE INDEX IF NOT EXISTS memories_agent_created_idx
  ON public.memories (agent_id, created_at DESC);

-- 同步状态索引
CREATE INDEX IF NOT EXISTS memories_synced_idx
  ON public.memories (agent_id, synced);

-- ═══════════════════════════════════════════════════
-- 管理控制台：admins / admin_sessions / settings
--
-- 为什么 admins 不并进 agents：Agent 是「工具」，持 API Key 走 MCP；
-- 管理员是「人」，持口令登管理面板。混在一张表里只靠 role 区分，
-- 迟早写出「某个 Agent 的 key 能登管理面板」这类越权。
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.admins (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text        NOT NULL UNIQUE,
  -- scrypt$N$r$p$salt$hash，永不下发前端、永不明文
  password_hash   text        NOT NULL,
  role            text        NOT NULL DEFAULT 'admin'
                                CHECK (role IN ('super', 'admin')),
  disabled        boolean     NOT NULL DEFAULT false,
  -- 改口令 / 停用时 +1，旧会话因版本不符立刻作废（无需吊销列表）
  session_version bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        uuid        NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  -- 存 token 的 sha256，不存原文
  token_hash      text        NOT NULL UNIQUE,
  session_version bigint      NOT NULL DEFAULT 0,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_sessions_token_idx
  ON public.admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx
  ON public.admin_sessions (admin_id);

-- ═══════════════════════════════════════════════════
-- oauth_tokens 表（MCP 浏览器授权：access / refresh token）
-- 仅在使用 OAuth（配了 MOYI_OAUTH_CLIENT_ID）时才需要这张表。
-- 同样只存 sha256，不存原文；删掉对应 Agent 会级联清掉它的 token。
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.oauth_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text        NOT NULL UNIQUE,
  kind        text        NOT NULL,                 -- 'access' | 'refresh'
  agent_id    uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  revoked     boolean     NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_hash_idx  ON public.oauth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS oauth_tokens_agent_idx ON public.oauth_tokens (agent_id);

-- 授权码：只活 60 秒、兑换即删（DELETE+RETURN 原子消费）。删 Agent 级联清。
CREATE TABLE IF NOT EXISTS public.oauth_codes (
  code_hash      text        PRIMARY KEY,
  agent_id       uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  client_id      text        NOT NULL,
  redirect_uri   text        NOT NULL,
  code_challenge text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 一行一个键。setup_locked 这一行同时充当「已安装」的 CAS 锁。
CREATE TABLE IF NOT EXISTS public.settings (
  key         text        PRIMARY KEY,
  value       text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.settings (key, value) VALUES
  ('instance_name', '墨忆'),
  ('global_memory', '0'),
  ('open_register', '1')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════
-- 函数
-- ═══════════════════════════════════════════════════

-- 访问计数原子自增
CREATE OR REPLACE FUNCTION increment_access(p_id text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.memories SET access_count = access_count + 1 WHERE id = p_id;
$$;

-- 向量近邻检索
-- match_agent_id 传 NULL = 不限定 agent（全局记忆模式）。
-- 之所以不用「每个 agent 各查一次再合并」：那样一条查询要打 N 次 RPC，
-- 而且全局排序得在服务层重做，索引也就白用了。
-- query_embedding 用「无维度 vector」：维度由调用方传入的向量决定，运行时
-- 与 embedding 列比对即可。这样改 embedding 维度时 RPC 无需重建。
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector,
  match_agent_id  uuid,
  match_count     int DEFAULT 20,
  min_similarity  float DEFAULT 0.10
)
RETURNS TABLE (
  id           text,
  agent_id     uuid,
  content      text,
  summary      text,
  importance   text,
  tags         text[],
  source       text,
  synced       boolean,
  access_count integer,
  created_at   timestamptz,
  updated_at   timestamptz,
  similarity   float
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT m.id, m.agent_id, m.content, m.summary, m.importance, m.tags, m.source,
         m.synced, m.access_count, m.created_at, m.updated_at,
         1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memories m
  WHERE (match_agent_id IS NULL OR m.agent_id = match_agent_id)
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > min_similarity
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ═══════════════════════════════════════════════════
-- 换 embedding 维度（如从本地 384 切到 BGE-large 1024）
-- ═══════════════════════════════════════════════════
-- 不同模型/维度的向量不在同一空间，混用会让相似度彻底失真，
-- 所以换维度 = 重建列 + 全量回填，三步：
--   1) 改本文件第「维度常量」处 v_dim，与服务端 MOYI_EMBED_DIM 对齐；
--   2) 跑下面这段，按新维度重建 embedding 列（会清空旧向量）；
--   3) 服务端调用 POST /api/admin/backfill-embeddings 重新算全部向量。
--
-- DROP INDEX IF EXISTS memories_embedding_idx;
-- ALTER TABLE public.memories DROP COLUMN IF EXISTS embedding;
-- ALTER TABLE public.memories ADD COLUMN embedding vector(1024);  -- 换成目标维度
-- CREATE INDEX memories_embedding_idx ON public.memories USING hnsw (embedding vector_cosine_ops);
