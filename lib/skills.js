/**
 * 墨忆 — 技能层（Skill Registry）
 *
 * 定位：技能是**公共只读层**，记忆是**私有可写层**。两张表、两个资源命名空间，
 * 技能不会流进 memories，因此检索打分 / 衰减 / 去重 / 全局记忆开关都碰不到它，
 * 「每个 Agent 各自独立记忆、互不干扰」这件事不需要额外实现 —— 结构上就是分开的。
 *
 * 一条技能 = 一份 markdown（对齐业界 SKILL.md 约定：YAML frontmatter 里
 * name + description），Agent 凭自己那把 key 就能读到 published 的全部技能。
 *
 * 生命周期是本模块刻意收窄的地方：
 *   published —— 人（管理台）放的，或 Agent 提交后经人审核放行的。
 *   draft     —— Agent 自己生成的，只能读、只能改自己提交的；
 *                必须有人在管理台点「发布」才会进入公共只读层。
 *   rejected  —— 人否决过，保留正文供追溯，不再出现在任何列表里。
 * 为什么非要这一道闸：能往公共层写，等价于能对所有 Agent 下指令（提示注入的
 * 放大器）。「Agent 读的是公共层，写的只能是自己那一份」是这功能的安全边界。
 *
 * URL 抓取（管理台的「从 URL 导入」与刷新）用的是**域名白名单**而不是「解析后校验 IP」：
 * 后者要在零依赖前提下真正防住 DNS rebinding，必须自己拿 net/tls 按已验证的 IP
 * 建连并手搓 HTTP —— 那等于把整个漏洞面从「想不周」换成「写不对」，风险更高。
 * 白名单把可达主机收敛成一个封闭集合，SSRF 面因而不存在；代价是私有的内部
 * GitLab 需要显式加白（MOYI_SKILL_URL_HOSTS），这是个诚实的取舍。
 */
'use strict';

const crypto = require('crypto');

// 正文上限 200KB：技能是「说明书」，不是文库。超了直接拒，不做截断——
// 截断后的 markdown 语义可能已经反了，那比拒收更危险。
const MAX_CONTENT = 200 * 1024;
const MAX_NAME = 64;
const MAX_DESC = 500;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 512 * 1024;
const FETCH_MAX_HOPS = 3;

// 默认只放 GitHub 的原始内容域。gist.githubusercontent 的响应带
// Access-Control-Allow-Origin 且可 302，纳入后仍然封闭在同一组主机里。
const DEFAULT_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com',
  'gist.github.com', 'github.com'];

function hostWhitelist() {
  const raw = String(process.env.MOYI_SKILL_URL_HOSTS || '');
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_HOSTS.slice();
}

/** 白名单判定：精确命中，或作为子域命中（example.com 放行 a.example.com）。 */
function hostAllowed(hostname, whitelist) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return whitelist.some(entry => h === entry || h.endsWith('.' + entry));
}

/**
 * github 的 blob 链接不能直接抓 —— 那个 URL 返回的是「带代码高亮的网页」，
 * 正文被 HTML 包着。改写成 raw 域才是原始文件。
 * tree（目录）链接明确拒绝：抓一个目录得到的是网页，且「递归收一个仓库」
 * 需要走 API 与分页，不在这一版里。
 */
function normalizeSourceUrl(input) {
  let u;
  try { u = new URL(String(input || '')); } catch { return { error: 'URL 不合法' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { error: '只支持 http(s) 地址' };
  }
  if (u.username || u.password) return { error: 'URL 不允许携带账号信息' };
  if (u.hash) u.hash = '';

  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'github.com' && seg.length >= 4 && (seg[2] === 'blob' || seg[2] === 'tree')) {
    if (seg[2] === 'tree') {
      return { error: '目录链接暂不支持（只会收一个仓库的首页，语义不清）。请直接给某个 .md 文件的 blob 链接。' };
    }
    // 分支名可以含斜杠（feature/x），所以「第 4 段之后全是路径」并不成立。
    // 交给 GitHub：raw 域对 ref/path 的组合会自己解析，解析不出就 404，
    // 比在这里猜分支边界可靠。
    const ref = seg[3];
    const p = seg.slice(4).join('/');
    if (!p) return { error: 'URL 里没解析出文件路径' };
    u = new URL('https://raw.githubusercontent.com/'
      + encodeURIComponent(seg[0]) + '/' + encodeURIComponent(seg[1])
      + '/' + ref.split('/').map(encodeURIComponent).join('/') + '/'
      + p.split('/').map(encodeURIComponent).join('/'));
  }
  return { url: u };
}

