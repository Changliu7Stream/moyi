/**
 * ⚠️ 这是最初的手工冒烟脚本，会真实注册 Agent 并写入记忆。
 *    默认已禁用：直接运行会退出，避免误把生产库当测试场。
 *    确实要跑（连的是 .env.local 里配置的那个库）时显式加确认：
 *        MOYI_ALLOW_LIVE_TEST=1 node test/legacy-smoke.js
 *    日常回归请用不碰真实数据库的：npm test
 */
if (process.env.MOYI_ALLOW_LIVE_TEST !== '1') {
  console.error('\n[已拦截] test/legacy-smoke.js 会向真实数据库写入数据。');
  console.error('  跑离线回归请用: npm test');
  console.error('  确认要连真实库: MOYI_ALLOW_LIVE_TEST=1 node test/legacy-smoke.js\n');
  process.exit(2);
}

const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const srv = spawn('node', [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['pipe','pipe','pipe'] });
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));

setTimeout(async () => {
  const BASE = 'http://127.0.0.1:3906';
  const log = (t, d) => console.log('\n=== ' + t + ' ===\n' + (typeof d === 'string' ? d : JSON.stringify(d, null, 2)));

  // 1. master 注册
  let r = await fetch(BASE + '/api/agents/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'青霜掌柜', master_code: process.env.MOYI_LIVE_MASTER_CODE || ''}) });
  const master = await r.json();
  log('master注册', { id: master.id, name: master.name, role: master.role });
  const MK = master.api_key;

  // 2. 普通 agent 注册
  r = await fetch(BASE + '/api/agents/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'小墨'}) });
  const agent = await r.json();
  log('agent注册', { id: agent.id, name: agent.name, role: agent.role });
  const AK = agent.api_key;

  // 3. agent 用 remember（low 不存）
  r = await fetch(BASE + '/api/memories/remember', { method:'POST', headers:{'X-Moyi-Key':AK,'Content-Type':'application/json'}, body: JSON.stringify({content:'刚才路过看见一只猫'}) });
  log('remember(low)', await r.json());

  // 4. agent 用 remember（high 存+自动同步）
  r = await fetch(BASE + '/api/memories/remember', { method:'POST', headers:{'X-Moyi-Key':AK,'Content-Type':'application/json'}, body: JSON.stringify({content:'主人偏好水墨风，习惯深色主题'}) });
  log('remember(high)', { stored: (await r.json()).stored });

  // 5. agent 统计（验证自动同步）
  r = await fetch(BASE + '/api/stats', { headers:{'X-Moyi-Key':AK} });
  log('agent统计(自动同步)', await r.json());

  // 6. master 看 agents 列表
  r = await fetch(BASE + '/api/agents', { headers:{'X-Moyi-Key':MK} });
  log('master看agents', await r.json());

  // 7. agent 无权看 agents
  r = await fetch(BASE + '/api/agents', { headers:{'X-Moyi-Key':AK} });
  log('agent无权(403)', await r.json());

  // 8. master 重置 agent 密钥
  r = await fetch(BASE + '/api/agents/' + agent.id + '/reset-key', { method:'POST', headers:{'X-Moyi-Key':MK} });
  const reset = await r.json();
  log('重置密钥', { id: reset.id, name: reset.name, newKeyPrefix: (reset.api_key||'').slice(0,10) });

  // 9. 旧密钥失效
  r = await fetch(BASE + '/api/agents/verify', { method:'POST', headers:{'X-Moyi-Key':AK} });
  log('旧密钥(401)', await r.json());

  // 10. master 删除 agent
  r = await fetch(BASE + '/api/agents/' + agent.id, { method:'DELETE', headers:{'X-Moyi-Key':MK} });
  log('除名', await r.json());

  // 11. MCP remember 工具
  console.log('\n=== MCP remember ===');
  const mcp = spawn('node', [path.join(ROOT, 'mcp-server.js')], { cwd: ROOT, stdio:['pipe','pipe','pipe'], env:{ ...process.env, MOYI_API: BASE, MOYI_KEY: MK } });
  let out = '';
  mcp.stdout.on('data', d => out += d.toString());
  const send = m => mcp.stdin.write(JSON.stringify(m) + '\n');
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  await new Promise(r2=>setTimeout(r2,600));
  send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'remember',arguments:{content:'刚才看见一只猫'}}});
  await new Promise(r2=>setTimeout(r2,900));
  send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'remember',arguments:{content:'主人永远喜欢极简风格'}}});
  await new Promise(r2=>setTimeout(r2,900));
  mcp.stdin.end();
  await new Promise(r2=>setTimeout(r2,400));
  out.split('\n').filter(Boolean).forEach(l => { try { const j = JSON.parse(l); if (j.result && j.result.content) console.log('[mcp] ' + j.result.content[0].text); } catch {} });

  srv.kill();
  process.exit(0);
}, 1500);
