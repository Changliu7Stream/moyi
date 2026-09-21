/**
 * 墨忆 · 管理台
 *
 * 三条实现约束，都是被这里的场景逼出来的，不是风格偏好：
 *  1. 页面该显示什么由 /console/status 决定，不由本地存的那个标记决定 ——
 *     引导页是一次性的，服务端说装好了就永远不再出现，防止「清 localStorage
 *     就能重跑安装器」这类想当然的绕过。
 *  2. 所有写请求都带 X-Moyi-Console: 1。会话 Cookie 是 SameSite=Lax（跨站 POST
 *     不带 Cookie；用 Lax 而非 Strict 是为了让 MCP 浏览器授权的顶层跳转能带上它），
 *     这一头是第二道闸：跨站表单发不出自定义头，跨站 fetch 又要过 CORS 白名单。
 *  3. 这里拿不到任何记忆正文。管理台只显示条数 —— 管理员是「管工具的人」，
 *     不是「读别人日记的人」。想看内容得用那个 Agent 自己的 key。
 */
(function () {
'use strict';

var API = '/api/console';
var $ = function (id) { return document.getElementById(id); };

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function api(path, method, body) {
  var opts = { method: method || 'GET', headers: {}, credentials: 'same-origin' };
  if (method && method !== 'GET') {
    opts.headers['X-Moyi-Console'] = '1';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  return fetch(API + path, opts).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (d) {
      if (!r.ok) {
        var e = new Error((d && (d.error || d.hint)) || '请求失败（' + r.status + '）');
        e.status = r.status; e.data = d;
        throw e;
      }
      return d;
    });
  });
}

function say(el, msg, isErr) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
  if (isErr !== undefined) el.classList.toggle('notice', !isErr);
}

function show(view) {
  ['setupView', 'loginView', 'panelView'].forEach(function (v) {
    $(v).classList.toggle('hidden', v !== view);
  });
}

var ME = { role: null, username: null, isSuper: false };

// ── 引导安装：只在服务端确认「未安装」时出现 ──────────
function bootSetup() {
  show('setupView');
  $('suBtn').addEventListener('click', function () {
    var btn = $('suBtn');
    btn.disabled = true;
    say($('setupErr'), '', true);
    api('/setup', 'POST', {
      username: $('suUser').value.trim(),
      password: $('suPass').value,
      instance_name: $('suName').value.trim(),
      open_register: $('suOpenReg').checked,
    }).then(function () {
      // 装好即进面板；引导页此后再无入口
      location.reload();
    }).catch(function (e) {
      btn.disabled = false;
      say($('setupErr'), e.message, true);
    });
  });
}

function bootLogin(st) {
  show('loginView');
  $('loginDesc').textContent = (st && st.instance_name ? st.instance_name : '墨忆') + ' · 管理台登录';
  var go = function () {
    var btn = $('liBtn');
    btn.disabled = true;
    say($('loginErr'), '', true);
    api('/login', 'POST', { username: $('liUser').value.trim(), password: $('liPass').value })
      .then(function () { location.reload(); })
      .catch(function (e) { btn.disabled = false; say($('loginErr'), e.message, true); });
  };
  $('liBtn').addEventListener('click', go);
  $('liPass').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
}

// ── 面板 ─────────────────────────────────────────────
function switchPane(name) {
  ['agents', 'skills', 'users', 'sessions', 'settings'].forEach(function (n) {
    $('cp-' + n).classList.toggle('hidden', n !== name);
  });
  document.querySelectorAll('.c-tabs .tab-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-cp') === name);
  });
  if (name === 'agents') loadAgents();
  if (name === 'skills') loadSkills();
  if (name === 'users') loadAdmins();
  if (name === 'sessions') loadSessions();
  if (name === 'settings') loadSettings();
}

