/**
 * 墨忆 v3 — 本地开发服务器
 * API 逻辑与 Vercel 版共用 lib/moyi.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { route } = require('./lib/moyi.js');

const PORT = process.env.MOYI_PORT || 3906;
const PUBLIC_DIR = path.join(__dirname, 'public');

function staticFile(req, res) {
  let fp = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  fp = path.join(PUBLIC_DIR, fp.replace(/\.\./g, ''));
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  try {
    const c = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    res.end(c);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  // API 请求交给共享逻辑（strip /api 前缀在 route 内部处理）
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
    try { return await route(req, res, null, u); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '服务器内部错误', detail: e.message }));
    }
  }
  if (req.method === 'GET' && staticFile(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '路径不存在: ' + u.pathname }));
});

server.listen(PORT, () => {
  console.log('\n  墨忆 v3  Agent Memory Layer');
  console.log('  ────────────────────────────');
  console.log('  服务: http://localhost:' + PORT);
  console.log('  状态: 运行中\n');
});
