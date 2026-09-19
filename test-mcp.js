const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { stdio: ['pipe','pipe','pipe'] });

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
