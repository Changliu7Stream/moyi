#!/usr/bin/env node
/**
 * 墨忆 · 自托管栈的 PostgREST 匿名 JWT 签发器
 *
 * 为什么需要它：一旦 PostgREST 配了 PGRST_JWT_SECRET，它就不再接受裸的
 * 「apikey 字符串」——Authorization 头必须是一个用同一密钥签发的 HS256 JWT，
 * 否则一律 401。墨忆服务层把 MOYI_DB_TOKEN 原样放进 Bearer 头，
 * 所以本地栈必须先签发一个合法 JWT 再交给它。
 *
 * 零依赖：只用 Node 内置 crypto，保持与项目「不引入任何 npm 包」的选型一致。
 *
 * 用法：
 *   MOYI_JWT_SECRET=xxx node scripts/gen-jwt.js
 *   MOYI_JWT_SECRET=xxx MOYI_JWT_EXP_SECONDS=7200 node scripts/gen-jwt.js
 *
 * 输出：把打印出来的字符串填进挂载的 env 文件里作为 MOYI_DB_TOKEN。
 */

const crypto = require('crypto');

const secret = process.env.MOYI_JWT_SECRET || process.env.PGRST_JWT_SECRET || '';
if (!secret) {
  console.error('缺少 MOYI_JWT_SECRET。请设成一个长随机串，例如：\n'
    + '  MOYI_JWT_SECRET=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))") '
    + 'node scripts/gen-jwt.js');
  process.exit(1);
}
const anonRole = process.env.PGRST_DB_ANON_ROLE || 'web_anon';
const expSeconds = Math.max(60, parseInt(process.env.MOYI_JWT_EXP_SECONDS, 10) || 3600);

// Buffer 与字符串必须分开处理：Buffer.from(aBuffer) 返回的是**同一个** buffer，
// 不会拷贝，所以不能拿它当「转字节」用 —— 那样下面 JSON.stringify 会把
// { type:'Buffer', data:[...] } 编进签名里，产出的 token 永远验不过（实测踩过）。
const b64str = s => Buffer.from(s, 'utf8').toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64buf = b => b.toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const header = b64str(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
// iss 用任意标识即可：PostgREST 只校验签名与 role，除非你另设 PGRST_JWT_AUD
const payload = b64str(JSON.stringify({ role: anonRole, iat: now, exp: now + expSeconds, iss: 'moyi-local' }));
const sig = b64buf(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
const token = header + '.' + payload + '.' + sig;

// 自检：把 payload 反解回来，确认 role/exp 真的是我们要的。
// （原先这里写成「再算一次签名比对」——同一段代码吃同一个输入，
//  永远相等，是个假检查，改不成真检查就不如删掉。）
const unb64 = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
const back = unb64(payload);
if (back.role !== anonRole || back.exp - back.iat !== expSeconds) {
  console.error('令牌自检未通过，请勿使用本次输出：', back);
  process.exit(1);
}

console.log(token);
console.error('\n# role=' + back.role + '，有效期 ' + expSeconds + ' 秒'
  + '（约 ' + (expSeconds / 3600).toFixed(1) + ' 小时），到期后重新签发。');
console.error('# 填入挂载的 env 文件：MOYI_DB_TOKEN=<上面这一行>');
