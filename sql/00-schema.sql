-- 墨忆 — 原生 PostgreSQL + pgvector 建表脚本
--
-- 本脚本面向原生 PostgREST 本地栈（不开 RLS）。
-- 若使用 Supabase，必须改用 sql/vector-search.sql（那份会开 RLS）。
--
-- 幂等：全部使用 IF NOT EXISTS / OR REPLACE，可重复执行。

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
  updated_at   timestamptz,
  embedding    vector(384)
);

-- HNSW 索引：余弦距离
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON public.memories USING hnsw (embedding vector_cosine_ops);

-- 按 agent + 时间排序
CREATE INDEX IF NOT EXISTS memories_agent_created_idx
  ON public.memories (agent_id, created_at DESC);

-- 同步状态索引
CREATE INDEX IF NOT EXISTS memories_synced_idx
  ON public.memories (agent_id, synced);

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
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(384),
  match_agent_id  uuid,
  match_count     int DEFAULT 20,
  min_similarity  float DEFAULT 0.10
)
RETURNS TABLE (
  id           text,
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
  SELECT m.id, m.content, m.summary, m.importance, m.tags, m.source,
         m.synced, m.access_count, m.created_at, m.updated_at,
         1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memories m
  WHERE m.agent_id = match_agent_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > min_similarity
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;
