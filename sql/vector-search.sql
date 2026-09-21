-- 墨忆 — 向量检索与安全加固迁移
--
-- 用法：Supabase 后台 → SQL Editor，整段粘贴执行。
-- 建议按顺序整段执行：第 1 步安全、第 2 步控制台表、第 3 步检索函数。
-- 前提：agents / memories 两张表已由旧版墨忆建好（本脚本不建这两张表，
-- 全新库请先执行 sql/00-schema.sql 建表，再回来跑本脚本补 RLS 与控制台表）。
--
-- 幂等：全部使用 IF NOT EXISTS / OR REPLACE，可重复执行。

-- ═══════════════════════════════════════════════════
-- 第 1 步：开启 RLS（最高优先级）
-- ═══════════════════════════════════════════════════
-- 前提：anon/public key 有可能出现在前端包、公开仓库或镜像层里。
-- 在 RLS 关闭的情况下，任何拿到该 key 的人都能读写全库，
-- 完全绕过墨忆服务层的 agent 隔离。开启 RLS 后，
-- 只有下面的 service_role（后端专用，绝不下发到前端）能访问。

ALTER TABLE public.agents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

-- 拒绝 anon/authenticated 的一切访问：不建任何 policy 即为默认拒绝。
-- 若你希望前端直连 Supabase，请另建带 agent 校验的 policy，而不是放开全表。

-- 后端（service_role）全量放行。
-- 注意：PostgREST 中 service_role 会绕过 RLS，这条只是显式声明意图，
-- 便于后续收紧为「仅服务端 IP / 仅特定表」时改造。
DROP POLICY IF EXISTS "service_role full access" ON public.agents;
CREATE POLICY "service_role full access" ON public.agents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role full access" ON public.memories;
CREATE POLICY "service_role full access" ON public.memories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 关键：请确认 API 网关没有把 anon 映射成 service_role。
-- 若曾把 service_role key 写进前端或本仓库，必须在 Supabase 后台轮换密钥。

-- ═══════════════════════════════════════════════════
-- 第 2 步：管理控制台三张表
--
-- ⚠ 这三张表**必须**在 RLS 下运行，尤其 admins：它的 password_hash
--   一旦被 anon 读到，等于把管理员口令的离线爆破包送出去。
--   所以这里跟着第 1 步一起 ENABLE ROW LEVEL SECURITY 且不建任何策略，
--   默认全拒 —— 只有 service_role（后端）能碰。
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
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx
  ON public.admin_sessions (admin_id);

-- MCP 浏览器授权签发的 access / refresh token（详见 lib/oauth.js）。
-- 同样只存 sha256，不存原文；删掉对应 Agent 会级联清掉它的 token。
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
CREATE INDEX IF NOT EXISTS oauth_tokens_agent_idx ON public.oauth_tokens (agent_id);
ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON public.oauth_tokens;
CREATE POLICY "service_role full access" ON public.oauth_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

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
ALTER TABLE public.oauth_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON public.oauth_codes;
CREATE POLICY "service_role full access" ON public.oauth_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 技能：公共只读层的存储。旧库升级时这份脚本负责补建。
CREATE TABLE IF NOT EXISTS public.skills (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  description text        NOT NULL DEFAULT '',
  content     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('published', 'draft', 'rejected')),
  origin      text        NOT NULL DEFAULT 'console'
                            CHECK (origin IN ('console', 'agent', 'url')),
  source_url  text,
  sha256      text        NOT NULL,
  agent_id    uuid        REFERENCES public.agents(id) ON DELETE SET NULL,
  fetched_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skills_status_idx ON public.skills (status, updated_at DESC);
ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON public.skills;
CREATE POLICY "service_role full access" ON public.skills
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 一行一个键。setup_locked 这一行同时充当「已安装」的 CAS 锁。
CREATE TABLE IF NOT EXISTS public.settings (
  key         text        PRIMARY KEY,
  value       text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admins         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings       ENABLE ROW LEVEL SECURITY;

-- 同上：不建面向 anon 的策略即为默认拒绝，只放行 service_role。
DROP POLICY IF EXISTS "service_role full access" ON public.admins;
CREATE POLICY "service_role full access" ON public.admins
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role full access" ON public.admin_sessions;
CREATE POLICY "service_role full access" ON public.admin_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role full access" ON public.settings;
CREATE POLICY "service_role full access" ON public.settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.settings (key, value) VALUES
  ('instance_name', '墨忆'),
  ('global_memory', '0'),
  ('open_register', '1')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════
-- 第 3 步：pgvector 与检索函数
-- ═══════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS vector;

-- embedding 列：维度需与 lib/embeddings.js 的 MOYI_EMBED_DIM 一致。
-- 默认 384（本地哈希向量 / bge-small）；bge-base=768、bge-large/m3=1024。
-- 只改下面 DO block 里的 v_dim 一处即可；改维度后若已有旧向量需重建列并回填。
DO $$
DECLARE v_dim int := 384;
BEGIN
  EXECUTE format('ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS embedding vector(%s)', v_dim);
  EXECUTE format('CREATE INDEX IF NOT EXISTS memories_embedding_idx ON public.memories USING hnsw (embedding vector_cosine_ops)');
END $$;

CREATE INDEX IF NOT EXISTS memories_agent_created_idx
  ON public.memories (agent_id, created_at DESC);

-- 访问计数原子自增，消除服务层「读-改-写」的并发窗口
CREATE OR REPLACE FUNCTION increment_access(p_id text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.memories SET access_count = access_count + 1 WHERE id = p_id;
$$;

-- 向量近邻检索：记忆量上万后用这个替代服务层暴力扫描。
-- 墨忆的 API 层仍负责 agent_id 归属判断，此函数只做召回。
-- match_agent_id 传 NULL = 不限定 agent（全局记忆模式），与 00-schema.sql 保持一致。
-- query_embedding 用「无维度 vector」：维度由调用方传入的向量决定，改维度时 RPC 无需重建。
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector,
  match_agent_id  uuid,
  match_count     int DEFAULT 20,
  min_similarity  float DEFAULT 0.10
)
RETURNS TABLE (
  id          text,
  agent_id    uuid,
  content     text,
  summary     text,
  importance  text,
  tags        text[],
  source      text,
  synced      boolean,
  access_count int,
  created_at  timestamptz,
  updated_at  timestamptz,
  similarity  float
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
-- 步骤同 sql/00-schema.sql 末尾：改本文件「维度常量」v_dim 与服务端
-- MOYI_EMBED_DIM 对齐 → 重建列 → 调用 /api/admin/backfill-embeddings 回填。
--
-- DROP INDEX IF EXISTS memories_embedding_idx;
-- ALTER TABLE public.memories DROP COLUMN IF EXISTS embedding;
-- ALTER TABLE public.memories ADD COLUMN embedding vector(1024);  -- 换成目标维度
-- CREATE INDEX memories_embedding_idx ON public.memories USING hnsw (embedding vector_cosine_ops);

