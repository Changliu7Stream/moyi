/**
 * 墨忆 v3.3 — 本地开发服务器
 * API 逻辑与 Vercel 版共用 lib/moyi.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 零依赖的 .env.local 加载：不引入 dotenv，保持「Node 内置模块」的技术选型。
// 已在真实环境中设置的变量不会被 .env.local 覆盖。
(function loadEnv(file) {
  const fp = path.join(__dirname, file);
  if (!fs.existsSync(fp)) return;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (/^\s*#/.test(line)) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})('.env.local');

const { route } = require('./lib/moyi.js');

const PORT = process.env.MOYI_PORT || 3906;
const HOST = process.env.MOYI_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function staticFile(req, res) {
  let fp = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // /console 是管理台的短地址（真正的 API 在 /api/console/*，两者不冲突）
  if (fp === '/console' || fp === '/console/') fp = '/console.html';
  // 目录穿越防护：先规范化，再确认仍落在 PUBLIC_DIR 内
  fp = path.normalize(path.join(PUBLIC_DIR, fp));
  if (!fp.startsWith(PUBLIC_DIR + path.sep) && fp !== PUBLIC_DIR) return false;
  try {
    const c = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    res.end(c);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  // /.well-known/* 为 OAuth 元数据发现端点，必须与 /api/* 一样直接进 route，
  // 不能被 staticFile 吞掉（public/ 下并无对应文件）。
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')
      || u.pathname.startsWith('/.well-known/')) {
    try { return await route(req, res, null, u); }
    catch (e) {
      // 不把内部异常细节回给客户端
      console.error('[moyi] ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '服务器内部错误' }));
    }
  }
  if (req.method === 'GET' && staticFile(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '路径不存在: ' + u.pathname }));
});

server.listen(PORT, HOST, () => {
  // 与 lib/moyi.js 保持同一套判定：后端可换，变量名两认
  const cloud = (process.env.MOYI_DB_BACKEND || '').toLowerCase() === 'supabase'
    || /\.supabase\.(co|in)$/i.test((process.env.SUPABASE_URL || '').replace(/\/+$/, ''));
  const missing = [];
  if (!process.env.MOYI_DB_URL && !process.env.SUPABASE_URL) missing.push(cloud ? 'SUPABASE_URL' : 'MOYI_DB_URL');
  if (!process.env.MOYI_DB_TOKEN && !process.env.SUPABASE_KEY && !process.env.SUPABASE_ANON_KEY) {
    missing.push(cloud ? 'SUPABASE_KEY' : 'MOYI_DB_TOKEN');
  }
  console.log('\n  墨忆 v3.3  Agent Memory Layer');
  console.log('  ────────────────────────────');
  console.log('  服务: http://localhost:' + PORT);
  console.log('  管理台: http://localhost:' + PORT + '/console'
    + '（首次访问会进入引导安装，装完即封存）');
  console.log('  存储: ' + (cloud ? 'Supabase（托管）' : 'PostgREST（自托管/兼容协议）'));
  if (missing.length) {
    console.log('  ⚠ 缺少环境变量: ' + missing.join(', '));
    console.log('    请复制 .env.example 为 .env.local 并填写，否则所有 API 调用会返回 500。');
  } else {
    console.log('  状态: 运行中');
  }
  if (!process.env.MOYI_CODE && !process.env.MASTER_CODE) {
    console.log('  ⓘ 未设置 MOYI_CODE，任何人都无法注册为 master（安全默认）。');
  }
  console.log('');
});