function loadAgents() {
  api('/agents').then(function (d) {
    var rows = (d.agents || []).map(function (a) {
      return '<div class="c-row">'
        + '<div class="c-row-main"><strong>' + esc(a.name) + '</strong>'
        + '<span class="c-badge ' + (a.role === 'master' ? 'master' : '') + '">'
        + (a.role === 'master' ? '掌柜' : 'Agent') + '</span></div>'
        + '<div class="c-row-meta">' + esc(a.memory_count || 0) + ' 条记忆</div>'
        + '<div class="c-row-act">'
        + '<button class="btn btn-ghost btn-sm" data-rot="' + esc(a.id) + '">换钥</button> '
        + '<button class="btn btn-danger btn-sm" data-del="' + esc(a.id) + '" data-nm="' + esc(a.name) + '">除名</button>'
        + '</div></div>';
    }).join('');
    $('agList').innerHTML = rows || '<p class="field-note">尚无 Agent。</p>';
    $('agList').querySelectorAll('[data-rot]').forEach(function (b) {
      b.addEventListener('click', function () { rotateKey(b.getAttribute('data-rot')); });
    });
    $('agList').querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        delAgent(b.getAttribute('data-del'), b.getAttribute('data-nm'));
      });
    });
  }).catch(function (e) { say($('agList'), e.message); });
}

function renderKey(d) {
  $('agKey').classList.remove('hidden');
  $('agKeyCode').textContent = d.api_key || '';
  $('agCfg').textContent = d.mcp_config || '';
}

function rotateKey(id) {
  if (!confirm('换新钥后旧钥立即失效，正在使用它的工具会连不上。继续？')) return;
  api('/agents/' + encodeURIComponent(id) + '/reset-key', 'POST', {}).then(renderKey)
    .catch(function (e) { alert(e.message); });
}

function delAgent(id, name) {
  if (!confirm('除名「' + name + '」会连带删除它的记忆，且不可恢复。确认？')) return;
  api('/agents/' + encodeURIComponent(id), 'DELETE', {}).then(loadAgents)
    .catch(function (e) { alert(e.message); });
}

// ── 技能层 ───────────────────────────────────────────
/*
 * 这一页是公共层的唯一写入口，所以它的责任也被刻意收窄：
 *  - 列表不含正文（服务端就不返回 content），要看正文必须逐条「查看」再拉一次。
 *    这样「一眼扫过 200 条技能」不会顺手把 200 份指令读进编辑器里改。
 *  - 只有「发布」这一个动作能让技能对所有 Agent 生效，所以它是独立按钮，
 *    不与保存合并 —— 保存草稿和放行发布是两件事。
 */
var SK_FILTER = '';

function loadSkills() {
  api('/skills').then(function (d) {
    $('skLocked').classList.add('hidden');
    var hosts = d.fetch_hosts || [];
    $('skHosts').textContent = '只允许白名单内的主机：' + (hosts.join('、') || '（未配置）')
      + '。要接内部 GitLab，请在服务端设 MOYI_SKILL_URL_HOSTS。';
    var c = d.counts || {};
    document.querySelectorAll('#skFilter .chip').forEach(function (b) {
      var k = b.getAttribute('data-sk');
      var n = k ? (c[k] || 0) : (d.skills || []).length;
      if (!b.getAttribute('data-label')) b.setAttribute('data-label', b.textContent);
      b.textContent = b.getAttribute('data-label') + ' (' + n + ')';
    });
    renderSkills(d.skills || []);
  }).catch(function (e) {
    $('skList').innerHTML = '';
    say($('skLocked'), e.status === 409
      ? '未找到 skills 表：请先执行 sql/00-schema.sql（Supabase 还要执行 sql/vector-search.sql）后重启。'
      : e.message, false);
    $('skLocked').classList.remove('hidden');
  });
}

var ORIGIN_CN = { console: '管理台', agent: 'Agent 提交', url: 'URL 导入' };

