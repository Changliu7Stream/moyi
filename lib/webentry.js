/**
 * 墨忆 — Cloudflare 环境入口的共享逻辑（Workers / Pages Functions 都用它）
 *
 * 为什么需要这一层：lib/moyi.js 里有若干**模块加载时**就读取的 process.env
 * （SUPA_URL、BACKEND、MASTER_CODE、SETTINGS_TTL 等顶层 const）。Node 里
 * .env.local 在服务启动前就已注入 process.env，所以没问题；但 Workers /
 * Pages Functions 是把 Secrets/变量作为 env 参数**每次调用**传进来的，
 * 顶层 import 时 env 还没到，若直接 import lib/moyi.js 会把这些常量固化成空值，
 * 于是每个请求都 500（"服务端未配置"）。
 *
 * 解法：先 await 把 env 拷进 process.env，**之后**再用 require 惰性加载
 * moyi.js——CommonJS require 有缓存，冷启动只加载一次，此时 process.env 已就绪。
 *
 * 只支持 Cloudflare Workers 付费版（Paid）：口令哈希用 scrypt N=16384，
 * 实测单次要几十毫秒 CPU，而 Workers 免费版每次调用 CPU 上限仅 10ms，
 * 登录/注册会被 Error 1102 掐断。付费版默认 30s CPU 才够用。详见
 * docs/deploy.html 的 Cloudflare 一节。
 */
'use strict';

const { handleRequest } = require('./webadapter.js');

let _loaded = null;

/** 把 Workers/Pages 的 env 绑定拷进 process.env，然后惰性拿到 route。 */
async function ensureRoute(env) {
  if (env && typeof env === 'object') {
    for (const k of Object.keys(env)) {
      const v = env[k];
      // 只拷字符串/数字型绑定；D1/KV/R2 这类对象绑定跳过（墨忆用不到，
      // 它只通过 HTTP 打 PostgREST/Supabase）。
      if (typeof v === 'string' || typeof v === 'number') {
        if (process.env[k] === undefined) process.env[k] = String(v);
      }
    }
  }
  if (!_loaded) _loaded = require('./moyi.js');
  return _loaded.route;
}

/**
 * 处理一次 Cloudflare 请求：把 Web Request 交给 route，返回 Web Response。
 * 非 /api/* 路径在这里直接 404（静态资源交由 Pages 的 asset 层处理，
 * Workers 纯后端场景一般只挂 /api）。
 *
 * @param {Request} request
 * @param {object} env  Workers env / Pages Functions 的 ctx.env
 */
async function serveRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: '路径不存在: ' + url.pathname }), {
      status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const route = await ensureRoute(env);
  return handleRequest(request, route);
}

module.exports = { serveRequest, ensureRoute };
