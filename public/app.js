/**
 * 墨忆 v3.1 — 前端逻辑
 * 注册 / 登录 / 只读账本 / 图谱 / 衰减体检 / 审计簿 / MCP 配置
 */
const $ = id => document.getElementById(id);
let KEY = localStorage.getItem('moyi_key') || '';
let agentInfo = JSON.parse(localStorage.getItem('moyi_agent') || 'null');
let currentFilter = '', currentSearch = '';
let decayPreview = null; // 缓存衰减体检结果，供详情弹窗使用

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
    if (!r.ok) return showAuthErr(d.error || d.hint || '注册失败（' + r.status + '）');
    if (d.error) return showAuthErr(d.error);
    $('newKey').textContent = d.api_key;
    $('keyResult').classList.remove('hidden');
    KEY = d.api_key;
    agentInfo = { id: d.id, name: d.name, role: d.role, created_at: d.created_at };
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
    if (!r.ok) return showAuthErr(d.error || '登录失败（' + r.status + '）');
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
  $('auditBtn').classList.toggle('hidden', !isMaster);
  loadStats(); loadList();
}

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('moyi_key'); localStorage.removeItem('moyi_agent');
  KEY=''; agentInfo=null; decayPreview=null;
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('loginKey').value=''; $('regName').value='';
  $('keyResult').classList.add('hidden');
});

// ── API（统一错误处理）──
async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'X-Moyi-Key': KEY } };
  if (body) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const r = await fetch(path, opts);
  let d;
  try { d = await r.json(); } catch(_) { d = null; }
  if (!r.ok) {
    const err = new ApiError(r.status, d && (d.error || d.hint) || null);
    err.data = d;
    throw err;
  }
  return d;
}
function ApiError(status, msg) {
  this.status = status;
  this.message = msg || apiStatusMsg(status);
}
ApiError.prototype = Object.create(Error.prototype);
function apiStatusMsg(s) {
  if (s === 401) return '密钥无效或已失效';
  if (s === 403) return '权限不足';
  if (s === 429) return '请求过于频繁，请稍后再试';
  if (s === 502) return '存储层连接失败';
  if (s >= 500) return '服务器内部错误';
  return '请求失败（' + s + '）';
}
function showApiErr(err, fallback) {
  const msg = err instanceof ApiError ? err.message : (err.message || fallback || '未知错误');
  alert(msg);
}

// ── 统计 ──
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('statTotal').textContent = s.total;
    $('statHigh').textContent = s.high;
    $('statMedium').textContent = s.medium;
    $('statLow').textContent = s.low;
    $('statSynced').textContent = s.synced;
  } catch(e) { showApiErr(e, '统计加载失败'); }
}

// ── 列表 ──
async function loadList() {
  let p = '/api/memories';
  if (currentFilter === 'unsynced') p += '?synced=false';
  else if (currentFilter) p += '?importance=' + currentFilter;
  if (currentSearch) p += (p.includes('?')?'&':'?') + 'q=' + encodeURIComponent(currentSearch);
  try {
    const d = await api(p);
    let mems = d.memories || d.results || [];
    if (currentFilter === 'unsynced') mems = mems.filter(m => !m.synced);
    // 搜索透明度
    renderSearchMeta(d);
    renderList(mems);
  } catch(e) {
    showApiErr(e, '记忆列表加载失败');
    // 不清空列表
  }
}

function renderSearchMeta(d) {
  const el = $('searchMeta');
  if (!currentSearch || !d || !d.mode) { el.classList.add('hidden'); el.textContent = ''; return; }
  const parts = [];
  const modeLabels = { hybrid:'混合检索', keyword:'关键词检索', empty:'无结果', none:'未输入' };
  parts.push(modeLabels[d.mode] || d.mode);
  if (d.search_backend === 'pgvector') parts.push('向量检索');
  else if (d.search_backend === 'scan') parts.push('扫描 ' + (d.scanned||0) + ' 条');
  if (d.decay === 'on') parts.push('衰减生效');
  else if (d.decay === 'off') parts.push('衰减未启');
  el.textContent = parts.join(' · ');
  el.classList.remove('hidden');
}

