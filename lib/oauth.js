/**
 * 墨忆 — MCP 浏览器授权（OAuth 2.1 精简子集）
 *
 * 只做「浏览器给一个 MCP 客户端一次性批一把临时 key」这件事，
 * 不做完整的 OIDC/JWT，也不做动态客户端注册（DCR 留给下一阶段）。
 * 核心边界：
 *
 * 1) 单一 client：MCP 客户端预先约定——服务端环境变量
 *    MOYI_OAUTH_CLIENT_ID 指定 client_id；MOYI_OAUTH_REDIRECT_WHITELIST
 *    指定 redirect_uri 前缀白名单（逗号分隔）。未配 CLIENT_ID 视为
 *    关闭 OAuth，/api/oauth/* 直接 501，/api/mcp 的 401 也不带发现头。
 * 2) 授权同意人 = 已登录的 admin（复用管理台会话 Cookie）。墨忆没有
 *    Agent 侧浏览器登录，管理员点「同意」就是这一流程的信任根。
 * 3) 一次授权 = 新建一把只属于该客户端的 Agent（名字 oauth:<client_id>），
 *    access token 通过 oauth_tokens 表映射到这个 Agent。作用域、隔离与
 *    手动新建 Agent 完全一致；管理台删除该 Agent 即级联吊销全部 token。
 * 4) PKCE 强制 S256；auth code 一次性 + 60s TTL；access 1 小时；
 *    refresh 30 天。全部只存 sha256，明文只在签发瞬间出现一次。
 * 5) redirect_uri 必须精确命中白名单某项，禁 fragment / userinfo，
 *    防开放重定向。state 原样回传，不解释。
 *
 * 无状态设计（重要）：Vercel/Workers 上 authorize、approve、token 三个
 * 请求可能落在不同实例，任何进程内存放的东西都不可靠。因此：
 *   - auth code 落 oauth_codes 表，兑换时用一次「DELETE + return
 *     representation」原子取出并销毁（并发双兑换只有一边拿得到行）；
 *   - 同意表单不加服务端会话：approve 重新做一遍与 authorize 相同的
 *     校验（client_id / redirect 白名单 / PKCE 参数），真正的安全兜底
 *     是 PKCE——code 就算被伪造流程骗出来，没有 verifier 也换不了 token；
 *   - CSRF 两道：会话 Cookie 是 SameSite=Lax（跨站表单 POST 不带 Cookie）
 *     + approve 校验 Origin 必须等于本站（见 verifySameOrigin）。
 */
'use strict';

const crypto = require('crypto');

const CODE_TTL_MS = 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── 配置 ─────────────────────────────────────────────
// env 在函数里读而不是顶层 const：测试要在子进程里覆盖，也避免
// 「先 import 后设 env」在 Workers 冷启动时序下把开关固化成关闭态。
function oauthEnabled() {
  return Boolean((process.env.MOYI_OAUTH_CLIENT_ID || '').trim());
}
function oauthConfig() {
  const cid = (process.env.MOYI_OAUTH_CLIENT_ID || '').trim();
  const wlRaw = (process.env.MOYI_OAUTH_REDIRECT_WHITELIST || '').trim();
  // 白名单未配置时兜底为 loopback：MCP 客户端绝大多数在用户本机开回调端口
  const list = wlRaw
    ? wlRaw.split(',').map(s => s.trim()).filter(Boolean)
    : ['http://localhost:', 'http://127.0.0.1:'];
  return { clientId: cid, whitelist: list };
}

/**
 * redirect_uri 校验：合法 URL、无 fragment、无 userinfo，且精确命中
 * 白名单某一项（相等或以该项为前缀）。白名单项建议写到端口级。
 */
function checkRedirect(uri) {
  if (typeof uri !== 'string' || !uri) return false;
  let parsed;
  try { parsed = new URL(uri); } catch { return false; }
  if (parsed.hash) return false;
  if (parsed.username || parsed.password) return false;
  const { whitelist } = oauthConfig();
  return whitelist.some(pref => uri === pref || uri.startsWith(pref));
}

