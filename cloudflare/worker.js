/**
 * 墨忆 — Cloudflare Workers 入口（纯后端 /api）
 *
 * 部署：wrangler deploy（见仓库根 wrangler.toml）。
 * 环境变量/Secrets：MOYI_DB_URL、MOYI_DB_TOKEN、MOYI_CODE 等，
 *   - 非敏感：wrangler.toml 的 [vars]
 *   - 敏感：wrangler secret put MOYI_DB_TOKEN 等（不要写进 wrangler.toml / 提交进仓库）
 *
 * ⚠ 仅 Cloudflare Workers 付费版可用：scrypt 口令哈希单次要几十毫秒 CPU，
 *   免费版 10ms 上限会掐断登录/注册。详见 docs/deploy.html 的 Cloudflare 一节。
 */
import { serveRequest } from '../lib/webentry.js';

export default {
  async fetch(request, env /* , ctx */) {
    return serveRequest(request, env);
  },
};