function renderSkills(all) {
  var rows = all.filter(function (s) { return !SK_FILTER || s.status === SK_FILTER; });
  var html = rows.map(function (s) {
    var badge = s.status === 'published' ? '<span class="c-badge on">已发布</span>'
      : s.status === 'draft' ? '<span class="c-badge master">待审草稿</span>'
      : '<span class="c-badge off">已否决</span>';
    return '<div class="c-row">'
      + '<div class="c-row-main"><strong>' + esc(s.name) + '</strong>' + badge
      + '<span class="c-badge">' + esc(ORIGIN_CN[s.origin] || s.origin) + '</span></div>'
      + '<div class="c-row-meta">' + esc(s.description || '（无描述）').slice(0, 40) + '</div>'
      + '<div class="c-row-act">'
      + '<button class="btn btn-ghost btn-sm" data-sk-view="' + esc(s.id) + '">查看</button> '
      + (s.status === 'published'
        ? '<button class="btn btn-ghost btn-sm" data-sk-reject="' + esc(s.id) + '">下架</button> '
        : '<button class="btn btn-primary btn-sm" data-sk-pub="' + esc(s.id) + '" data-nm="' + esc(s.name) + '">发布</button> ')
      + (s.source_url ? '<button class="btn btn-ghost btn-sm" data-sk-refresh="' + esc(s.id) + '">重抓</button> ' : '')
      + '<button class="btn btn-danger btn-sm" data-sk-del="' + esc(s.id) + '" data-nm="' + esc(s.name) + '">删除</button>'
      + '</div></div>';
  }).join('');
  $('skList').innerHTML = html || '<p class="field-note">这里还没有技能。</p>';
  $('skList').querySelectorAll('[data-sk-view]').forEach(function (b) {
    b.addEventListener('click', function () { viewSkill(b.getAttribute('data-sk-view')); });
  });
  $('skList').querySelectorAll('[data-sk-pub]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('发布「' + b.getAttribute('data-nm') + '」后，所有 Agent 都能读到它，等价于向它们下指令。已读过正文？')) return;
      skillAction(b.getAttribute('data-sk-pub'), 'publish');
    });
  });
  $('skList').querySelectorAll('[data-sk-reject]').forEach(function (b) {
    b.addEventListener('click', function () { skillAction(b.getAttribute('data-sk-reject'), 'reject'); });
  });
  $('skList').querySelectorAll('[data-sk-refresh]').forEach(function (b) {
    b.addEventListener('click', function () { refreshSkill(b.getAttribute('data-sk-refresh')); });
  });
  $('skList').querySelectorAll('[data-sk-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('删除技能「' + b.getAttribute('data-nm') + '」？不可恢复。')) return;
      api('/skills/' + encodeURIComponent(b.getAttribute('data-sk-del')), 'DELETE', {})
        .then(loadSkills).catch(function (e) { alert(e.message); });
    });
  });
}

function skillAction(id, act) {
  api('/skills/' + encodeURIComponent(id) + '/' + act, 'POST', {}).then(loadSkills)
    .catch(function (e) { alert(e.message); });
}

function refreshSkill(id) {
  api('/skills/' + encodeURIComponent(id) + '/refresh', 'POST', {}).then(function (d) {
    alert(d.changed ? '已从来源地址更新正文。' : (d.note || '内容未变。'));
    loadSkills();
  }).catch(function (e) { alert(e.message); });
}

// 查看 = 把正文连同名称、描述一起填进编辑区（进入编辑态，保存走 PATCH）
function viewSkill(id) {
  api('/skills/' + encodeURIComponent(id)).then(function (d) {
    var s = d.skill || {};
    $('skEditing').value = s.id || '';
    $('skName').value = s.name || '';
    $('skName').readOnly = true;
    $('skDesc').value = s.description || '';
    $('skContent').value = s.content || '';
    $('skSaveBtn').textContent = '保存修改';
    $('skCancelBtn').classList.remove('hidden');
    $('skNotice').textContent = '正在编辑「' + s.name + '」（' + (s.status === 'published' ? '已发布' : '草稿') + '）。改完点保存。';
    $('skNotice').classList.remove('hidden');
    $('skContent').scrollIntoView({ block: 'center' });
  }).catch(function (e) { alert(e.message); });
}