// ── PKCE（RFC 7636）──────────────────────────────────
function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const got = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (got.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(challenge));
}

// ── token 原语 ───────────────────────────────────────
function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function newAuthCode() { return b64url(crypto.randomBytes(24)); }
function newAccessToken() { return 'moat_' + b64url(crypto.randomBytes(24)); }
function newRefreshToken() { return 'morf_' + b64url(crypto.randomBytes(32)); }
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function isoAfter(ms) { return new Date(Date.now() + ms).toISOString(); }
function notExpired(row) { return !row.expires_at || new Date(row.expires_at).getTime() > Date.now(); }

// ── auth code：落库 + 原子兑换 ───────────────────────
async function storeCode(supa, code, rec) {
  const r = await supa('/oauth_codes', 'POST', [{
    code_hash: hashToken(code),
    agent_id: rec.agent_id, client_id: rec.client_id,
    redirect_uri: rec.redirect_uri, code_challenge: rec.code_challenge,
    expires_at: isoAfter(CODE_TTL_MS), created_at: new Date().toISOString(),
  }]);
  return r.status < 400;
}
/**
 * 一次性取出：DELETE + return=representation 是单条 SQL 的原子操作，
 * 并发下只有一个请求能拿到行（拿到即销毁）。过期判断在 JS 里补，
 * 不依赖 mock/真实库对 gt 过滤的差异。
 */
async function consumeCode(supa, code, clientId, redirectUri, verifier) {
  const r = await supa('/oauth_codes?code_hash=eq.' + hashToken(code), 'DELETE', null, 'return=representation');
  if (r.status === 404 || r.status >= 400) return null;
  const row = (r.data || [])[0];
  if (!row || !notExpired(row)) return null;
  if (row.client_id !== clientId) return null;
  if (row.redirect_uri !== redirectUri) return null;
  if (!verifyPkce(verifier, row.code_challenge)) return null;
  return { agent_id: row.agent_id };
}

// ── access / refresh token ───────────────────────────
async function issueTokens(supa, agentId, clientId) {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  const now = new Date().toISOString();
  const r = await supa('/oauth_tokens', 'POST', [
    { token_hash: hashToken(access), kind: 'access', agent_id: agentId, client_id: clientId,
      revoked: false, created_at: now, expires_at: isoAfter(ACCESS_TTL_MS) },
    { token_hash: hashToken(refresh), kind: 'refresh', agent_id: agentId, client_id: clientId,
      revoked: false, created_at: now, expires_at: isoAfter(REFRESH_TTL_MS) },
  ]);
  if (r.status >= 400) throw new Error('oauth_tokens 写入失败：' + JSON.stringify(r.data || r.status));
  return { access_token: access, refresh_token: refresh,
           token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope: 'mcp' };
}
/** refresh 换一个新 access（不轮转 refresh，MVP 简化；删 Agent 即全部作废）。 */
async function rotateAccess(supa, refreshPlain, clientId) {
  const row = await supa('/oauth_tokens?token_hash=eq.' + hashToken(refreshPlain)
    + '&kind=eq.refresh&revoked=eq.false&select=agent_id,client_id,expires_at');
  if (row.status === 404 || row.status >= 400) return null;   // 表未建 = 功能关
  const hit = (row.data || [])[0];
  if (!hit || hit.client_id !== clientId || !notExpired(hit)) return null;
  const access = newAccessToken();
  const ins = await supa('/oauth_tokens', 'POST', [{
    token_hash: hashToken(access), kind: 'access', agent_id: hit.agent_id,
    client_id: hit.client_id, revoked: false,
    created_at: new Date().toISOString(), expires_at: isoAfter(ACCESS_TTL_MS),
  }]);
  if (ins.status >= 400) throw new Error('oauth_tokens 写入失败：' + JSON.stringify(ins.data || ins.status));
  return { access_token: access, refresh_token: refreshPlain,
           token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope: 'mcp' };
}

