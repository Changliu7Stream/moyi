/**
 * 墨忆 — embedding 维度可配置（lib/embeddings.js）单元测试
 *
 * 背景：接入语义搜索 provider（尤其 BGE）时，模型输出维度不再是 384
 * （bge-base=768、bge-large/m3=1024）。维度必须端到端一致：
 *   MOYI_EMBED_DIM  ⟷  这里 DIM  ⟷  DB 的 vector(<dim>) 列。
 * 本测试用真实子进程覆盖三条契约（DIM 在模块加载时从 env 读取，
 * 所以每条都要独立进程跑，不能在同一 require 里改 env）。
 *
 *   1. 默认维度 384，本地哈希向量长度=384。
 *   2. MOYI_EMBED_DIM=1024 时，本地哈希向量随之变 1024。
 *   3. provider 返回维度与 DIM 不符 → 降级本地、embedInfo 报出可读错误。
 *   4. provider 维度匹配 → 真正走 provider 模式。
 */
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let n = 0;
function ok(name) { n++; console.log('  \u2713 ' + name); }

// 在独立子进程里跑一段 JS，返回其 stdout 的 JSON 行
function inChild(env, code) {
  const r = spawnSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (r.status !== 0) throw new Error('child failed: ' + (r.stderr || r.stdout));
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

console.log('\n=== test/embeddings.js ===');

// 1) 默认 384
{
  const o = inChild({ MOYI_EMBED_DIM: '' },
    'const e=require("./lib/embeddings.js");console.log(JSON.stringify({dim:e.DIM,len:e.localEmbed("测试语义").length}));');
  assert.strictEqual(o.dim, 384);
  assert.strictEqual(o.len, 384);
  ok('默认维度 384，本地向量长度一致');
}

// 2) env 驱动本地维度
{
  const o = inChild({ MOYI_EMBED_DIM: '1024' },
    'const e=require("./lib/embeddings.js");console.log(JSON.stringify({dim:e.DIM,len:e.localEmbed("测试语义").length}));');
  assert.strictEqual(o.dim, 1024);
  assert.strictEqual(o.len, 1024);
  ok('MOYI_EMBED_DIM=1024 时本地向量随之变 1024');
}

// 3) provider 维度不符 → 降级 local 并报错
{
  const code = `
    const http=require('http');
    const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:[{embedding:Array(768).fill(0.1)}]}));
      srv.close();
    });});
    srv.listen(0,'127.0.0.1',async()=>{
      process.env.MOYI_EMBED_URL='http://127.0.0.1:'+srv.address().port+'/v1/embeddings';
      process.env.MOYI_EMBED_KEY='k'; process.env.MOYI_EMBED_MODEL='BAAI/bge-base-zh';
      process.env.MOYI_EMBED_DIM='1024';
      const e=require('./lib/embeddings.js');
      const v=await e.embed('hi'); const info=e.embedInfo();
      console.log(JSON.stringify({len:v.length,mode:info.mode,err:info.last_error}));
    });`;
  const o = inChild({}, code);
  assert.strictEqual(o.mode, 'local', '维度不符应降级 local');
  assert.strictEqual(o.len, 1024, '降级后向量长度应=本地 DIM');
  assert.ok(/维度不匹配/.test(o.err), '错误信息应点明维度不匹配: ' + o.err);
  ok('provider 维度不符时降级本地并给出可读错误');
}

// 4) provider 维度匹配 → provider 模式
{
  const code = `
    const http=require('http');
    const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:[{embedding:Array(768).fill(0.1)}]}));
      srv.close();
    });});
    srv.listen(0,'127.0.0.1',async()=>{
      process.env.MOYI_EMBED_URL='http://127.0.0.1:'+srv.address().port+'/v1/embeddings';
      process.env.MOYI_EMBED_KEY='k'; process.env.MOYI_EMBED_MODEL='BAAI/bge-base-zh';
      process.env.MOYI_EMBED_DIM='768';
      const e=require('./lib/embeddings.js');
      const v=await e.embed('hi'); const info=e.embedInfo();
      console.log(JSON.stringify({len:v.length,mode:info.mode}));
    });`;
  const o = inChild({}, code);
  assert.strictEqual(o.mode, 'provider');
  assert.strictEqual(o.len, 768);
  ok('provider 维度匹配时真正走 provider 模式');
}

console.log('\n\u2714 test/embeddings.js: ' + n + ' 项全部通过\n');