function resetSkillForm() {
  $('skEditing').value = '';
  $('skName').value = ''; $('skName').readOnly = false;
  $('skDesc').value = ''; $('skContent').value = '';
  $('skSaveBtn').textContent = '发布这份技能';
  $('skCancelBtn').classList.add('hidden');
  $('skNotice').classList.add('hidden');
  say($('skErr'), '', true);
}

function saveSkill() {
  var editing = $('skEditing').value;
  var payload = {
    description: $('skDesc').value.trim(),
    content: $('skContent').value,
  };
  var p;
  if (editing) {
    p = api('/skills/' + encodeURIComponent(editing), 'PATCH', payload);
  } else {
    payload.name = $('skName').value.trim();
    p = api('/skills', 'POST', payload);
  }
  p.then(function () { resetSkillForm(); loadSkills(); })
    .catch(function (e) { say($('skErr'), e.message, true); });
}

function previewSkillUrl() {
  var url = $('skUrl').value.trim();
  if (!url) { say($('skErr'), '先粘一个链接。', true); return; }
  var btn = $('skPreviewBtn');
  btn.disabled = true;
  say($('skErr'), '', true);
  api('/skills/preview', 'POST', { url: url }).then(function (d) {
    btn.disabled = false;
    resetSkillForm();
    // 预览只回前 600 字，绝不能把它当正文存进库。这里只把 name/description
    // 与整份链接填好，真正的正文由「整份导入」时服务端重新抓一次。
    $('skName').value = d.name || '';
    $('skDesc').value = d.description || '';
    $('skSourceUrl').value = d.source_url || url;
    $('skPrev').textContent = '抓到 ' + d.bytes + ' 字节，名称＝' + (d.name || '（待填）')
      + '。核对无误后点「整份导入并发布」，服务端会按原链接重抓全文入库（预览只显示前 600 字）。';
    $('skPrev').classList.remove('hidden');
    $('skUrlSaveBtn').classList.remove('hidden');
  }).catch(function (e) { btn.disabled = false; say($('skErr'), e.message, true); });
}

// 整份导入：只把 URL 交给服务端，由它现抓现存，前端不碰截断过的正文。
function importSkillByUrl() {
  var url = $('skSourceUrl').value || $('skUrl').value.trim();
  if (!url) { say($('skErr'), '先抓取一个预览链接。', true); return; }
  var payload = { source_url: url, name: $('skName').value.trim(), description: $('skDesc').value.trim() };
  say($('skErr'), '', true);
  api('/skills', 'POST', payload).then(function () {
    $('skPrev').classList.add('hidden');
    $('skUrlSaveBtn').classList.add('hidden');
    $('skSourceUrl').value = ''; $('skUrl').value = '';
    resetSkillForm(); loadSkills();
  }).catch(function (e) { say($('skErr'), e.message, true); });
}

function wireSkills() {
  $('skSaveBtn').addEventListener('click', saveSkill);
  $('skCancelBtn').addEventListener('click', resetSkillForm);
  $('skPreviewBtn').addEventListener('click', previewSkillUrl);
  $('skUrlSaveBtn').addEventListener('click', importSkillByUrl);
  document.querySelectorAll('#skFilter .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      SK_FILTER = b.getAttribute('data-sk');
      document.querySelectorAll('#skFilter .chip').forEach(function (x) {
        x.classList.toggle('active', x === b);
      });
      loadSkills();
    });
  });
}

