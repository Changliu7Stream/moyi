/**
 * lib/webadapter.js 的契约测试（无需真实数据库、无需 Cloudflare 环境）。
 *
 * 复用 lib/moyi.js 里真实的 parseBody / corsHeaders / json 逻辑形状，
 * 用一个「假的 route」去读写 req/res，验证适配器把 Web Request/Response
 * 与 Node 风格 req/res 缝合得对不对：
 *   1. GET 无 body → route 拿到小写 headers、正确的 path+query
 *   2. POST 带 body → route 通过 on('data')/on('end') 收到完整 JSON
 *   3. route 内先 await 再 await parseBody → body 仍能补发（时序无关）
 *   4. OPTIONS → route 只 writeHead(204)+end()（无 body）→ 204 且无 body
 *   5. cf-connecting-ip → 归一化进 x-forwarded-for（限速/审计取 IP 用）
 *   6. Set-Cookie 数组 → 逐条出现在响应头
 */
'use strict';

const assert = require('assert');
const { toNodeReq, makeCollectorRes, handleRequest } = require('../lib/webadapter.js');

// 复刻 lib/moyi.js 的 parseBody（逐字），确保测的是真实契约
function parseBody(req) {
  return new Promise(res => {
    let b = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { req.destroy(); return res({}); }
      b += c;
    });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
  });
}

function corsHeaders(req) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': req && req.headers && req.headers.origin ? req.headers.origin : '',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Moyi-Key,X-Moyi-Admin-Token,X-Moyi-Console',
  };
}

function json(res, code, data, extraHeaders) {
  const h = corsHeaders(res.__moyiReq || {});
  if (extraHeaders) Object.assign(h, extraHeaders);
  res.writeHead(code, h);
  res.end(JSON.stringify(data));
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

function req(method, url, opts) {
  return new Request(url, { method, ...opts });
}

(async () => {
  console.log('webadapter 契约测试');

  await t('GET：headers 小写化 + path/query 正确', async () => {
    const seen = {};
    const fakeRoute = async (r, res) => {
      res.__moyiReq = r;                      // 真实 routeInner 开头就这么做（moyi.js:1073）
      seen.method = r.method;
      seen.url = r.url;
      seen.key = r.headers['x-moyi-key'];
      json(res, 200, { ok: true });
    };
    const resp = await handleRequest(req('GET', 'https://x.dev/api/memories?q=hi&n=3', {
      headers: { 'X-Moyi-Key': 'moyi_abc', 'Origin': 'https://site.dev' },
    }), fakeRoute);
    assert.strictEqual(seen.method, 'GET');
    assert.strictEqual(seen.url, '/api/memories?q=hi&n=3', 'url 应为 path+search: ' + seen.url);
    assert.strictEqual(seen.key, 'moyi_abc', 'header 应小写键可读');
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get('access-control-allow-origin'), 'https://site.dev');
    const body = await resp.json();
    assert.deepStrictEqual(body, { ok: true });
  });

  await t('POST：body 通过 data/end 事件补发给 parseBody', async () => {
    let got = null;
    const fakeRoute = async (r, res) => {
      got = await parseBody(r);
      json(res, 201, { echo: got });
    };
    const resp = await handleRequest(req('POST', 'https://x.dev/api/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', role: 'agent' }),
    }), fakeRoute);
    assert.deepStrictEqual(got, { name: 'A', role: 'agent' });
    assert.strictEqual(resp.status, 201);
    assert.deepStrictEqual(await resp.json(), { echo: { name: 'A', role: 'agent' } });
  });

  await t('POST：route 先 await 再读 body 也不丢数据（时序无关）', async () => {
    let got = null;
    const fakeRoute = async (r, res) => {
      await new Promise(rz => setTimeout(rz, 20));   // 中间插入异步
      await new Promise(rz => setImmediate(rz));
      got = await parseBody(r);
      json(res, 200, { len: Object.keys(got).length });
    };
    const resp = await handleRequest(req('POST', 'https://x.dev/api/memories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 2, c: 3 }),
    }), fakeRoute);
    assert.deepStrictEqual(got, { a: 1, b: 2, c: 3 });
    assert.deepStrictEqual(await resp.json(), { len: 3 });
  });

  await t('OPTIONS：204 且无响应体', async () => {
    const fakeRoute = async (r, res) => {
      const h = corsHeaders(r);
      delete h['Content-Type'];
      res.writeHead(204, h);
      res.end();
    };
    const resp = await handleRequest(req('OPTIONS', 'https://x.dev/api/memories', {
      method: 'OPTIONS', headers: { Origin: 'https://site.dev' },
    }), fakeRoute);
    assert.strictEqual(resp.status, 204);
    assert.strictEqual(await resp.text(), '');
  });

  await t('cf-connecting-ip 归一化为 x-forwarded-for', async () => {
    let ip = null;
    const fakeRoute = async (r, res) => {
      ip = (r.headers['x-forwarded-for'] || '').split(',')[0].trim();
      json(res, 200, {});
    };
    await handleRequest(req('GET', 'https://x.dev/api/health', {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    }), fakeRoute);
    assert.strictEqual(ip, '203.0.113.9');
  });

  await t('已有 x-forwarded-for 时不被 cf-connecting-ip 覆盖', async () => {
    let ip = null;
    const fakeRoute = async (r, res) => {
      ip = r.headers['x-forwarded-for'];
      json(res, 200, {});
    };
    await handleRequest(req('GET', 'https://x.dev/api/health', {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    }), fakeRoute);
    assert.strictEqual(ip, '198.51.100.1, 10.0.0.1');
  });

  await t('Set-Cookie 多条各自保留', async () => {
    const fakeRoute = async (r, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/; HttpOnly'],
      });
      res.end('{}');
    };
    const resp = await handleRequest(req('GET', 'https://x.dev/api/x'), fakeRoute);
    const cookies = resp.headers.getSetCookie ? resp.headers.getSetCookie()
      : resp.headers.get('set-cookie').split(/,(?=[^;]+?=)/);
    assert.ok(cookies.length >= 2, '应保留 2 条 Set-Cookie，实得 ' + cookies.length);
  });

  await t('超 1MB body：req.destroy 被调用且 parseBody 返回空对象', async () => {
    let got = 'unset';
    const fakeRoute = async (r, res) => {
      got = await parseBody(r);
      json(res, 200, { destroyed: !!r.destroyed });
    };
    const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
    const resp = await handleRequest(req('POST', 'https://x.dev/api/big', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big,
    }), fakeRoute);
    assert.deepStrictEqual(got, {}, '超大 body 应解析为空对象');
    assert.deepStrictEqual(await resp.json(), { destroyed: true });
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
