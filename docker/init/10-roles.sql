-- 墨忆 · 原生 PostgREST 栈的角色与授权
--
-- 为什么单独一个文件：docker-entrypoint-initdb.d 会按文件名顺序执行该目录下
-- **所有** .sql。早期版本直接把整个 ./sql 挂进去，结果 sql/vector-search.sql
-- 也被执行了 —— 那份是 Supabase 用的，会给两张表开 RLS 且默认拒绝 anon，
-- 于是自托管栈表现为「所有记忆凭空消失」（每条读都是 0 行，且不报错）。
-- 现在只精确挂载需要的两个文件，顺序：00-schema → 10-roles。
--
-- 幂等：全部 IF NOT EXISTS / OR REPLACE / GRANT 可重复。

-- PostgREST 匿名连接角色。PGRST_DB_ANON_ROLE 必须与此一致。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

-- 收回 public schema 的默认建表权（PG15 起默认就不给了，这里对旧版本兜底）
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE moyi FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents  TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_access(text) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_memories(vector(384), uuid, int, float) TO web_anon, authenticated;

-- 注意：本文件**不开 RLS**。自托管栈的信任边界是「PostgREST 只对墨忆服务暴露，
-- 由墨忆负责 agent 隔离」。若你把 PostgREST 端口直接暴露到公网，必须自己补
-- 面向 agent 的 RLS 策略，否则等同回到本次安全修复前的状态。
-- 详见 SECURITY-MIGRATION.md。
