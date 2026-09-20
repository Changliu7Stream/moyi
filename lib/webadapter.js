/**
 * 墨忆 — Web 标准 ⇄ Node req/res 适配器
 *
 * 背景：整套 API 逻辑已经收敛在 lib/moyi.js 的 route(req, res, pathname, url)
 * 这一个函数上，Vercel 版（api/index.js）和本地版（server.js）都复用它。
 * route 只用到 req/res 的一个极小子集：
 *   req.method / req.url / req.headers(小写键) / req.on('data'|'end') / req.destroy
 *   res.writeHead(code, headers) / res.end(body)
 * Cloudflare Workers 用的是 Web 标准的 Request/Response，没有 Node 的
 * http.IncomingMessage/ServerResponse。本文件把这两端缝起来，让同一份 route
 * 不改一行就能跑在 Workers / Pages Functions 上。
 *
 * 不引第三方框架：只用 Node 内置 events 和 Web 标准 Request/Response，
 * 保持墨忆「零运行时依赖」的技术选型。Workers 打开 nodejs_compat 后
 * require('events') 可用。
 */
'use strict';

const { EventEmitter } = require('events');

/**
 * 把一个 Web Request 翻译成 route 认识的 Node 风格 req。
 *
 * body 处理：route 内部用 parseBody(req)，靠 req.on('data')/req.on('end') 事件。
 * Workers 里 body 是一次性可读的（await request.text()）。这里的做法是：先把
 * 整个 body 读成 Buffer 存起来，再用 newListener 钩子——当 parseBody 挂上
 * 'data'/'end' 监听的当下，在微任务里把缓存的 body 补发出去。这样无论 route
 * 在哪一步 await parseBody，都能拿到数据；不读 body 的路由则不会触发补发。
 */
function toNodeReq(webReq) {
  const req = new EventEmitter();
  req.method = webReq.method;

  const u = new URL(webReq.url);
  req.url = u.pathname + u.search;

  // headers 全部转小写：route 里读的是 req.headers['x-moyi-key'] 这种小写键
  const headers = {};
  webReq.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  // Cloudflare 用 cf-connecting-ip 传真实来源 IP，而不是 x-forwarded-for。
  // 墨忆的限速/审计统一读 x-forwarded-for 的第一跳，所以这里归一化：
  // 有 cf-connecting-ip 就把它写进 x-forwarded-for，让 lib/audit.js 的
  // clientKey(req) 原样生效，核心代码不用为 Cloudflare 特判。
  if (headers['cf-connecting-ip'] && !headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = headers['cf-connecting-ip'];
  }
  req.headers = headers;

  // socket 兜底：没有 XFF 时 audit 会读 req.socket.remoteAddress。
  // Workers 里给不了真正的 socket，退化成 unknown（等价于匿名化后同一桶）。
  req.socket = {
    remoteAddress: (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
  };

  // route 只在「body 超 1MB」时调 req.destroy() 提前收尾；这里是内存 Buffer，
  // destroy 只需存在、无需真正关流。
  req.destroy = () => { req.destroyed = true; };

  // 预读 body（无 body 的方法给空）。GET/HEAD 读 body 会抛，跳过。
  // 加 catch 兜住 rejection：万一某个 POST 路由始终没读 body，也不至于冒
  // unhandledRejection；读取失败时按空 body 处理，parseBody 自有兜底。
  let bodyBuf = null;
  if (webReq.method !== 'GET' && webReq.method !== 'HEAD') {
    bodyBuf = webReq.arrayBuffer()
      .then(ab => Buffer.from(ab))
      .catch(() => Buffer.alloc(0));
  }

  // 当 parseBody 注册 data/end 监听后，补发缓存的 body。
  req.on('newListener', (name) => {
    if (name !== 'data' && name !== 'end') return;
    queueMicrotask(async () => {
      if (req._bodyFed) return;
      req._bodyFed = true;
      try {
        const buf = bodyBuf ? await bodyBuf : Buffer.alloc(0);
        if (buf && buf.length && !req.destroyed) req.emit('data', buf);
      } catch { /* 读 body 失败按空 body 处理，parseBody 自己兜底 */ }
      req.emit('end');
    });
  });

  return req;
}

/**
 * 造一个 Node 风格的可写 res，把 writeHead/end 的结果收集成 Web Response。
 * 返回 { res, toResponse() }：toResponse() 在 route 调完 res.end() 后可用。
 */
function makeCollectorRes() {
  let status = 200;
  const headers = new Headers();
  const chunks = [];
  let ended = false;

  const res = {
    writeHead(code, hdrs) {
      status = code;
      if (hdrs) {
        for (const k of Object.keys(hdrs)) {
          const v = hdrs[k];
          if (v == null) continue;
          if (k.toLowerCase() === 'set-cookie') {
            // Set-Cookie 可能是字符串或数组，逐条 append
            for (const c of [].concat(v)) headers.append('Set-Cookie', c);
          } else {
            headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
          }
        }
      }
      return res;
    },
    end(body) {
      if (body != null) chunks.push(typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
      ended = true;
      return res;
    },
  };

  function toResponse() {
    if (!ended) {
      // route 没有显式 end（异常情况）：给个 500，避免把没写完的响应发出去
      return new Response('{"error":"empty response"}', {
        status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const body = chunks.length ? Buffer.concat(chunks) : null;
    return new Response(body, { status, headers });
  }

  return { res, toResponse };
}

/**
 * 把一次 Web 请求跑完整条 route，返回 Web Response。
 * 调用方（workers 入口 / Pages Function）拿到它直接 return 即可。
 *
 * @param {Request} webReq
 * @param {(req,res,pathname,url)=>Promise<void>} routeFn  通常传 lib/moyi.js 的 route
 */
async function handleRequest(webReq, routeFn) {
  const req = toNodeReq(webReq);
  const { res, toResponse } = makeCollectorRes();
  const url = new URL(webReq.url);
  const pathname = url.pathname.replace(/^\/api/, '') || '/';
  await routeFn(req, res, pathname, url);
  return toResponse();
}

module.exports = { toNodeReq, makeCollectorRes, handleRequest };
