/**
 * 墨忆 v2 — 前端逻辑
 * 注册 / 登录 / 只读账本 / MCP 配置
 */
const $ = id => document.getElementById(id);
let KEY = localStorage.getItem('moyi_key') || '';
let agentInfo = JSON.parse(localStorage.getItem('moyi_agent') || 'null');
let currentFilter = '', currentSearch = '';

// ── Tab 切换 ──
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('loginPane').classList.toggle('hidden', b.dataset.tab !== 'login');
    $('registerPane').classList.toggle('hidden', b.dataset.tab !== 'register');
    $('authErr').classList.add('hidden');
    $('keyResult').classList.add('hidden');
  });
});

// ── 注册 ──
$('registerBtn').addEventListener('click', async () => {
  const name = $('regName').value.trim();
  if (!name) return showAuthErr('请填写 Agent 名称');
  try {
    const r = await fetch('/api/agents/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name}) });
    const d = await r.json();
    if (d.error) return showAuthErr(d.error);
    $('newKey').textContent = d.api_key;
    $('keyResult').classList.remove('hidden');
    KEY = d.api_key;
    agentInfo = { id: d.id, name: d.name };
  } catch(e) { showAuthErr('网络错误: ' + e.message); }
});

$('copyKeyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('newKey').textContent).then(() => {
    const b = $('copyKeyBtn'); const o = b.textContent; b.textContent = '已复制'; setTimeout(()=>b.textContent=o,1500);
  });
});

$('enterBtn').addEventListener('click', () => {
  localStorage.setItem('moyi_key', KEY);
  localStorage.setItem('moyi_agent', JSON.stringify(agentInfo));
  enterApp();
});

// ── 登录 ──
$('loginBtn').addEventListener('click', async () => {
  const key = $('loginKey').value.trim();
  if (!key) return showAuthErr('请输入 API Key');
  try {
    const r = await fetch('/api/agents/verify', { method:'POST', headers:{'X-Moyi-Key':key} });
    const d = await r.json();
    if (d.error) return showAuthErr(d.error);
    KEY = key; agentInfo = { id: d.id, name: d.name, role: d.role, created_at: d.created_at };
    localStorage.setItem('moyi_key', KEY);
    localStorage.setItem('moyi_agent', JSON.stringify(agentInfo));
    enterApp();
  } catch(e) { showAuthErr('网络错误: ' + e.message); }
});

$('loginKey').addEventListener('keydown', e => { if (e.key==='Enter') $('loginBtn').click(); });

function showAuthErr(msg) { const el = $('authErr'); el.textContent = msg; el.classList.remove('hidden'); }

// ── 进入应用 ──
function enterApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('agentName').textContent = agentInfo.name;
  const isMaster = agentInfo.role === 'master';
  $('roleBadge').classList.toggle('hidden', !isMaster);
  $('agentsBtn').classList.toggle('hidden', !isMaster);
  loadStats(); loadList();
}

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('moyi_key'); localStorage.removeItem('moyi_agent');
  KEY=''; agentInfo=null;
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('loginKey').value=''; $('regName').value='';
  $('keyResult').classList.add('hidden');
});

// ── API ──
async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'X-Moyi-Key': KEY } };
  if (body) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const r = await fetch(path, opts);
  return r.json();
}

// ── 统计 ──
async function loadStats() {
  const s = await api('/api/stats');
  $('statTotal').textContent = s.total;
  $('statHigh').textContent = s.high;
  $('statMedium').textContent = s.medium;
  $('statLow').textContent = s.low;
  $('statSynced').textContent = s.synced;
}

// ── 列表 ──
async function loadList() {
  let p = '/api/memories';
  if (currentFilter === 'unsynced') p += '?synced=false';
  else if (currentFilter) p += '?importance=' + currentFilter;
  if (currentSearch) p += (p.includes('?')?'&':'?') + 'q=' + encodeURIComponent(currentSearch);
  const d = await api(p);
  let mems = d.memories || [];
  if (currentFilter === 'unsynced') mems = mems.filter(m => !m.synced);
  renderList(mems);
}

function renderList(mems) {
  if (!mems.length) {
    $('memoryList').innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>尚无记忆。Agent 会通过 MCP 自行存取。</p></div>';
    return;
  }
  const impL = {high:'重要',medium:'常态',low:'轻微'};
  $('memoryList').innerHTML = mems.map(m => {
    const ic = m.importance||'low';
    const tags = (m.tags||[]).slice(0,3).map(t=>`<span class="card-tag">#${esc(t)}</span>`).join('');
    return `<div class="memory-card fade-in" data-id="${m.id}">
      <div class="imp-bar ${ic}"></div>
      <div class="card-summary">${esc(m.summary||m.content.slice(0,80))}</div>
      <div class="card-meta">
        <span class="sync-badge ${m.synced?'synced':'unsynced'}">${m.synced?'已同步':'未同步'}</span>
        ${tags}
        <span>${fmt(m.created_at)}</span>
        <span>来源: ${esc(m.source||'未知')}</span>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.memory-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

// ── 详情 ──
let curId = null;
async function openDetail(id) {
  const m = await api('/api/memories/'+id);
  curId = id;
  const ic = m.importance||'low';
  $('detailImportance').className = 'importance-badge '+ic;
  $('detailImportance').textContent = {high:'重要',medium:'常态',low:'轻微'}[ic]||'轻微';
  $('detailTime').textContent = fmt(m.created_at);
  $('detailSync').className = 'sync-badge '+(m.synced?'synced':'unsynced');
  $('detailSync').textContent = m.synced?'已同步':'未同步';
  $('detailContent').textContent = m.content;
  $('detailTags').innerHTML = (m.tags||[]).map(t=>`<span class="tag-chip">#${esc(t)}</span>`).join('');
  $('detailMeta').textContent = `ID: ${m.id} · 访问 ${m.access_count||0} 次 · 来源: ${esc(m.source||'未知')}`;
  $('detailModal').classList.remove('hidden');
}

$('closeModal').addEventListener('click', () => $('detailModal').classList.add('hidden'));
$('detailModal').querySelector('.modal-backdrop').addEventListener('click', () => $('detailModal').classList.add('hidden'));
$('detailDeleteBtn').addEventListener('click', async () => {
  await api('/api/memories/'+curId, 'DELETE');
  $('detailModal').classList.add('hidden');
  loadStats(); loadList();
});

// ── 搜索/筛选 ──
$('searchBtn').addEventListener('click', () => { currentSearch = $('searchInput').value.trim(); loadList(); });
$('searchInput').addEventListener('keydown', e => { if (e.key==='Enter') { currentSearch=e.target.value.trim(); loadList(); } });
document.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  currentFilter = b.dataset.filter;
  loadList();
}));
$('syncAllBtn').addEventListener('click', async () => {
  const r = await api('/api/sync/batch','POST');
  loadStats(); loadList();
  const b=$('syncAllBtn'); const o=b.textContent;
  b.textContent = r.synced ? `已同步 ${r.synced} 条` : '无可同步项';
  setTimeout(()=>b.textContent=o, 2000);
});

