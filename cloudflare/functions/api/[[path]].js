/**
 * 墨忆 — Cloudflare Pages Functions 示例路由
 *
 * 用途：把墨忆 API 挂到一个 Pages 站点的 /api/* 下（与静态前端同源）。
 * Pages Functions 的文件即路由：本文件放在 Functions 目录的 api/[[path]].js，
 * 就代表 /api/* 全部命中。仓库默认没有 Pages 前端，所以这份是**示例模板**，
 * 用时需要拷进你自己的 Pages 项目：
 *   cp -r cloudflare/functions  <你的-pages-项目>/
 * 并确保 nodejs_compat 打开、把 lib/*.js 一并打进项目（或用构建步骤拷贝）。
 *
 * 付费版限制同 worker.js（scrypt CPU 时间）。
 */
import { serveRequest } from '../../../lib/webentry.js';

export async function onRequest(context) {
  return serveRequest(context.request, context.env);
}
