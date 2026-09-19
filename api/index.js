/**
 * 墨忆 v3.2 — Vercel Function 入口
 * 处理所有 /api/* 请求
 */
const { route, corsHeaders } = require('../lib/moyi.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    const h = corsHeaders(req);
    delete h['Content-Type'];
    res.writeHead(204, h);
    return res.end();
  }
  try {
    // Vercel rewrites 后 req.url 保留原路径（/api/...），route 内部会 strip 前缀
    await route(req, res, null, new URL(req.url, 'http://localhost'));
  } catch (e) {
    console.error('[moyi] ' + e.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '服务器内部错误' }));
  }
};
