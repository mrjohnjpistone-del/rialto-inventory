/* Rialto Inventory — phone-first single-page app. No build step, no framework. */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rinv_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rinv_' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  let D = null;            // everything from /api/data
  let editing = false;     // a form is open — live updates must not wipe it
  let route = '';

  // ── API ──────────────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const opt = { method, headers: { 'x-rialto': '1', 'x-user': encodeURIComponent(LS.get('name', '') || '') } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    for (let tries = 0; ; tries++) {
      try { r = await fetch(url, opt); } catch (e) { throw new Error('No connection. Check your signal and try again.'); }
      if (r.status !== 503 || tries >= 20) break;
      if (tries === 0 && view && !D) view.innerHTML = '<div class="card"><p>Waking up the inventory… this takes a few seconds.</p></div>';
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    if (r.status === 401) { location.href = '/'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const er = new Error(j.error || 'Something went wrong.'); er.status = r.status; er.data = j; throw er; }
    return j;
  }
  let BUILD0 = null; // version of the code this page loaded with
  async function load() {
    D = await api('GET', '/api/data'); $('#title').textContent = D.settings.title;
    if (BUILD0 === null) BUILD0 = D.build;
    else if (D.build && D.build !== BUILD0) newVersion();
  }
  // A new version went live: reload now unless someone is mid-typing; then offer a one-tap update instead.
  function newVersion() {
    if (!editing && !scanner && !typing()) { location.reload(); return; }
    if ($('#updbar')) return;
    const b = document.createElement('div'); b.id = 'updbar'; b.className = 'toast good'; b.style.opacity = 1; b.style.cursor = 'pointer';
    b.textContent = 'New version ready — tap here to update (save first)'; b.onclick = () => location.reload();
    document.body.appendChild(b);
  }
  function upsert(item) { const i = D.items.findIndex((x) => x.code === item.code); if (i >= 0) D.items[i] = item; else D.items.push(item); }
  const item = (c) => D.items.find((x) => x.code === c) || D.items.find((x) => (x.aliases || []).includes(c));
  const depts = () => D.settings.departments;
  const deptOf = (code) => depts().find((d) => d.p === String(code).split('-')[0]);
  const deptByName = (n) => depts().find((d) => d.name === n || d.p === n);
  const LOCP = 'LOC';
  const LOC_COLOR = '#111111';
  // "cost141" / "COST 141" / "cost-0141" → "COST-0141"
  function normCode(v) {
    const m = String(v || '').trim().toUpperCase().match(/^([A-Z]{1,4})[\s_-]*(\d{1,6})$/);
    return m ? m[1] + '-' + String(Number(m[2])).padStart(4, '0') : '';
  }
  const isLocCode = (c) => /^(LOC|L)-/.test(c);
  // Typing a sticker code (cost1, COST-0001, loc3) in a search box + Enter opens that item/place,
  // including a blank sticker's new-item form. Anything else stays a normal search.
  function codeTarget(v) {
    const c = normCode(v); if (!c) return '';
    if (isLocCode(c)) return loc(c) ? '/l/' + c : '';
    return (item(c) || deptOf(c)) ? '/i/' + c : '';
  }
  // QR content: an all-capitals URL so the QR can use its compact alphanumeric mode.
  const qrUrl = (code) => (D.base + (isLocCode(code) ? '/L/' : '/I/') + code).toUpperCase();
  function ink(hex) { // readable text colour on a band of `hex`
    const n = parseInt(String(hex).slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111' : '#fff';
  }
  function chip(code) {
    const d = isLocCode(code) ? { p: LOCP, color: LOC_COLOR } : deptOf(code); if (!d) return '';
    return '<span class="chip" style="background:' + esc(d.color) + ';color:' + ink(d.color) + (d.color.toLowerCase() === '#ffffff' ? ';border:1px solid #999' : '') + '">' + esc(d.p) + '</span>';
  }
  const loc = (c) => D.locations.find((x) => x.code === c);
  const locName = (c) => (loc(c) || {}).name || '';

  // ── Live updates ───────────────────────────────────────────────────────────
  function live() {
    let es, opened = false;
    const dot = $('#live');
    const open = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        dot.classList.remove('off'); dot.title = 'Live — changes appear instantly';
        if (opened) load().then(() => { if (!editing && !scanner && !typing()) render(true); }).catch(() => {});
        opened = true;
      };
      es.onerror = () => { dot.classList.add('off'); dot.title = 'Reconnecting…'; };
      es.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'item') upsert(m.item);
        else if (m.t === 'del') D.items = D.items.filter((x) => x.code !== m.code);
        else if (m.t === 'loc') { const i = D.locations.findIndex((x) => x.code === m.loc.code); if (i >= 0) D.locations[i] = m.loc; else D.locations.push(m.loc); }
        else if (m.t === 'shows') D.shows = m.shows;
        else if (m.t === 'reload' || m.t === 'settings') await load();
        if (!editing && !scanner && !typing()) render(true);
      };
    };
    open();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && es && es.readyState === 2) { open(); load().then(() => render(true)); } });
  }

  function typing() {
    const ae = document.activeElement;
    return !!(ae && (view.contains(ae) || ae.closest('.modal')) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) || !!$('.modal');
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  let toastT;
  function toast(msg, kind) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.className = 'toast ' + (kind || ''); t.textContent = msg; t.style.opacity = 1;
    clearTimeout(toastT); toastT = setTimeout(() => { t.style.opacity = 0; }, kind === 'bad' ? 5000 : 2600);
  }
  function go(path, replace) { if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path); render(); window.scrollTo(0, 0); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (editing && !confirm('Leave without saving?')) return;
    editing = false; go(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => { editing = false; closeScanner(); render(); });
  const pillCls = (st) => (st || 'Available').split(' ')[0];
  const pill = (st) => '<span class="pill ' + pillCls(st) + '">' + esc(st || 'Available') + '</span>';
  const thumb = (it) => it.photos && it.photos[0] ? '<div class="th" style="background-image:url(/p/' + it.photos[0] + '_t.jpg)"></div>' : '<div class="th">▢</div>';
  function rowHtml(it, extra) {
    const where = locName(it.location);
    const meta = [it.code, where, it.holder ? 'with ' + it.holder : '', it.qty > 1 ? '×' + it.qty : ''].filter(Boolean).join(' · ');
    return '<a class="it" href="/i/' + esc(it.code) + '" data-nav>' + thumb(it) + '<div class="bd"><div class="nm">' + chip(it.code) + ' ' + esc(it.name) + '</div><div class="mt">' + esc(meta) + (it.size ? ' · ' + esc(it.size) : '') + '</div>' +
      (activeTemp(it).length ? '<div class="mt" style="color:var(--warn);font-weight:700">✂ temporary alteration to undo</div>' : '') +
      (extra || '') + '</div>' + pill(it.status) + '</a>';
  }
  function qrMake(text) {
    const q = qrcode(0, 'M'); q.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte'); q.make(); return q;
  }
  function qrSvg(text, px) {
    const q = qrMake(text);
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg ', '<svg style="width:' + (px || 110) + 'px;height:' + (px || 110) + 'px" ');
  }
  function opts(list, sel, blank) {
    return (blank != null ? '<option value="">' + esc(blank) + '</option>' : '') + list.map((v) => {
      const [val, lab] = Array.isArray(v) ? v : [v, v];
      return '<option value="' + esc(val) + '"' + (val === sel ? ' selected' : '') + '>' + esc(lab) + '</option>';
    }).join('');
  }
  const locOpts = (sel) => opts(D.locations.slice().sort((a, b) => a.name.localeCompare(b.name)).map((l) => [l.code, l.name]), sel, '— No location yet —');
  const when = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  function modal(html, onMount) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="sheet">' + html + '</div>';
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); });
    function close() { m.remove(); }
    document.body.appendChild(m); if (onMount) onMount(m, close);
    return close;
  }

  // ── Who am I ───────────────────────────────────────────────────────────────
  function askName(force) {
    if (LS.get('name', '') && !force) return;
    modal('<h2>What is your name?</h2><p class="muted">So the crew can see who moved or checked out what. Asked once on this phone.</p>' +
      '<form id="nf"><label>Your name<input id="nm" autocomplete="name" required value="' + esc(LS.get('name', '')) + '"></label><button class="btn big">Save</button></form>',
    (m, close) => { $('#nm', m).focus(); $('#nf', m).onsubmit = (e) => { e.preventDefault(); LS.set('name', $('#nm', m).value.trim().slice(0, 60)); setWho(); close(); }; });
  }
  function setWho() { if (D && D.me && !D.me.master) LS.set('name', D.me.name); const n = LS.get('name', ''); $('#whoBtn').textContent = n ? n.split(' ')[0] : 'Name?'; }
  $('#whoBtn').onclick = () => go('/settings');

  // ── Router ─────────────────────────────────────────────────────────────────
  let pinned = false; // a generated screen (sticker sheets) that live updates must not redraw
  function render(soft) {
    if (soft && pinned) return;
    pinned = false;
    const p = location.pathname.replace(/\/+$/, '') || '/';
    route = p;
    const tab = p === '/' ? 'home' : p.split('/')[1].toLowerCase();
    $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab || (tab === 'i' && a.dataset.tab === 'browse') || (tab === 'l' && a.dataset.tab === 'locations') || ((tab === 'show' || tab === 'set') && a.dataset.tab === 'characters')));
    let m;
    if (p === '/') return home();
    if (p === '/browse') return browse(soft);
    if (p === '/add') return addForm(new URLSearchParams(location.search).get('code') || '', false, copyOf());
    if (p === '/scan') { if (!soft) { history.replaceState(null, '', '/'); home(); openScanner({ mode: 'go' }); } return; }
    if (p === '/locations') return locations();
    if (p === '/labels') return labels();
    if (p === '/settings') return settings();
    if (p === '/recent') return recent();
    if (p === '/characters') return characters();
    if (p === '/show') return showPage(new URLSearchParams(location.search).get('show') || '');
    if (p === '/upload') return uploadPage();
    if (p === '/set') return setPage(new URLSearchParams(location.search).get('show') || '', new URLSearchParams(location.search).get('character') || '');
    if ((m = p.match(/^\/i\/(.+)$/i))) return itemPage(normCode(decodeURIComponent(m[1])) || decodeURIComponent(m[1]).toUpperCase());
    if ((m = p.match(/^\/l\/(.+)$/i))) return locPage(normCode(decodeURIComponent(m[1])) || decodeURIComponent(m[1]).toUpperCase());
    if ((m = p.match(/^\/audit\/(.+)$/i))) return audit(normCode(decodeURIComponent(m[1])) || decodeURIComponent(m[1]).toUpperCase());
    view.innerHTML = '<div class="card">Page not found. <a href="/" data-nav>Home</a></div>';
  }

  // ── Home ───────────────────────────────────────────────────────────────────
  function home() {
    const its = D.items;
    const out = its.filter((i) => i.status === 'Checked out' || i.status === 'In a show').length;
    const miss = its.filter((i) => i.status === 'Missing').length;
    const nophoto = its.filter((i) => !i.photos.length).length;
    const needDet = its.filter((i) => i.needs_details).length;
    const toUndo = its.filter((i) => activeTemp(i).length).length;
    const recentList = its.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6);
    const welcome = new URLSearchParams(location.search).get('welcome');
    view.innerHTML =
      (welcome ? '<div class="banner">You are in. Scan any sticker with your camera, or use the red Scan button.</div>' : '') +
      '<div class="search"><input id="q" type="search" placeholder="Search everything — name, color, size, code…" enterkeyhint="search"></div>' +
      '<div class="tiles">' +
      '<button class="tile hero" id="scanT"><span class="ic">⌗</span><div><b>Scan a sticker</b><br><span>Opens the item — or starts a new one if the sticker is blank</span></div></button>' +
      '<a class="tile" href="/add" data-nav><span class="ic">＋</span><div><b>Add item</b><br><span>Photo, name, place</span></div></a>' +
      '<a class="tile" href="/browse" data-nav><span class="ic">☰</span><div><b>All items</b><br><span>' + its.length + ' total</span></div></a>' +
      '<a class="tile" href="/locations" data-nav><span class="ic">▦</span><div><b>Places</b><br><span>Racks, shelves, bins · audit</span></div></a>' +
      '<a class="tile" href="/labels" data-nav><span class="ic">▤</span><div><b>Print stickers</b><br><span>Blank or for items</span></div></a>' +
      '<a class="tile" href="/upload" data-nav><span class="ic">⇪</span><div><b>Upload photos</b><br><span>Many at once — sticker in each shot</span></div></a>' +
      '<a class="tile" href="/characters" data-nav><span class="ic">☺</span><div><b>Shows</b><br><span>Shows, characters &amp; their items</span></div></a>' +
      '</div>' +
      '<div class="card"><div class="stats"><div><b>' + its.length + '</b><span>Items</span></div><div><b>' + out + '</b><span>Out now</span></div><div><b>' + miss + '</b><span>Missing</span></div></div>' +
      '<div class="row" style="margin-top:10px"><a class="btn alt sm" data-nav href="/browse?status=Checked out">Who has what</a><a class="btn alt sm" data-nav href="/browse?photo=none">' + nophoto + ' need photos</a>' +
      '<a class="btn ' + (needDet ? '' : 'alt ') + 'sm" data-nav href="/browse?details=need">' + needDet + ' need details</a>' +
      '<a class="btn ' + (toUndo ? '' : 'alt ') + 'sm" data-nav href="/browse?alt=undo">' + toUndo + ' alteration' + (toUndo === 1 ? '' : 's') + ' to undo</a></div></div>' +
      '<div class="sect"><h2>Latest changes</h2><a href="/recent" data-nav class="small">See all</a></div>' +
      (recentList.length ? '<div class="list">' + recentList.map((i) => rowHtml(i, '<div class="mt">' + esc((i.history[0] || {}).action || '') + ' · ' + esc(i.updated_by || '') + ' · ' + esc(when(i.updated_at)) + '</div>')).join('') + '</div>'
        : '<div class="card empty">Nothing yet. Tap <b>Scan a sticker</b> on a blank label, or <b>Add item</b>, to start.</div>');
    $('#scanT').onclick = () => openScanner({ mode: 'go' });
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') {
      const v = e.target.value, c = codeTarget(v), sm = showMatches(v);
      go(c || (sm.length === 1 && sm[0].toLowerCase() === v.trim().toLowerCase() ? showHref(sm[0]) : '/browse?q=' + encodeURIComponent(v))); } });
  }

  function recent() {
    const ev = [];
    D.items.forEach((i) => i.history.forEach((h) => ev.push({ i, h })));
    ev.sort((a, b) => b.h.at.localeCompare(a.h.at));
    view.innerHTML = '<h1>Activity</h1><div class="card"><ul class="hist">' + ev.slice(0, 200).map(({ i, h }) =>
      '<li><a href="/i/' + esc(i.code) + '" data-nav><b>' + esc(i.name) + '</b></a> — ' + esc(h.action) + (h.detail ? ' ' + esc(h.detail) : '') +
      '<br><span class="muted small">' + esc(h.by) + ' · ' + esc(when(h.at)) + '</span></li>').join('') + '</ul>' + (ev.length ? '' : '<p class="empty">No activity yet.</p>') + '</div>';
  }

  // ── Browse / search ────────────────────────────────────────────────────────
  function browse(soft) {
    const sp = new URLSearchParams(location.search);
    const st = { q: sp.get('q') || '', cat: sp.get('cat') || '', status: sp.get('status') || '', loc: sp.get('loc') || '', photo: sp.get('photo') || '', details: sp.get('details') || '', fit: sp.get('fit') || '', alt: sp.get('alt') || '', sort: sp.get('sort') || LS.get('sort', 'name') };
    if (soft && $('#bq')) { draw(); return; }
    view.innerHTML = '<h1>Items</h1>' +
      '<div class="search"><input id="bq" type="search" placeholder="Search name, color, size, tag, code…" value="' + esc(st.q) + '"></div>' +
      '<div class="filters">' +
      '<select id="fc">' + opts(depts().map((d) => [d.name, d.p + ' · ' + d.name]), st.cat, 'All departments') + '</select>' +
      '<select id="fs">' + opts(D.statuses, st.status, 'Any status') + '</select>' +
      '<select id="fl">' + locOpts(st.loc).replace('— No location yet —', 'Any place') + '<option value="none"' + (st.loc === 'none' ? ' selected' : '') + '>No place set</option></select>' +
      '<select id="fp">' + opts([['none', 'No photo'], ['has', 'Has photo']], st.photo, 'Photos: any') + '</select>' +
      '<select id="ffit">' + opts(FITS.map((f) => [f, f]), st.fit, "Men's / Women's / Unisex / Children's") + '</select>' +
      '<select id="falt">' + opts([['undo', 'Temporary — to undo'], ['any', 'Any alteration'], ['perm', 'Permanently altered']], st.alt, 'Alterations: any') + '</select>' +
      '<select id="fdt">' + opts([['need', 'Needs details']], st.details, 'Details: any') + '</select>' +
      '<select id="fo">' + opts([['name', 'A → Z'], ['new', 'Newest'], ['updated', 'Recently changed'], ['code', 'Sticker code']], st.sort) + '</select>' +
      '</div><div id="showHit"></div><p class="muted small" id="cnt"></p><div class="list" id="res"></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn alt" id="printRes">Print stickers for these</button><a class="btn alt" href="/api/export.csv">Download spreadsheet</a></div>';
    const sync = () => {
      st.q = $('#bq').value; st.cat = $('#fc').value; st.status = $('#fs').value; st.loc = $('#fl').value; st.photo = $('#fp').value; st.details = $('#fdt').value; st.fit = $('#ffit').value; st.alt = $('#falt').value; st.sort = $('#fo').value; LS.set('sort', st.sort);
      const u = new URLSearchParams(); Object.entries(st).forEach(([k, v]) => { if (v && k !== 'sort') u.set(k, v); });
      history.replaceState(null, '', '/browse' + (u.toString() ? '?' + u : '')); draw();
    };
    $('#bq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = codeTarget(e.target.value); if (c) { e.preventDefault(); go(c); } } });
    $('#bq').addEventListener('input', sync); $$('.filters select').forEach((s) => s.addEventListener('change', sync));
    $('#printRes').onclick = () => { const c = filtered().map((i) => i.code); if (!c.length) return toast('No items to print.'); printCodes(c); };
    function filtered() {
      const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
      let r = D.items.filter((i) => {
        if (st.cat && i.category !== st.cat) return false;
        if (st.status && i.status !== st.status) return false;
        if (st.loc === 'none' ? i.location : st.loc && i.location !== st.loc) return false;
        if (st.photo === 'none' && i.photos.length) return false;
        if (st.photo === 'has' && !i.photos.length) return false;
        if (st.details === 'need' && !i.needs_details) return false;
        if (st.fit && !(i.fit || []).includes(st.fit)) return false;
        if (st.alt === 'undo' && !activeTemp(i).length) return false;
        if (st.alt === 'any' && !(i.alterations || []).length) return false;
        if (st.alt === 'perm' && !(i.alterations || []).some((a) => a.kind === 'Permanent')) return false;
        if (!words.length) return true;
        const hay = [i.code, i.name, i.category, i.color, i.size, (i.fit || []).join(' '), (i.alterations || []).map((a) => a.what + ' ' + a.show).join(' '), i.period, i.tags, i.description, i.notes, i.holder, i.show, locName(i.location), i.sublocation, i.condition,
          (i.roles || []).map((r) => r.show + ' ' + r.character).join(' ')].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const by = { name: (a, b) => a.name.localeCompare(b.name), new: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
        updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''), code: (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) };
      return r.sort(by[st.sort] || by.name);
    }
    function draw() {
      const r = filtered();
      const sm = showMatches(st.q);
      $('#showHit').innerHTML = sm.map((s) => '<a class="banner" style="display:block;text-decoration:none" href="' + showHref(s) + '" data-nav>🎭 <b>' + esc(s) + '</b> — see every character and item in this show →</a>').join('');
      $('#cnt').textContent = r.length + ' of ' + D.items.length + ' items' + (r.length ? ' · ' + r.reduce((a, i) => a + (i.qty || 1), 0) + ' pieces' : '');
      $('#res').innerHTML = r.slice(0, 400).map((i) => rowHtml(i)).join('') + (r.length > 400 ? '<p class="muted">Showing the first 400 — search to narrow it down.</p>' : '') +
        (r.length ? '' : '<div class="card empty">No matches.</div>');
    }
    draw();
  }

  // Fields that carry over when one item is copied to the next sticker (never photos, status or holder).
  const COPY_FIELDS = ['name', 'category', 'qty', 'location', 'sublocation', 'color', 'size', 'fit', 'period', 'condition', 'tags', 'description', 'notes', 'value', 'roles'];
  function copyOf() { const c = new URLSearchParams(location.search).get('copy'); return c ? item(c.toUpperCase()) : null; }

  // ── Item page ──────────────────────────────────────────────────────────────
  function itemPage(code) {
    const it = item(code);
    if (it && it.code !== code) { history.replaceState(null, '', '/i/' + it.code); toast(code + ' was re-stickered as ' + it.code); }
    if (!it && !deptOf(code)) {
      view.innerHTML = '<div class="card"><h1>Unknown sticker <span class="code">' + esc(code) + '</span></h1><p>“' + esc(code.split('-')[0]) + '” is not one of our department codes. ' +
        'Department codes are: ' + depts().map((d) => '<b>' + esc(d.p) + '</b> ' + esc(d.name)).join(', ') + '.</p></div>'; return;
    }
    if (!it) {
      const src = copyOf();
      view.innerHTML = '<div class="card"><h1>New sticker: <span class="code">' + esc(code) + '</span></h1><p>' +
        (src ? 'Copying from <b>' + esc(src.name) + '</b> (' + esc(src.code) + '). Check the details, take this one\'s photo, and save.' : 'This sticker is not on anything yet. Fill in the item it is stuck to.') + '</p></div>';
      if (!src) {
        // Identical to something already in (the 20th khaki tie)? One tap: its details + its photo land on this sticker.
        const dp = deptOf(code).p;
        const same = D.items.filter((i) => i.code.split('-')[0] === dp && !i.needs_details && i.name !== 'Details needed');
        const last = item(LS.get('lastSame', '')); const lastOk = last && last.code.split('-')[0] === dp && !last.needs_details;
        if (same.length) view.insertAdjacentHTML('beforeend', '<div class="card" style="border:2px solid var(--blue)"><h2 style="margin-bottom:6px">Same as one we already have?</h2>' +
          '<p class="muted small" style="margin-top:0">This sticker gets that item\'s details and photo. No new photo, no typing.</p>' +
          (lastOk ? '<button class="btn big blue" id="sameLast" style="margin-bottom:8px">' + (last.photos[0] ? '<img src="/p/' + last.photos[0] + '_t.jpg" style="width:34px;height:34px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px">' : '') + 'Same as ' + esc(last.name) + (last.size ? ' · ' + esc(last.size) : '') + '</button>' : '') +
          '<button class="btn big alt" id="samePick">📋 Pick the matching item…</button></div>');
        const applySame = async (s) => {
          try { const r = await api('POST', '/api/items/' + s.code + '/copies', { codes: [code], photo: true }); r.items.forEach(upsert);
            LS.set('lastSame', s.code); editing = false; history.replaceState(null, '', '/i/' + code); render();
            toast(code + ' is now ' + s.name + ' ✓  Scan the next sticker.', 'good'); }
          catch (er) { toast(er.message, 'bad'); }
        };
        if ($('#sameLast')) $('#sameLast').onclick = () => applySame(last);
        if ($('#samePick')) $('#samePick').onclick = () => pickSame(same, applySame);
        view.insertAdjacentHTML('beforeend', '<div class="card" style="border:2px solid var(--red)"><h2 style="margin-bottom:6px">On the phone? Just take the photo</h2>' +
          '<p class="muted small" style="margin-top:0">Saves this sticker with its photo. Type the details later on the computer (Home → <b>Need details</b>).</p>' +
          '<input type="file" id="poph" accept="image/*" capture="environment" hidden><button class="btn big" id="pob">📷 Photo only — details later</button></div>' +
          '<p class="muted small" style="text-align:center">— or fill everything in now —</p>');
        $('#pob').onclick = () => $('#poph').click();
        $('#poph').onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          $('#pob').disabled = true; $('#pob').textContent = 'Saving…';
          try {
            const photo = { full: await shrink(f, 1400, 0.74), thumb: await shrink(f, 360, 0.7) };
            const r = await api('POST', '/api/items', { code, needs_details: true }); upsert(r.item);
            const r2 = await api('POST', '/api/items/' + r.item.code + '/photos', photo); upsert(r2.item);
            editing = false; history.replaceState(null, '', '/i/' + r.item.code); render();
            modal('<h2>Saved ✓</h2><p><span class="code">' + esc(r.item.code) + '</span> has its photo. Add the details on the computer.</p>' +
              '<button class="btn big" id="nx">⌗ Scan the next sticker</button><button class="btn alt big" data-close style="margin-top:8px">Done</button>',
            (m, close) => { $('#nx', m).onclick = () => { close(); openScanner({ mode: 'go' }); }; });
          } catch (er) { toast(er.message, 'bad'); $('#pob').disabled = false; $('#pob').textContent = '📷 Photo only — details later'; }
        };
      }
      return addForm(code, true, src);
    }
    const where = loc(it.location);
    const needBanner = it.needs_details ? '<div class="banner" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span><b>Details needed</b> — photo is in; type the rest on the computer.</span><span class="row" style="flex:none;margin:0"><button class="btn sm" id="fillNow">Add details</button>' + (copySources(it).length ? '<button class="btn alt sm" id="fillCopy">📋 Same as another</button>' : '') + '</span></div>' : '';
    view.innerHTML =
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><span>' + chip(it.code) + ' <span class="code">' + esc(it.code) + '</span></span>' + pill(it.status) + '</div>' +
      '<h1>' + esc(it.name) + (it.qty > 1 ? ' <span class="muted">×' + it.qty + '</span>' : '') + '</h1>' +
      needBanner +
      (it.photos.length ? '<div class="photos">' + it.photos.map((p) => '<img src="/p/' + p + '.jpg" alt="" loading="lazy" data-pid="' + p + '">').join('') + '</div>'
        : '<label class="nophoto" for="ph">No photo yet — tap to take one</label>') +
      '<input type="file" id="ph" accept="image/*" capture="environment" hidden><input type="file" id="phg" accept="image/*" multiple hidden>' +
      '<div class="row" style="margin-bottom:14px"><button class="btn alt sm" id="addPh">📷 Take photo</button><button class="btn alt sm" id="addPhG">From library</button>' +
      (D.tag_reader && it.photos.length ? '<button class="btn alt sm" id="rdTag"' + (it.tag_read && it.tag_read.status === 'reading' ? ' disabled>🏷 Reading tag…' : '>🏷 Read tag' + (it.tag_read ? ' again' : '')) + '</button>' : '') + '</div>' +
      (it.tag_read ? '<p class="muted small" style="margin:-6px 0 12px">' + tagNote(it.tag_read) + '</p>' : '') +
      ((it.status === 'Checked out' || it.status === 'In a show') ? '<div class="banner"><b>With ' + esc(it.holder) + '</b>' + (it.show ? ' for ' + esc(it.show) : '') + (it.due ? ' · due back ' + esc(it.due) : '') + '</div>' : '') +
      '<div class="row" style="margin-bottom:14px">' +
      ((it.status === 'Checked out' || it.status === 'In a show') ? '<button class="btn ok" id="ci">Check in / returned</button>' : '<button class="btn" id="co">Check out</button>') +
      '<button class="btn blue" id="mv">Move it</button></div>' +
      '<div class="card"><dl class="facts">' +
      '<dt>Place</dt><dd>' + (where ? '<a href="/l/' + esc(where.code) + '" data-nav>' + esc(where.name) + '</a>' : '<span class="muted">Not set</span>') + (it.sublocation ? ' · ' + esc(it.sublocation) : '') + '</dd>' +
      '<dt>Department</dt><dd>' + esc(it.category) + (deptOf(it.code) && deptOf(it.code).room ? ' <span class="muted">· ' + esc(deptOf(it.code).room) + '</span>' : '') + '</dd>' +
      (it.condition ? '<dt>Condition</dt><dd>' + esc(it.condition) + '</dd>' : '') +
      (it.color ? '<dt>Color</dt><dd>' + esc(it.color) + '</dd>' : '') +
      (it.size ? '<dt>Size</dt><dd>' + esc(it.size) + '</dd>' : '') +
      ((it.fit || []).length ? '<dt>Fits</dt><dd>' + esc(it.fit.join(', ')) + '</dd>' : '') +
      (it.period ? '<dt>Period / style</dt><dd>' + esc(it.period) + '</dd>' : '') +
      (it.tags ? '<dt>Tags</dt><dd>' + esc(it.tags) + '</dd>' : '') +
      (it.value ? '<dt>Value</dt><dd>$' + Number(it.value).toFixed(2) + '</dd>' : '') +
      (it.description ? '<dt>Description</dt><dd>' + esc(it.description) + '</dd>' : '') +
      (it.notes ? '<dt>Notes</dt><dd>' + esc(it.notes) + '</dd>' : '') +
      ((it.roles || []).length ? '<dt>Shows / characters</dt><dd>' + it.roles.map((r) => '<a href="' + setHref(r) + '" data-nav>' + esc(roleLabel(r)) + '</a>' + (r.show ? ' <a class="muted" href="' + showHref(r.show) + '" data-nav>· ' + esc(r.show) + '</a>' : '')).join('<br>') + '</dd>' : '') +
      '<dt>Last seen</dt><dd>' + esc(when(it.last_seen) || '—') + '</dd>' +
      '</dl><div class="row" style="margin-top:14px"><button class="btn alt" id="ed">Edit details</button>' +
      (copySources(it).length ? '<button class="btn alt" id="cfb">📋 Copy details from…</button>' : '') +
      (it.status !== 'Missing' ? '<button class="btn alt" id="ms">Can\'t find it</button>' : '') + '</div></div>' +
      alterCard(it) +
      '<div class="card"><h3>More just like this one?</h3><p class="muted small">Identical items (ten green web belts)? Tap <b>Scan stickers to copy</b> and scan each one\'s sticker: each gets these details' + (it.photos.length ? ' and this photo' : '') + '. No new photos, no typing.</p>' +
      '<div class="row"><button class="btn" id="cpy">⌗ Scan stickers to copy</button><button class="btn alt" id="cpyN">📋 Copy to several at once</button></div></div>' +
      '<div class="card"><div class="qrbox">' + qrSvg(qrUrl(it.code)) + '<div><b>Sticker</b><p class="muted small" style="margin:.3em 0 .6em">Lost or damaged sticker? Print a new one.</p>' +
      '<div class="row"><button class="btn alt sm" id="pr">Print sticker</button><button class="btn alt sm" id="rc">Wrong department?</button></div></div></div></div>' +
      '<div class="card"><h3>History</h3><ul class="hist">' + it.history.map((h) => '<li><b>' + esc(h.action) + '</b>' + (h.detail ? ' — ' + esc(h.detail) : '') + '<br><span class="muted small">' + esc(h.by) + ' · ' + esc(when(h.at)) + '</span></li>').join('') + '</ul></div>' +
      (D.role === 'admin' ? '<button class="btn alt sm" id="del" style="color:var(--bad)">Remove from inventory</button>' : '');
    $('#addPh').onclick = () => $('#ph').click(); $('#addPhG').onclick = () => $('#phg').click();
    if ($('#rdTag')) $('#rdTag').onclick = async () => {
      const b = $('#rdTag'); b.disabled = true; b.textContent = '🏷 Reading tag…';
      try { const r = await api('POST', '/api/items/' + it.code + '/readtag', {}); upsert(r.item);
        toast(r.filled.length ? 'Filled in: ' + r.filled.join(', ') : (r.has_tag ? 'Tag read, nothing new to fill' : 'No readable tag in the photos'), r.filled.length ? 'good' : '');
        render(true);
      } catch (e) { toast(e.message, 'bad'); b.disabled = false; b.textContent = '🏷 Read tag again'; }
    };
    const nophoto = $('.nophoto'); if (nophoto) nophoto.onclick = (e) => { e.preventDefault(); $('#ph').click(); };
    $('#ph').onchange = (e) => uploadPhotos(it.code, e.target.files);
    $('#phg').onchange = (e) => uploadPhotos(it.code, e.target.files);
    $$('.photos img').forEach((img) => img.onclick = () => photoMenu(it, img.dataset.pid));
    if ($('#co')) $('#co').onclick = () => checkout(it);
    if ($('#ci')) $('#ci').onclick = () => checkin(it);
    $('#mv').onclick = () => moveItem(it);
    $('#ed').onclick = () => editForm(it);
    if ($('#fillNow')) $('#fillNow').onclick = () => editForm(it);
    if ($('#fillCopy')) $('#fillCopy').onclick = () => editForm(it, null, true);
    if ($('#cfb')) $('#cfb').onclick = () => editForm(it, null, true);
    $('#cpy').onclick = () => copyToSticker(it);
    $('#altAdd').onclick = () => alterForm(it);
    $$('[data-alt]').forEach((b) => b.onclick = async () => {
      const [id, action] = b.dataset.alt.split(':');
      if (action === 'delete' && !confirm('Delete this alteration record? (Use this only for a mistake.)')) return;
      try { const r = await api('POST', '/api/items/' + it.code + '/alterations/' + id, { action }); upsert(r.item); render(true);
        toast(action === 'undo' ? 'Marked undone ✓' : action === 'permanent' ? 'Kept, now permanent' : 'Deleted', 'good'); }
      catch (e) { toast(e.message, 'bad'); }
    });
    $('#cpyN').onclick = () => makeCopies(it);
    if ($('#ms')) $('#ms').onclick = async () => { if (!confirm('Mark ' + it.name + ' as missing?')) return; await act(it.code, { action: 'missing' }, 'Marked missing'); };
    $('#pr').onclick = () => printCodes([it.code]);
    $('#rc').onclick = () => recode(it);
    if ($('#del')) $('#del').onclick = async () => {
      if (!confirm('Remove ' + it.name + ' (' + it.code + ') from the inventory? You can restore it from Settings.')) return;
      try { await api('DELETE', '/api/items/' + it.code); D.items = D.items.filter((x) => x.code !== it.code); toast('Removed'); go('/browse'); } catch (e) { toast(e.message, 'bad'); }
    };
  }
  async function act(code, body, msg) {
    try { const r = await api('POST', '/api/items/' + code + '/action', body); upsert(r.item); toast(msg, 'good'); render(true); return r.item; }
    catch (e) { if (e.data && e.data.item) { upsert(e.data.item); render(true); } toast(e.message, 'bad'); }
  }
  function checkout(it) {
    const recent = LS.get('holders', []);
    modal('<h2>Check out: ' + esc(it.name) + '</h2>' +
      '<form id="cf"><label>Who is taking it?<input id="h" list="hl" required value="' + esc(LS.get('name', '')) + '"></label><datalist id="hl">' + recent.map((r) => '<option value="' + esc(r) + '">').join('') + '</datalist>' +
      '<label>What for? (show, rental, event)<input id="sh" list="shl" value="' + esc(LS.get('lastShow', '')) + '"></label><datalist id="shl">' + [...new Set(D.items.map((i) => i.show).filter(Boolean))].map((r) => '<option value="' + esc(r) + '">').join('') + '</datalist>' +
      '<label>Due back (optional)<input id="du" type="date"></label>' +
      '<label class="check"><input type="checkbox" id="ins"> It is staying in the building for a show</label>' +
      '<button class="btn big">Check out</button><button type="button" class="btn alt big" data-close style="margin-top:8px">Cancel</button></form>',
    (m, close) => {
      $('#cf', m).onsubmit = async (e) => {
        e.preventDefault();
        const h = $('#h', m).value.trim(), sh = $('#sh', m).value.trim();
        LS.set('holders', [h].concat(recent.filter((x) => x !== h)).slice(0, 12)); LS.set('lastShow', sh);
        close(); await act(it.code, { action: 'checkout', holder: h, show: sh, due: $('#du', m).value, in_show: $('#ins', m).checked }, 'Checked out to ' + h);
      };
    });
  }
  function checkin(it) {
    modal('<h2>Returned: ' + esc(it.name) + '</h2><p class="muted">Where is it going back to?</p>' +
      '<label>Place<select id="lc">' + locOpts(it.location) + '</select></label>' +
      '<button class="btn ok big" id="ok">Check in</button><button class="btn alt big" id="sc" style="margin-top:8px">Scan the shelf sticker instead</button>' +
      '<button type="button" class="btn alt big" data-close style="margin-top:8px">Cancel</button>',
    (m, close) => {
      $('#ok', m).onclick = async () => { close(); await act(it.code, { action: 'checkin', location: $('#lc', m).value }, 'Checked in'); };
      $('#sc', m).onclick = () => { close(); openScanner({ mode: 'pickLoc', prompt: 'Scan the shelf / rack / bin sticker', onLoc: (l) => act(it.code, { action: 'checkin', location: l.code }, 'Checked in to ' + l.name) }); };
    });
  }
  function moveItem(it) {
    modal('<h2>Where is ' + esc(it.name) + ' now?</h2>' +
      '<button class="btn big" id="sc">⌗ Scan the shelf / bin sticker</button><p class="muted" style="text-align:center;margin:12px 0">or pick it</p>' +
      '<label>Place<select id="lc">' + locOpts(it.location) + '</select></label>' +
      '<label>Spot within it (optional)<input id="sub" placeholder="e.g. top shelf, left end" value="' + esc(it.sublocation || '') + '"></label>' +
      '<button class="btn blue big" id="ok">Save place</button><button type="button" class="btn alt big" data-close style="margin-top:8px">Cancel</button>',
    (m, close) => {
      $('#ok', m).onclick = async () => { close(); await act(it.code, { action: 'move', location: $('#lc', m).value, sublocation: $('#sub', m).value }, 'Place saved'); };
      $('#sc', m).onclick = () => { close(); openScanner({ mode: 'pickLoc', prompt: 'Scan the shelf / rack / bin sticker', onLoc: (l) => act(it.code, { action: 'move', location: l.code }, 'Now at ' + l.name) }); };
    });
  }
  // ── Alterations ────────────────────────────────────────────────────────────
  const activeTemp = (i) => (i.alterations || []).filter((a) => a.kind === 'Temporary' && a.status === 'Active');
  function alterCard(it) {
    const list = it.alterations || [];
    const isAdm = D.role === 'admin';
    return '<div class="card"><div class="sect" style="margin:0"><h3 style="margin:0">Alterations</h3><button class="btn alt sm" id="altAdd">✂ Add alteration</button></div>' +
      (activeTemp(it).length ? '<div class="banner" style="margin-top:10px"><b>' + activeTemp(it).length + ' temporary alteration' + (activeTemp(it).length === 1 ? '' : 's') + ' to undo</b> before this goes back in stock.</div>' : '') +
      (list.length ? '<ul class="alts">' + list.map((a) => {
        const live = a.kind === 'Temporary' && a.status === 'Active';
        return '<li class="' + (a.status === 'Undone' ? 'done' : '') + '"><span class="altk ' + (a.kind === 'Temporary' ? 'tmp' : 'perm') + '">' + (a.status === 'Undone' ? 'Undone' : a.kind) + '</span> <b>' + esc(a.what) + '</b>' +
          (a.show ? ' <span class="muted">· ' + esc(a.show) + (a.character ? ' / ' + esc(a.character) : '') + '</span>' : '') +
          (a.undo_by && live ? ' <span class="muted">· undo by ' + esc(a.undo_by) + '</span>' : '') +
          (a.notes ? '<div class="small">' + esc(a.notes) + '</div>' : '') +
          '<div class="muted small">' + esc(a.by) + ' · ' + esc(when(a.at)) + (a.undone_at ? ' · undone by ' + esc(a.undone_by) + ' ' + esc(when(a.undone_at)) : '') + '</div>' +
          (live || isAdm ? '<div class="row" style="margin-top:6px">' + (live ? '<button class="btn sm" data-alt="' + a.id + ':undo">✓ Mark undone</button><button class="btn alt sm" data-alt="' + a.id + ':permanent">Keep it (make permanent)</button>' : '') +
            (isAdm ? '<button class="btn alt sm" style="color:var(--bad)" data-alt="' + a.id + ':delete">Delete</button>' : '') + '</div>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="muted small" style="margin:8px 0 0">None recorded. Hemmed, taken in, dyed, cut, painted? Log it here.</p>') + '</div>';
  }
  function alterForm(it) {
    const shows = (D.shows || []).map((s) => s.name);
    const cur = ((it.roles || []).find((r) => r.show) || {}).show || '';
    modal('<h2>Alteration on ' + esc(it.name) + '</h2><form id="alf">' +
      '<label>What was changed? *<input id="al_what" required maxlength="300" placeholder="e.g. Hemmed 2 in., took in waist 1 in., dyed black"></label>' +
      '<div class="seg"><label><input type="radio" name="alk" value="Temporary" checked> <b>Temporary</b><span>basted, pinned, safety-pinned — undo after the show</span></label>' +
      '<label><input type="radio" name="alk" value="Permanent"> <b>Permanent</b><span>cut, sewn for good, dyed, painted</span></label></div>' +
      '<label>For which show? <span class="muted small">(optional)</span><input id="al_show" list="al_shows" value="' + esc(cur) + '"><datalist id="al_shows">' + shows.map((s) => '<option value="' + esc(s) + '">').join('') + '</datalist></label>' +
      '<div class="grid2"><label>Character <span class="muted small">(optional)</span><input id="al_char"></label>' +
      '<label id="al_undo_l">Undo by <span class="muted small">(optional)</span><input id="al_undo" type="date"></label></div>' +
      '<label>Notes <span class="muted small">(optional)</span><textarea id="al_notes" placeholder="Original measurement, who did it, thread colour…"></textarea></label>' +
      '<button class="btn big">Save alteration</button><button type="button" class="btn alt big" data-close style="margin-top:8px">Cancel</button></form>',
    (m, close) => {
      const sync = () => { $('#al_undo_l', m).style.display = $('input[name=alk]:checked', m).value === 'Temporary' ? '' : 'none'; };
      $$('input[name=alk]', m).forEach((x) => x.onchange = sync);
      $('#alf', m).onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/api/items/' + it.code + '/alterations', { what: $('#al_what', m).value, kind: $('input[name=alk]:checked', m).value,
            show: $('#al_show', m).value, character: $('#al_char', m).value, undo_by: $('#al_undo', m).value, notes: $('#al_notes', m).value });
          upsert(r.item); close(); render(true); toast('Alteration saved', 'good');
        } catch (er) { toast(er.message, 'bad'); }
      };
    });
  }
  function pickSame(list, onPick) {
    const seen = new Map();   // 7 identical belts show as one row "×7"
    list.slice().sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).forEach((i) => {
      const k = [i.name, i.size, i.color].join('|').toLowerCase();
      if (seen.has(k)) seen.get(k).n++; else seen.set(k, { i, n: 1 });
    });
    const rows = [...seen.values()].map((x) => Object.assign({}, x.i, { _n: x.n })).sort((a, b) => a.name.localeCompare(b.name));
    const draw = (q) => { const w = q.toLowerCase().split(/\s+/).filter(Boolean);
      return rows.filter((i) => w.every((x) => (i.name + ' ' + i.size + ' ' + i.color + ' ' + i.code + ' ' + i.tags).toLowerCase().includes(x))).slice(0, 80)
        .map((i) => '<button type="button" class="it" data-same="' + esc(i.code) + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer">' + thumb(i) +
          '<div class="bd"><div class="nm">' + esc(i.name) + '</div><div class="mt">' + esc([i.size, i.color, i._n > 1 ? '×' + i._n + ' in stock' : i.code].filter(Boolean).join(' · ')) + '</div></div></button>').join('') || '<p class="muted">No match.</p>'; };
    modal('<h2>Which item is it the same as?</h2><input id="sq" type="search" placeholder="Search: tie, khaki, 15½…" style="margin-bottom:8px"><div id="sl" style="max-height:55vh;overflow:auto">' + draw('') + '</div>' +
      '<button type="button" class="btn alt big" data-close style="margin-top:10px">Cancel</button>',
    (m, close) => {
      const wire = () => $$('[data-same]', m).forEach((b) => b.onclick = () => { close(); onPick(item(b.dataset.same)); });
      $('#sq', m).oninput = (e) => { $('#sl', m).innerHTML = draw(e.target.value); wire(); }; wire();
    });
  }
  function tagNote(t) {
    if (t.status === 'reading') return '🏷 Reading the tag in the photos…';
    if (t.status === 'error') return '🏷 Tag reading failed — tap Read tag again.';
    if (t.status === 'no_tag') return '🏷 No readable tag in these photos. Add a close, flat photo of the label and tap Read tag again.';
    return '🏷 Details read from the tag photo' + (t.confidence && t.confidence !== 'high' ? ' (tag was hard to read — check the size)' : '') + '. Anything you type yourself is never overwritten.';
  }
  function photoMenu(it, pid) {
    modal('<img src="/p/' + pid + '.jpg" style="width:100%;border-radius:12px;margin-bottom:12px">' +
      '<div class="row"><button class="btn alt" id="cv">Make main photo</button><button class="btn alt" id="rm" style="color:var(--bad)">Delete photo</button></div>' +
      '<button class="btn alt big" data-close style="margin-top:10px">Close</button>',
    (m, close) => {
      $('#cv', m).onclick = async () => { close(); try { const r = await api('POST', '/api/items/' + it.code + '/cover', { pid }); upsert(r.item); render(true); } catch (e) { toast(e.message, 'bad'); } };
      $('#rm', m).onclick = async () => { if (!confirm('Delete this photo?')) return; close(); try { const r = await api('DELETE', '/api/items/' + it.code + '/photos/' + pid); upsert(r.item); render(true); } catch (e) { toast(e.message, 'bad'); } };
    });
  }

  // ── Photos: shrink on the phone, then upload ───────────────────────────────
  // ── Batch photo upload: read the sticker inside each photo ─────────────────
  // Order of attempts: the phone's built-in reader (fast, Android/Mac), then jsQR on the whole
  // picture, then jsQR on overlapping tiles at near-full resolution so a small sticker in a wide
  // shot of a rack still reads.
  // Finds EVERY sticker in a photo (a group shot of several items returns all their codes).
  // The phone's built-in reader sees all codes at once; otherwise jsQR scans the whole picture and
  // overlapping tiles, and after each hit paints over that code so the next one can be found.
  async function codesInPhoto(file) {
    let bmp; try { bmp = await createImageBitmap(file); } catch (e) { return []; }
    const W = bmp.width, H = bmp.height; const found = new Set();
    const add = (raw) => { const r = parseScan(raw); if (r && r.kind === 'item') found.add(r.code); };
    if ('BarcodeDetector' in window) {
      try { const det = new window.BarcodeDetector({ formats: ['qr_code'] }); (await det.detect(bmp)).forEach((f) => add(f.rawValue)); } catch (e) { /* fall through */ }
    }
    await loadJsQR().catch(() => {});
    if (window.jsQR) {
      const c = document.createElement('canvas'); const x = c.getContext('2d', { willReadFrequently: true });
      const scanRegion = (sx, sy, sw, sh, scale) => {
        c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
        x.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
        for (let k = 0; k < 8; k++) {
          const q = window.jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
          if (!q) break;
          add(q.data);
          const L = q.location; x.fillStyle = '#fff'; x.beginPath();   // blank out this code, look for the next
          [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].forEach((pt, i) => { const px = pt.x + (pt.x - (L.topLeftCorner.x + L.bottomRightCorner.x) / 2) * 0.25, py = pt.y + (pt.y - (L.topLeftCorner.y + L.bottomRightCorner.y) / 2) * 0.25; i ? x.lineTo(px, py) : x.moveTo(px, py); });
          x.closePath(); x.fill();
        }
      };
      scanRegion(0, 0, W, H, Math.min(1, 1600 / Math.max(W, H)));
      const s = Math.min(1, 3200 / Math.max(W, H)); const tile = Math.round(1100 / s), step = Math.round(tile / 2);
      for (let ty = 0; ty < H; ty += step) {
        for (let tx = 0; tx < W; tx += step) {
          scanRegion(tx, ty, Math.min(tile, W - tx), Math.min(tile, H - ty), s);
          await new Promise((ok) => setTimeout(ok, 0));
          if (tx + tile >= W) break;
        }
        if (ty + tile >= H) break;
      }
    }
    return [...found].sort();
  }
  async function attachPhoto(code, file, made) {
    let it = item(code);
    if (!it) {
      if (!deptOf(code)) throw new Error(code + ' is not one of our sticker codes');
      const r = await api('POST', '/api/items', { code, needs_details: true }); upsert(r.item); it = r.item; made.push(code);
    }
    const photo = { full: await shrink(file, 1400, 0.74), thumb: await shrink(file, 360, 0.7) };
    const r2 = await api('POST', '/api/items/' + it.code + '/photos', photo); upsert(r2.item);
    return it;
  }
  function uploadPage() {
    editing = false;
    pinned = true; // live updates from other phones must not wipe the results / "type the code" list
    view.innerHTML = '<h1>Upload photos</h1>' +
      '<div class="card"><p>Pick as many photos as you like. Each one needs its <b>sticker clearly visible</b>. The site reads the sticker and puts the photo on that item.</p>' +
      '<ul class="small muted" style="margin:0 0 12px;padding-left:20px"><li>Sticker in focus, not tiny: about a tenth of the picture or bigger.</li><li>Several items in one photo is fine: every sticker it can read gets that photo. One item per photo gives the best pictures.</li><li>A blank sticker becomes a new item in <b>Need details</b>.</li><li>Photos it cannot read are listed at the bottom so you can type the code.</li></ul>' +
      '<input type="file" id="bf" accept="image/*" multiple hidden><button class="btn big" id="bp">⇪ Choose photos</button></div>' +
      '<div id="bsum" class="card" style="display:none"></div><div id="blist" class="list"></div><div id="bmiss"></div>';
    $('#bp').onclick = () => $('#bf').click();
    $('#bf').onchange = async (e) => {
      const files = Array.from(e.target.files || []); if (!files.length) return;
      $('#bp').disabled = true; editing = true;
      const list = $('#blist'), sum = $('#bsum'); sum.style.display = '';
      let done = 0, ok = 0; const misses = [], made = [];
      const tick = () => { sum.innerHTML = '<b>' + done + ' of ' + files.length + '</b> photos checked · ' + ok + ' item' + (ok === 1 ? '' : 's') + ' got a photo' + (made.length ? ' · ' + made.length + ' new (Need details)' : '') + (misses.length ? ' · <span class="audit-miss">' + misses.length + ' need a code</span>' : ''); };
      tick();
      for (const f of files) {
        const url = URL.createObjectURL(f);
        const row = document.createElement('div'); row.className = 'it';
        row.innerHTML = '<div class="th" style="background-image:url(' + url + ')"></div><div class="bd"><div class="nm">' + esc(f.name) + '</div><div class="mt">Reading sticker…</div></div>';
        list.prepend(row);
        let codes = []; try { codes = await codesInPhoto(f); } catch (er) { codes = []; }
        if (codes.length) {
          const lines = [];
          for (const code of codes) {
            try { const it = await attachPhoto(code, f, made); ok++; lines.push('✓ <a href="/i/' + esc(it.code) + '" data-nav>' + esc(it.code) + '</a> · ' + esc(it.name)); }
            catch (er) { lines.push('✕ ' + esc(code) + ': ' + esc(er.message)); }
          }
          row.querySelector('.mt').innerHTML = (codes.length > 1 ? '<b>' + codes.length + ' stickers in this photo</b><br>' : '') + lines.join('<br>');
          row.querySelector('.mt').style.whiteSpace = 'normal';
        } else { row.querySelector('.mt').innerHTML = '<span class="audit-miss">No sticker found</span>'; misses.push({ f, url, row }); }
        done++; tick();
      }
      editing = false; $('#bp').disabled = false; $('#bp').textContent = '⇪ Choose more photos'; e.target.value = '';
      if (!misses.length) { toast('All ' + ok + ' photos attached', 'good'); return; }
      $('#bmiss').innerHTML = '<div class="sect"><h2>Type the code for these</h2></div>' + misses.map((m, i) =>
        '<div class="card" style="display:flex;gap:12px;align-items:center"><img src="' + m.url + '" style="width:110px;height:110px;object-fit:cover;border-radius:10px;flex:none">' +
        '<form data-miss="' + i + '" style="flex:1;min-width:0"><input placeholder="Sticker code, e.g. cost21" autocapitalize="characters" required style="margin:0 0 8px">' +
        '<div class="row"><button class="btn sm">Attach</button><button type="button" class="btn alt sm" data-skip>Skip</button></div></form></div>').join('');
      $$('#bmiss form').forEach((fm) => {
        const m = misses[+fm.dataset.miss];
        fm.querySelector('[data-skip]').onclick = () => fm.closest('.card').remove();
        fm.onsubmit = async (ev) => {
          ev.preventDefault(); const code = normCode(fm.querySelector('input').value);
          if (!code) return toast('Type a code like COST-0021', 'bad');
          try { const it = await attachPhoto(code, m.f, made); fm.closest('.card').remove(); ok++; tick();
            m.row.querySelector('.mt').innerHTML = '✓ <a href="/i/' + esc(it.code) + '" data-nav>' + esc(it.code) + '</a> · ' + esc(it.name) + ' (typed)';
            toast('Attached to ' + it.code, 'good');
          } catch (er) { toast(er.message, 'bad'); }
        };
      });
    };
  }
  function shrink(file, max, q) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
      img.src = url;
    });
  }
  async function uploadPhotos(code, files) {
    files = Array.from(files || []); if (!files.length) return;
    for (let i = 0; i < files.length; i++) {
      toast('Uploading photo ' + (i + 1) + ' of ' + files.length + '…');
      try {
        const full = await shrink(files[i], 1400, 0.74), th = await shrink(files[i], 360, 0.7);
        const r = await api('POST', '/api/items/' + code + '/photos', { full, thumb: th }); upsert(r.item);
      } catch (e) { toast(e.message, 'bad'); return; }
    }
    toast('Photo saved', 'good'); render(true);
  }

  // ── Add / edit ─────────────────────────────────────────────────────────────
  const FITS = ["Men's", "Women's", "Unisex", "Children's"];
  function fieldsHtml(v) {
    const sticky = LS.get('sticky', {});
    v = Object.assign({ category: sticky.category || '', location: sticky.location || '', roles: sticky.roles || [], qty: 1, condition: '' }, v || {});
    if (v.code && deptOf(v.code)) v.fixedDept = deptOf(v.code);
    return '<label>What is it? *<input id="f_name" required maxlength="120" placeholder="e.g. Red velvet Victorian gown" value="' + esc(v.name || '') + '"></label>' +
      (v.fixedDept ? '<label>Department<input value="' + esc(v.fixedDept.p + ' · ' + v.fixedDept.name) + '" disabled></label><input type="hidden" id="f_category" value="' + esc(v.fixedDept.name) + '">'
        : '<label>Department *<select id="f_category" required>' + opts(depts().map((d) => [d.name, d.p + ' · ' + d.name]), v.category, 'Pick one') + '</select></label>') +
      '<div class="grid2">' +
      '<label>How many<input id="f_qty" type="number" inputmode="numeric" min="0" value="' + esc(v.qty) + '"></label>' +
      '<label>Size<input id="f_size" placeholder="38S, M, 9½…" value="' + esc(v.size || '') + '"></label></div>' +
      '<fieldset class="fits"><legend>Who it fits <span class="muted small">(tick all that apply)</span></legend>' +
      FITS.map((f) => '<label class="check"><input type="checkbox" class="f_fit" value="' + esc(f) + '"' + ((v.fit || []).includes(f) ? ' checked' : '') + '> ' + esc(f) + '</label>').join('') + '</fieldset>' +
      '<label>Place<select id="f_location">' + locOpts(v.location) + '</select></label>' +
      bookHtml(v) +
      rolesHtml(v.roles) +
      '<details' + (v.color || v.size || v.period || v.notes || v.description || v.tags || v.value || v.condition || v.sublocation ? ' open' : '') + '><summary style="font-weight:700;margin:4px 0 12px;cursor:pointer">More details (optional)</summary>' +
      '<label>Spot within the place<input id="f_sublocation" placeholder="top shelf, left end…" value="' + esc(v.sublocation || '') + '"></label>' +
      '<label>Color<input id="f_color" value="' + esc(v.color || '') + '"></label>' +
      '<div class="grid2"><label>Period / style<input id="f_period" placeholder="1920s, Victorian…" value="' + esc(v.period || '') + '"></label>' +
      '<label>Condition<select id="f_condition">' + opts(D.conditions, v.condition, '—') + '</select></label></div>' +
      '<label>Tags (words to search by)<input id="f_tags" placeholder="military, formal, Christmas…" value="' + esc(v.tags || '') + '"></label>' +
      '<label>Description<textarea id="f_description">' + esc(v.description || '') + '</textarea></label>' +
      '<label>Notes<textarea id="f_notes">' + esc(v.notes || '') + '</textarea></label>' +
      '<label>Replacement value ($)<input id="f_value" inputmode="decimal" value="' + esc(v.value || '') + '"></label>' +
      (v.code ? '<label>Status<select id="f_status">' + opts(D.statuses, v.status) + '</select></label>' : '') +
      '</details>';
  }
  // ── Characters (show + character) ─────────────────────────────────────────
  const setHref = (r) => r.character ? '/set?show=' + encodeURIComponent(r.show || '') + '&character=' + encodeURIComponent(r.character) : showHref(r.show);
  const showHref = (s) => '/show?show=' + encodeURIComponent(s || '');
  const roleLabel = (r) => r.character || 'Whole show';
  function allRoles() {
    const m = new Map();
    const put = (show, character, add) => { const k = (show + '|' + character).toLowerCase(); if (!m.has(k)) m.set(k, { show, character, n: 0 }); m.get(k).n += add; };
    (D.shows || []).forEach((s) => { put(s.name, '', 0); s.characters.forEach((c) => put(s.name, c, 0)); });
    D.items.forEach((i) => (i.roles || []).forEach((r) => put(r.show, r.character, 1)));
    return [...m.values()];
  }
  const rosterNames = () => [...new Set((D.shows || []).map((s) => s.name).concat(D.items.flatMap((i) => (i.roles || []).map((r) => r.show))).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const rosterChars = (show) => { const s = (D.shows || []).find((x) => x.name.toLowerCase() === String(show).toLowerCase());
    return [...new Set((s ? s.characters : []).concat(D.items.flatMap((i) => (i.roles || []).filter((r) => r.show.toLowerCase() === String(show).toLowerCase()).map((r) => r.character))).filter(Boolean))].sort((a, b) => a.localeCompare(b)); };
  // One row = a show drop-down + a character drop-down (with "+ New…" choices to add on the spot).
  function roleRow(r) {
    const show = (r && r.show) || LS.get('lastShowRole', '');
    return '<div class="row role" style="gap:6px;margin-bottom:6px;flex-wrap:nowrap">' +
      '<select class="r_show" style="margin:0;flex:1.2;min-width:0">' + showOpts(show) + '</select>' +
      '<select class="r_char" style="margin:0;flex:1;min-width:0">' + charOpts(show, (r && r.character) || '') + '</select>' +
      '<button type="button" class="btn alt sm" data-delrole title="Remove" style="flex:none">✕</button></div>';
  }
  function showOpts(sel) {
    const names = rosterNames(); if (sel && !names.some((n) => n.toLowerCase() === sel.toLowerCase())) names.push(sel);
    return '<option value="">Pick a show…</option>' + names.map((n) => '<option' + (n.toLowerCase() === String(sel).toLowerCase() ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '<option value="__new">+ New show…</option>';
  }
  function charOpts(show, sel) {
    const cs = show ? rosterChars(show) : []; if (sel && !cs.some((c) => c.toLowerCase() === sel.toLowerCase())) cs.push(sel);
    return '<option value="">Whole show (no character)</option>' + cs.map((c) => '<option' + (c.toLowerCase() === String(sel).toLowerCase() ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + (show ? '<option value="__new">+ New character…</option>' : '');
  }
  const BOOK_ROLES = ['Stage manager', 'Assistant stage manager', 'Director', 'Lighting designer', 'Sound designer', 'Light board op', 'Sound board op',
    'Curtain puller', 'Fly rail', 'Props master', 'Wardrobe', 'Music director', 'Actor script', 'Rehearsal script'];
  function isBookDept(v) { return (v.fixedDept && v.fixedDept.p === 'BOOK') || (!v.fixedDept && /^BOOK$/i.test(((depts().find((d) => d.name === v.category) || {}).p) || '')); }
  function bookHtml(v) {
    const cur = (String(v.name || '').match(/ — (.+?) book$/) || [])[1] || '';
    return '<div id="bookBox" class="banner" style="display:' + (isBookDept(v) ? 'block' : 'none') + '"><b>Prompt book / script</b> — belongs to one show. Pick the show below and whose book it is; the name fills itself in.' +
      '<label style="margin:8px 0 0">Whose book?<select id="bk_role">' + opts(BOOK_ROLES.map((r) => [r, r]), BOOK_ROLES.includes(cur) ? cur : '', 'Pick one') + '</select></label></div>';
  }
  function bookAutoName() {
    const box = $('#bookBox'); if (!box || box.style.display === 'none') return;
    const show = ($('#roles .r_show') || {}).value || '', role = ($('#bk_role') || {}).value || '', nm = $('#f_name');
    if (!nm || !show || show === '__new' || !role) return;
    if (!nm.value.trim() || nm.dataset.auto === '1' || / — .+ book$/.test(nm.value)) { nm.value = show + ' — ' + role + ' book'; nm.dataset.auto = '1'; }
  }
  document.addEventListener('change', (e) => {
    if (e.target.id === 'bk_role' || e.target.classList.contains('r_show')) bookAutoName();
    if (e.target.id === 'f_category' && $('#bookBox')) { $('#bookBox').style.display = isBookDept({ category: e.target.value }) ? 'block' : 'none'; bookAutoName(); }
  });
  function rolesHtml(roles) {
    return '<div style="margin:0 0 12px"><div style="font-weight:650;font-size:.92rem;margin-bottom:5px">Show &amp; character</div>' +
      '<div id="roles">' + ((roles && roles.length) ? roles.map(roleRow).join('') : roleRow(null)) + '</div>' +
      '<button type="button" class="btn alt sm" data-addrole>+ Add another show or character</button></div>';
  }
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-addrole]'); if (add) { e.preventDefault(); $('#roles').insertAdjacentHTML('beforeend', roleRow(null)); return; }
    const del = e.target.closest('[data-delrole]'); if (del) { e.preventDefault(); del.closest('.role').remove(); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target; const row = t.closest && t.closest('.role'); if (!row) return;
    if (t.classList.contains('r_show')) {
      if (t.value === '__new') {
        const n = (prompt('Name of the new show') || '').trim(); if (!n) { t.value = ''; return; }
        try { const r = await api('POST', '/api/shows', { name: n }); D.shows = r.shows; } catch (er) { toast(er.message, 'bad'); }
        t.innerHTML = showOpts(n);
      }
      if (t.value) LS.set('lastShowRole', t.value);
      $('.r_char', row).innerHTML = charOpts(t.value, '');
    } else if (t.classList.contains('r_char') && t.value === '__new') {
      const show = $('.r_show', row).value; const n = (prompt('New character in ' + show) || '').trim(); if (!n) { t.value = ''; return; }
      try { const r = await api('POST', '/api/shows', { name: show, character: n }); D.shows = r.shows; } catch (er) { toast(er.message, 'bad'); }
      t.innerHTML = charOpts(show, n);
    }
  });
  function readRoles(root) {
    return $$('#roles .role', root).map((r) => ({ show: $('.r_show', r).value.replace('__new', ''), character: $('.r_char', r).value.replace('__new', '') })).filter((r) => r.show || r.character);
  }
  function readFields(root) {
    const o = {};
    if ($('.fits', root)) o.fit = $$('.f_fit', root).filter((c) => c.checked).map((c) => c.value);
    if ($('#roles', root)) { o.roles = readRoles(root); const s = o.roles.find((r) => r.show); if (s) LS.set('lastShowRole', s.show); }
    ['name', 'category', 'qty', 'location', 'sublocation', 'color', 'size', 'period', 'condition', 'tags', 'description', 'notes', 'value', 'status'].forEach((k) => {
      const el = $('#f_' + k, root); if (el) o[k] = el.value;
    });
    return o;
  }
  function addForm(code, append, src) {
    editing = true;
    const pre = {}; if (src) COPY_FIELDS.forEach((k) => { if (src[k] != null && src[k] !== '') pre[k] = src[k]; });
    if (code && deptOf(code)) pre.fixedDept = deptOf(code);
    const html = '<form class="card" id="af">' + (append ? '' : '<h1>Add an item</h1>') +
      (code ? '<p class="muted">Sticker <span class="code">' + esc(code) + '</span> will be attached to this item.</p>'
        : '<p class="muted small">No sticker yet? It gets the next number and you can print its sticker after saving. Have blank stickers? Use <b>Scan</b> on one instead.</p>') +
      '<input type="file" id="aph" accept="image/*" capture="environment" hidden>' +
      '<div id="aprev" class="nophoto" style="cursor:pointer">📷 Tap to take a photo (recommended)</div>' +
      fieldsHtml(pre) +
      '<label class="check"><input type="checkbox" id="keep"' + (LS.get('keepOn', true) ? ' checked' : '') + '> Keep department, place &amp; characters for the next item</label>' +
      '<button class="btn big" id="sv">Save item</button></form>';
    if (append) view.insertAdjacentHTML('beforeend', html); else view.innerHTML = html;
    let photo = null;
    $('#aprev').onclick = () => $('#aph').click();
    $('#aph').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { photo = { full: await shrink(f, 1400, 0.74), thumb: await shrink(f, 360, 0.7) };
        $('#aprev').innerHTML = '<img src="' + photo.thumb + '" style="max-height:140px;border-radius:10px">'; } catch (er) { toast(er.message, 'bad'); }
    };
    $('#af').onsubmit = async (e) => {
      e.preventDefault(); const b = readFields(view); if (code) b.code = code;
      if (!code && !deptByName(b.category)) { toast('Pick a department.', 'bad'); return; }
      const keep = $('#keep').checked; LS.set('keepOn', keep);
      LS.set('sticky', keep ? { category: b.category, location: b.location, roles: b.roles || [] } : {});
      $('#sv').disabled = true; $('#sv').textContent = 'Saving…';
      try {
        const r = await api('POST', '/api/items', b); upsert(r.item);
        if (photo) { try { const r2 = await api('POST', '/api/items/' + r.item.code + '/photos', photo); upsert(r2.item); } catch (er) { toast('Item saved, photo failed: ' + er.message, 'bad'); } }
        editing = false; afterAdd(r.item, !code, !!src);
      } catch (er) {
        $('#sv').disabled = false; $('#sv').textContent = 'Save item';
        if (er.status === 409 && er.data && er.data.code) { toast(er.message, 'bad'); } else toast(er.message, 'bad');
      }
    };
    setTimeout(() => { const n = $('#f_name'); if (n && !('ontouchstart' in window)) n.focus(); }, 50);
  }
  function afterAdd(it, needsLabel, wasCopy) {
    history.replaceState(null, '', '/i/' + it.code); render();
    modal('<h2>Saved ✓</h2><p><b>' + esc(it.name) + '</b> is <span class="code">' + esc(it.code) + '</span>.</p>' +
      (needsLabel ? '<button class="btn big" id="pl">Print its sticker</button>' : '') +
      '<button class="btn ' + (wasCopy ? '' : 'alt ') + 'big" id="cp" style="margin-top:8px">⌗ Copy this to the next sticker</button>' +
      '<button class="btn ' + (wasCopy ? 'alt ' : '') + 'big" id="nx" style="margin-top:8px">⌗ Scan next blank sticker (new item)</button>' +
      '<button class="btn alt big" id="na" style="margin-top:8px">Add another without a sticker</button>' +
      '<button class="btn alt big" data-close style="margin-top:8px">Done</button>',
    (m, close) => {
      if ($('#pl', m)) $('#pl', m).onclick = () => { close(); printCodes([it.code]); };
      $('#nx', m).onclick = () => { close(); openScanner({ mode: 'go' }); };
      $('#cp', m).onclick = () => { close(); copyToSticker(it); };
      $('#na', m).onclick = () => { close(); go('/add'); };
    });
  }
  function recode(it) {
    modal('<h2>Move ' + esc(it.name) + ' to another department</h2><p class="muted">It gets a new sticker with the new department code. The old sticker ' + esc(it.code) + ' keeps working until you replace it.</p>' +
      '<label>New department<select id="nd">' + opts(depts().filter((d) => d !== deptOf(it.code)).map((d) => [d.name, d.p + ' · ' + d.name]), '', 'Pick one') + '</select></label>' +
      '<button class="btn big" id="go">Give it a new code</button><button class="btn alt big" data-close style="margin-top:8px">Cancel</button>',
    (m, close) => {
      $('#go', m).onclick = async () => {
        const dn = $('#nd', m).value; if (!dn) return toast('Pick a department.', 'bad');
        try { const r = await api('POST', '/api/items/' + it.code + '/recode', { department: dn }); await load(); close();
          go('/i/' + r.item.code, true); toast('Now ' + r.item.code + '. Print and stick the new sticker.', 'good'); printCodes([r.item.code]); }
        catch (er) { toast(er.message, 'bad'); }
      };
    });
  }
  function copyToSticker(it) {
    if (it.needs_details || it.name === 'Details needed') return toast('Fill in this item\'s details first, then copy them to the others.', 'bad');
    openScanner({ mode: 'copy', from: it, prompt: 'Scan each matching sticker, one after another' + (it.photos.length ? ' (they share this photo)' : ''), onClose: () => render(true) });
  }
  // Most of the time the twins already wear a printed sticker (often with a phone photo and "Details needed").
  // So the dialog leads with "copy onto stickers we already have"; new sticker numbers are the second choice.
  function parseCodeList(txt) {
    const out = [];
    String(txt || '').replace(/\s+(to|thru|through)\s+/gi, '-').split(/[\s,;]+/).filter(Boolean).forEach((tok) => {
      const m = tok.match(/^([a-z]+)-?0*(\d+)-(?:[a-z]+-?)?0*(\d+)$/i);
      if (m) { const a = +m[2], b = +m[3]; for (let k = Math.min(a, b); k <= Math.max(a, b) && out.length < 100; k++) out.push(normCode(m[1] + k)); }
      else { const c = normCode(tok); if (c) out.push(c); }
    });
    return [...new Set(out.filter(Boolean))];
  }
  function makeCopies(it) {
    if (it.needs_details || it.name === 'Details needed') return toast('Fill in this item\'s details first, then copy them to the others.', 'bad');
    const pend = D.items.filter((i) => i.needs_details && i.code !== it.code && i.category === it.category)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    modal('<h2>Copy the details of ' + esc(it.name) + '</h2>' +
      '<form id="ce"><h3 style="margin:4px 0 6px">Onto stickers you already have</h3>' +
      '<p class="muted small" style="margin-top:0">No printing. Each keeps its own sticker and its own photo.</p>' +
      (pend.length ? '<p class="small" style="margin:6px 0"><b>Waiting for details</b> (photo taken on the phone) — tick every one that is the same:</p>' +
        '<label class="check" style="margin:0 0 6px"><input type="checkbox" id="pcAll"> Select all ' + pend.length + '</label>' +
        '<div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px 8px;margin-bottom:10px">' +
        pend.map((p) => '<label class="check" style="margin:6px 0;font-weight:500"><input type="checkbox" class="pc" value="' + esc(p.code) + '">' +
          (p.photos[0] ? '<img src="/p/' + p.photos[0] + '_t.jpg" style="width:56px;height:56px;object-fit:cover;border-radius:8px">' : '') +
          '<span class="code">' + esc(p.code) + '</span></label>').join('') + '</div>' : '') +
      '<label>' + (pend.length ? 'Or type' : 'Type') + ' the sticker numbers<input id="ct" placeholder="e.g. cost45, cost46  or  cost45-50" autocapitalize="characters"></label>' +
      (it.photos.length ? '<label class="check" style="margin:4px 0 12px"><input type="checkbox" id="cph" checked> Use this photo on the ones that have no photo yet</label>' : '') +
      '<button class="btn big">Copy details onto these</button></form>' +
      '<hr style="border:0;border-top:1px solid var(--line);margin:18px 0">' +
      '<details><summary style="font-weight:700;cursor:pointer">No stickers on them yet? Make new sticker numbers</summary><div style="margin-top:10px">' +
      '<p class="muted">Each copy becomes its own item with its own sticker number and QR code. You print the stickers next, stick each one on, and scan it to add that one\'s photo.</p>' +
      '<form id="mc"><label>How many more?<input id="mn" type="number" min="1" max="100" value="1" inputmode="numeric"></label>' +
      (it.photos.length ? '<label class="check"><input type="checkbox" id="mp" checked> Show this photo on the copies until each gets its own</label>' : '') +
      '<button class="btn alt big">Make copies with new stickers</button></form></div></details>' +
      '<button type="button" class="btn alt big" data-close style="margin-top:12px">Cancel</button>',
    (m, close) => {
      if ($('#pcAll', m)) $('#pcAll', m).onchange = (e) => $$('.pc', m).forEach((c) => { c.checked = e.target.checked; });
      $('#ce', m).onsubmit = async (e) => {
        e.preventDefault();
        const codes = [...new Set($$('.pc', m).filter((c) => c.checked).map((c) => c.value).concat(parseCodeList($('#ct', m).value)))];
        if (!codes.length) return toast('Tick or type at least one sticker number.', 'bad');
        try {
          const r = await api('POST', '/api/items/' + it.code + '/copies', { codes, photo: !!($('#cph', m) && $('#cph', m).checked) });
          r.items.forEach(upsert); close();
          modal('<h2>Copied onto ' + r.items.length + ' item' + (r.items.length === 1 ? '' : 's') + ' ✓</h2>' +
            '<p>' + r.items.map((x) => '<a class="code" href="/i/' + esc(x.code) + '" data-nav>' + esc(x.code) + '</a>').join(' ') + '</p>' +
            (r.skipped && r.skipped.length ? '<p class="audit-miss small">Skipped: ' + r.skipped.map((x) => esc(x.code + ' (' + x.why + ')')).join(', ') + '</p>' : '') +
            '<p class="muted small">Nothing to print — they already have their stickers. Change size or color on any one that differs.</p>' +
            '<button class="btn big" data-close>Done</button>', () => {});
          render(true);
        } catch (er) { toast(er.message, 'bad'); }
      };
      $('#mc', m).onsubmit = async (e) => {
        e.preventDefault(); const n = Number($('#mn', m).value) || 0; if (n < 1) return;
        if (!confirm('Create ' + n + ' new item' + (n === 1 ? '' : 's') + ', each with its own sticker number?')) return;
        try {
          const r = await api('POST', '/api/items/' + it.code + '/copies', { count: n, photo: !!($('#mp', m) && $('#mp', m).checked) });
          r.items.forEach(upsert); close();
          modal('<h2>' + r.items.length + ' copies made ✓</h2><p>Stickers <span class="code">' + esc(r.items[0].code) + '</span>' + (r.items.length > 1 ? ' to <span class="code">' + esc(r.items[r.items.length - 1].code) + '</span>' : '') + '.</p>' +
            '<button class="btn big" id="pp">Print their ' + r.items.length + ' sticker' + (r.items.length === 1 ? '' : 's') + '</button><button class="btn alt big" data-close style="margin-top:8px">Later</button>',
          (m2, c2) => { $('#pp', m2).onclick = () => { c2(); printCodes(r.items.map((x) => x.code)); }; });
          render(true);
        } catch (er) { toast(er.message, 'bad'); }
      };
    });
  }
  // "Same as another one" — pull every detail from an item already filled in (the other tie), then Save.
  function copySources(it) {
    return D.items.filter((i) => i.code !== it.code && !i.needs_details && i.name !== 'Details needed' && i.category === it.category)
      .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  }
  function editForm(it, src, focusCopy) {
    editing = true;
    const base = it.needs_details ? Object.assign({}, it, { name: '' }) : it;
    const shown = src ? Object.assign({}, base, Object.fromEntries(COPY_FIELDS.filter((k) => k !== 'category' && src[k] != null && src[k] !== '').map((k) => [k, JSON.parse(JSON.stringify(src[k]))]))) : base;
    const srcs = copySources(it);
    view.innerHTML = '<form class="card" id="ef"><h1>' + (it.needs_details ? 'Add details: ' : 'Edit ') + '<span class="code">' + esc(it.code) + '</span></h1>' +
      (it.photos[0] ? '<img src="/p/' + it.photos[0] + '_t.jpg" style="max-height:160px;border-radius:10px;display:block;margin-bottom:12px">' : '') +
      (srcs.length ? '<div class="banner" style="display:block"><label style="margin:0"><b>📋 Same as another item? Copy its details</b>' +
        '<select id="cfrom"><option value="">— pick the matching item —</option>' + srcs.map((s) => '<option value="' + esc(s.code) + '"' + (src && src.code === s.code ? ' selected' : '') + '>' +
          esc(s.name + (s.size ? ' · ' + s.size : '') + (s.color ? ' · ' + s.color : '') + ' · ' + s.code) + '</option>').join('') + '</select></label>' +
        (src ? '<p class="small" style="margin:6px 0 0">Copied from <b>' + esc(src.code) + '</b> — change anything that differs (size?), then <b>Save</b>. This item keeps its own photo and sticker.</p>' : '') + '</div>' : '') +
      fieldsHtml(shown) +
      '<button class="btn big">Save changes</button><button type="button" class="btn alt big" id="cx" style="margin-top:8px">Cancel</button></form>';
    $('#cx').onclick = () => { editing = false; render(); };
    if ($('#cfrom')) { $('#cfrom').onchange = (e) => { const s = item(e.target.value); editForm(it, s || null); };
      if (focusCopy) { $('#cfrom').focus(); $('#cfrom').scrollIntoView({ block: 'center' }); } }
    $('#ef').onsubmit = async (e) => {
      e.preventDefault(); const b = readFields(view); const ch = {};
      delete b.category; // the sticker sets the department; use "Wrong department?" to change it
      Object.keys(b).forEach((k) => { const same = k === 'roles' ? JSON.stringify(b.roles) === JSON.stringify(it.roles || []) : String(b[k] ?? '') === String(it[k] ?? ''); if (!same) ch[k] = b[k]; });
      try { if (Object.keys(ch).length) { const r = await api('PATCH', '/api/items/' + it.code, ch); upsert(r.item); } editing = false; toast('Saved', 'good'); render(); }
      catch (er) { toast(er.message, 'bad'); }
    };
  }

  // ── Locations ──────────────────────────────────────────────────────────────
  function characters() {
    const rs = allRoles().sort((a, b) => (a.show || '').localeCompare(b.show || '') || a.character.localeCompare(b.character));
    let last = null;
    view.innerHTML = '<h1>Shows</h1>' +
      '<form class="card" id="nsf"><h3>Add a show</h3><label>Show name<input id="nsn" placeholder="e.g. Romeo and Juliet" required></label><button class="btn big">Add show</button></form>' +
      '<p class="muted small">Tap a show to add its characters and see everything for it.</p>' +
      '<div class="search"><input id="cq" type="search" placeholder="Find a show or character…"></div><div class="list" id="cl">' +
      rs.map((r) => {
        const head = (r.show || 'No show named') !== last ? '<a class="it" href="' + showHref(r.show) + '" data-nav data-key="' + esc((r.show || '').toLowerCase()) + '" style="margin-top:10px;border-width:2px"><div class="th">🎭</div><div class="bd"><div class="nm">' + esc(last = (r.show || 'No show named')) + '</div><div class="mt">Whole show — all characters and items</div></div></a>' : '';
        return head + (r.character ? '<a class="it" href="' + setHref(r) + '" data-nav data-key="' + esc((r.show + ' ' + r.character).toLowerCase()) + '" style="margin-left:18px"><div class="th">☺</div><div class="bd"><div class="nm">' + esc(r.character) + '</div><div class="mt">' + r.n + ' item' + (r.n === 1 ? '' : 's') + '</div></div></a>' : '');
      }).join('') + '</div>' + (rs.length ? '' : '<div class="card empty">Nothing tagged yet. Open an item, tap <b>Edit details</b>, and add a show and character.</div>');
    $('#cq').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('#cl a').forEach((a) => { a.style.display = a.dataset.key.includes(q) ? '' : 'none'; }); });
    $('#nsf').onsubmit = async (e) => { e.preventDefault(); const n = $('#nsn').value.trim();
      try { const r = await api('POST', '/api/shows', { name: n }); D.shows = r.shows; toast('Added ' + n + ' — now add its characters', 'good'); go(showHref(r.show.name)); } catch (er) { toast(er.message, 'bad'); } };
  }
  function showPage(show) {
    const inShow = (r) => (r.show || '').toLowerCase() === show.toLowerCase();
    const its = D.items.filter((i) => (i.roles || []).some(inShow));
    const chars = new Map();
    rosterChars(show).forEach((c) => chars.set(c.toLowerCase(), { show, character: c, n: 0 }));
    its.forEach((i) => i.roles.filter(inShow).forEach((r) => { if (!r.character) return; const k = r.character.toLowerCase(); if (!chars.has(k)) chars.set(k, { show: r.show, character: r.character, n: 0 }); chars.get(k).n++; }));
    const byDept = {}; its.forEach((i) => { const d = (deptOf(i.code) || { name: i.category }).name; (byDept[d] = byDept[d] || []).push(i); });
    const who = (i) => i.roles.filter(inShow).map(roleLabel).join(', ');
    const out = its.filter((i) => i.status === 'Checked out' || i.status === 'In a show').length;
    view.innerHTML = '<span class="muted small">SHOW</span><h1>' + esc(show) + '</h1>' +
      '<div class="card"><div class="stats"><div><b>' + its.length + '</b><span>Items</span></div><div><b>' + chars.size + '</b><span>Characters</span></div><div><b>' + out + '</b><span>Out now</span></div></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn alt sm" id="prShow"' + (its.length ? '' : ' disabled') + '>Print stickers for this show</button><button class="btn alt sm" onclick="window.print()">Print this list</button><a class="btn alt sm" href="/api/export.csv">Spreadsheet</a></div></div>' +
      '<form class="card" id="ncf" style="margin-top:12px"><h3>Add a character</h3><div class="row" style="flex-wrap:nowrap"><input id="ncn" placeholder="e.g. Galloway" required style="margin:0;flex:1;min-width:0"><button class="btn" style="flex:none">Add</button></div></form>' +
      '<div class="sect"><h2>Characters</h2></div><div class="list">' + [...chars.values()].sort((a, b) => a.character.localeCompare(b.character)).map((r) =>
        '<a class="it" href="' + setHref(r) + '" data-nav><div class="th">☺</div><div class="bd"><div class="nm">' + esc(r.character) + '</div><div class="mt">' + r.n + ' item' + (r.n === 1 ? '' : 's') + '</div></div></a>').join('') + '</div>' +
      (chars.size ? '' : '<div class="card empty">No characters tagged for this show yet.</div>') +
      Object.keys(byDept).sort((a, b) => (/prompt book/i.test(b) ? 1 : 0) - (/prompt book/i.test(a) ? 1 : 0) || a.localeCompare(b)).map((d) => '<div class="sect"><h2>' + esc(d) + '</h2></div><div class="list">' + byDept[d].sort((a, b) => a.name.localeCompare(b.name)).map((i) => rowHtml(i, '<div class="mt">' + esc(who(i)) + ' · ' + esc(locName(i.location) || 'No place set') + '</div>')).join('') + '</div>').join('') +
      (its.length ? '' : '<div class="card empty">Nothing tagged for this show yet.</div>');
    if ($('#prShow')) $('#prShow').onclick = () => printCodes(its.map((i) => i.code));
    $('#ncf').onsubmit = async (e) => { e.preventDefault(); const n = $('#ncn').value.trim();
      try { const r = await api('POST', '/api/shows', { name: show, character: n }); D.shows = r.shows; toast('Added ' + n, 'good'); showPage(show); } catch (er) { toast(er.message, 'bad'); } };
  }
  // A search that names a show gets a link to that show's page.
  function showMatches(q) {
    q = String(q || '').trim().toLowerCase(); if (q.length < 3) return [];
    return [...new Set(D.items.flatMap((i) => (i.roles || []).map((r) => r.show)).filter(Boolean))].filter((s) => s.toLowerCase().includes(q));
  }
  function setPage(show, character) {
    const match = (r) => r.character.toLowerCase() === character.toLowerCase() && (r.show || '').toLowerCase() === show.toLowerCase();
    const its = D.items.filter((i) => (i.roles || []).some(match));
    const byDept = {}; its.forEach((i) => { const d = (deptOf(i.code) || { name: i.category }).name; (byDept[d] = byDept[d] || []).push(i); });
    const out = its.filter((i) => i.status === 'Checked out' || i.status === 'In a show').length;
    view.innerHTML = '<a class="muted small" href="' + showHref(show) + '" data-nav>' + esc(show || 'No show named') + ' — see the whole show</a><h1>' + esc(character) + '</h1>' +
      '<div class="card"><div class="stats"><div><b>' + its.length + '</b><span>Pieces</span></div><div><b>' + out + '</b><span>Out now</span></div><div><b>' + its.filter((i) => i.status === 'Missing').length + '</b><span>Missing</span></div></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn" id="coAll"' + (its.length ? '' : ' disabled') + '>Check out whole set</button><button class="btn ok" id="ciAll"' + (out ? '' : ' disabled') + '>Return whole set</button></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn alt sm" id="prSet"' + (its.length ? '' : ' disabled') + '>Print stickers for this set</button><button class="btn alt sm" onclick="window.print()">Print this list</button></div></div>' +
      Object.keys(byDept).sort().map((d) => '<div class="sect"><h2>' + esc(d) + '</h2></div><div class="list">' + byDept[d].sort((a, b) => a.name.localeCompare(b.name)).map((i) => rowHtml(i, '<div class="mt">' + esc(locName(i.location) || 'No place set') + (i.sublocation ? ' · ' + esc(i.sublocation) : '') + '</div>')).join('') + '</div>').join('') +
      (its.length ? '' : '<div class="card empty">Nothing tagged for this character yet.</div>');
    if ($('#prSet')) $('#prSet').onclick = () => printCodes(its.map((i) => i.code));
    $('#coAll').onclick = () => modal('<h2>Check out ' + esc(character) + '\'s set</h2><form id="sf"><label>Who is taking it? (actor or dresser)<input id="h" required></label>' +
      '<label class="check"><input type="checkbox" id="ins" checked> Staying in the building for the show</label><button class="btn big">Check out ' + its.length + ' pieces</button><button type="button" class="btn alt big" data-close style="margin-top:8px">Cancel</button></form>',
      (m, close) => { $('#sf', m).onsubmit = async (e) => { e.preventDefault(); const h = $('#h', m).value.trim(); close(); let n = 0;
        for (const i of its) { if (i.status === 'Checked out' || i.status === 'In a show') continue; try { const r = await api('POST', '/api/items/' + i.code + '/action', { action: 'checkout', holder: h, show: show, in_show: $('#ins', m).checked }); upsert(r.item); n++; } catch (er) { toast(er.message, 'bad'); } }
        toast(n + ' pieces checked out to ' + h, 'good'); render(true); }; });
    $('#ciAll').onclick = async () => { if (!confirm('Mark all ' + out + ' pieces as returned?')) return; let n = 0;
      for (const i of its) { if (i.status !== 'Checked out' && i.status !== 'In a show') continue; try { const r = await api('POST', '/api/items/' + i.code + '/action', { action: 'checkin' }); upsert(r.item); n++; } catch (er) { toast(er.message, 'bad'); } }
      toast(n + ' pieces returned', 'good'); render(true); };
  }
  function locations() {
    const ls = D.locations.slice().sort((a, b) => (a.area || '').localeCompare(b.area || '') || a.name.localeCompare(b.name));
    const count = (c) => D.items.filter((i) => i.location === c).length;
    let lastArea = null;
    view.innerHTML = '<h1>Places</h1><p class="muted">Every rack, shelf, bin and room gets its own sticker. Scan it to see what is there, or to audit it.</p>' +
      '<form class="card" id="lf"><h3>Add a place</h3><label>Name<input id="ln" required placeholder="e.g. Costume loft – Rack 3"></label>' +
      '<label>Area / room (groups places together)<input id="la" list="al" placeholder="e.g. Costume loft"></label><datalist id="al">' +
      [...new Set(D.locations.map((l) => l.area).filter(Boolean))].map((a) => '<option value="' + esc(a) + '">').join('') + '</datalist>' +
      '<button class="btn big">Add place</button></form>' +
      (ls.length ? '<div class="row" style="margin-bottom:10px"><button class="btn alt" id="plAll">Print all place stickers</button></div>' : '') +
      '<div class="list">' + ls.map((l) => {
        const head = (l.area || 'Other places') !== lastArea ? '<h3 style="margin:12px 2px 2px">' + esc(lastArea = (l.area || 'Other places')) + '</h3>' : '';
        return head + '<a class="it" href="/l/' + esc(l.code) + '" data-nav><div class="th">▦</div><div class="bd"><div class="nm">' + esc(l.name) + '</div><div class="mt">' + esc(l.code) + ' · ' + count(l.code) + ' items</div></div></a>';
      }).join('') + '</div>' + (ls.length ? '' : '<div class="card empty">No places yet. Start with the big ones: each room, then each rack or shelf unit.</div>');
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/locations', { name: $('#ln').value, area: $('#la').value }); D.locations.push(r.loc); toast('Added ' + r.loc.name, 'good'); LS.set('lastArea', $('#la').value); render(); }
      catch (er) { toast(er.message, 'bad'); }
    };
    const la = $('#la'); if (la) la.value = LS.get('lastArea', '');
    if ($('#plAll')) $('#plAll').onclick = () => printCodes(ls.map((l) => l.code), 'locations');
  }
  function locPage(code) {
    const l = loc(code);
    if (!l) { view.innerHTML = '<div class="card"><h1>Unknown place sticker ' + esc(code) + '</h1><p>It may have been removed. <a href="/locations" data-nav>See all places</a></p></div>'; return; }
    const here = D.items.filter((i) => i.location === code).sort((a, b) => a.name.localeCompare(b.name));
    view.innerHTML = '<span class="code muted">' + esc(l.code) + '</span><h1>' + esc(l.name) + '</h1>' + (l.area ? '<p class="muted">' + esc(l.area) + '</p>' : '') +
      '<div class="row" style="margin-bottom:14px"><a class="btn" href="/audit/' + esc(code) + '" data-nav>Audit this place</a><button class="btn blue" id="put">Put items here</button></div>' +
      '<div class="row" style="margin-bottom:14px"><a class="btn alt" href="/add" id="addHere">Add new item here</a><button class="btn alt" id="pl">Print sticker</button><button class="btn alt" id="rn">Rename</button></div>' +
      '<div class="sect"><h2>' + here.length + ' item' + (here.length === 1 ? '' : 's') + ' here</h2></div>' +
      '<div class="list">' + here.map((i) => rowHtml(i)).join('') + '</div>' + (here.length ? '' : '<div class="card empty">Nothing recorded here yet.</div>') +
      (D.role === 'admin' && !here.length ? '<button class="btn alt sm" id="dl" style="margin-top:16px;color:var(--bad)">Delete this place</button>' : '');
    $('#addHere').onclick = (e) => { e.preventDefault(); const st = LS.get('sticky', {}); st.location = code; LS.set('sticky', st); go('/add'); };
    $('#pl').onclick = () => printCodes([code], 'locations');
    $('#put').onclick = () => openScanner({ mode: 'put', loc: l, prompt: 'Scan each item you are putting in ' + l.name });
    $('#rn').onclick = async () => {
      const n = prompt('New name for this place', l.name); if (!n) return;
      try { const r = await api('PATCH', '/api/locations/' + code, { name: n }); Object.assign(l, r.loc); render(); } catch (er) { toast(er.message, 'bad'); }
    };
    if ($('#dl')) $('#dl').onclick = async () => { if (!confirm('Delete ' + l.name + '?')) return; try { await api('DELETE', '/api/locations/' + code); await load(); go('/locations'); } catch (er) { toast(er.message, 'bad'); } };
  }

  // ── Audit: scan everything on a shelf, see what is missing ─────────────────
  function audit(code) {
    const l = loc(code); if (!l) return locPage(code);
    const key = 'audit_' + code;
    let st = LS.get(key, null);
    if (!st || Date.now() - new Date(st.started).getTime() > 12 * 3600 * 1000) st = { started: new Date().toISOString(), seen: [] };
    LS.set(key, st);
    const expected = D.items.filter((i) => i.location === code && !['Retired', 'Checked out', 'In a show', 'Missing'].includes(i.status));
    const seen = new Set(st.seen);
    const notSeen = expected.filter((i) => !seen.has(i.code));
    const extra = st.seen.filter((c) => !expected.find((i) => i.code === c));
    view.innerHTML = '<span class="code muted">AUDIT · ' + esc(code) + '</span><h1>' + esc(l.name) + '</h1>' +
      '<p class="muted small">Started ' + esc(when(st.started)) + (st.seen.length ? ' · <a href="#" id="restart">Start over</a>' : '') + '</p>' +
      '<div class="card"><div class="stats"><div><b class="audit-ok">' + (expected.length - notSeen.length) + '</b><span>Found</span></div><div><b class="audit-miss">' + notSeen.length + '</b><span>Not scanned yet</span></div><div><b>' + extra.length + '</b><span>Moved here</span></div></div></div>' +
      '<button class="btn big" id="go">⌗ Scan items on this shelf</button>' +
      '<div class="sect"><h2>Not scanned yet</h2></div><div class="list">' + notSeen.map((i) => rowHtml(i)).join('') + '</div>' + (notSeen.length ? '' : '<div class="card empty">Everything recorded here has been found. ✓</div>') +
      (extra.length ? '<div class="sect"><h2>Found here (moved in)</h2></div><div class="list">' + extra.map((c) => item(c)).filter(Boolean).map((i) => rowHtml(i)).join('') + '</div>' : '') +
      '<div class="card" style="margin-top:16px"><h3>Finish</h3><p class="muted small">Items not scanned can be marked Missing. Anything checked out is not expected here.</p>' +
      '<div class="row"><button class="btn warn" id="fin"' + (notSeen.length ? '' : ' disabled') + '>Mark ' + notSeen.length + ' missing &amp; finish</button><button class="btn alt" id="done">Finish, change nothing</button></div></div>';
    $('#go').onclick = () => openScanner({ mode: 'audit', loc: l, prompt: 'Scan every sticker in ' + l.name, onItem: (it) => { if (!st.seen.includes(it.code)) { st.seen.push(it.code); LS.set(key, st); } } , onClose: () => render() });
    $('#fin').onclick = async () => {
      if (!confirm('Mark ' + notSeen.length + ' items as Missing?')) return;
      for (const i of notSeen) await api('POST', '/api/items/' + i.code + '/action', { action: 'missing', note: 'not found in audit of ' + l.name }).then((r) => upsert(r.item)).catch(() => {});
      localStorage.removeItem('rinv_' + key); toast('Audit finished', 'good'); go('/l/' + code);
    };
    $('#done').onclick = () => { localStorage.removeItem('rinv_' + key); go('/l/' + code); };
    if ($('#restart')) $('#restart').onclick = (e) => { e.preventDefault(); localStorage.removeItem('rinv_' + key); render(); };
  }

  // ── Scanner (camera inside the app; works on iPhone and Android) ───────────
  let scanner = null;
  function parseScan(text) {
    text = String(text || '').trim();
    let m = text.match(/\/(i|l)\/([A-Za-z]{1,4}-\d{1,6})(?:[/?#]|$)/i);
    if (m) { const c = normCode(m[2]); return { kind: m[1].toLowerCase() === 'l' || isLocCode(c) ? 'loc' : 'item', code: c }; }
    const c = normCode(text);
    if (c) return { kind: isLocCode(c) ? 'loc' : 'item', code: c };
    return null;
  }
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/jsQR.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  function beep() { try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.connect(g); g.connect(a.destination); o.frequency.value = 1150; g.gain.value = 0.08; o.start(); o.stop(a.currentTime + 0.09); setTimeout(() => a.close(), 300); } catch (e) { /* no audio */ } if (navigator.vibrate) navigator.vibrate(60); }
  async function openScanner(o) {
    closeScanner();
    const el = document.createElement('div'); el.className = 'scanner';
    el.innerHTML = '<video playsinline muted autoplay></video><div class="frame"></div>' +
      '<div class="hdr"><span>' + esc(o.mode === 'audit' ? 'Auditing ' + o.loc.name : o.mode === 'put' ? 'Putting into ' + o.loc.name : o.mode === 'copy' ? 'Copying ' + o.from.name : 'Scan') + '</span><button id="sx">' + (o.mode === 'go' || o.mode === 'pickLoc' ? 'Close' : 'Done') + '</button></div>' +
      '<div class="bar"><div class="log" id="slog"></div><p id="smsg">' + esc(o.prompt || 'Point at a sticker') + '</p>' +
      (o.mode === 'copy' ? '<button class="btn alt sm" id="nostk" style="width:100%;margin-bottom:8px;color:#fff;border-color:rgba(255,255,255,.5)">No blank sticker? Use the next number</button>' : '') +
      '<form id="sf" class="row" style="gap:8px"><input id="sc" placeholder="or type the code, e.g. R-0012" autocapitalize="characters" style="flex:1;margin:0;background:#fff;color:#000"><button class="btn sm">Go</button></form></div>';
    document.body.appendChild(el);
    const video = $('video', el), msg = $('#smsg', el), frame = $('.frame', el), logEl = $('#slog', el);
    scanner = { el, stream: null, timer: null, last: '', lastAt: 0, o };
    $('#sx', el).onclick = () => { closeScanner(); if (o.onClose) o.onClose(); };
    if ($('#nostk', el)) $('#nostk', el).onclick = () => { closeScanner(); go('/add?copy=' + o.from.code); };
    $('#sf', el).onsubmit = (e) => { e.preventDefault(); const r = parseScan($('#sc', el).value); if (r) handle(r); else msg.textContent = 'That is not a sticker code.'; };
    const handle = async (r) => {
      const key = r.kind + r.code; const now = Date.now();
      if (key === scanner.last && now - scanner.lastAt < 2500) return; scanner.last = key; scanner.lastAt = now;
      beep(); frame.classList.add('hit'); setTimeout(() => frame.classList.remove('hit'), 400);
      const add = (t, cls) => { logEl.insertAdjacentHTML('afterbegin', '<div class="' + (cls || '') + '">' + t + '</div>'); };
      if (o.mode === 'go') { closeScanner(); go(r.kind === 'loc' ? '/l/' + r.code : '/i/' + r.code); return; }
      if (o.mode === 'copy') {
        if (r.kind === 'loc') { msg.textContent = 'That is a place sticker. Scan a blank item sticker.'; return; }
        const used = item(r.code);
        if (r.code === o.from.code) { msg.textContent = 'That is the one you are copying. Scan the next one.'; return; }
        if (used && !used.needs_details) { msg.textContent = r.code + ' is already "' + used.name + '". Scan a blank sticker.'; return; }
        try { const x = await api('POST', '/api/items/' + o.from.code + '/copies', { codes: [r.code], photo: true }); x.items.forEach(upsert);
          o.n = (o.n || 0) + 1; add('✓ ' + esc(r.code) + ' — ' + esc(o.from.name), 'ok');
          msg.textContent = o.n + ' done. Scan the next one, or tap Done.'; }
        catch (er) { msg.textContent = er.message; }
        return;
      }
      if (o.mode === 'pickLoc') {
        if (r.kind !== 'loc') { msg.textContent = 'That is an item sticker — scan the shelf/bin sticker.'; return; }
        const l = loc(r.code); if (!l) { msg.textContent = 'Unknown place ' + r.code; return; }
        closeScanner(); o.onLoc(l); return;
      }
      if (r.kind === 'loc') { msg.textContent = 'That is a place sticker. Scan item stickers.'; return; }
      const it = item(r.code);
      if (!it) { add('⚠ ' + esc(r.code) + ' is a blank sticker — add it after'); msg.textContent = r.code + ' is not on an item yet.'; return; }
      if (o.mode === 'audit') {
        o.onItem(it);
        if (it.location !== o.loc.code) {
          await api('POST', '/api/items/' + it.code + '/action', { action: 'move', location: o.loc.code }).then((x) => upsert(x.item)).catch((e) => add('✕ ' + esc(e.message)));
          add('↪ ' + esc(it.name) + ' — moved here'); msg.textContent = it.name + ' recorded as here now';
        } else {
          await api('POST', '/api/items/' + it.code + '/action', { action: 'seen', location: o.loc.code }).then((x) => upsert(x.item)).catch(() => {});
          add('✓ ' + esc(it.name)); msg.textContent = '✓ ' + it.name;
        }
      } else if (o.mode === 'put') {
        const x = await api('POST', '/api/items/' + it.code + '/action', { action: 'move', location: o.loc.code }).catch((e) => { add('✕ ' + esc(e.message)); });
        if (x) { upsert(x.item); add('✓ ' + esc(it.name) + ' → ' + esc(o.loc.name)); msg.textContent = '✓ ' + it.name; }
      }
    };
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = scanner.stream; await video.play().catch(() => {});
    } catch (e) {
      msg.innerHTML = 'Camera blocked. Allow camera access for this site, or just open your phone\'s <b>Camera app</b> and point it at the sticker — that works too.'; return;
    }
    let detector = null;
    if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
    if (!detector) await loadJsQR().catch(() => {});
    const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!scanner || scanner.el !== el) return;
      if (video.readyState >= 2) {
        try {
          let text = null;
          if (detector) { const codes = await detector.detect(video); if (codes[0]) text = codes[0].rawValue; }
          else if (window.jsQR) {
            const w = video.videoWidth, h = video.videoHeight, side = Math.min(w, h) * 0.8, sc = Math.min(1, 640 / side);
            c.width = Math.round(side * sc); c.height = Math.round(side * sc);
            ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, c.width, c.height);
            const d = ctx.getImageData(0, 0, c.width, c.height); const q = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
            if (q) text = q.data;
          }
          if (text) { const r = parseScan(text); if (r) await handle(r); else msg.textContent = 'That QR code is not a Rialto sticker.'; }
        } catch (e) { /* keep scanning */ }
      }
      if (scanner && scanner.el === el) scanner.timer = setTimeout(tick, 120);
    };
    tick();
  }
  function closeScanner() {
    if (!scanner) return;
    clearTimeout(scanner.timer);
    if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
    scanner.el.remove(); scanner = null;
  }

  // ── Labels ─────────────────────────────────────────────────────────────────
  // Printers. The Liene PixCut S1 prints only from its phone app (Bluetooth), on 4×7"
  // sticker media with a 3.9×6.7" printable area at 300 dpi, so we hand it ready-made
  // sheet images: transparent background, each sticker a separate shape with a gap so
  // the cutter can cut round each one.
  // Liene only cuts inside its dashed bleed line (3.54 x 6.68 in). Sheet = 3.5 x 6.6 in, stickers 0.2 in apart.
  // In Liene: set the image to W 3.5, H 6.6, X 0.02, Y 0.04 inches.
  const PIX = { W: 1050, H: 1980, DPI: 300, GAP: 60 };
  const PIX_LAYOUTS = {
    std:   { name: 'Standard 1.57 × 0.9 in — 12 per sheet', w: 470, h: 270, cols: 2, rows: 6 },
    small: { name: 'Small square 0.98 in — 15 per sheet (props, jewelry)', w: 294, h: 294, cols: 3, rows: 5 },
    big:   { name: 'Large 3.33 × 1.87 in — 3 per sheet (racks, shelves, bins)', w: 1000, h: 560, cols: 1, rows: 3 },
  };
  function printer() { return LS.get('printer', 'pixcut'); }
  const perSheet = (layout) => { const L = PIX_LAYOUTS[layout] || PIX_LAYOUTS.std; return L.cols * L.rows; };
  async function printCodes(codes, kind) {
    if (printer() === 'pixcut') {
      const layout = kind === 'locations' || codes.every(isLocCode) ? 'big' : LS.get('pixLayout', 'std');
      const spare = (perSheet(layout) - codes.length % perSheet(layout)) % perSheet(layout);
      // Never print a partial sheet: fill the empty spaces with the next blank stickers of the same department.
      const d = !codes.every(isLocCode) && deptOf(codes[codes.length - 1]);
      if (spare && d) {
        try {
          const r = await api('POST', '/api/reserve', { count: spare, department: d.name });
          codes = codes.concat(r.codes); D.settings.next = Object.assign({}, D.settings.next, { [d.p]: Number(r.codes[r.codes.length - 1].split('-')[1]) + 1 });
          toast('Filled ' + spare + ' empty space' + (spare === 1 ? '' : 's') + ' with blank ' + d.p + ' stickers', 'good');
        } catch (er) { toast(er.message, 'bad'); }
      }
      return pixcut(codes, layout);
    }
    const size = LS.get('labelSize', '2x1');
    const f = document.createElement('form'); f.method = 'post'; f.action = '/print';
    [['size', size], ['kind', kind || 'items'], ['codes', codes.join(',')]].forEach(([n, v]) => {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; f.appendChild(i);
    });
    document.body.appendChild(f); f.submit();
  }
  function rrect(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
  function fitText(x, text, maxW, size, weight) {
    let s = size; do { x.font = (weight || 'bold') + ' ' + s + 'px Arial, Helvetica, sans-serif'; s -= 2; } while (x.measureText(text).width > maxW && s > 12);
  }
  function wrap(x, text, maxW, maxLines) {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (x.measureText(t).width <= maxW) cur = t; else { if (cur) lines.push(cur); cur = w; } if (lines.length === maxLines) break; }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) { let l = lines[maxLines - 1]; while (x.measureText(l + '…').width > maxW && l.length) l = l.slice(0, -1); lines[maxLines - 1] = l + '…'; }
    return lines;
  }
  function drawSticker(x, X, Y, L, code) {
    const isL = isLocCode(code), d = isL ? { p: LOCP, name: 'Location', room: '', color: LOC_COLOR } : (deptOf(code) || { p: code.split('-')[0], name: '', room: '', color: '#616161' });
    const thing = isL ? loc(code) : item(code);
    const w = L.w, h = L.h, r = 26, pad = 14;
    x.save(); rrect(x, X, Y, w, h, r); x.fillStyle = '#fff'; x.fill(); x.clip();
    const small = L === PIX_LAYOUTS.small;
    const band = small ? 54 : L === PIX_LAYOUTS.big ? 96 : 62;
    // QR: on wide stickers it fills the full height on the left (biggest possible = easiest scan);
    // the department band runs across the rest of the top. Square stickers: band on top, QR below.
    const q = qrMake(qrUrl(code)); const n = q.getModuleCount() + 4;
    const avail = small ? h - band - 70 : h - pad * 2;
    const cell = Math.floor(avail / n); const qs = cell * n;
    const qx = small ? X + (w - qs) / 2 : X + pad, qy = small ? Y + band + 8 : Y + (h - qs) / 2;
    const bx = small ? X : qx + qs + 6;
    x.fillStyle = d.color; x.fillRect(bx, Y, X + w - bx, band);
    if (d.color.toLowerCase() === '#ffffff') { x.fillStyle = '#111'; x.fillRect(bx, Y + band - 4, X + w - bx, 4); }
    x.fillStyle = ink(d.color); x.textBaseline = 'middle';
    const bw = X + w - bx;
    // Band: the department code, big. The organisation name (BOLD THEATRE) gets its own line under the code.
    fitText(x, d.p, bw * 0.8, band * 0.7); x.textAlign = 'left'; x.fillText(d.p, bx + 12, Y + band / 2 + 2);
    const org = String(D.settings.org || '').toUpperCase();
    x.fillStyle = '#000';
    for (let rr = 0; rr < n - 4; rr++) for (let c = 0; c < n - 4; c++) if (q.isDark(rr, c)) x.fillRect(qx + (c + 2) * cell, qy + (rr + 2) * cell, cell, cell);
    x.fillStyle = '#111'; x.textBaseline = 'alphabetic';
    if (small) {
      fitText(x, code, w - 24, 46); x.textAlign = 'center'; x.fillText(code, X + w / 2, Y + h - 18);
      if (org) { fitText(x, org, w - 30, 22, '900'); x.textBaseline = 'top'; x.fillText(org, X + w / 2, Y + band + 4); x.textBaseline = 'alphabetic'; }
    }
    else {
      const tx = qx + qs + 16, tw = X + w - pad - tx; x.textAlign = 'left';
      fitText(x, code, tw, L === PIX_LAYOUTS.big ? 96 : 58); let ty = Y + band + (L === PIX_LAYOUTS.big ? 92 : 54); x.fillText(code, tx, ty);
      if (org) { ty += L === PIX_LAYOUTS.big ? 40 : 30; fitText(x, org, tw, L === PIX_LAYOUTS.big ? 40 : 26, '900'); x.fillText(org, tx, ty); }
      if (thing) {
        const nm = thing.name || ''; x.font = 'bold ' + (L === PIX_LAYOUTS.big ? 52 : 28) + 'px Arial, Helvetica, sans-serif';
        for (const line of wrap(x, nm, tw, L === PIX_LAYOUTS.big ? 3 : 2)) { ty += L === PIX_LAYOUTS.big ? 62 : 33; x.fillText(line, tx, ty); }
        if (!isL && thing.size) { x.font = '900 ' + 34 + 'px Arial, Helvetica, sans-serif'; ty += 44; x.fillText('Size ' + thing.size, tx, Math.min(ty, Y + h - 16)); }
      } else if (!isL) { x.font = 'bold 24px Arial, Helvetica, sans-serif'; x.fillStyle = '#555'; x.fillText(d.name, tx, ty + 36); x.fillText('Scan to add', tx, ty + 66); }
    }
    x.restore();
    rrect(x, X + 1, Y + 1, w - 2, h - 2, r); x.strokeStyle = 'rgba(0,0,0,.18)'; x.lineWidth = 2; x.stroke();
  }
  function pixSheets(codes, layout) {
    const L = PIX_LAYOUTS[layout] || PIX_LAYOUTS.std, per = L.cols * L.rows, out = [];
    const bw = L.cols * L.w + (L.cols - 1) * PIX.GAP, bh = L.rows * L.h + (L.rows - 1) * PIX.GAP;
    const x0 = Math.floor((PIX.W - bw) / 2), y0 = Math.floor((PIX.H - bh) / 2);
    for (let s = 0; s < codes.length; s += per) {
      const c = document.createElement('canvas'); c.width = PIX.W; c.height = PIX.H; const x = c.getContext('2d');
      codes.slice(s, s + per).forEach((code, i) => {
        const col = i % L.cols, row = Math.floor(i / L.cols);
        drawSticker(x, x0 + col * (L.w + PIX.GAP), y0 + row * (L.h + PIX.GAP), L, code);
      });
      out.push(c);
    }
    return out;
  }
  function pixcut(codes, layout) {
    editing = false;
    pinned = true;
    const L = PIX_LAYOUTS[layout] || PIX_LAYOUTS.std;
    const sheets = pixSheets(codes, layout);
    const name = (i) => 'rialto-stickers-' + codes[0] + (sheets.length > 1 ? '-sheet' + (i + 1) : '') + '.png';
    view.innerHTML = '<h1>PixCut sticker sheets</h1>' +
      '<div class="card"><p><b>' + codes.length + ' sticker' + (codes.length === 1 ? '' : 's') + '</b> on <b>' + sheets.length + ' sheet' + (sheets.length === 1 ? '' : 's') + '</b> · ' + esc(L.name) + '</p>' +
      '<label>Layout<select id="lay">' + opts(Object.entries(PIX_LAYOUTS).map(([k, v]) => [k, v.name]), layout) + '</select></label>' +
      '<div class="row"><button class="btn big" id="shareAll">Save / share to this phone</button></div>' +
      '<ol class="small" style="margin:12px 0 0;padding-left:22px"><li>Tap <b>Save / share</b> and choose <b>Save Image</b> (iPhone) or <b>Save to Photos / Gallery</b>.</li>' +
      '<li>Open the <b>Liene</b> app, start a sticker print and pick the sheet image from your photos.</li>' +
      '<li>Choose the 4 × 7 sticker paper. Set the picture to <b>W 3.5, H 6.6, X 0.02, Y 0.04</b> inches so it sits inside the dashed cut line, then tap <b>Make-it</b>.</li>' +
      '<li>First time: print ONE sheet and scan a sticker with your camera before printing the rest.</li></ol></div>' +
      sheets.map((c, i) => '<div class="card"><p class="small muted">Sheet ' + (i + 1) + ' of ' + sheets.length + '</p><img src="' + c.toDataURL('image/png') + '" style="width:100%;max-width:360px;display:block;margin:auto;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/20px 20px;border-radius:8px">' +
        '<div class="row" style="margin-top:8px"><a class="btn alt sm" download="' + esc(name(i)) + '" href="' + c.toDataURL('image/png') + '">Download sheet ' + (i + 1) + '</a></div></div>').join('');
    $('#lay').onchange = (e) => { if (e.target.value !== 'big') LS.set('pixLayout', e.target.value); pixcut(codes, e.target.value); };
    $('#shareAll').onclick = async () => {
      const files = await Promise.all(sheets.map((c, i) => new Promise((ok) => c.toBlob((b) => ok(new File([b], name(i), { type: 'image/png' }))))));
      if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files, title: 'Rialto stickers' }); } catch (e) { /* cancelled */ } }
      else files.forEach((f) => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); });
    };
    window.scrollTo(0, 0);
  }
  function labels() {
    const pr = printer();
    view.innerHTML = '<h1>Print stickers</h1>' +
      '<div class="card"><label>Sticker printer<select id="prn">' + opts([['pixcut', 'Liene PixCut S1 (phone app)'], ['other', 'Other printer (roll or sheets)']], pr) + '</select></label>' +
      (pr === 'pixcut' ? '<label>Sticker layout<select id="lay">' + opts(Object.entries(PIX_LAYOUTS).filter(([k]) => k !== 'big').map(([k, v]) => [k, v.name]), LS.get('pixLayout', 'std')) + '</select></label>' +
        '<p class="muted small">You get ready-to-print sheet pictures. Save them to the phone and print from the Liene app. Place stickers always use the large layout.</p>'
        : '<label>Sticker size<select id="sz">' + opts(Object.entries(D.sizes), LS.get('labelSize', '2x1')) + '</select></label>') + '</div>' +
      '<form class="card" id="bk"><h2>1 · Blank stickers for a department</h2>' +
      '<p>Print numbered stickers first. Volunteers stick one on each item, scan it, and fill it in. Nobody types a code.</p>' +
      '<label>Department<select id="bd" required>' + opts(depts().map((d) => [d.name, d.p + ' · ' + d.name]), LS.get('lastDept', ''), 'Pick one') + '</select></label>' +
      '<label>How many<input id="bn" type="number" min="1" max="1000" value="' + (pr === 'pixcut' ? 12 : 100) + '" inputmode="numeric"></label>' +
      '<p class="muted small" id="nxt"></p><button class="btn big">Print blank stickers</button></form>' +
      '<div class="card"><h2>2 · Stickers for items already entered</h2>' +
      '<label>Department<select id="lc">' + opts(depts().map((d) => [d.name, d.p + ' · ' + d.name]), '', 'All departments') + '</select></label>' +
      '<label>Added<select id="ld">' + opts([['today', 'Today'], ['7', 'Last 7 days'], ['all', 'Any time']], 'today') + '</select></label>' +
      '<button class="btn big" id="lp">Print these</button><p class="muted small">Or search on the Items page and use "Print stickers for these".</p></div>' +
      '<div class="card"><h2>3 · Place stickers</h2><p>One per rack, shelf, bin or room. Black band, LOC code, the place name in big letters.</p>' +
      '<button class="btn big" id="lo"' + (D.locations.length ? '' : ' disabled') + '>Print all ' + D.locations.length + ' place stickers</button></div>' +
      '<div class="card"><h2>Reprint a range</h2><div class="grid2"><label>From<input id="rf" placeholder="COST-0001" autocapitalize="characters"></label><label>How many<input id="rc" type="number" value="12"></label></div><button class="btn alt big" id="rp">Reprint</button></div>' +
      '<div class="card"><h2>Department codes</h2><table style="width:100%;border-collapse:collapse;font-size:.92rem">' +
      depts().map((d) => '<tr><td style="padding:4px 6px">' + chip(d.p + '-1') + '</td><td style="padding:4px 6px">' + esc(d.name) + '</td><td class="muted" style="padding:4px 6px">' + esc(d.room || '') + '</td></tr>').join('') +
      '<tr><td style="padding:4px 6px">' + chip('LOC-1') + '</td><td style="padding:4px 6px">Places (racks, shelves, bins)</td><td></td></tr></table>' +
      '<p class="muted small">Not tagged: paint, tape, lamps, batteries, makeup, fabric yardage. Tag the shelf or bin they live in.</p></div>';
    const showNext = () => { const d = deptByName($('#bd').value); $('#nxt').textContent = d ? 'Next ' + d.p + ' number: ' + d.p + '-' + String((D.settings.next || {})[d.p] || 1).padStart(4, '0') + '. Numbers are reserved so they never repeat.' : ''; };
    $('#bd').onchange = () => { LS.set('lastDept', $('#bd').value); showNext(); }; showNext();
    $('#prn').onchange = (e) => { LS.set('printer', e.target.value); labels(); };
    if ($('#lay')) $('#lay').onchange = (e) => LS.set('pixLayout', e.target.value);
    if ($('#sz')) $('#sz').onchange = (e) => LS.set('labelSize', e.target.value);
    $('#bk').onsubmit = async (e) => {
      e.preventDefault(); let n = Number($('#bn').value) || 0; const dn = $('#bd').value; if (n < 1 || !dn) return toast('Pick a department and a number.', 'bad');
      // Never print a partial sheet: round up to whole sheets (sticker paper costs money).
      const per = printer() === 'pixcut' ? perSheet(LS.get('pixLayout', 'std')) : 1; const asked = n; n = Math.ceil(n / per) * per;
      if (!confirm('Reserve and print ' + n + ' blank ' + deptByName(dn).p + ' stickers' + (n !== asked ? ' (rounded up from ' + asked + ' to fill ' + (n / per) + ' full sheet' + (n / per === 1 ? '' : 's') + ')' : '') + '?')) return;
      try { const r = await api('POST', '/api/reserve', { count: n, department: dn }); D.settings.next = Object.assign({}, D.settings.next, { [deptByName(dn).p]: Number(r.codes[r.codes.length - 1].split('-')[1]) + 1 }); printCodes(r.codes); }
      catch (er) { toast(er.message, 'bad'); }
    };
    $('#lp').onclick = () => {
      const cat = $('#lc').value, d = $('#ld').value; const since = d === 'all' ? '' : new Date(new Date().setHours(0, 0, 0, 0) - (d === '7' ? 6 : 0) * 864e5).toISOString();
      const c = D.items.filter((i) => (!cat || i.category === cat) && (!since || (i.created_at || '') >= since)).map((i) => i.code);
      if (!c.length) return toast('No items match.'); printCodes(c);
    };
    $('#lo').onclick = () => printCodes(D.locations.map((l) => l.code), 'locations');
    $('#rp').onclick = () => {
      const f = normCode($('#rf').value); if (!f) return toast('Use a code like COST-0001', 'bad');
      const [pfx, n0] = f.split('-'); const c = []; for (let i = 0; i < (Number($('#rc').value) || 12); i++) c.push(pfx + '-' + String(Number(n0) + i).padStart(4, '0'));
      printCodes(c, pfx === LOCP ? 'locations' : 'items');
    };
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function settings() {
    const admin = D.role === 'admin', st = D.settings;
    view.innerHTML = '<h1>Settings</h1>' +
      '<div class="card"><h3>You</h3><p>Signed in as <b>' + esc(D.me && !D.me.master ? D.me.name + ' (' + D.me.user + ')' : (LS.get('name', '') || '(no name)')) + '</b> · ' +
        (D.me ? (D.me.manager ? 'Owner / admin' : 'Department head (admin)') : 'Crew') + '</p>' +
      '<div class="row">' + (D.me && !D.me.master ? '' : '<button class="btn alt" id="cn">Change my name</button>') + '<a class="btn alt" href="/logout">Sign out</a></div></div>' +
      (D.me && !D.me.master ? pwFormHtml() : '') +
      '<div class="card"><h3>Add to home screen</h3><p class="muted small">iPhone: Share button → <b>Add to Home Screen</b>. Android: ⋮ menu → <b>Add to Home screen</b>. It then opens like an app.</p></div>' +
      '<div class="card"><h3>Spreadsheet</h3><div class="row"><a class="btn alt" href="/api/export.csv">Download everything (CSV)</a></div></div>' +
      (admin ? adminHtml(st) : '<form class="card" id="al"><h3>Department head sign-in</h3>' +
        '<label>Username<input id="au" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' +
        '<label>Password<input id="ap" type="password" autocomplete="current-password" required></label>' + showPwBox() + '<button class="btn alt big">Sign in as admin</button></form>');
    if ($('#cn')) $('#cn').onclick = () => askName(true);
    if (D.me && !D.me.master) wirePwForm();
    if (!admin) $('#al').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/login', { user: $('#au').value, password: $('#ap').value }); await load(); setWho(); render(); toast('Signed in as ' + D.me.name, 'good'); checkMustChange(); }
      catch (er) { toast(er.message, 'bad'); }
    };
    else wireAdmin(st);
  }
  // "Show password" tick box: reveals every password box in the same form while ticked.
  function showPwBox() { return '<label class="check"><input type="checkbox" class="showpw"> Show password</label>'; }
  document.addEventListener('change', (e) => {
    if (!e.target.classList || !e.target.classList.contains('showpw')) return;
    const f = e.target.closest('form'); if (!f) return;
    f.querySelectorAll('input[data-pw], input[type=password]').forEach((i) => { i.dataset.pw = '1'; i.type = e.target.checked ? 'text' : 'password'; });
  });
  function pwFormHtml() {
    return '<form class="card" id="pwf"><h3>Change my password</h3>' +
      '<label>Current password<input id="pw0" type="password" autocomplete="current-password" required></label>' +
      '<label>New password (8 or more characters)<input id="pw1" type="password" autocomplete="new-password" minlength="8" required></label>' +
      '<label>New password again<input id="pw2" type="password" autocomplete="new-password" minlength="8" required></label>' +
      showPwBox() +
      '<button class="btn big">Change password</button></form>';
  }
  function wirePwForm(onDone) {
    $('#pwf').onsubmit = async (e) => {
      e.preventDefault();
      if ($('#pw1').value !== $('#pw2').value) return toast('The two new passwords do not match.', 'bad');
      try { await api('POST', '/api/account/password', { current: $('#pw0').value, password: $('#pw1').value }); await load(); toast('Password changed', 'good'); if (onDone) onDone(); else render(); }
      catch (er) { toast(er.message, 'bad'); }
    };
  }
  function checkMustChange() {
    if (!D.me || !D.me.must_change) return;
    modal('<h2>Set your own password</h2><p class="muted">You signed in with a temporary password. Choose your own now — only you will know it.</p>' + pwFormHtml().replace('<form class="card" id="pwf"><h3>Change my password</h3>', '<form id="pwf">'),
      (m, close) => { m.onclick = null; wirePwForm(() => { close(); render(); }); });
  }
  function accountsHtml() {
    if (!D.me || !D.me.manager) return '';
    return '<div class="card"><h3>Admin accounts</h3><p class="muted small">Each department head signs in with their own username and password. New accounts and resets get a temporary password they must change the first time.</p>' +
      '<ul class="hist">' + D.admins.map((a) => '<li><b>' + esc(a.name) + '</b> · <span class="code">' + esc(a.user) + '</span>' + (a.manager ? ' · owner' : '') +
        (a.must_change ? ' · <span class="muted">temporary password</span>' : '') + '<br><span class="muted small">' + (a.last_login ? 'last sign-in ' + esc(when(a.last_login)) : 'never signed in') + '</span>' +
        '<div class="row" style="margin-top:6px"><button class="btn alt sm" data-reset="' + a.id + '">Reset password</button>' +
        (D.me.id === a.id ? '' : '<button class="btn alt sm" data-del="' + a.id + '" style="color:var(--bad)">Remove</button>') + '</div></li>').join('') + '</ul>' +
      (D.admins.length ? '' : '<p class="muted">No accounts yet.</p>') +
      '<form id="naf" style="margin-top:12px"><h3>Add a department head</h3><div class="grid2"><label>Name or role<input id="nan" placeholder="Costume Shop Head" required></label>' +
      '<label>Username<input id="nau" placeholder="costumes" autocapitalize="none" spellcheck="false" required></label></div>' +
      '<label class="check"><input type="checkbox" id="nam"> Owner (can manage accounts and codes)</label><button class="btn alt big">Add account</button></form></div>';
  }
  function showTemp(a, temp) {
    modal('<h2>Temporary password for ' + esc(a.name) + '</h2><p>Username: <b class="code">' + esc(a.user) + '</b></p><p>Temporary password: <b class="code" style="font-size:1.3rem">' + esc(temp) + '</b></p>' +
      '<p class="muted small">Write it down now — it is not shown again. They will be asked to choose their own password the first time they sign in.</p><button class="btn big" data-close>Done</button>');
  }
  function adminHtml(st) {
    return accountsHtml() + '<div class="card"><h3>Invite the crew</h3><p>Print the poster and tape it up, or text people this link (it signs them in):</p>' +
      '<p><input readonly id="jl" value="' + esc(D.base + '/join?k=' + st.crew_key) + '"></p>' +
      '<div class="row"><button class="btn" id="cp">Copy link</button><a class="btn alt" href="/poster" target="_blank">Print crew poster</a></div></div>' +
      (D.me && D.me.manager ?
        '<div class="card"><h3>Change the admin code</h3><p class="muted small">The master admin code gives full owner access from the crew-code box. Change it any time; the old one stops working at once.</p>' +
        '<p>Current: <b class="code">' + esc(st.admin_key) + '</b></p>' +
        '<label>New admin code (8 or more letters/numbers)<input id="adk" autocapitalize="characters" autocomplete="off" placeholder="type one, or tap Make one for me"></label>' +
        '<div class="row"><button class="btn alt" type="button" data-gen="adk" data-pre="ADMIN-" data-len="8">Make one for me</button><button class="btn" type="button" id="saveAdk">Change admin code</button></div></div>' +
        '<div class="card"><h3>Change the crew code</h3><p class="muted small">Volunteers use this. Changing it signs every volunteer out until they scan the new poster, so reprint the poster afterwards.</p>' +
        '<p>Current: <b class="code">' + esc(st.crew_key) + '</b></p>' +
        '<label>New crew code (6 or more letters/numbers)<input id="ck" autocapitalize="characters" autocomplete="off" placeholder="type one, or tap Make one for me"></label>' +
        '<div class="row"><button class="btn alt" type="button" data-gen="ck" data-pre="RIALTO-" data-len="6">Make one for me</button><button class="btn" type="button" id="saveCk">Change crew code</button></div></div>' : '') +
      '<form class="card" id="sf2"><h3>Names</h3><label>App title<input id="tt" value="' + esc(st.title) + '"></label><label>Organization (printed on stickers)<input id="og" value="' + esc(st.org) + '"></label>' +
      '<label>Departments — one per line: CODE | Name | Room | #colour<textarea id="cats" rows="10" style="font-family:monospace;font-size:.85rem">' +
        esc(st.departments.map((d) => [d.p, d.name, d.room || '', d.color].join(' | ')).join('\n')) + '</textarea></label>' +
      '<p class="muted small">Codes are 2–4 letters. A department that has items keeps its code.</p><button class="btn alt">Save</button></form>' +
      '<div class="card"><h3>Import from a spreadsheet</h3><p class="muted small">CSV with a header row. Columns it understands: name, department (code like COST or the name), qty, location, color, size, period, condition, tags, description, notes, value, code. New places are created automatically.</p>' +
      '<input type="file" id="imp" accept=".csv,text/csv"><p id="impMsg" class="muted small"></p></div>' +
      '<div class="card"><h3>Removed items</h3>' + (D.removed.length ? '<ul class="hist">' + D.removed.slice(0, 50).map((r) => '<li><b>' + esc(r.name) + '</b> <span class="code">' + esc(r.code) + '</span> <button class="btn alt sm" data-restore="' + esc(r.code) + '">Restore</button></li>').join('') + '</ul>' : '<p class="muted">None.</p>') + '</div>';
  }
  function wireAdmin() {
    $$('[data-reset]').forEach((b) => b.onclick = async () => {
      const a = D.admins.find((x) => x.id === b.dataset.reset); if (!confirm('Give ' + a.name + ' a new temporary password? Their old password stops working.')) return;
      try { const r = await api('POST', '/api/admins/' + a.id + '/reset'); await load(); render(); showTemp(r.admin, r.temp_password); } catch (er) { toast(er.message, 'bad'); }
    });
    $$('[data-del]').forEach((b) => b.onclick = async () => {
      const a = D.admins.find((x) => x.id === b.dataset.del); if (!confirm('Remove the admin account for ' + a.name + '?')) return;
      try { await api('DELETE', '/api/admins/' + a.id); await load(); render(); toast('Removed', 'good'); } catch (er) { toast(er.message, 'bad'); }
    });
    if ($('#naf')) $('#naf').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('POST', '/api/admins', { name: $('#nan').value, user: $('#nau').value, manager: $('#nam').checked }); await load(); render(); showTemp(r.admin, r.temp_password); }
      catch (er) { toast(er.message, 'bad'); }
    };
    $('#cp').onclick = () => { const i = $('#jl'); i.select(); (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('Copied', 'good'), () => document.execCommand('copy')); };
    $$('[data-gen]').forEach((b) => b.onclick = () => {
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = new Uint32Array(+b.dataset.len); crypto.getRandomValues(r);
      $('#' + b.dataset.gen).value = b.dataset.pre + Array.from(r, (n) => A[n % A.length]).join('');
    });
    const saveCode = async (field, label, extra) => {
      const v = $('#' + (field === 'admin_key' ? 'adk' : 'ck')).value.trim().toUpperCase();
      if (!v) return toast('Type a new code or tap Make one for me.', 'bad');
      if (!confirm('Change the ' + label + ' to ' + v + '?\nThe old one stops working right away.')) return;
      try {
        await api('POST', '/api/settings', { [field]: v }); await load(); render();
        modal('<h2>' + label.charAt(0).toUpperCase() + label.slice(1) + ' changed ✓</h2><p>New code: <b class="code" style="font-size:1.4rem">' + esc(v) + '</b></p><p class="muted">Write it down now.' + (extra || '') + '</p><button class="btn big" data-close>Done</button>');
      } catch (er) { toast(er.message, 'bad'); }
    };
    if ($('#saveAdk')) $('#saveAdk').onclick = () => saveCode('admin_key', 'admin code');
    if ($('#saveCk')) $('#saveCk').onclick = () => saveCode('crew_key', 'crew code', ' Reprint the crew poster (button above) and take down the old one.');
    $('#sf2').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/settings', { title: $('#tt').value, org: $('#og').value, departments: $('#cats').value.split('\n').map((l) => l.split('|').map((s) => s.trim())).filter((a) => a[0]).map(([p, name, room, color]) => ({ p, name, room, color })) }); await load(); render(); toast('Saved', 'good'); } catch (er) { toast(er.message, 'bad'); } };
    $$('[data-restore]').forEach((b) => b.onclick = async () => { try { await api('POST', '/api/restore', { code: b.dataset.restore }); await load(); render(); toast('Restored', 'good'); } catch (er) { toast(er.message, 'bad'); } });
    $('#imp').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCsv(await f.text()); if (rows.length < 2) return toast('That file has no rows.', 'bad');
      const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
      const alias = { item: 'name', itemname: 'name', description: 'description', quantity: 'qty', count: 'qty', place: 'location', where: 'location', type: 'category', category: 'category', department: 'category', dept: 'category', colour: 'color' };
      const objs = rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => { const o = {}; head.forEach((h, i) => { o[alias[h] || h] = r[i] || ''; }); return o; });
      if (!confirm('Import ' + objs.length + ' rows?')) return;
      try { const r = await api('POST', '/api/import', { rows: objs }); $('#impMsg').textContent = 'Added ' + r.added + ' items and ' + r.locations + ' new places.' + (r.skipped ? ' Skipped ' + r.skipped + ' rows with no recognisable department.' : ''); await load(); toast('Imported ' + r.added, 'good'); }
      catch (er) { toast(er.message, 'bad'); }
    };
  }
  function parseCsv(t) {
    const rows = []; let row = [], f = '', q = false;
    t = t.replace(/^﻿/, '');
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function boot() {
    try { await load(); } catch (e) { view.innerHTML = '<div class="card"><h2>Could not load</h2><p>' + esc(e.message) + '</p><button class="btn" onclick="location.reload()">Try again</button></div>'; return; }
    setWho(); render(); live(); if (D.me && D.me.must_change) checkMustChange(); else askName(false);
  })();
})();