function renderList(mems) {
  if (!mems.length) {
    $('memoryList').innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>尚无记忆。Agent 会通过 MCP 自行存取。</p></div>';
    return;
  }
  const impL = {high:'重要',medium:'常态',low:'轻微'};
  $('memoryList').innerHTML = mems.map(m => {
    const ic = m.importance||'low';
    const summary = m.summary || (m.content ? m.content.slice(0,80) : '—');
    const tags = (m.tags||[]).slice(0,3).map(t=>`<span class="card-tag">#${esc(t)}</span>`).join('');
    const scoreStr = (m._score != null) ? `<span class="score-badge">分 ${esc(String(m._score))}</span>` : '';
    return `<div class="memory-card fade-in" data-id="${esc(m.id)}">
      <div class="imp-bar ${ic}"></div>
      <div class="card-summary">${esc(summary)}</div>
      <div class="card-meta">
        <span class="sync-badge ${m.synced?'synced':'unsynced'}">${m.synced?'已同步':'未同步'}</span>
        ${tags}
        <span>${fmt(m.created_at)}</span>
        <span>来源: ${esc(m.source||'未知')}</span>
        ${scoreStr}
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.memory-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

// ── 详情 ──
let curId = null;
async function openDetail(id) {
  try {
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
    $('detailMeta').textContent = `ID: ${esc(m.id)} · 访问 ${m.access_count||0} 次 · 来源: ${esc(m.source||'未知')}`;
    // 活力信息
    renderDetailVitality(m);
    $('detailModal').classList.remove('hidden');
  } catch(e) { showApiErr(e, '详情加载失败'); }
}

function renderDetailVitality(m) {
  const el = $('detailVitality');
  // 先尝试从缓存的 decayPreview 中匹配
  let info = null;
  if (decayPreview) {
    const all = (decayPreview.would_downgrade||[]).concat(decayPreview.would_forget||[]);
    const hit = all.find(x => x.id === m.id);
    if (hit) info = hit;
  }
  if (info) {
    el.textContent = `活力 ${info.vitality != null ? info.vitality : '—'} · 衰减 ${info.decay != null ? info.decay : '—'} · 距今 ${info.age_days != null ? info.age_days + ' 天' : '—'}`;
    el.classList.add('has-data');
  } else if (m.updated_at || m.created_at) {
    // 有记忆数据但不在 preview 里，显示已知字段或 —
    const ageDays = m.created_at ? Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000) : null;
    el.textContent = `活力 — · 衰减 — · 距今 ${ageDays != null ? ageDays + ' 天' : '—'}`;
    el.classList.add('has-data');
  } else {
    el.textContent = '活力 — · 衰减 — · 距今 —';
    el.classList.remove('has-data');
  }
}

$('closeModal').addEventListener('click', () => $('detailModal').classList.add('hidden'));
$('detailModal').querySelector('.modal-backdrop').addEventListener('click', () => $('detailModal').classList.add('hidden'));
$('detailDeleteBtn').addEventListener('click', async () => {
  if (!confirm('确定抹去此条记忆？不可恢复。')) return;
  try {
    await api('/api/memories/'+curId, 'DELETE');
    $('detailModal').classList.add('hidden');
    loadStats(); loadList();
  } catch(e) { showApiErr(e, '删除失败'); }
});

// ── 搜索/筛选 ──
$('searchBtn').addEventListener('click', () => { currentSearch = $('searchInput').value.trim(); loadList(); });
$('searchInput').addEventListener('keydown', e => { if (e.key==='Enter') { currentSearch=e.target.value.trim(); loadList(); } });
document.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  currentFilter = b.dataset.filter;
  currentSearch = '';
  $('searchInput').value = '';
  loadList();
}));
$('syncAllBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/sync/batch','POST');
    loadStats(); loadList();
    const b=$('syncAllBtn'); const o=b.textContent;
    b.textContent = r.synced ? `已同步 ${r.synced} 条` : '无可同步项';
    setTimeout(()=>b.textContent=o, 2000);
  } catch(e) { showApiErr(e, '同步失败'); }
});

// ── 视图切换：墨录 / 墨格 ──
$('viewListBtn').addEventListener('click', () => {
  $('viewListBtn').classList.add('active');
  $('viewGraphBtn').classList.remove('active');
  $('listView').classList.remove('hidden');
  $('graphView').classList.add('hidden');
});
$('viewGraphBtn').addEventListener('click', () => {
  $('viewGraphBtn').classList.add('active');
  $('viewListBtn').classList.remove('active');
  $('graphView').classList.remove('hidden');
  $('listView').classList.add('hidden');
  loadGraph();
});

// ── 墨格：力导向图谱 ──
let graphFocus = null;

async function loadGraph(focus) {
  const container = $('graphContainer');
  const isolated = $('isolatedSection');
  const tooltip = $('graphTooltip');
  tooltip.classList.add('hidden');
  graphFocus = focus || null;

  container.innerHTML = '<p class="empty-hint">绘图中…</p>';
  isolated.classList.add('hidden');

  let url = '/api/graph?limit=200&min_weight=0.3';
  if (focus) url += '&focus=' + encodeURIComponent(focus);

  let data;
  try {
    data = await api(url);
  } catch(e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>' + esc(e.message || '图谱加载失败') + '</p></div>';
    return;
  }

  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const stats = data.stats || null;

  if (!nodes.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>尚无记忆可绘图谱。Agent 存入记忆后，关联自现。</p></div>';
    return;
  }

  // 分离孤立节点
  const connected = new Set();
  edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
  const isolatedNodes = nodes.filter(n => !connected.has(n.id));
  const graphNodes = nodes.filter(n => connected.has(n.id));

  if (graphNodes.length === 0 && isolatedNodes.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>无有效节点。</p></div>';
    return;
  }

  // 如果只有一条记忆
  if (nodes.length === 1) {
    container.innerHTML = '<div class="empty-state"><div class="empty-circle"></div><p>仅一条记忆，尚无关联。多存几条，墨格自生。</p></div>';
    // 仍显示孤立节点
    renderIsolated(isolatedNodes.length ? isolatedNodes : nodes);
    return;
  }

  // 力导向布局
  const W = 800, H = 600;
  const positions = forceLayout(graphNodes, edges, W, H);

  // 渲染 SVG
  renderGraphSVG(container, graphNodes, edges, positions, W, H, data);

  // 孤立节点
  if (isolatedNodes.length) {
    renderIsolated(isolatedNodes);
  } else {
    isolated.classList.add('hidden');
  }
}

function renderIsolated(nodes) {
  const section = $('isolatedSection');
  const list = $('isolatedList');
  section.classList.remove('hidden');
  list.innerHTML = nodes.map(n => {
    const ic = n.importance || 'low';
    return `<div class="isolated-card" data-id="${esc(n.id)}">
      <div class="imp-bar ${ic}"></div>
      <span class="card-summary">${esc(n.summary || '—')}</span>
      <span class="importance-badge ${ic}">${{high:'重要',medium:'常态',low:'轻微'}[ic]||'轻微'}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.isolated-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

function forceLayout(nodes, edges, W, H) {
  const pos = {};
  const cx = W / 2, cy = H / 2;
  // 初始化：圆形分布
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(W, H) * 0.3;
    pos[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), vx: 0, vy: 0 };
  });

  const edgeMap = {};
  edges.forEach(e => {
    if (!edgeMap[e.from]) edgeMap[e.from] = [];
    if (!edgeMap[e.to]) edgeMap[e.to] = [];
    edgeMap[e.from].push({ target: e.to, weight: e.weight });
    edgeMap[e.to].push({ target: e.from, weight: e.weight });
  });

  const TICKS = 120;
  const repulse = 8000;
  const attract = 0.005;
  const center = 0.01;
  const damping = 0.85;

  for (let t = 0; t < TICKS; t++) {
    const temp = 1 - t / TICKS; // 冷却
    // 斥力
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos[nodes[i].id], b = pos[nodes[j].id];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = repulse / (dist * dist) * temp;
        let fx = dx / dist * force, fy = dy / dist * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // 引力（沿边）
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = dist * attract * (0.5 + e.weight * 0.5) * temp;
      let fx = dx / dist * force, fy = dy / dist * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });
    // 居中力
    nodes.forEach(n => {
      const p = pos[n.id];
      p.vx += (cx - p.x) * center * temp;
      p.vy += (cy - p.y) * center * temp;
    });
    // 更新位置
    nodes.forEach(n => {
      const p = pos[n.id];
      p.vx *= damping; p.vy *= damping;
      p.x += p.vx; p.y += p.vy;
      // 边界约束
      p.x = Math.max(30, Math.min(W - 30, p.x));
      p.y = Math.max(30, Math.min(H - 30, p.y));
    });
  }
  return pos;
}