function loadAdmins() {
  api('/admins').then(function (d) {
    $('superWarn').classList.add('hidden');
    var rows = (d.admins || []).map(function (a) {
      return '<div class="c-row">'
        + '<div class="c-row-main"><strong>' + esc(a.username) + '</strong>'
        + '<span class="c-badge">' + (a.role === 'super' ? '超管' : '管理员') + '</span>'
        + (a.disabled ? '<span class="c-badge off">已停用</span>' : '') + '</div>'
        + '<div class="c-row-meta">' + esc((a.created_at || '').slice(0, 10)) + '</div>'
        + '<div class="c-row-act">'
        + '<button class="btn btn-ghost btn-sm" data-pw="' + esc(a.id) + '">置口令</button> '
        + '<button class="btn btn-ghost btn-sm" data-dis="' + esc(a.id) + '" data-v="' + (a.disabled ? '0' : '1') + '">'
        + (a.disabled ? '启用' : '停用') + '</button> '
        + '<button class="btn btn-danger btn-sm" data-adel="' + esc(a.id) + '" data-nm="' + esc(a.username) + '">删除</button>'
        + '</div></div>';
    }).join('');
    $('adList').innerHTML = rows || '<p class="field-note">读取失败。</p>';
    bindAdminRows();
  }).catch(function (e) {
    // 403 = 我是普通管理员：这页对我本就该是只读且不可见的
    $('adList').innerHTML = '';
    say($('superWarn'), e.status === 403 ? '仅超管可查看与增删管理员账号。' : e.message);
  });
}

function bindAdminRows() {
  $('adList').querySelectorAll('[data-dis]').forEach(function (b) {
    b.addEventListener('click', function () {
      api('/admins/' + encodeURIComponent(b.getAttribute('data-dis')), 'PATCH',
        { disabled: b.getAttribute('data-v') === '1' }).then(loadAdmins)
        .catch(function (e) { alert(e.message); });
    });
  });
  $('adList').querySelectorAll('[data-pw]').forEach(function (b) {
    b.addEventListener('click', function () {
      var pw = prompt('为该账号设置新口令（≥10 字符）。该账号的既有会话会全部失效。');
      if (!pw) return;
      api('/admins/' + encodeURIComponent(b.getAttribute('data-pw')) + '/password', 'POST', { password: pw })
        .then(function () { alert('已更新。'); }).catch(function (e) { alert(e.message); });
    });
  });
  $('adList').querySelectorAll('[data-adel]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('删除管理员「' + b.getAttribute('data-nm') + '」？')) return;
      api('/admins/' + encodeURIComponent(b.getAttribute('data-adel')), 'DELETE', {})
        .then(loadAdmins).catch(function (e) { alert(e.message); });
    });
  });
}

function loadSessions() {
  api('/sessions').then(function (d) {
    var rows = (d.sessions || []).map(function (s) {
      return '<div class="c-row">'
        + '<div class="c-row-main"><strong>' + esc(s.username) + '</strong>'
        + (s.current ? '<span class="c-badge">本次</span>' : '') + '</div>'
        + '<div class="c-row-meta">有效至 ' + esc((s.expires_at || '').slice(0, 16).replace('T', ' ')) + '</div>'
        + '<div class="c-row-act"><button class="btn btn-danger btn-sm" data-se="'
        + esc(s.id) + '">撤销</button></div></div>';
    }).join('');
    $('seList').innerHTML = rows || '<p class="field-note">无在线会话。</p>';
    $('seList').querySelectorAll('[data-se]').forEach(function (b) {
      b.addEventListener('click', function () {
        api('/sessions/' + encodeURIComponent(b.getAttribute('data-se')), 'DELETE', {}).then(loadSessions)
          .catch(function (e) { alert(e.message); });
      });
    });
  }).catch(function (e) { say($('seList'), e.message); });
}