// ── MCP 配置弹窗 ──
$('mcpCfgBtn').addEventListener('click', () => {
  const cfg = {
    mcpServers: {
      moyi: {
        command: 'node',
        args: ['/workspace/moyi/mcp-server.js'],
        env: { MOYI_API: location.origin, MOYI_KEY: KEY }
      }
    }
  };
  $('mcpConfig').textContent = JSON.stringify(cfg, null, 2);
  $('moyiUrl').textContent = location.origin;
  $('mcpModal').classList.remove('hidden');
});
$('closeMcp').addEventListener('click', () => $('mcpModal').classList.add('hidden'));
$('mcpModal').querySelector('.modal-backdrop').addEventListener('click', () => $('mcpModal').classList.add('hidden'));
$('copyCfgBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('mcpConfig').textContent).then(()=>{
    const b=$('copyCfgBtn'); const o=b.textContent; b.textContent='已复制'; setTimeout(()=>b.textContent=o,1500);
  });
});

// ── Agent 管理（掌柜）──
$('agentsBtn').addEventListener('click', async () => {
  $('agentsModal').classList.remove('hidden');
  await loadAgents();
});
$('closeAgents').addEventListener('click', () => $('agentsModal').classList.add('hidden'));
$('agentsModal').querySelector('.modal-backdrop').addEventListener('click', () => $('agentsModal').classList.add('hidden'));

async function loadAgents() {
  const r = await api('/api/agents');
  const list = r.agents || [];
  if (!list.length) {
    $('agentsList').innerHTML = '<p class="empty-hint">尚无其他 Agent。</p>';
    return;
  }
  $('agentsList').innerHTML = list.map(a => `
    <div class="agent-row" data-id="${a.id}">
      <div class="agent-info">
        <span class="agent-nm">${esc(a.name)}</span>
        ${a.role === 'master' ? '<span class="role-badge">掌柜</span>' : ''}
        <span class="agent-cnt">${a.memory_count} 条记忆</span>
        <span class="agent-date">${fmt(a.created_at)} 注册</span>
      </div>
      <div class="agent-actions">
        ${a.id !== agentInfo.id ? '<button class="btn btn-ghost btn-sm act-reset">重置密钥</button><button class="btn btn-danger btn-sm act-del">除名</button>' : '<span class="agent-self">当前</span>'}
      </div>
    </div>
  `).join('');

  $('agentsList').querySelectorAll('.act-reset').forEach(b => b.addEventListener('click', async e => {
    const id = e.target.closest('.agent-row').dataset.id;
    const r = await api('/api/agents/' + id + '/reset-key', 'POST');
    if (r.error) return alert(r.error);
    $('resetKey').textContent = r.api_key;
    $('agentsModal').classList.add('hidden');
    $('resetModal').classList.remove('hidden');
  }));
  $('agentsList').querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async e => {
    const id = e.target.closest('.agent-row').dataset.id;
    if (!confirm('确定除名？该 Agent 的全部记忆将一并抹去。')) return;
    await api('/api/agents?id=' + id, 'DELETE');
    await loadAgents();
  }));
}
$('closeReset').addEventListener('click', () => $('resetModal').classList.add('hidden'));
$('resetModal').querySelector('.modal-backdrop').addEventListener('click', () => $('resetModal').classList.add('hidden'));
$('copyResetBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('resetKey').textContent).then(()=>{
    const b=$('copyResetBtn'); const o=b.textContent; b.textContent='已复制'; setTimeout(()=>b.textContent=o,1500);
  });
});

// ── 工具 ──
function fmt(iso){const d=new Date(iso);const n=new Date();const s=(n-d)/1000;
  if(s<60)return'刚刚';if(s<3600)return Math.floor(s/60)+'分钟前';
  if(s<86400)return Math.floor(s/3600)+'小时前';
  if(s<604800)return Math.floor(s/86400)+'天前';
  return `${d.getMonth()+1}月${d.getDate()}日`;}
function esc(s){if(!s)return'';return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── 启动 ──
if (KEY && agentInfo) {
  // 验证已存 key 是否仍有效
  fetch('/api/agents/verify', { method:'POST', headers:{'X-Moyi-Key':KEY} })
    .then(r => r.json())
    .then(d => { if (!d.error) enterApp(); })
    .catch(()=>{});
}