function renderGraphSVG(container, nodes, edges, positions, W, H, data) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 边
  edges.forEach(e => {
    const a = positions[e.from], b = positions[e.to];
    if (!a || !b) return;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#8a8a8a');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-opacity', Math.max(0.15, e.weight).toFixed(2));
    // tooltip: via
    const viaText = (e.via && e.via.length) ? '因 ' + e.via.join('、') + ' 相连' : '';
    if (viaText) {
      line.setAttribute('data-tip', viaText);
      line.classList.add('graph-edge');
    }
    svg.appendChild(line);
  });

  // 节点
  const tooltip = $('graphTooltip');
  nodes.forEach(n => {
    const p = positions[n.id];
    const ic = n.importance || 'low';
    const r = 6 + Math.min(14, (n.degree || 0) * 2);
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y);
    circle.setAttribute('r', r);
    circle.setAttribute('class', 'graph-node ' + ic);
    circle.setAttribute('data-id', n.id);
    circle.setAttribute('data-summary', n.summary || '');
    circle.setAttribute('data-focus', n.id);

    // 悬停 tooltip
    circle.addEventListener('mouseenter', (ev) => {
      const summary = n.summary || '—';
      const viaEdges = edges.filter(e => e.from === n.id || e.to === n.id);
      const viaInfo = viaEdges.slice(0, 3).map(e => {
        const other = e.from === n.id ? e.to : e.from;
        const otherNode = nodes.find(x => x.id === other);
        const viaText = (e.via && e.via.length) ? '（因 ' + e.via.join('、') + '）' : '';
        return '→ ' + (otherNode ? esc(otherNode.summary || other).slice(0, 20) : esc(other).slice(0, 10)) + viaText;
      }).join('<br>');
      tooltip.innerHTML = `<b>${esc(summary.slice(0, 60))}</b><br><span class="importance-badge ${ic}">${{high:'重要',medium:'常态',low:'轻微'}[ic]||''}</span> 度 ${n.degree||0}<br>${viaInfo}<br><button class="btn btn-ghost btn-sm graph-focus-btn" data-focus="${esc(n.id)}">看它的关联</button>`;
      tooltip.classList.remove('hidden');
      positionTooltip(ev);
    });
    circle.addEventListener('mousemove', positionTooltip);
    circle.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));

    // 点击：聚焦
    circle.addEventListener('click', () => {
      tooltip.classList.add('hidden');
      loadGraph(n.id);
    });

    svg.appendChild(circle);
  });

  container.innerHTML = '';
  container.appendChild(svg);

  // 聚焦模式下的返回按钮
  if (data.focus) {
    const back = document.createElement('div');
    back.className = 'graph-back';
    back.innerHTML = '<button class="btn btn-ghost btn-sm" id="graphBackBtn">← 返回全图</button>';
    container.insertBefore(back, container.firstChild);
    $('graphBackBtn').addEventListener('click', () => loadGraph());
  }

  // 边 tooltip 事件
  container.querySelectorAll('.graph-edge').forEach(line => {
    line.addEventListener('mouseenter', (ev) => {
      const tip = line.getAttribute('data-tip');
      if (!tip) return;
      tooltip.textContent = tip;
      tooltip.classList.remove('hidden');
      positionTooltip(ev);
    });
    line.addEventListener('mousemove', positionTooltip);
    line.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

function positionTooltip(ev) {
  const tooltip = $('graphTooltip');
  const x = ev.clientX + 12;
  const y = ev.clientY + 12;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

// ── 衰减体检 ──
$('decayBtn').addEventListener('click', async () => {
  $('decayModal').classList.remove('hidden');
  const body = $('decayBody');
  body.innerHTML = '<p class="empty-hint">体检中…</p>';
  try {
    const d = await api('/api/decay/preview');
    decayPreview = d;
    renderDecayPanel(d);
  } catch(e) {
    body.innerHTML = '<p class="empty-hint">' + esc(e.message || '体检失败') + '</p>';
  }
});
$('closeDecay').addEventListener('click', () => $('decayModal').classList.add('hidden'));
$('decayModal').querySelector('.modal-backdrop').addEventListener('click', () => $('decayModal').classList.add('hidden'));

function renderDecayPanel(d) {
  const body = $('decayBody');
  const downList = d.would_downgrade || [];
  const forgetList = d.would_forget || [];

  let html = '<div class="decay-summary">';
  html += `<div class="decay-stat-row"><span>半衰期</span><b>${d.half_life_days} 天</b></div>`;
  html += `<div class="decay-stat-row"><span>遗忘窗口</span><b>${d.forget_after_days} 天</b></div>`;
  html += `<div class="decay-stat-row"><span>扫描</span><b>${d.scanned} 条</b></div>`;
  html += `<div class="decay-stat-row"><span>固定（pinned）</span><b>${d.pinned} 条</b></div>`;
  html += `<div class="decay-stat-row"><span>保留</span><b>${d.keep} 条</b></div>`;
  html += '</div>';

  // 降级候选
  html += '<h3 class="block-title">降级候选（' + downList.length + '）</h3>';
  if (downList.length) {
    html += '<div class="decay-list">';
    downList.forEach(m => {
      html += `<div class="decay-card">
        <div class="decay-card-summary">${esc(m.summary || '—')}</div>
        <div class="decay-card-meta">
          <span class="importance-badge ${m.importance||'low'}">${{high:'重要',medium:'常态',low:'轻微'}[m.importance||'low']}</span>
          <span>活力 ${m.vitality != null ? m.vitality : '—'}</span>
          <span>衰减 ${m.decay != null ? m.decay : '—'}</span>
          <span>${m.age_days} 天</span>
          <span>访问 ${m.access_count||0} 次</span>
        </div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += '<p class="empty-hint">当前无降级候选。</p>';
  }

  // 遗忘候选（只列出，不给删除按钮）
  html += '<h3 class="block-title">遗忘候选（' + forgetList.length + '）</h3>';
  if (forgetList.length) {
    html += '<p class="decay-note">遗忘候选仅列出，不会自动删除。如需抹去，请在详情弹窗逐条操作。</p>';
    html += '<div class="decay-list">';
    forgetList.forEach(m => {
      html += `<div class="decay-card">
        <div class="decay-card-summary">${esc(m.summary || '—')}</div>
        <div class="decay-card-meta">
          <span class="importance-badge ${m.importance||'low'}">${{high:'重要',medium:'常态',low:'轻微'}[m.importance||'low']}</span>
          <span>活力 ${m.vitality != null ? m.vitality : '—'}</span>
          <span>衰减 ${m.decay != null ? m.decay : '—'}</span>
          <span>${m.age_days} 天</span>
          <span>访问 ${m.access_count||0} 次</span>
          ${m.reason ? '<span>' + esc(m.reason) + '</span>' : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += '<p class="empty-hint">当前无遗忘候选。</p>';
  }

  // 两段式确认按钮
  html += '<div class="decay-apply-section">';
  html += '<p class="decay-note">执行降级：不会删除任何记忆；高重要性记忆永不自动降级。</p>';
  html += '<div id="decayApplyArea">';
  if (downList.length) {
    html += '<button id="decayApplyBtn" class="btn btn-danger">执行降级（' + downList.length + ' 条）</button>';
  } else {
    html += '<button class="btn btn-ghost" disabled>无可降级项</button>';
  }
  html += '</div></div>';

  body.innerHTML = html;

  // 两段式确认绑定
  const applyBtn = $('decayApplyBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const area = $('decayApplyArea');
      area.innerHTML = `<p class="decay-confirm-text">即将降级 <b>${downList.length}</b> 条记忆的重要性。不会删除任何记忆；高重要性记忆永不自动降级。</p>
        <div class="decay-confirm-btns">
          <button id="decayConfirmYes" class="btn btn-danger btn-sm">确认执行</button>
          <button id="decayConfirmNo" class="btn btn-ghost btn-sm">取消</button>
        </div>`;
      $('decayConfirmNo').addEventListener('click', () => {
        area.innerHTML = '<button id="decayApplyBtn" class="btn btn-danger">执行降级（' + downList.length + ' 条）</button>';
        $('decayApplyBtn').addEventListener('click', arguments.callee.caller ? applyBtn.onclick : (() => {}));
        // 重新绑定
        const nb = $('decayApplyBtn');
        if (nb) nb.addEventListener('click', () => {
          // 递归太复杂，直接内联
          showDecayConfirm(downList.length, area);
        });
      });
      $('decayConfirmYes').addEventListener('click', async () => {
        area.innerHTML = '<p class="empty-hint">执行中…</p>';
        try {
          const r = await api('/api/decay/apply', 'POST', { confirm: true });
          area.innerHTML = `<p class="decay-done">已降级 ${r.downgraded} 条。${r.note ? esc(r.note) : ''}</p>`;
          loadStats();
        } catch(e) {
          area.innerHTML = '<p class="empty-hint">' + esc(e.message || '执行失败') + '</p>';
        }
      });
    });
  }
}

function showDecayConfirm(count, area) {
  area.innerHTML = `<p class="decay-confirm-text">即将降级 <b>${count}</b> 条记忆的重要性。不会删除任何记忆；高重要性记忆永不自动降级。</p>
    <div class="decay-confirm-btns">
      <button id="decayConfirmYes" class="btn btn-danger btn-sm">确认执行</button>
      <button id="decayConfirmNo" class="btn btn-ghost btn-sm">取消</button>
    </div>`;
  $('decayConfirmNo').addEventListener('click', () => {
    area.innerHTML = '<button id="decayApplyBtn" class="btn btn-danger">执行降级（' + count + ' 条）</button>';
    $('decayApplyBtn').addEventListener('click', () => showDecayConfirm(count, area));
  });
  $('decayConfirmYes').addEventListener('click', async () => {
    area.innerHTML = '<p class="empty-hint">执行中…</p>';
    try {
      const r = await api('/api/decay/apply', 'POST', { confirm: true });
      area.innerHTML = `<p class="decay-done">已降级 ${r.downgraded} 条。${r.note ? esc(r.note) : ''}</p>`;
      loadStats();
    } catch(e) {
      area.innerHTML = '<p class="empty-hint">' + esc(e.message || '执行失败') + '</p>';
    }
  });
}

// ── 审计簿（master only）──
$('auditBtn').addEventListener('click', async () => {
  if (agentInfo.role !== 'master') {
    alert('仅掌柜可查阅审计簿。');
    return;
  }
  $('auditModal').classList.remove('hidden');
  const body = $('auditBody');
  body.innerHTML = '<p class="empty-hint">翻阅中…</p>';
  try {
    const d = await api('/api/admin/audit?limit=200');
    renderAuditPanel(d);
  } catch(e) {
    if (e instanceof ApiError && e.status === 403) {
      body.innerHTML = '<p class="empty-hint">仅掌柜可查阅审计簿。</p>';
    } else {
      body.innerHTML = '<p class="empty-hint">' + esc(e.message || '审计簿加载失败') + '</p>';
    }
  }
});
$('closeAudit').addEventListener('click', () => $('auditModal').classList.add('hidden'));
$('auditModal').querySelector('.modal-backdrop').addEventListener('click', () => $('auditModal').classList.add('hidden'));

function renderAuditPanel(d) {
  const body = $('auditBody');
  const events = d.events || [];
  const stats = d.stats || {};
  let html = '';

  // 警告（原样显示）
  if (d.warning) {
    html += '<div class="audit-warning">' + esc(d.warning) + '</div>';
  }

  // 统计
  html += '<div class="decay-summary">';
  html += `<div class="decay-stat-row"><span>缓冲</span><b>${stats.buffered != null ? stats.buffered : '—'}</b></div>`;
  html += `<div class="decay-stat-row"><span>容量</span><b>${stats.capacity != null ? stats.capacity : '—'}</b></div>`;
  html += `<div class="decay-stat-row"><span>已录</span><b>${stats.total_recorded != null ? stats.total_recorded : '—'}</b></div>`;
  html += `<div class="decay-stat-row"><span>丢弃</span><b>${stats.dropped != null ? stats.dropped : '—'}</b></div>`;
  html += '</div>';

  // 事件表
  if (!events.length) {
    html += '<p class="empty-hint">尚无审计事件。</p>';
  } else {
    html += '<table class="audit-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead><tbody>';
    events.forEach(ev => {
      const actor = ev.actor && ev.actor.length > 12 ? esc(ev.actor.slice(0, 8)) + '…' : esc(ev.actor || '—');
      const detail = formatAuditDetail(ev.detail);
      html += `<tr><td>${esc(ev.ts || '—')}</td><td>${actor}</td><td>${esc(ev.action || '—')}</td><td>${detail}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  body.innerHTML = html;
}

function formatAuditDetail(detail) {
  if (detail == null) return '—';
  if (typeof detail === 'string') return esc(detail.slice(0, 120));
  if (typeof detail === 'object') {
    try {
      const s = JSON.stringify(detail);
      return esc(s.length > 120 ? s.slice(0, 120) + '…' : s);
    } catch(_) { return '—'; }
  }
  return esc(String(detail));
}

// ── MCP 配置弹窗 ──
$('mcpCfgBtn').addEventListener('click', () => {
  const httpCfg = {
    mcpServers: {
      moyi: {
        url: location.origin + '/api/mcp',
        headers: { Authorization: 'Bearer ' + KEY }
      }
    }
  };
  const stdioCfg = {
    mcpServers: {
      moyi: {
        command: 'node',
        args: ['/workspace/moyi/mcp-server.js'],
        env: { MOYI_API: location.origin, MOYI_KEY: KEY }
      }
    }
  };
  $('mcpHttpConfig').textContent = JSON.stringify(httpCfg, null, 2);
  $('mcpConfig').textContent = JSON.stringify(stdioCfg, null, 2);
  $('moyiUrl').textContent = location.origin;
  $('mcpModal').classList.remove('hidden');
});
$('closeMcp').addEventListener('click', () => $('mcpModal').classList.add('hidden'));
$('mcpModal').querySelector('.modal-backdrop').addEventListener('click', () => $('mcpModal').classList.add('hidden'));
function wireCopy(btnId, preId) {
  const btn = $(btnId); if (!btn) return;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText($(preId).textContent).then(() => {
      const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => btn.textContent = o, 1500);
    });
  });
}
wireCopy('copyHttpCfgBtn', 'mcpHttpConfig');
wireCopy('copyCfgBtn', 'mcpConfig');

// ── Agent 管理（掌柜）──
$('agentsBtn').addEventListener('click', async () => {
  $('agentsModal').classList.remove('hidden');
  $('agentKeyResult').classList.add('hidden');
  await loadAgents();
});
$('closeAgents').addEventListener('click', () => $('agentsModal').classList.add('hidden'));
$('agentsModal').querySelector('.modal-backdrop').addEventListener('click', () => $('agentsModal').classList.add('hidden'));

$('createAgentBtn').addEventListener('click', async () => {
  const name = $('newAgentName').value.trim();
  if (!name) return;
  try {
    const r = await api('/api/agents', 'POST', { name });
    $('agentNewKey').textContent = r.api_key;
    $('agentKeyResult').classList.remove('hidden');
    $('newAgentName').value = '';
    await loadAgents();
  } catch(e) { showApiErr(e, '创建失败'); }
});
$('copyAgentKeyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('agentNewKey').textContent).then(()=>{
    const b=$('copyAgentKeyBtn'); const o=b.textContent; b.textContent='已复制'; setTimeout(()=>b.textContent=o,1500);
  });
});

async function loadAgents() {
  try {
    const r = await api('/api/agents');
    const list = r.agents || [];
    if (!list.length) {
      $('agentsList').innerHTML = '<p class="empty-hint">尚无其他 Agent。</p>';
      return;
    }
    $('agentsList').innerHTML = list.map(a => `
      <div class="agent-row" data-id="${esc(a.id)}">
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
      try {
        const r = await api('/api/agents/' + id + '/reset-key', 'POST');
        $('resetKey').textContent = r.api_key;
        $('agentsModal').classList.add('hidden');
        $('resetModal').classList.remove('hidden');
      } catch(err) { showApiErr(err, '重置失败'); }
    }));
    $('agentsList').querySelectorAll('.act-del').forEach(b => b.addEventListener('click', async e => {
      const id = e.target.closest('.agent-row').dataset.id;
      if (!confirm('确定除名？该 Agent 的全部记忆将一并抹去。')) return;
      try {
        await api('/api/agents/' + id, 'DELETE');
        await loadAgents();
      } catch(err) { showApiErr(err, '除名失败'); }
    }));
  } catch(e) { showApiErr(e, 'Agent 列表加载失败'); }
}
$('closeReset').addEventListener('click', () => $('resetModal').classList.add('hidden'));
$('resetModal').querySelector('.modal-backdrop').addEventListener('click', () => $('resetModal').classList.add('hidden'));
$('copyResetBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('resetKey').textContent).then(()=>{
    const b=$('copyResetBtn'); const o=b.textContent; b.textContent='已复制'; setTimeout(()=>b.textContent=o,1500);
  });
});

// ── 工具 ──
function fmt(iso){if(!iso)return'—';const d=new Date(iso);const n=new Date();const s=(n-d)/1000;
  if(s<60)return'刚刚';if(s<3600)return Math.floor(s/60)+'分钟前';
  if(s<86400)return Math.floor(s/3600)+'小时前';
  if(s<604800)return Math.floor(s/86400)+'天前';
  return `${d.getMonth()+1}月${d.getDate()}日`;}
function esc(s){if(s==null)return'';s=String(s);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ── 启动 ──
if (KEY && agentInfo) {
  // 验证已存 key 是否仍有效
  fetch('/api/agents/verify', { method:'POST', headers:{'X-Moyi-Key':KEY} })
    .then(r => r.json())
    .then(d => { if (!d.error && d.id) enterApp(); })
    .catch(()=>{});
}