/**
 * authenticate() 专用：把 moat_ 前缀的 access token 翻成 agent 对象。
 * 未建表 / 未命中 / 过期都返回 null（回退到普通 key 逻辑之外即 401）。
 *
 * 5 秒缓存：一次 MCP tools/call 会经 internalRoute 把同一把 token 重放
 * 1~N 次（每个 REST 子调用 authenticate 一遍），不缓存的话每次工具调用
 * 都要多打一对查询。5 秒也是「删 Agent 吊销 token」的最大延迟窗口，
 * 与 settings 缓存同一量级，写路径本来就强一致的（删除/写库）不受影响。
 * 负缓存同 TTL：没跑 oauth 迁移的实例若每请求都查一次必 404 的表，纯浪费。
 */
const _authzCache = new Map();   // token_hash -> { at, agent|null }
const AUTHZ_TTL_MS = 5000;
async function authenticateAccessToken(supa, token) {
  const h = hashToken(token);
  const hit = _authzCache.get(h);
  if (hit && Date.now() - hit.at < AUTHZ_TTL_MS) return hit.agent ? Object.assign({}, hit.agent) : null;
  const r = await supa('/oauth_tokens?token_hash=eq.' + h
    + '&kind=eq.access&revoked=eq.false&select=agent_id,client_id,expires_at');
  let agent = null;
  if (r.status !== 404 && r.status < 400) {
    const row = (r.data || [])[0];
    if (row && notExpired(row)) {
      const a = await supa('/agents?id=eq.' + row.agent_id + '&select=id,name,role,created_at');
      const base = (a.data || [])[0];
      // Agent 已被删：token 随之失效（FK 级联也会清行，这里双保险）
      if (base) agent = Object.assign({}, base, { _via_oauth: true, _oauth_client_id: row.client_id });
    }
  }
  if (_authzCache.size > 200) _authzCache.clear();   // 粗暴防泄漏
  _authzCache.set(h, { at: Date.now(), agent });
  return agent ? Object.assign({}, agent) : null;
}

// ── authorize：请求校验与出码 ────────────────────────
/**
 * GET /api/oauth/authorize 的参数校验，authorize 渲染前与 approve
 * 提交时各跑一次（approve 不信任表单，一切重新验）。
 * 通过 → { ok:true, q }；失败 → { ok:false, code, desc, redirect }。
 */
function validateAuthorizeRequest(q) {
  const fail = (code, desc, redirect) => ({ ok: false, code, desc, redirect: redirect || null });
  if (!oauthEnabled()) return fail('temporarily_unavailable', '本实例未开启浏览器授权');
  const { clientId } = oauthConfig();
  if (q.response_type !== 'code') {
    const redir = checkRedirect(q.redirect_uri) ? withErr(q, 'unsupported_response_type') : null;
    return fail('unsupported_response_type', '仅支持 response_type=code', redir);
  }
  if (!q.client_id || q.client_id !== clientId) return fail('invalid_client', '未知 client_id');
  if (!checkRedirect(q.redirect_uri)) return fail('invalid_request', 'redirect_uri 缺失或不在白名单');
  if (!q.code_challenge) return fail('invalid_request', '缺少 code_challenge', withErr(q, 'invalid_request'));
  if ((q.code_challenge_method || 'S256') !== 'S256') return fail('invalid_request', '仅支持 code_challenge_method=S256', withErr(q, 'invalid_request'));
  return { ok: true, q };
}
function withErr(q, code) {
  // 只有 redirect_uri 已确认在白名单里才允许回跳（调用方保证先查过）。
  // state 只接受 URL 安全字符集并截断，防响应头注入 / XSS。
  try {
    const u = new URL(q.redirect_uri);
    u.searchParams.set('error', code);
    const st = String(q.state || '').slice(0, 512);
    if (st && /^[\w\-=.~+]+$/.test(st)) u.searchParams.set('state', st);
    return u.toString();
  } catch { return null; }
}

