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
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admins TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_sessions TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oauth_tokens TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oauth_codes TO web_anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.skills TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_access(text) TO web_anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_memories(vector(384), uuid, int, float) TO web_anon, authenticated;

-- ⚠ 自托管栈新增 admins 之后，「PostgREST 不能暴露公网」这条前提变重了。
--   以前拖到 agents.api_key_hash 也不够用：那是 128 位随机 key 的 sha256，
--   离线爆破不可行。现在 admins.password_hash 是**人挑的口令**的 scrypt 哈希，
--   拿到就等于拿到一份可离线爆破的包（scrypt 参数在哈希里，爆破成本已知）。
--   admin_sessions.token_hash 同理不可逆，但 token 本身是 bearer 凭据，
--   能读表就能读全部会话。
--   本栈没有数据库级的第二重隔离（不开 RLS 的代价，见下），
--   所以：要把管理端点暴露到不可信网络，请改用 Supabase 那份带 RLS 的 SQL，
--   或自己在 admins / admin_sessions / settings 上写策略。

-- 注意：本文件**不开 RLS**。自托管栈的信任边界是「PostgREST 只对墨忆服务暴露，
-- 由墨忆负责 agent 隔离」。若你把 PostgREST 端口直接暴露到公网，必须自己补
-- 面向 agent 的 RLS 策略，否则等同回到本次安全修复前的状态。
-- 详见 SECURITY-MIGRATION.md。
