/**
 * 墨忆 v3 — Vercel Function 入口
 * 处理所有 /api/* 请求
 */
const { route } = require('../lib/moyi.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Moyi-Key,X-Moyi-Master-Key',
    });
    return res.end();
  }
  try {
    // Vercel rewrites 后 req.url 保留原路径（/api/...），route 内部会 strip 前缀
    await route(req, res, null, new URL(req.url, 'http://localhost'));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '服务器内部错误', detail: e.message }));
  }
};