/** 同意通过后：建专用 Agent → 存 code → 给回跳地址。createAgent 由 moyi.js 注入。 */
async function mintAuthCode(supa, { q, createAgent }) {
  const { clientId } = oauthConfig();
  const { agentId } = await createAgent('oauth:' + clientId);
  const code = newAuthCode();
  const ok = await storeCode(supa, code, {
    agent_id: agentId, client_id: clientId,
    redirect_uri: q.redirect_uri, code_challenge: q.code_challenge,
  });
  if (!ok) return { error: '服务器无法暂存授权码，请稍后重试' };
  const u = new URL(q.redirect_uri);
  u.searchParams.set('code', code);
  const st = String(q.state || '').slice(0, 512);
  if (st && /^[\w\-=.~+]+$/.test(st)) u.searchParams.set('state', st);
  return { location: u.toString(), agentId };
}

// ── token 端点 ───────────────────────────────────────
async function handleTokenBody(supa, body) {
  const noStore = { 'Cache-Control': 'no-store' };
  if (!oauthEnabled()) return { status: 501, json: { error: 'unsupported_grant_type', error_description: '未开启浏览器授权' }, headers: noStore };
  const { clientId } = oauthConfig();
  if (body.client_id && body.client_id !== clientId) return { status: 400, json: { error: 'invalid_client' }, headers: noStore };
  const gt = body.grant_type;
  if (gt === 'authorization_code') {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      return { status: 400, json: { error: 'invalid_request', error_description: '需要 code / code_verifier / redirect_uri' }, headers: noStore };
    }
    let res;
    try { res = await consumeCode(supa, body.code, clientId, body.redirect_uri, body.code_verifier); }
    catch (e) { return { status: 500, json: { error: 'server_error', error_description: e.message }, headers: noStore }; }
    if (!res) return { status: 400, json: { error: 'invalid_grant', error_description: 'code 无效、过期或 PKCE 不匹配' }, headers: noStore };
    try {
      const tok = await issueTokens(supa, res.agent_id, clientId);
      return { status: 200, json: tok, headers: noStore };
    } catch (e) { return { status: 500, json: { error: 'server_error', error_description: e.message }, headers: noStore }; }
  }
  if (gt === 'refresh_token') {
    if (!body.refresh_token) return { status: 400, json: { error: 'invalid_request' }, headers: noStore };
    try {
      const tok = await rotateAccess(supa, body.refresh_token, clientId);
      if (!tok) return { status: 400, json: { error: 'invalid_grant' }, headers: noStore };
      return { status: 200, json: tok, headers: noStore };
    } catch (e) { return { status: 500, json: { error: 'server_error', error_description: e.message }, headers: noStore }; }
  }
  return { status: 400, json: { error: 'unsupported_grant_type' }, headers: noStore };
}

// ── 发现文档（RFC 8414 / RFC 9728）───────────────────
function asMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: origin + '/api/oauth/authorize',
    token_endpoint: origin + '/api/oauth/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    service_documentation: origin + '/docs/agents.html#oauth',
  };
}
function protectedResourceMetadata(origin) {
  return {
    resource: origin + '/api/mcp',
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: '墨忆 · MCP',
  };
}

