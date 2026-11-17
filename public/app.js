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
    try { r = await fetch(url, opt); } catch (e) { throw new Error('No connection. Check your signal and try again.'); }
    if (r.status === 401) { location.href = '/'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const er = new Error(j.error || 'Something went wrong.'); er.status = r.status; er.data = j; throw er; }
    return j;
  }
  async function load() { D = await api('GET', '/api/data'); $('#title').textContent = D.settings.title; }
  function upsert(item) { const i = D.items.findIndex((x) => x.code === item.code); if (i >= 0) D.items[i] = item; else D.items.push(item); }
  const item = (c) => D.items.find((x) => x.code === c);
  const loc = (c) => D.locations.find((x) => x.code === c);
  const locName = (c) => (loc(c) || {}).name || '';

  // ── Live updates ───────────────────────────────────────────────────────────
  function live() {
    let es;
    const dot = $('#live');
    const open = () => {
      es = new EventSource('/api/events');
      es.onopen = () => { dot.classList.remove('off'); dot.title = 'Live — changes appear instantly'; };
      es.onerror = () => { dot.classList.add('off'); dot.title = 'Reconnecting…'; };
      es.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'item') upsert(m.item);
        else if (m.t === 'del') D.items = D.items.filter((x) => x.code !== m.code);
        else if (m.t === 'loc') { const i = D.locations.findIndex((x) => x.code === m.loc.code); if (i >= 0) D.locations[i] = m.loc; else D.locations.push(m.loc); }
        else if (m.t === 'reload' || m.t === 'settings') await load();
        if (!editing && !scanner) render(true);
      };
    };
    open();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && es && es.readyState === 2) { open(); load().then(() => render(true)); } });
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
    const meta = [it.code, it.category, where, it.holder ? 'with ' + it.holder : '', it.qty > 1 ? '×' + it.qty : ''].filter(Boolean).join(' · ');
    return '<a class="it" href="/i/' + esc(it.code) + '" data-nav>' + thumb(it) + '<div class="bd"><div class="nm">' + esc(it.name) + '</div><div class="mt">' + esc(meta) + '</div>' +
      (extra || '') + '</div>' + pill(it.status) + '</a>';
  }
  function qrSvg(text, px) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
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
  function setWho() { const n = LS.get('name', ''); $('#whoBtn').textContent = n ? n.split(' ')[0] : 'Name?'; }
  $('#whoBtn').onclick = () => go('/settings');

  // ── Router ─────────────────────────────────────────────────────────────────
  function render(soft) {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    route = p;
    const tab = p === '/' ? 'home' : p.split('/')[1];
    $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab || (tab === 'i' && a.dataset.tab === 'browse') || (tab === 'l' && a.dataset.tab === 'locations')));
    let m;
    if (p === '/') return home();
    if (p === '/browse') return browse(soft);
    if (p === '/add') return addForm(new URLSearchParams(location.search).get('code') || '');
    if (p === '/scan') { if (!soft) { history.replaceState(null, '', '/'); home(); openScanner({ mode: 'go' }); } return; }
    if (p === '/locations') return locations();
    if (p === '/labels') return labels();
    if (p === '/settings') return settings();
    if (p === '/recent') return recent();
    if ((m = p.match(/^\/i\/(.+)$/))) return itemPage(decodeURIComponent(m[1]).toUpperCase());
    if ((m = p.match(/^\/l\/(.+)$/))) return locPage(decodeURIComponent(m[1]).toUpperCase());
    if ((m = p.match(/^\/audit\/(.+)$/))) return audit(decodeURIComponent(m[1]).toUpperCase());
    view.innerHTML = '<div class="card">Page not found. <a href="/" data-nav>Home</a></div>';
  }

  // ── Home ───────────────────────────────────────────────────────────────────
  function home() {
    const its = D.items;
    const out = its.filter((i) => i.status === 'Checked out' || i.status === 'In a show').length;
    const miss = its.filter((i) => i.status === 'Missing').length;
    const nophoto = its.filter((i) => !i.photos.length).length;
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
      '</div>' +
      '<div class="card"><div class="stats"><div><b>' + its.length + '</b><span>Items</span></div><div><b>' + out + '</b><span>Out now</span></div><div><b>' + miss + '</b><span>Missing</span></div></div>' +
      '<div class="row" style="margin-top:10px"><a class="btn alt sm" data-nav href="/browse?status=Checked out">Who has what</a><a class="btn alt sm" data-nav href="/browse?photo=none">' + nophoto + ' need photos</a></div></div>' +
      '<div class="sect"><h2>Latest changes</h2><a href="/recent" data-nav class="small">See all</a></div>' +
      (recentList.length ? '<div class="list">' + recentList.map((i) => rowHtml(i, '<div class="mt">' + esc((i.history[0] || {}).action || '') + ' · ' + esc(i.updated_by || '') + ' · ' + esc(when(i.updated_at)) + '</div>')).join('') + '</div>'
        : '<div class="card empty">Nothing yet. Tap <b>Scan a sticker</b> on a blank label, or <b>Add item</b>, to start.</div>');
    $('#scanT').onclick = () => openScanner({ mode: 'go' });
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') go('/browse?q=' + encodeURIComponent(e.target.value)); });
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
    const st = { q: sp.get('q') || '', cat: sp.get('cat') || '', status: sp.get('status') || '', loc: sp.get('loc') || '', photo: sp.get('photo') || '', sort: sp.get('sort') || LS.get('sort', 'name') };
    if (soft && $('#bq')) { draw(); return; }
    view.innerHTML = '<h1>Items</h1>' +
      '<div class="search"><input id="bq" type="search" placeholder="Search name, color, size, tag, code…" value="' + esc(st.q) + '"></div>' +
      '<div class="filters">' +
      '<select id="fc">' + opts(D.settings.categories, st.cat, 'All categories') + '</select>' +
      '<select id="fs">' + opts(D.statuses, st.status, 'Any status') + '</select>' +
      '<select id="fl">' + locOpts(st.loc).replace('— No location yet —', 'Any place') + '<option value="none"' + (st.loc === 'none' ? ' selected' : '') + '>No place set</option></select>' +
      '<select id="fp">' + opts([['none', 'No photo'], ['has', 'Has photo']], st.photo, 'Photos: any') + '</select>' +
      '<select id="fo">' + opts([['name', 'A → Z'], ['new', 'Newest'], ['updated', 'Recently changed'], ['code', 'Sticker code']], st.sort) + '</select>' +
      '</div><p class="muted small" id="cnt"></p><div class="list" id="res"></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn alt" id="printRes">Print stickers for these</button><a class="btn alt" href="/api/export.csv">Download spreadsheet</a></div>';
    const sync = () => {
      st.q = $('#bq').value; st.cat = $('#fc').value; st.status = $('#fs').value; st.loc = $('#fl').value; st.photo = $('#fp').value; st.sort = $('#fo').value; LS.set('sort', st.sort);
      const u = new URLSearchParams(); Object.entries(st).forEach(([k, v]) => { if (v && k !== 'sort') u.set(k, v); });
      history.replaceState(null, '', '/browse' + (u.toString() ? '?' + u : '')); draw();
    };
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
        if (!words.length) return true;
        const hay = [i.code, i.name, i.category, i.color, i.size, i.period, i.tags, i.description, i.notes, i.holder, i.show, locName(i.location), i.sublocation, i.condition].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const by = { name: (a, b) => a.name.localeCompare(b.name), new: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
        updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''), code: (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) };
      return r.sort(by[st.sort] || by.name);
    }
    function draw() {
      const r = filtered();
      $('#cnt').textContent = r.length + ' of ' + D.items.length + ' items' + (r.length ? ' · ' + r.reduce((a, i) => a + (i.qty || 1), 0) + ' pieces' : '');
      $('#res').innerHTML = r.slice(0, 400).map((i) => rowHtml(i)).join('') + (r.length > 400 ? '<p class="muted">Showing the first 400 — search to narrow it down.</p>' : '') +
        (r.length ? '' : '<div class="card empty">No matches.</div>');
    }
    draw();
  }

  // ── Item page ──────────────────────────────────────────────────────────────
  function itemPage(code) {
    const it = item(code);
    if (!it) {
      view.innerHTML = '<div class="card"><h1>New sticker: <span class="code">' + esc(code) + '</span></h1><p>This sticker is not on anything yet. Fill in the item it is stuck to.</p></div>';
      return addForm(code, true);
    }
    const where = loc(it.location);
    view.innerHTML =
      '<div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="code muted">' + esc(it.code) + '</span>' + pill(it.status) + '</div>' +
      '<h1>' + esc(it.name) + (it.qty > 1 ? ' <span class="muted">×' + it.qty + '</span>' : '') + '</h1>' +
      (it.photos.length ? '<div class="photos">' + it.photos.map((p) => '<img src="/p/' + p + '.jpg" alt="" loading="lazy" data-pid="' + p + '">').join('') + '</div>'
        : '<label class="nophoto" for="ph">No photo yet — tap to take one</label>') +
      '<input type="file" id="ph" accept="image/*" capture="environment" hidden><input type="file" id="phg" accept="image/*" multiple hidden>' +
      '<div class="row" style="margin-bottom:14px"><button class="btn alt sm" id="addPh">📷 Take photo</button><button class="btn alt sm" id="addPhG">From library</button></div>' +
      ((it.status === 'Checked out' || it.status === 'In a show') ? '<div class="banner"><b>With ' + esc(it.holder) + '</b>' + (it.show ? ' for ' + esc(it.show) : '') + (it.due ? ' · due back ' + esc(it.due) : '') + '</div>' : '') +
      '<div class="row" style="margin-bottom:14px">' +
      ((it.status === 'Checked out' || it.status === 'In a show') ? '<button class="btn ok" id="ci">Check in / returned</button>' : '<button class="btn" id="co">Check out</button>') +
      '<button class="btn blue" id="mv">Move it</button></div>' +
      '<div class="card"><dl class="facts">' +
      '<dt>Place</dt><dd>' + (where ? '<a href="/l/' + esc(where.code) + '" data-nav>' + esc(where.name) + '</a>' : '<span class="muted">Not set</span>') + (it.sublocation ? ' · ' + esc(it.sublocation) : '') + '</dd>' +
      '<dt>Category</dt><dd>' + esc(it.category) + '</dd>' +
      (it.condition ? '<dt>Condition</dt><dd>' + esc(it.condition) + '</dd>' : '') +
      (it.color ? '<dt>Color</dt><dd>' + esc(it.color) + '</dd>' : '') +
      (it.size ? '<dt>Size</dt><dd>' + esc(it.size) + '</dd>' : '') +
      (it.period ? '<dt>Period / style</dt><dd>' + esc(it.period) + '</dd>' : '') +
      (it.tags ? '<dt>Tags</dt><dd>' + esc(it.tags) + '</dd>' : '') +
      (it.value ? '<dt>Value</dt><dd>$' + Number(it.value).toFixed(2) + '</dd>' : '') +
      (it.description ? '<dt>Description</dt><dd>' + esc(it.description) + '</dd>' : '') +
      (it.notes ? '<dt>Notes</dt><dd>' + esc(it.notes) + '</dd>' : '') +
      '<dt>Last seen</dt><dd>' + esc(when(it.last_seen) || '—') + '</dd>' +
      '</dl><div class="row" style="margin-top:14px"><button class="btn alt" id="ed">Edit details</button>' +
      (it.status !== 'Missing' ? '<button class="btn alt" id="ms">Can\'t find it</button>' : '') + '</div></div>' +
      '<div class="card"><div class="qrbox">' + qrSvg(D.base + '/i/' + it.code) + '<div><b>Sticker</b><p class="muted small" style="margin:.3em 0 .6em">Lost or damaged sticker? Print a new one.</p>' +
      '<div class="row"><button class="btn alt sm" id="pr">Print sticker</button><button class="btn alt sm" id="png">Save image</button></div></div></div></div>' +
      '<div class="card"><h3>History</h3><ul class="hist">' + it.history.map((h) => '<li><b>' + esc(h.action) + '</b>' + (h.detail ? ' — ' + esc(h.detail) : '') + '<br><span class="muted small">' + esc(h.by) + ' · ' + esc(when(h.at)) + '</span></li>').join('') + '</ul></div>' +
      (D.role === 'admin' ? '<button class="btn alt sm" id="del" style="color:var(--bad)">Remove from inventory</button>' : '');
    $('#addPh').onclick = () => $('#ph').click(); $('#addPhG').onclick = () => $('#phg').click();
    const nophoto = $('.nophoto'); if (nophoto) nophoto.onclick = (e) => { e.preventDefault(); $('#ph').click(); };
    $('#ph').onchange = (e) => uploadPhotos(it.code, e.target.files);
    $('#phg').onchange = (e) => uploadPhotos(it.code, e.target.files);
    $$('.photos img').forEach((img) => img.onclick = () => photoMenu(it, img.dataset.pid));
    if ($('#co')) $('#co').onclick = () => checkout(it);
    if ($('#ci')) $('#ci').onclick = () => checkin(it);
    $('#mv').onclick = () => moveItem(it);
    $('#ed').onclick = () => editForm(it);
    if ($('#ms')) $('#ms').onclick = async () => { if (!confirm('Mark ' + it.name + ' as missing?')) return; await act(it.code, { action: 'missing' }, 'Marked missing'); };
    $('#pr').onclick = () => printCodes([it.code]);
    $('#png').onclick = () => savePng(it);
    if ($('#del')) $('#del').onclick = async () => {
      if (!confirm('Remove ' + it.name + ' (' + it.code + ') from the inventory? You can restore it from Settings.')) return;
      try { await api('DELETE', '/api/items/' + it.code); D.items = D.items.filter((x) => x.code !== it.code); toast('Removed'); go('/browse'); } catch (e) { toast(e.message, 'bad'); }
    };
  }
  async function act(code, body, msg) {
    try { const r = await api('POST', '/api/items/' + code + '/action', body); upsert(r.item); toast(msg, 'good'); render(true); return r.item; }
    catch (e) { toast(e.message, 'bad'); }
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
  function fieldsHtml(v) {
    const sticky = LS.get('sticky', {});
    v = Object.assign({ category: sticky.category || '', location: sticky.location || '', qty: 1, condition: '' }, v || {});
    return '<label>What is it? *<input id="f_name" required maxlength="120" placeholder="e.g. Red velvet Victorian gown" value="' + esc(v.name || '') + '"></label>' +
      '<div class="grid2"><label>Category<select id="f_category">' + opts(D.settings.categories, v.category, 'Pick one') + '</select></label>' +
      '<label>How many<input id="f_qty" type="number" inputmode="numeric" min="0" value="' + esc(v.qty) + '"></label></div>' +
      '<label>Place<select id="f_location">' + locOpts(v.location) + '</select></label>' +
      '<details' + (v.color || v.size || v.period || v.notes || v.description || v.tags || v.value || v.condition || v.sublocation ? ' open' : '') + '><summary style="font-weight:700;margin:4px 0 12px;cursor:pointer">More details (optional)</summary>' +
      '<label>Spot within the place<input id="f_sublocation" placeholder="top shelf, left end…" value="' + esc(v.sublocation || '') + '"></label>' +
      '<div class="grid2"><label>Color<input id="f_color" value="' + esc(v.color || '') + '"></label><label>Size<input id="f_size" placeholder="M, 40R, 6ft…" value="' + esc(v.size || '') + '"></label></div>' +
      '<div class="grid2"><label>Period / style<input id="f_period" placeholder="1920s, Victorian…" value="' + esc(v.period || '') + '"></label>' +
      '<label>Condition<select id="f_condition">' + opts(D.conditions, v.condition, '—') + '</select></label></div>' +
      '<label>Tags (words to search by)<input id="f_tags" placeholder="military, formal, Christmas…" value="' + esc(v.tags || '') + '"></label>' +
      '<label>Description<textarea id="f_description">' + esc(v.description || '') + '</textarea></label>' +
      '<label>Notes<textarea id="f_notes">' + esc(v.notes || '') + '</textarea></label>' +
      '<label>Replacement value ($)<input id="f_value" inputmode="decimal" value="' + esc(v.value || '') + '"></label>' +
      (v.code ? '<label>Status<select id="f_status">' + opts(D.statuses, v.status) + '</select></label>' : '') +
      '</details>';
  }
  function readFields(root) {
    const o = {};
    ['name', 'category', 'qty', 'location', 'sublocation', 'color', 'size', 'period', 'condition', 'tags', 'description', 'notes', 'value', 'status'].forEach((k) => {
      const el = $('#f_' + k, root); if (el) o[k] = el.value;
    });
    return o;
  }
  function addForm(code, append) {
    editing = true;
    const html = '<form class="card" id="af">' + (append ? '' : '<h1>Add an item</h1>') +
      (code ? '<p class="muted">Sticker <span class="code">' + esc(code) + '</span> will be attached to this item.</p>'
        : '<p class="muted small">No sticker yet? It gets the next number and you can print its sticker after saving. Have blank stickers? Use <b>Scan</b> on one instead.</p>') +
      '<input type="file" id="aph" accept="image/*" capture="environment" hidden>' +
      '<div id="aprev" class="nophoto" style="cursor:pointer">📷 Tap to take a photo (recommended)</div>' +
      fieldsHtml({}) +
      '<label class="check"><input type="checkbox" id="keep"' + (LS.get('keepOn', true) ? ' checked' : '') + '> Keep category &amp; place for the next item</label>' +
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
      const keep = $('#keep').checked; LS.set('keepOn', keep);
      LS.set('sticky', keep ? { category: b.category, location: b.location } : {});
      $('#sv').disabled = true; $('#sv').textContent = 'Saving…';
      try {
        const r = await api('POST', '/api/items', b); upsert(r.item);
        if (photo) { try { const r2 = await api('POST', '/api/items/' + r.item.code + '/photos', photo); upsert(r2.item); } catch (er) { toast('Item saved, photo failed: ' + er.message, 'bad'); } }
        editing = false; afterAdd(r.item, !code);
      } catch (er) {
        $('#sv').disabled = false; $('#sv').textContent = 'Save item';
        if (er.status === 409 && er.data && er.data.code) { toast(er.message, 'bad'); } else toast(er.message, 'bad');
      }
    };
    setTimeout(() => { const n = $('#f_name'); if (n && !('ontouchstart' in window)) n.focus(); }, 50);
  }
  function afterAdd(it, needsLabel) {
    history.replaceState(null, '', '/i/' + it.code); render();
    modal('<h2>Saved ✓</h2><p><b>' + esc(it.name) + '</b> is <span class="code">' + esc(it.code) + '</span>.</p>' +
      (needsLabel ? '<button class="btn big" id="pl">Print its sticker</button>' : '') +
      '<button class="btn big" id="nx" style="margin-top:8px">⌗ Scan next blank sticker</button>' +
      '<button class="btn alt big" id="na" style="margin-top:8px">Add another without a sticker</button>' +
      '<button class="btn alt big" data-close style="margin-top:8px">Done</button>',
    (m, close) => {
      if ($('#pl', m)) $('#pl', m).onclick = () => { close(); printCodes([it.code]); };
      $('#nx', m).onclick = () => { close(); openScanner({ mode: 'go' }); };
      $('#na', m).onclick = () => { close(); go('/add'); };
    });
  }
  function editForm(it) {
    editing = true;
    view.innerHTML = '<form class="card" id="ef"><h1>Edit <span class="code">' + esc(it.code) + '</span></h1>' + fieldsHtml(it) +
      '<button class="btn big">Save changes</button><button type="button" class="btn alt big" id="cx" style="margin-top:8px">Cancel</button></form>';
    $('#cx').onclick = () => { editing = false; render(); };
    $('#ef').onsubmit = async (e) => {
      e.preventDefault(); const b = readFields(view); const ch = {};
      Object.keys(b).forEach((k) => { if (String(b[k] ?? '') !== String(it[k] ?? '')) ch[k] = b[k]; });
      try { if (Object.keys(ch).length) { const r = await api('PATCH', '/api/items/' + it.code, ch); upsert(r.item); } editing = false; toast('Saved', 'good'); render(); }
      catch (er) { toast(er.message, 'bad'); }
    };
  }

  // ── Locations ──────────────────────────────────────────────────────────────
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
    const st = LS.get(key, { started: new Date().toISOString(), seen: [] });
    LS.set(key, st);
    const expected = D.items.filter((i) => i.location === code && i.status !== 'Retired' && i.status !== 'Checked out');
    const seen = new Set(st.seen);
    const notSeen = expected.filter((i) => !seen.has(i.code));
    const extra = st.seen.filter((c) => !expected.find((i) => i.code === c));
    view.innerHTML = '<span class="code muted">AUDIT · ' + esc(code) + '</span><h1>' + esc(l.name) + '</h1>' +
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
  }

  // ── Scanner (camera inside the app; works on iPhone and Android) ───────────
  let scanner = null;
  function parseScan(text) {
    text = String(text || '').trim();
    let m = text.match(/\/(i|l)\/([A-Za-z]{1,4}-\d{1,6})(?:[/?#]|$)/);
    if (m) return { kind: m[1] === 'l' ? 'loc' : 'item', code: m[2].toUpperCase() };
    m = text.match(/^([A-Za-z]{1,4}-\d{1,6})$/);
    if (m) return { kind: /^L-/i.test(m[1]) ? 'loc' : 'item', code: m[1].toUpperCase() };
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
      '<div class="hdr"><span>' + esc(o.mode === 'audit' ? 'Auditing ' + o.loc.name : o.mode === 'put' ? 'Putting into ' + o.loc.name : 'Scan') + '</span><button id="sx">' + (o.mode === 'go' || o.mode === 'pickLoc' ? 'Close' : 'Done') + '</button></div>' +
      '<div class="bar"><div class="log" id="slog"></div><p id="smsg">' + esc(o.prompt || 'Point at a sticker') + '</p>' +
      '<form id="sf" class="row" style="gap:8px"><input id="sc" placeholder="or type the code, e.g. R-0012" autocapitalize="characters" style="flex:1;margin:0;background:#fff;color:#000"><button class="btn sm">Go</button></form></div>';
    document.body.appendChild(el);
    const video = $('video', el), msg = $('#smsg', el), frame = $('.frame', el), logEl = $('#slog', el);
    scanner = { el, stream: null, timer: null, last: '', lastAt: 0, o };
    $('#sx', el).onclick = () => { closeScanner(); if (o.onClose) o.onClose(); };
    $('#sf', el).onsubmit = (e) => { e.preventDefault(); const r = parseScan($('#sc', el).value); if (r) handle(r); else msg.textContent = 'That is not a sticker code.'; };
    const handle = async (r) => {
      const key = r.kind + r.code; const now = Date.now();
      if (key === scanner.last && now - scanner.lastAt < 2500) return; scanner.last = key; scanner.lastAt = now;
      beep(); frame.classList.add('hit'); setTimeout(() => frame.classList.remove('hit'), 400);
      const add = (t, cls) => { logEl.insertAdjacentHTML('afterbegin', '<div class="' + (cls || '') + '">' + t + '</div>'); };
      if (o.mode === 'go') { closeScanner(); go(r.kind === 'loc' ? '/l/' + r.code : '/i/' + r.code); return; }
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
  function printCodes(codes, kind) {
    const size = LS.get('labelSize', '2x1');
    const u = '/print?size=' + encodeURIComponent(size) + '&kind=' + (kind || 'items') + '&codes=' + encodeURIComponent(codes.join(','));
    if (u.length > 7000) { // very long lists: print as a range instead
      const nums = codes.map((c) => Number(c.split('-')[1])).sort((a, b) => a - b);
      location.href = '/print?size=' + size + '&from=' + encodeURIComponent(codes[0].split('-')[0] + '-' + nums[0]) + '&count=' + (nums[nums.length - 1] - nums[0] + 1); return;
    }
    location.href = u;
  }
  function savePng(it) {
    const q = qrcode(0, 'M'); q.addData(D.base + '/i/' + it.code); q.make();
    const n = q.getModuleCount(), cell = 10, m = 2, W = (n + 2 * m) * cell, H = W + 120;
    const c = document.createElement('canvas'); c.width = Math.max(W, 600); c.height = H; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, H); x.fillStyle = '#000';
    const ox = (c.width - W) / 2;
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect(ox + (k + m) * cell, (r + m) * cell, cell, cell);
    x.textAlign = 'center'; x.font = 'bold 54px Arial'; x.fillText(it.code, c.width / 2, W + 52);
    x.font = 'bold 30px Arial'; x.fillText(it.name.slice(0, 34), c.width / 2, W + 98);
    c.toBlob((b) => {
      const f = new File([b], it.code + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) navigator.share({ files: [f], title: it.code }).catch(() => {});
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = it.code + '.png'; a.click(); }
    });
  }
  function labels() {
    const size = LS.get('labelSize', '2x1');
    const sizeSel = '<label>Sticker size<select id="sz">' + opts(Object.entries(D.sizes), size) + '</select></label>';
    view.innerHTML = '<h1>Print stickers</h1>' +
      '<div class="card">' + sizeSel + '<p class="muted small">Thermal sticker printer: pick its roll size, then Print and choose the sticker printer. Phone-only sticker printer (Phomemo, Niimbot…): open an item and tap <b>Save image</b>, then print the image from the printer\'s app.</p></div>' +
      '<form class="card" id="bk"><h2>1 · Blank stickers (fastest way to inventory)</h2>' +
      '<p>Print a roll of numbered stickers first. Volunteers stick one on each item, scan it, and fill in the item. No typing codes.</p>' +
      '<label>How many<input id="bn" type="number" min="1" max="1000" value="100" inputmode="numeric"></label>' +
      '<button class="btn big">Print blank stickers</button><p class="muted small">Next number: ' + esc(D.settings.prefix) + '-' + String(D.settings.next_num).padStart(4, '0') + '. These numbers are reserved so they never repeat.</p></form>' +
      '<div class="card"><h2>2 · Stickers for items already entered</h2>' +
      '<label>Category<select id="lc">' + opts(D.settings.categories, '', 'All categories') + '</select></label>' +
      '<label>Added<select id="ld">' + opts([['today', 'Today'], ['7', 'Last 7 days'], ['all', 'Any time']], 'today') + '</select></label>' +
      '<button class="btn big" id="lp">Print these</button><p class="muted small">Or search on the Items page and use "Print stickers for these".</p></div>' +
      '<div class="card"><h2>3 · Place stickers</h2><p>One per rack, shelf, bin or room. Print them big (4×6 or 2×2) so they are easy to scan.</p>' +
      '<button class="btn big" id="lo"' + (D.locations.length ? '' : ' disabled') + '>Print all ' + D.locations.length + ' place stickers</button></div>' +
      '<div class="card"><h2>Reprint a range</h2><div class="grid2"><label>From<input id="rf" placeholder="R-0001"></label><label>How many<input id="rc" type="number" value="30"></label></div><button class="btn alt big" id="rp">Reprint</button></div>';
    $('#sz').onchange = (e) => LS.set('labelSize', e.target.value);
    $('#bk').onsubmit = async (e) => {
      e.preventDefault(); const n = Number($('#bn').value) || 0; if (n < 1) return;
      if (!confirm('Reserve and print ' + n + ' blank stickers?')) return;
      try { const r = await api('POST', '/api/reserve', { count: n }); location.href = '/print?size=' + LS.get('labelSize', '2x1') + '&from=' + r.from + '&count=' + r.count; }
      catch (er) { toast(er.message, 'bad'); }
    };
    $('#lp').onclick = () => {
      const cat = $('#lc').value, d = $('#ld').value; const since = d === 'all' ? '' : new Date(Date.now() - (d === 'today' ? 0 : 7) * 864e5).toISOString().slice(0, 10);
      const c = D.items.filter((i) => (!cat || i.category === cat) && (!since || (i.created_at || '') >= since)).map((i) => i.code);
      if (!c.length) return toast('No items match.'); printCodes(c);
    };
    $('#lo').onclick = () => printCodes(D.locations.map((l) => l.code), 'locations');
    $('#rp').onclick = () => { const f = $('#rf').value.trim().toUpperCase(); if (!/^[A-Z]{1,4}-\d+$/.test(f)) return toast('Use a code like R-0001', 'bad'); location.href = '/print?size=' + LS.get('labelSize', '2x1') + '&from=' + f + '&count=' + (Number($('#rc').value) || 30); };
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function settings() {
    const admin = D.role === 'admin', st = D.settings;
    view.innerHTML = '<h1>Settings</h1>' +
      '<div class="card"><h3>You</h3><p>Signed in as <b>' + esc(LS.get('name', '') || '(no name)') + '</b> · ' + (admin ? 'Admin' : 'Crew') + '</p>' +
      '<div class="row"><button class="btn alt" id="cn">Change my name</button><a class="btn alt" href="/logout">Sign out</a></div></div>' +
      '<div class="card"><h3>Add to home screen</h3><p class="muted small">iPhone: Share button → <b>Add to Home Screen</b>. Android: ⋮ menu → <b>Add to Home screen</b>. It then opens like an app.</p></div>' +
      '<div class="card"><h3>Spreadsheet</h3><div class="row"><a class="btn alt" href="/api/export.csv">Download everything (CSV)</a></div></div>' +
      (admin ? adminHtml(st) : '<form class="card" id="al"><h3>Admin</h3><label>Admin code<input id="ak" autocomplete="off" autocapitalize="characters"></label><button class="btn alt">Unlock admin</button></form>');
    $('#cn').onclick = () => askName(true);
    if (!admin) $('#al').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/login', { key: $('#ak').value }); await load(); render(); toast('Admin unlocked', 'good'); } catch (er) { toast(er.message, 'bad'); } };
    else wireAdmin(st);
  }
  function adminHtml(st) {
    return '<div class="card"><h3>Invite the crew</h3><p>Print the poster and tape it up, or text people this link (it signs them in):</p>' +
      '<p><input readonly id="jl" value="' + esc(D.base + '/join?k=' + st.crew_key) + '"></p>' +
      '<div class="row"><button class="btn" id="cp">Copy link</button><a class="btn alt" href="/poster" target="_blank">Print crew poster</a></div></div>' +
      '<form class="card" id="kf"><h3>Codes</h3><label>Crew code (everyone)<input id="ck" value="' + esc(st.crew_key) + '"></label>' +
      '<label>Admin code (you)<input id="adk" value="' + esc(st.admin_key) + '"></label><p class="muted small">Changing the crew code signs everyone out until they use the new one.</p><button class="btn alt">Save codes</button></form>' +
      '<form class="card" id="sf2"><h3>Names</h3><label>App title<input id="tt" value="' + esc(st.title) + '"></label><label>Organization (printed on stickers)<input id="og" value="' + esc(st.org) + '"></label>' +
      '<label>Categories (one per line)<textarea id="cats" rows="8">' + esc(st.categories.join('\n')) + '</textarea></label><button class="btn alt">Save</button></form>' +
      '<div class="card"><h3>Import from a spreadsheet</h3><p class="muted small">CSV with a header row. Columns it understands: name, category, qty, location, color, size, period, condition, tags, description, notes, value, code. New places are created automatically.</p>' +
      '<input type="file" id="imp" accept=".csv,text/csv"><p id="impMsg" class="muted small"></p></div>' +
      '<div class="card"><h3>Removed items</h3>' + (D.removed.length ? '<ul class="hist">' + D.removed.slice(0, 50).map((r) => '<li><b>' + esc(r.name) + '</b> <span class="code">' + esc(r.code) + '</span> <button class="btn alt sm" data-restore="' + esc(r.code) + '">Restore</button></li>').join('') + '</ul>' : '<p class="muted">None.</p>') + '</div>';
  }
  function wireAdmin() {
    $('#cp').onclick = () => { const i = $('#jl'); i.select(); (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('Copied', 'good'), () => document.execCommand('copy')); };
    $('#kf').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/settings', { crew_key: $('#ck').value, admin_key: $('#adk').value }); await load(); render(); toast('Codes saved', 'good'); } catch (er) { toast(er.message, 'bad'); } };
    $('#sf2').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/settings', { title: $('#tt').value, org: $('#og').value, categories: $('#cats').value.split('\n') }); await load(); render(); toast('Saved', 'good'); } catch (er) { toast(er.message, 'bad'); } };
    $$('[data-restore]').forEach((b) => b.onclick = async () => { try { await api('POST', '/api/restore', { code: b.dataset.restore }); await load(); render(); toast('Restored', 'good'); } catch (er) { toast(er.message, 'bad'); } });
    $('#imp').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCsv(await f.text()); if (rows.length < 2) return toast('That file has no rows.', 'bad');
      const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
      const alias = { item: 'name', itemname: 'name', description: 'description', quantity: 'qty', count: 'qty', place: 'location', where: 'location', type: 'category', colour: 'color' };
      const objs = rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => { const o = {}; head.forEach((h, i) => { o[alias[h] || h] = r[i] || ''; }); return o; });
      if (!confirm('Import ' + objs.length + ' rows?')) return;
      try { const r = await api('POST', '/api/import', { rows: objs }); $('#impMsg').textContent = 'Added ' + r.added + ' items and ' + r.locations + ' new places.'; await load(); toast('Imported ' + r.added, 'good'); }
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
    setWho(); render(); live(); askName(false);
  })();
})();