/**
 * 每一跳都要重新过白名单：302 到内网是这类抓取最省事的绕法。
 * http 只在「白名单里精确写了这个主机」时放行 —— 子域级条目（example.com）
 * 必须走 https，避免一次配置失误就把整片子域降级成明文。这条例外也正是
 * 本地自托管 Gitea 与测试 fixture 需要的形态。
 */
function assertAllowed(u, whitelist) {
  const exact = whitelist.some(e => String(u.hostname).toLowerCase() === e);
  if (!hostAllowed(u.hostname, whitelist)) {
    return { error: '该主机不在技能抓取白名单内（MOYI_SKILL_URL_HOSTS）：' + u.hostname };
  }
  const port = u.port;
  if (port && port !== '443' && port !== '80') return { error: '只允许默认端口' };
  if (u.protocol === 'http:' && !exact) return { error: '明文 http 抓取要求白名单里精确写出该主机' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: '只支持 http(s)' };
  return null;
}

/**
 * 取一段远程 markdown。redirect 手动跟随（每跳重校验），超时用 AbortSignal，
 * 体积在拿到 body 后立刻二次判长（Content-Length 可以被伪造或省略）。
 */
async function fetchSkillText(input, whitelist) {
  const hosts = whitelist || hostWhitelist();
  const n = normalizeSourceUrl(input);
  if (n.error) return { error: n.error };
  let u = n.url;
  const finalUrl = u.href;

  let hops = 0;
  for (;;) {
    const bad = assertAllowed(u, hosts);
    if (bad) return bad;
    let res;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'moyi-skill-fetch/1', 'Accept': 'text/markdown, text/plain, */*' },
      });
    } catch (e) {
      return { error: '抓取失败：' + (e && e.name === 'TimeoutError' ? '超时' : e.message) };
    }
    const redir = res.status >= 300 && res.status < 400;
    if (redir) {
      if (hops >= FETCH_MAX_HOPS) return { error: '重定向次数过多' };
      const loc = res.headers.get('location');
      if (!loc) return { error: '重定向缺少 Location' };
      let next;
      try { next = new URL(loc, u); } catch { return { error: '重定向地址不合法' }; }
      u = next; hops++;
      continue;
    }
    if (!res.ok) return { error: '远端返回 ' + res.status, status: res.status };
    const cl = Number(res.headers.get('content-length') || 0);
    if (cl && cl > FETCH_MAX_BYTES) return { error: '内容过大（' + cl + ' 字节，上限 ' + FETCH_MAX_BYTES + '）' };
    const ctype = String(res.headers.get('content-type') || '');
    if (ctype && !/^text\//i.test(ctype) && !/json|xml|javascript|x-sh|yaml|toml/i.test(ctype)) {
      return { error: '不是文本内容：' + ctype };
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > FETCH_MAX_BYTES) return { error: '内容过大' };
    return { content: text, sourceUrl: u.href, requestedUrl: finalUrl, contentType: ctype };
  }
}

/**
 * 只解析「一层 key: value」的 YAML frontmatter —— 技能的 name/description 就够用了。
 * 不引入 YAML 解析器，也不假装支持嵌套/多行标量/锚点；遇到那些形态宁可当成无 frontmatter。
 */
function parseFrontmatter(content) {
  const out = { name: null, description: null, hasFrontmatter: false, body: content };
  const m = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(String(content || ''));
  if (!m) return out;
  out.hasFrontmatter = true;
  out.body = String(content).slice(m[0].length);
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1].toLowerCase();
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)
          || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
      if (lastKey === 'name' || lastKey === 'description') out[lastKey] = v || null;
      continue;
    }
    // 缩进的续行属于上一个键（YAML 的多行折叠写法），只拼 name/description。
    if (lastKey === 'description' && /^\s+\S/.test(line)) {
      out.description = ((out.description || '') + ' ' + line.trim()).trim();
    }
  }
  return out;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/** slug 规则：文件名即身份，限制到 URL 安全集，避免后面所有层都要处理转义。 */
function validName(name) {
  const n = String(name || '').trim();
  if (!n) return 'name 不能为空';
  if (n.length > MAX_NAME) return 'name 过长（上限 ' + MAX_NAME + ' 字符）';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(n)) {
    return 'name 只能是小写字母、数字、点、下划线与连字符，且以字母或数字开头';
  }
  return null;
}