function loadSettings() {
  api('/settings').then(function (d) {
    var s = d.settings || {};
    $('stName').value = s.instance_name || '';
    $('stGlobal').checked = s.global_memory === '1';
    $('stReg').checked = s.open_register === '1';
    $('stGlobalNote').textContent = d.can_manage
      ? '开启后所有 Agent 互相「只读」可见对方的记忆；写入、去重合并、删除仍各自独立。'
        + '关掉即恢复彻底隔离。这一改动会立刻影响所有 Agent 的检索结果。'
      : '仅超管可修改。当前为只读视图。';
    ['stName', 'stGlobal', 'stReg', 'stBtn'].forEach(function (id) {
      var el = $(id);
      if (el.type === 'checkbox') el.disabled = !d.can_manage;
      else el.readOnly = !d.can_manage && el.tagName === 'INPUT';
    });
    $('stBtn').disabled = !d.can_manage;
    $('stBody').classList.remove('hidden');
    say($('stLocked'), d.db_ready ? '' : '未找到 settings 表：请先执行 sql/00-schema.sql（Supabase 还要执行 sql/vector-search.sql）后重启。', false);
    $('stLocked').classList.toggle('hidden', !!d.db_ready);
  }).catch(function (e) { say($('stLocked'), e.message, true); });
}

function enterPanel() {
  show('panelView');
  $('whoami').textContent = ME.username + (ME.isSuper ? ' · 超管' : ' · 管理员');
  if (!ME.isSuper) {
    document.querySelectorAll('.c-tabs .tab-btn').forEach(function (b) {
      if (b.getAttribute('data-cp') === 'users') b.classList.add('hidden');
    });
  }
  switchPane('agents');
}

// ── 事件绑定 ─────────────────────────────────────────
function wirePanel() {
  document.querySelectorAll('.c-tabs .tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { switchPane(b.getAttribute('data-cp')); });
  });
  wireSkills();
  $('agBtn').addEventListener('click', function () {
    var n = $('agName').value.trim();
    if (!n) { alert('先给 Agent 起个名字'); return; }
    api('/agents', 'POST', { name: n }).then(function (d) {
      $('agName').value = '';
      renderKey(d); loadAgents();
    }).catch(function (e) { alert(e.message); });
  });
  $('agCopy').addEventListener('click', function () {
    var t = $('agKeyCode').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t);
    else { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  });
  $('adBtn').addEventListener('click', function () {
    api('/admins', 'POST', {
      username: $('adUser').value.trim(), password: $('adPass').value, role: $('adRole').value,
    }).then(function () {
      $('adUser').value = ''; $('adPass').value = ''; loadAdmins();
    }).catch(function (e) { alert(e.message); });
  });
  $('myPwBtn').addEventListener('click', function () {
    api('/me/password', 'POST', { current_password: $('myOld').value, password: $('myNew').value })
      .then(function (d) { $('myOld').value = ''; $('myNew').value = ''; alert(d.note || '已更新'); })
      .catch(function (e) { alert(e.message); });
  });
  $('stBtn').addEventListener('click', function () {
    api('/settings', 'PATCH', {
      instance_name: $('stName').value.trim() || '墨忆',
      global_memory: $('stGlobal').checked ? '1' : '0',
      open_register: $('stReg').checked ? '1' : '0',
    }).then(function () { say($('stErr'), ''); loadSettings(); })
      .catch(function (e) { say($('stErr'), e.message, true); });
  });
  $('outBtn').addEventListener('click', function () {
    api('/logout', 'POST', {}).then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  });
}

// ── 启动：一切由服务端状态决定 ───────────────────────
api('/status').then(function (st) {
  if (st.needs_setup) return bootSetup();
  if (st.authenticated) {
    ME.username = st.username; ME.role = st.role; ME.isSuper = st.role === 'super';
    wirePanel();
    return enterPanel();
  }
  if (!st.db_ready) {
    show('loginView');
    say($('loginErr'), '数据库尚未初始化：请先执行迁移 SQL（见 README「快速开始」）。', true);
    $('liBtn').disabled = true;
    return;
  }
  bootLogin(st);
}).catch(function () {
  show('loginView');
  say($('loginErr'), '无法连接服务：确认后端已启动。', true);
});

})();
