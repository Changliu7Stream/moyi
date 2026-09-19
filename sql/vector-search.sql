-- 墨忆 — 向量检索与安全加固迁移
--
-- 用法：Supabase 后台 → SQL Editor，整段粘贴执行。
-- 建议先跑「第 1 步 安全」，再跑「第 2 步 函数」。
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
-- 第 2 步：pgvector 与检索函数
-- ═══════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS vector;

-- embedding 列：与 lib/embeddings.js 的 DIM=384 必须一致
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS embedding vector(384);

-- HNSW 索引：余弦距离。数据量大时显著优于顺序扫描。
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON public.memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memories_agent_created_idx
  ON public.memories (agent_id, created_at DESC);

-- 访问计数原子自增，消除服务层「读-改-写」的并发窗口
CREATE OR REPLACE FUNCTION increment_access(p_id text)
RETURNS void LANGUAGE sql AS $$
  UPDATE public.memories SET access_count = access_count + 1 WHERE id = p_id;
$$;

-- 向量近邻检索：记忆量上万后用这个替代服务层暴力扫描。
-- 墨忆的 API 层仍负责 agent_id 归属判断，此函数只做召回。
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(384),
  match_agent_id  uuid,
  match_count     int DEFAULT 20,
  min_similarity  float DEFAULT 0.10
)
RETURNS TABLE (
  id          text,
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
LANGUAGE sql AS $$
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