function checkContent(content) {
  const c = String(content || '');
  if (!c.trim()) return 'content 不能为空';
  if (Buffer.byteLength(c) > MAX_CONTENT) {
    return '技能正文过大（' + Buffer.byteLength(c) + ' 字节，上限 ' + MAX_CONTENT + '）';
  }
  return null;
}

/**
 * 从一份 markdown 里推出该用的名字与描述：
 * frontmatter 优先 → 首个 H1 → 文件名 → 兜底串。
 * 「自动识别填写」就发生在这里；推不出来时才回落成必填错误。
 */
function inferMeta(content, url) {
  const fm = parseFrontmatter(content);
  let name = fm.name;
  let description = fm.description;
  if (!description) {
    const h1 = /^#\s+(.+)$/m.exec(fm.body || '');
    if (h1) description = h1[1].trim().slice(0, MAX_DESC);
  }
  if (!name) {
    const base = String((url || '').split('/').pop() || '').replace(/\.(md|markdown)$/i, '');
    const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '');
    if (slug && slug !== 'skill' && slug !== 'readme') name = slug;
  }
  return { name: name || null, description: description || null, fm };
}

// ── 存储 ───────────────────────────────────────────────
// 与其它层一致：只认 PostgREST 协议，不直连数据库。

async function listSkills(supa, where) {
  const r = await supa('/skills?select=id,name,description,status,origin,source_url,'
    + 'updated_at,created_at&' + (where || 'status=eq.published') + '&order=updated_at.desc&limit=200');
  // 表不存在（没跑迁移）≠ 没有技能：回 404 让调用方如实报错，
  // 但也确实存在「刚部署还没跑 SQL」的正常场景，所以 MCP 侧会降级成空清单。
  if (r.status === 404) return { missing: true, rows: [] };
  if (r.status >= 400) return { failure: r, rows: [] };
  return { rows: r.data || [] };
}

async function getSkillByName(supa, name, statusEq) {
  const q = '/skills?name=eq.' + encodeURIComponent(name)
    + '&select=id,name,description,content,status,origin,source_url,sha256,fetched_at,agent_id,updated_at';
  const r = await supa(q + (statusEq ? '&status=eq.' + statusEq : ''));
  if (r.status === 404) return { missing: true };
  if (r.status >= 400) return { failure: r };
  const row = (r.data || [])[0];
  return row ? { row } : { notFound: true };
}

async function getSkillById(supa, id) {
  const r = await supa('/skills?id=eq.' + encodeURIComponent(id)
    + '&select=id,name,description,content,status,origin,source_url,sha256,fetched_at,agent_id,updated_at');
  if (r.status === 404) return { missing: true };
  if (r.status >= 400) return { failure: r };
  const row = (r.data || [])[0];
  return row ? { row } : { notFound: true };
}

async function insertSkill(supa, rec) {
  const r = await supa('/skills', 'POST', rec, 'return=representation');
  if (r.status === 409) return { conflict: '同名技能已存在' };
  if (r.status >= 400) return { error: '技能写入失败', detail: r.data };
  return { row: (r.data || [])[0] };
}

async function updateSkill(supa, id, patch) {
  const r = await supa('/skills?id=eq.' + encodeURIComponent(id), 'PATCH', patch, 'return=representation');
  if (r.status >= 400 || !(r.data || []).length) return { error: '技能更新失败或目标不存在' };
  return { row: r.data[0] };
}

async function deleteSkill(supa, id) {
  const r = await supa('/skills?id=eq.' + encodeURIComponent(id), 'DELETE', null, 'return=representation');
  if (r.status >= 400) return { error: '技能删除失败' };
  return { deleted: (r.data || []).length > 0 };
}

const RESOURCE_SCHEME = 'moyi-skill://';
function resourceUri(name) { return RESOURCE_SCHEME + name; }
function nameFromUri(uri) {
  const s = String(uri || '');
  return s.startsWith(RESOURCE_SCHEME) ? s.slice(RESOURCE_SCHEME.length) : null;
}

module.exports = {
  MAX_CONTENT, MAX_NAME, MAX_DESC,
  hostWhitelist, hostAllowed, normalizeSourceUrl, fetchSkillText,
  parseFrontmatter, inferMeta, validName, checkContent, sha256,
  listSkills, getSkillByName, getSkillById, insertSkill, updateSkill, deleteSkill,
  resourceUri, nameFromUri, RESOURCE_SCHEME,
};