// ── 同意页（后端内联 HTML：不依赖静态文件，Workers/Pages 同样可发）──
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderConsentPage(q, instanceName) {
  const name = instanceName || '墨忆';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权请求 · ${esc(name)}</title>
<style>
body{font-family:'Noto Serif SC','Songti SC',serif;background:#f5f0e8;color:#1a1a1a;padding:40px 20px;margin:0;}
.card{max-width:520px;margin:0 auto;background:#fffdf8;border:1px solid #d8d2c6;border-radius:4px;padding:28px 32px;box-shadow:0 2px 12px rgba(0,0,0,.06);}
h1{font-size:20px;margin:0 0 10px;}
p.lead{color:#4a4a4a;font-size:14px;line-height:1.8;margin:0 0 20px;}
ul.meta{list-style:none;padding:0;margin:0 0 20px;font-size:12.5px;color:#4a4a4a;}
ul.meta li{padding:7px 0;border-bottom:1px dashed #d8d2c6;display:flex;gap:10px;}
ul.meta li:last-child{border-bottom:0;}
ul.meta b{flex:0 0 82px;font-weight:600;color:#1a1a1a;}
ul.meta code{word-break:break-all;}
.warn{background:#fdf1e8;border-left:3px solid #a0291f;padding:12px 14px;font-size:12.5px;color:#4a4a4a;margin:0 0 22px;line-height:1.7;}
.actions{display:flex;gap:10px;justify-content:flex-end;}
button{font:inherit;padding:9px 22px;border-radius:2px;cursor:pointer;border:1px solid #1a1a1a;background:#fffdf8;color:#1a1a1a;}
button.primary{background:#a0291f;color:#fffdf8;border-color:#a0291f;}
</style></head><body><div class="card">
<h1>MCP 客户端授权</h1>
<p class="lead">下面的客户端请求接入 <b>${esc(name)}</b>。同意后它会获得一个<b>专属 Agent</b> 及其 access token，读写范围与手动新建 Agent 完全一致，看不到其它 Agent 的记忆。</p>
<ul class="meta">
<li><b>Client ID</b><code>${esc(q.client_id)}</code></li>
<li><b>回调地址</b><code>${esc(q.redirect_uri)}</code></li>
<li><b>作用域</b><code>mcp</code></li>
</ul>
<div class="warn">想撤销授权：去管理台 Agent 页删除名为 <code>oauth:${esc(q.client_id)}</code> 的条目即可，token 随之级联失效。</div>
<form method="post" action="approve" style="margin:0">
<input type="hidden" name="response_type" value="code">
<input type="hidden" name="client_id" value="${esc(q.client_id)}">
<input type="hidden" name="redirect_uri" value="${esc(q.redirect_uri)}">
<input type="hidden" name="state" value="${esc(q.state || '')}">
<input type="hidden" name="code_challenge" value="${esc(q.code_challenge)}">
<input type="hidden" name="code_challenge_method" value="${esc(q.code_challenge_method || 'S256')}">
<div class="actions">
<button type="submit" name="decision" value="deny">拒绝</button>
<button type="submit" name="decision" value="approve" class="primary">同意授权</button>
</div>
</form>
</div></body></html>`;
}
function renderMessage(instanceName, title, text) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(instanceName || '墨忆')}</title>
<style>body{font-family:'Noto Serif SC','Songti SC',serif;background:#f5f0e8;color:#1a1a1a;padding:40px 20px;margin:0;}
.card{max-width:460px;margin:0 auto;background:#fffdf8;border:1px solid #d8d2c6;border-radius:4px;padding:28px 32px;}
h1{font-size:19px;margin:0 0 8px;}p{color:#4a4a4a;font-size:14px;line-height:1.8;margin:0;}a{color:#a0291f;}</style>
</head><body><div class="card"><h1>${esc(title)}</h1><p>${text}</p></div></body></html>`;
}
function renderLoginPrompt(instanceName) {
  return renderMessage(instanceName, '请先登录管理台',
    'MCP 授权需要一名管理员在浏览器里点「同意」。请先到 <a href="/console">管理台</a> 登录，再回到本页面刷新。');
}

module.exports = {
  oauthEnabled, oauthConfig, checkRedirect, verifyPkce,
  hashToken, newAuthCode, newAccessToken, newRefreshToken, isoAfter,
  storeCode, consumeCode, issueTokens, rotateAccess, authenticateAccessToken,
  validateAuthorizeRequest, withErr, mintAuthCode, handleTokenBody,
  asMetadata, protectedResourceMetadata,
  renderConsentPage, renderLoginPrompt, renderMessage,
  CODE_TTL_MS, ACCESS_TTL_MS, REFRESH_TTL_MS,
};
