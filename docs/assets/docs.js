/* ═══════════════════════════════════════════════════
   墨忆文档站 · 共用运行时
   零依赖、零构建。导航由本文件按 manifest 注入，
   避免 16 个页面各抄一份侧栏（改一处漏十五处）。
   ═══════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 站内页面清单。href 全部用相对路径：
  // GitHub Pages 项目站挂在 /<repo>/ 下，绝对路径会 404。
  var NAV = [
    { group: '开始', items: [
      { href: 'index.html',    text: '总览与架构' },
      { href: 'beginner.html', text: '部署前必看' },
      { href: 'quickstart.html', text: '十分钟跑通' }
    ]},
    { group: '环境与部署', items: [
      { href: 'env.html',     text: '环境变量全解' },
      { href: 'runtime.html', text: '环境自动识别' },
      { href: 'deploy.html',  text: '四条部署路径' },
      { href: 'https.html',   text: 'HTTPS 与反向代理' },
      { href: 'pages.html',   text: '文档站上线 Pages' }
    ]},
    { group: '使用', items: [
      { href: 'console.html', text: '引导安装与管理台' },
      { href: 'agents.html',  text: 'Agent 与全局记忆' },
      { href: 'skills.html',  text: '技能层' },
      { href: 'api.html',     text: '接口清单' }
    ]},
    { group: '底层', items: [
      { href: 'schema.html',  text: '数据库结构' },
      { href: 'database.html', text: '数据库与环境支持' },
      { href: 'security.html', text: '安全机制' },
      { href: 'account-gaps.html', text: '对照：网站账号体系' },
      { href: 'troubleshoot.html', text: '故障排查' }
    ]}
  ];

  var here = (location.pathname.split('/').pop() || 'index.html');
  if (here === '') here = 'index.html';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ── 顶栏 ── */
  function buildTop() {
    var top = el('header', 'd-top');
    var inn = el('div', 'd-top-in');

    var brand = el('a', 'd-brand');
    brand.href = 'index.html';
    brand.innerHTML = '<b>墨忆</b><span>Moyi Docs</span>';
    inn.appendChild(brand);

    var ver = document.documentElement.getAttribute('data-ver') || 'v3.3';
    inn.appendChild(el('span', 'd-ver', ver));

    var btn = el('button', 'd-menu-btn', '目录');
    btn.type = 'button';
    btn.setAttribute('aria-label', '打开目录');
    inn.appendChild(btn);

    var sw = el('div', 'd-search');
    var si = el('input');
    si.type = 'search';
    si.placeholder = '搜索文档…';
    si.setAttribute('aria-label', '搜索文档');
    si.autocomplete = 'off';
    var hits = el('div', 'd-search-hits');
    sw.appendChild(si); sw.appendChild(hits);
    inn.appendChild(sw);

    top.appendChild(inn);
    document.body.insertBefore(top, document.body.firstChild);
    return { btn: btn, input: si, hits: hits };
  }

  /* ── 侧栏 ── */
  function buildNav() {
    var nav = el('nav', 'd-nav');
    NAV.forEach(function (g) {
      nav.appendChild(el('h4', null, g.group));
      g.items.forEach(function (it) {
        var a = el('a', it.href === here ? 'on' : null, it.text);
        a.href = it.href;
        if (it.href === here) a.setAttribute('aria-current', 'page');
        nav.appendChild(a);
      });
    });
    return nav;
  }

  /* ── 标题锚点 ── */
  function addAnchors(main) {
    var used = {};
    main.querySelectorAll('h2, h3').forEach(function (h) {
      var base = (h.textContent || '').trim()
        .replace(/[^\w一-龥]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
      if (!base) base = 'sec';
      var id = base, n = 2;
      while (used[id]) id = base + '-' + (n++);
      used[id] = 1;
      if (!h.id) h.id = id;
      var a = el('a', 'anchor', '#');
      a.href = '#' + h.id;
      a.setAttribute('aria-label', '本节链接');
      h.appendChild(a);
    });
  }

  /* ── 上下页 ── */
  function flat() {
    var out = [];
    NAV.forEach(function (g) { g.items.forEach(function (i) { out.push(i); }); });
    return out;
  }
  function buildPager(main) {
    var list = flat(), idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].href === here) idx = i;
    if (idx < 0) return;
    var prev = list[idx - 1], next = list[idx + 1];
    if (!prev && !next) return;
    var p = el('div', 'd-pager');
    if (prev) p.appendChild(el('a', null,
      '<i>← 上一篇</i><b>' + prev.text + '</b>')).href = prev.href;
    if (next) p.appendChild(el('a', null,
      '<i>下一篇 →</i><b>' + next.text + '</b>')).href = next.href;
    main.appendChild(p);
  }

  /* ── 表格自动包横向滚动容器（H5 上表格最容易撑破版面）── */
  function wrapTables(main) {
    main.querySelectorAll('table').forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains('tw')) return;
      var w = el('div', 'tw');
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
  }

  /* ── 搜索：抓取同目录各页正文建索引 ──
     只在 http(s) 下工作；file:// 时 fetch 会被拦，静默降级为「不可用」，
     不影响其余功能。 */
  function initSearch(si, hits) {
    var INDEX = null, loading = null;

    function ensure() {
      if (INDEX) return Promise.resolve(INDEX);
      if (loading) return loading;
      loading = Promise.all(flat().map(function (p) {
        return fetch(p.href, { cache: 'force-cache' })
          .then(function (r) { return r.ok ? r.text() : ''; })
          .then(function (html) {
            if (!html) return [];
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var main = doc.querySelector('main');
            if (!main) return [];
            var out = [];
            var title = (doc.querySelector('h1') || {}).textContent || p.text;
            main.querySelectorAll('h2, h3').forEach(function (h) {
              var txt = (h.textContent || '').replace(/#$/, '').trim();
              var body = '', node = h.nextElementSibling;
              while (node && !/^H[23]$/.test(node.tagName)) {
                body += ' ' + (node.textContent || '');
                node = node.nextElementSibling;
              }
              out.push({
                page: p.href, pageText: p.text, title: title,
                sec: txt, id: h.id || '',
                // 压掉空白，索引更小、命中片段更干净
                text: body.replace(/\s+/g, ' ').trim().slice(0, 900)
              });
            });
            return out;
          })
          .catch(function () { return []; });
      })).then(function (chunks) {
        INDEX = [].concat.apply([], chunks);
        return INDEX;
      });
      return loading;
    }

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }
    function hl(s, q) {
      var i = s.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return esc(s.slice(0, 90));
      var a = Math.max(0, i - 30);
      return (a ? '…' : '') + esc(s.slice(a, i)) + '<em>' + esc(s.slice(i, i + q.length))
        + '</em>' + esc(s.slice(i + q.length, i + q.length + 70)) + '…';
    }

    function render(q) {
      if (!q || q.length < 1) { hits.classList.remove('on'); return; }
      var lq = q.toLowerCase();
      var rows = (INDEX || []).filter(function (c) {
        return c.sec.toLowerCase().indexOf(lq) >= 0
          || c.text.toLowerCase().indexOf(lq) >= 0
          || c.pageText.toLowerCase().indexOf(lq) >= 0;
      }).slice(0, 24);
      hits.innerHTML = rows.length
        ? rows.map(function (c) {
            var anchor = c.id ? '#' + c.id : '';
            return '<a class="d-hit" href="' + esc(c.page) + anchor + '">'
              + '<b>' + esc(c.pageText) + ' › ' + esc(c.sec) + '</b>'
              + '<i>' + hl(c.text || c.title, q) + '</i></a>';
          }).join('')
        : '<div class="d-none">' + (INDEX ? '没有匹配的结果' : '搜索索引不可用（需通过 http 访问本站）')
          + '</div>';
      hits.classList.add('on');
    }

    var t = null;
    si.addEventListener('input', function () {
      var q = si.value.trim();
      clearTimeout(t);
      if (INDEX) { render(q); return; }
      t = setTimeout(function () { ensure().then(function () { render(q); }); }, 220);
    });
    si.addEventListener('focus', function () { if (si.value.trim()) { if (INDEX) render(si.value.trim()); else ensure().then(function(){render(si.value.trim());}); } });
    document.addEventListener('click', function (e) {
      if (!hits.contains(e.target) && e.target !== si) hits.classList.remove('on');
    });
    si.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hits.classList.remove('on'); si.blur(); }
    });
  }

  /* ── 启动 ── */
  var main = document.querySelector('main');
  if (!main) return;

  var ui = buildTop();
  var nav = buildNav();
  var wrap = document.querySelector('.d-wrap');
  if (wrap) wrap.insertBefore(nav, main); else document.body.insertBefore(nav, main);

  var scrim = el('div', 'd-scrim');
  document.body.appendChild(scrim);
  function closeDrawer() { nav.classList.remove('on'); scrim.classList.remove('on'); }
  ui.btn.addEventListener('click', function () {
    var on = nav.classList.toggle('on');
    scrim.classList.toggle('on', on);
  });
  scrim.addEventListener('click', closeDrawer);
  nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') closeDrawer(); });

  wrapTables(main);
  addAnchors(main);
  buildPager(main);
  initSearch(ui.input, ui.hits);

  var foot = el('footer', 'd-foot');
  foot.innerHTML = '墨忆（Moyi）· Agent 记忆中间件 · 文档对应版本 <code>v3.3.0</code>'
    + ' · 源码 <a href="https://github.com/Changliu7Stream/moyi" rel="noopener">Changliu7Stream/moyi</a>';
  document.body.appendChild(foot);
})();
