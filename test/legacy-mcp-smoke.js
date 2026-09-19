/**
 * ⚠️ 最初的手工 MCP 冒烟脚本，会真实注册 Agent 并写入记忆。
 *    默认禁用，避免误写生产库。日常回归用 npm test。
 *    确要运行: MOYI_ALLOW_LIVE_TEST=1 node test/legacy-mcp-smoke.js
 */
if (process.env.MOYI_ALLOW_LIVE_TEST !== '1') {
  console.error('\n[已拦截] test/legacy-mcp-smoke.js 会向真实数据库写入数据。');
  console.error('  跑离线回归请用: npm test');
  console.error('  确认要连真实库: MOYI_ALLOW_LIVE_TEST=1 node test/legacy-mcp-smoke.js\n');
  process.exit(2);
}

const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const srv = spawn('node', [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['pipe','pipe','pipe'] });

setTimeout(async () => {
  const BASE = 'http://127.0.0.1:3906';
  // 注册
  let r = await fetch(BASE + '/api/agents/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'mcptest'}) });
  const reg = await r.json();
  console.log('KEY:', reg.api_key.slice(0, 12) + '...');

  const mcp = spawn('node', ['mcp-server.js'], { stdio:['pipe','pipe','pipe'], env:{ ...process.env, MOYI_API: BASE, MOYI_KEY: reg.api_key } });
  let out = '', err = '';
  mcp.stdout.on('data', d => { out += d.toString(); });
  mcp.stderr.on('data', d => { err += d.toString(); });

  const send = m => mcp.stdin.write(JSON.stringify(m) + '\n');
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  await new Promise(r2=>setTimeout(r2,800));
  console.log('--- after init, out lines:', out.split('\n').filter(Boolean).length);

  send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'remember',arguments:{content:'主人永远喜欢极简风格'}}});
  await new Promise(r2=>setTimeout(r2,2500));
  console.log('--- after call2, out lines:', out.split('\n').filter(Boolean).length);

  send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'remember',arguments:{content:'主人偏好水墨风格与深色主题，习惯留白'}}});
  await new Promise(r2=>setTimeout(r2,2500));
  console.log('--- after call3, out lines:', out.split('\n').filter(Boolean).length);

  mcp.stdin.end();
  await new Promise(r2=>setTimeout(r2,400));

  console.log('\n=== ALL STDOUT ===');
  out.split('\n').filter(Boolean).forEach(l => {
    try {
      const j = JSON.parse(l);
      if (j.result && j.result.content) console.log('[id' + j.id + '] ' + j.result.content[0].text.split('\n')[0]);
      else console.log('[id' + j.id + '] ' + (j.result ? 'ok' : JSON.stringify(j.error||'')));
    } catch { console.log('[raw] ' + l.slice(0, 80)); }
  });
  console.log('\n=== STDERR ===');
  console.log(err);
  srv.kill();
  process.exit(0);
}, 1500);
