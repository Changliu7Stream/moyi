/**
 * lib/webentry.js 冒烟测试（不需要真实数据库、不需要 Cloudflare 环境）。
 *
 * 关键验证点：lib/moyi.js 在**加载时**读 process.env 定死 SUPA_URL/BACKEND，
 * 所以 ensureRoute 必须「先把 env 拷进 process.env，再 require moyi.js」。
 * 若顺序反了，moyi 顶层常量固化成空值，线上每个请求都会「服务端未配置」500。
 *
 * 用一个干净子进程证明这条时序对全新进程成立：喂假 env → 断言已缓存的
 * moyi.SUPA_URL 反映的正是喂进去的值。（不 mock route 内部，也不在生产代码里
 * 留任何桩分支；handleRequest 的分支覆盖由 test/webadapter.js 负责。）
 */
'use strict';

function child() {
  // 子进程：证明「先拷 env 再 require」的时序对全新进程成立。
  const { spawnSync } = require('child_process');
  const script = `
    const { ensureRoute } = require('./lib/webentry.js');
    (async () => {
      const route = await ensureRoute({
        MOYI_DB_BACKEND: 'supabase',
        MOYI_DB_URL: 'https://proj-x.supabase.co',
        MOYI_DB_TOKEN: 'service-role-abc',
        MOYI_CODE: 'open-sesame',
      });
      if (typeof route !== 'function') throw new Error('route 未导出/未就绪');
      const m = require('./lib/moyi.js');
      if (m.SUPA_URL !== 'https://proj-x.supabase.co')
        throw new Error('SUPA_URL 固化错: ' + m.SUPA_URL);
      if (m.CONSOLE && process.env.MOYI_CODE !== 'open-sesame')
        throw new Error('MOYI_CODE 未拷入');
      console.log('OK');
    })().catch(e => { console.error(e.message); process.exit(1); });
  `;
  const childEnv = Object.assign({}, process.env);
  // 抹掉可能已存在的同名变量，确保是 env 参数喂进去才生效。
  // 必须 delete（而不是设成 ''）：ensureRoute 只在 process.env[k] === undefined
  // 时才写入，留成空串会让它跳过、测不到「先拷 env 再 require」这条时序。
  for (const k of ['MOYI_DB_URL', 'MOYI_DB_TOKEN', 'MOYI_DB_BACKEND', 'MOYI_CODE',
    'SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_ANON_KEY', 'MASTER_CODE']) {
    delete childEnv[k];
  }
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..'),
    env: childEnv,
    encoding: 'utf8',
  });
  return r;
}

console.log('webentry 冒烟测试');
let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { console.log('  ok   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); fail++; }
}

const r = child();
const out = (r.stdout || '').trim();
const err = (r.stderr || '').trim();
t('ensureRoute：env 在 require 前拷入 → moyi 顶层常量正确', r.status === 0 && out === 'OK',
  'status=' + r.status + ' stdout=' + JSON.stringify(out) + ' stderr=' + JSON.stringify(err));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
