// ─── Rialto Inventory ────────────────────────────────────────────────────────
// QR-code inventory for the Rialto's wardrobe, props, furniture and stock.
// Zero npm dependencies, runs on any Node 18+. Phones are the scanners: every
// sticker carries a QR that opens that item's page; the phone's own camera app
// (or the in-app Scan button) is all anyone needs.
//
//   PAGES  /            the app (search, add, scan, locations, labels, settings)
//          /i/:code     an item's page (unknown code = "new item with this label")
//          /l/:code     a location's page (contents + shelf audit)
//          /join?k=…    one-tap sign-in link (the crew poster QR points here)
//          /print       printable QR sticker sheets (any label size)
//          /poster      printable "scan to join" poster
//
//   API    POST /api/login              {key} → sets the sign-in cookie
//          GET  /api/data               everything the app needs (items, locations…)
//          GET  /api/events             live updates (Server-Sent Events)
//          POST /api/items              add (code optional — claims a pre-printed label)
//          PATCH /api/items/:code       edit (send only what changed)
//          POST /api/items/:code/action {action: checkout|checkin|move|seen|missing, …}
//          POST /api/items/:code/photos {full, thumb} (base64 JPEG)
//          DELETE /api/items/:code/photos/:pid
//          POST /api/locations / PATCH /api/locations/:code
//          POST /api/reserve            {count} → reserves a run of blank label codes
//          GET  /api/export.csv
//   ADMIN  DELETE /api/items/:code, POST /api/restore, POST /api/settings, POST /api/import
//
// Storage: one JSON file + a photos folder in DATA_DIR. On Render's free plan the
// disk is wiped on sleep, so (like the AFGM materials app) every change is also
// mirrored to the key-gated store on the audition service, which has a paid disk:
//   JSON   → BACKUP_URL            (…/api/blob/rialto-inventory)
//   photos → BACKUP_FILES_URL/<n>  (…/api/file/<name>)
// A boot whose mirror read fails never writes to the mirror (can't clobber good data).

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const qrcode = require('./qrcode');

const PORT       = process.env.PORT || 3000;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE  = path.join(DATA_DIR, 'inventory.json');
const PHOTO_DIR  = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const BACKUP_URL       = process.env.BACKUP_URL || '';
const BACKUP_FILES_URL = (process.env.BACKUP_FILES_URL || '').replace(/\/+$/, '');
const BACKUP_KEY       = process.env.BACKUP_KEY || '';

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Department codes, settled 2026-11-17 with an inventory-control and a theatre production
// review: a short readable word, a hyphen, 4 digits (COST-0141), numbered separately per
// department. Size and garment type live in the record, never in the code. Sticker colour
// follows the storage ROOM (all costume-shop departments are purple). Consumables (paint,
// tape, lamps, batteries, makeup, yardage) are not tagged; their shelf or bin is (LOC).
const DEFAULT_DEPTS = [
  { p: 'COST', name: 'Costumes',                      room: 'Costume shop',  color: '#1d4ed8' },
  { p: 'WIG',  name: 'Wigs & hair',                   room: 'Costume shop',  color: '#6b3fa0' },
  { p: 'HAT',  name: 'Hats',                          room: 'Costume shop',  color: '#6b3fa0' },
  { p: 'SHOE', name: 'Shoes & boots',                 room: 'Costume shop',  color: '#ffd400' },
  { p: 'ACC',  name: 'Accessories & jewelry',         room: 'Costume shop',  color: '#d71920' },
  { p: 'PROP', name: 'Props & set dressing',          room: 'Prop room',     color: '#16a34a' },
  { p: 'FURN', name: 'Furniture',                     room: 'Scene storage', color: '#2e7d32' },
  { p: 'SET',  name: 'Set pieces, flats & platforms', room: 'Scene storage', color: '#2e7d32' },
  { p: 'DRAP', name: 'Drapes & soft goods',           room: 'Soft goods',    color: '#1a2a5e' },
  { p: 'LITE', name: 'Lighting',                      room: 'Lighting & sound', color: '#1e73be' },
  { p: 'SND',  name: 'Sound & video',                 room: 'Lighting & sound', color: '#1e73be' },
  { p: 'RIG',  name: 'Rigging & hardware',            room: 'Shop & rigging', color: '#616161' },
  { p: 'TOOL', name: 'Tools',                         room: 'Shop & rigging', color: '#616161' },
  { p: 'BOOK', name: 'Scripts & prompt books',        room: 'Stage management', color: '#ea580c' },
  { p: 'FOH',  name: 'Office & front of house',       room: 'Lobby & office', color: '#ffffff' },
  { p: 'LOAN', name: 'Borrowed / rented (not ours)',  room: 'Return to owner', color: '#c62828' },
];
const LOC_PREFIX = 'LOC';
const STATUSES = ['Available', 'Checked out', 'In a show', 'Needs repair', 'Missing', 'Retired'];
const CONDITIONS = ['New', 'Good', 'Fair', 'Poor', 'Needs repair'];
const CODE_RE = /^[A-Z]{1,4}-\d{1,6}$/;
const LOC_RE  = /^(LOC|L)-\d{1,6}$/;
// "cost141", "COST 141", "Cost-0141" → "COST-0141"
function normCode(v) {
  const m = String(v || '').trim().toUpperCase().match(/^([A-Z]{1,4})[\s_-]*(\d{1,6})$/);
  return m ? m[1] + '-' + String(Number(m[2])).padStart(4, '0') : '';
}

// ── Store ────────────────────────────────────────────────────────────────────
function randKey(n) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += a[b[i] % a.length];
  return s;
}
function freshStore() {
  return {
    settings: {
      title: 'Rialto Inventory',
      org: 'Bold Theatre',
      departments: DEFAULT_DEPTS.map((d) => Object.assign({}, d)),
      next: {},          // per-prefix next number, e.g. { COST: 142 }
      next_loc: 1,
      crew_key: process.env.CREW_KEY || ('RIALTO-' + randKey(4)),
      admin_key: process.env.ADMIN_KEY || ('ADMIN-' + randKey(8)),
      secret: crypto.randomBytes(32).toString('hex'),   // signs admin session cookies
    },
    items: [],
    locations: [],
    removed: [],
    pending_photos: [],
    admins: [],          // department-head logins: { id, name, user, salt, hash, ver, manager, must_change }
    shows: [],           // roster: [{ name, characters: [..] }] — picked from on the item form
  };
}

fs.mkdirSync(PHOTO_DIR, { recursive: true });
let hadLocalFile = false;
let store = freshStore();
try {
  store = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  hadLocalFile = true;
} catch (e) { /* first run, or a wiped free-plan disk — the mirror restore fills it */ }

function normalize(d) {
  const f = freshStore();
  const out = {
    settings: Object.assign({}, f.settings, (d && d.settings) || {}),
    items: Array.isArray(d && d.items) ? d.items : [],
    locations: Array.isArray(d && d.locations) ? d.locations : [],
    removed: Array.isArray(d && d.removed) ? d.removed : [],
    pending_photos: Array.isArray(d && d.pending_photos) ? d.pending_photos : [],
    admins: Array.isArray(d && d.admins) ? d.admins : [],
    shows: Array.isArray(d && d.shows) ? d.shows : [],
  };
  if (!out.settings.secret) out.settings.secret = crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(out.settings.departments) || !out.settings.departments.length)
    out.settings.departments = DEFAULT_DEPTS.map((x) => Object.assign({}, x));
  if (!out.settings.next || typeof out.settings.next !== 'object') out.settings.next = {};
  delete out.settings.categories; delete out.settings.prefix; delete out.settings.next_num;
  // Env keys win, so a key set on the host is never shadowed by an old stored one.
  if (process.env.CREW_KEY && !out.settings.crew_key_rotated) out.settings.crew_key = process.env.CREW_KEY;
  if (process.env.ADMIN_KEY && !out.settings.admin_key_rotated) out.settings.admin_key = process.env.ADMIN_KEY;
  for (const it of out.items) {
    if (!Array.isArray(it.photos)) it.photos = []; if (!Array.isArray(it.history)) it.history = [];
    if (!Array.isArray(it.aliases)) it.aliases = [];
    if (it.name === 'Details needed') it.needs_details = true;   // the placeholder name always means "still to fill in"
  }
  if (d && d.tag_usage) out.tag_usage = d.tag_usage;
  return out;
}

let writeChain = Promise.resolve();
let writes = 0;
function save() {
  writes++;
  const snapshot = JSON.stringify(store);
  writeChain = writeChain.then(() => new Promise((res) => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, DATA_FILE); // atomic replace
    } catch (e) { console.error('save error:', e.message); }
    res();
  }));
  pushBackup();
  return writeChain;
}

// ── Off-box mirror (same rules as afgm-materials) ────────────────────────────
const MIRRORED  = Boolean(BACKUP_URL && BACKUP_KEY);
let restoreDone = !MIRRORED || hadLocalFile;
let pushWaiting = false, pushTimer = null, restoreTry = 0, pushRetry = null;

function pushBackup(now) {
  if (!MIRRORED) return;
  if (!restoreDone) { pushWaiting = true; return; }
  if (pushTimer) clearTimeout(pushTimer);
  const send = () => {
    pushTimer = null;
    return fetch(BACKUP_URL, {
      method: 'PUT',
      headers: { 'x-staff-key': BACKUP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    }).then((r) => { if (!r.ok) throw new Error('answered ' + r.status); retryPendingPhotos(); })
      .catch((e) => {
        console.error('backup push failed:', e.message);
        // Keep trying until it lands: a failed push must never be the last word.
        if (!pushRetry) pushRetry = setTimeout(() => { pushRetry = null; pushBackup(); }, 30000);
      });
  };
  if (now) return send();
  pushTimer = setTimeout(send, 2000);
}

function resumeTagReads() {
  store.items.filter((i) => wantsTagRead(i) && (!i.tag_read || i.tag_read.status === 'reading')).forEach(scheduleTagRead);
}
async function restoreFromBackup() {
  if (restoreDone) { resumeTagReads(); return; }
  try {
    const r = await fetch(BACKUP_URL, { headers: { 'x-staff-key': BACKUP_KEY } });
    if (r.status === 404) console.log('mirror is empty — starting fresh');
    else if (!r.ok) throw new Error('mirror answered ' + r.status);
    else {
      const d = await r.json();
      if (!d || !Array.isArray(d.items)) throw new Error('mirror held nothing usable');
      // Nothing can be written before this point (every /api/ call answers 503 until the
      // restore is done), so the mirror's copy is always the one to load.
      store = normalize(d); console.log('restored ' + store.items.length + ' items from the mirror');
    }
    restoreDone = true;
    if (!hadLocalFile) save();
    if (pushWaiting) { pushWaiting = false; pushBackup(); }
    retryPendingPhotos();
    // A deploy/restart drops the reader's 25 s timers: pick up photographed items it never got to,
    // and any left mid-read. Items it already read (done / no tag) are not sent again.
    resumeTagReads();
    broadcast({ t: 'reload' });
  } catch (e) {
    restoreTry++;
    console.error('restore attempt ' + restoreTry + ' failed (' + e.message + '); retrying in 30s');
    setTimeout(restoreFromBackup, 30000);
  }
}

// Photos not yet confirmed on the mirror are listed in store.pending_photos (itself
// mirrored) and retried after every successful data push and at boot, so a photo
// taken while the mirror service is redeploying is never lost.
function mirrorPhoto(name, buf) {
  if (!BACKUP_FILES_URL || !BACKUP_KEY) return Promise.resolve();
  if (!store.pending_photos.includes(name)) store.pending_photos.push(name);
  return fetch(BACKUP_FILES_URL + '/' + name, {
    method: 'PUT', headers: { 'x-staff-key': BACKUP_KEY, 'Content-Type': 'image/jpeg' }, body: buf,
  }).then((r) => {
    if (!r.ok) throw new Error('answered ' + r.status);
    store.pending_photos = store.pending_photos.filter((n) => n !== name);
  }).catch((e) => console.error('photo mirror failed for ' + name + ' (will retry):', e.message));
}
let photoRetrying = false;
function retryPendingPhotos() {
  if (photoRetrying || !store.pending_photos.length || !BACKUP_FILES_URL || !restoreDone) return;
  photoRetrying = true;
  const before = store.pending_photos.length;
  Promise.all(store.pending_photos.slice().map((name) => {
    let buf;
    try { buf = fs.readFileSync(path.join(PHOTO_DIR, name.replace(/^rinv-/, '') + '.jpg')); }
    catch (e) { store.pending_photos = store.pending_photos.filter((n) => n !== name); return null; } // local copy gone
    return mirrorPhoto(name, buf);
  })).finally(() => { photoRetrying = false; if (store.pending_photos.length !== before) save(); });
}
async function fetchMirroredPhoto(name) {
  if (!BACKUP_FILES_URL || !BACKUP_KEY) return null;
  try {
    const r = await fetch(BACKUP_FILES_URL + '/' + name, { headers: { 'x-staff-key': BACKUP_KEY } });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}

// ── Live updates ─────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(msg) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const c of clients) { try { c.write(line); } catch (e) { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 25000).unref();

// ── Helpers ──────────────────────────────────────────────────────────────────
function s(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : (typeof v === 'number' ? String(v).slice(0, max) : ''); }
function num(v, min, max, dflt) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; }
function money(v) { const n = Number(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; }
function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  // Rightmost entry = the address Render's own proxy saw; leftmost entries are client-controlled.
  return (xf ? String(xf).split(',').pop().trim() : '') || req.socket.remoteAddress || 'unknown';
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, html, code) {
  res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(html);
}
function readText(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readBody(req, limit) {
  const t = await readText(req, limit || 200 * 1024);
  if (!t) return {};
  try { return JSON.parse(t); } catch (e) { const er = new Error('bad json'); er.status = 400; throw er; }
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// ── Admin accounts ──────────────────────────────────────────────────────────
// Each department head has their own username + password (scrypt-hashed). A signed
// cookie "ra" = id.ver.sig; bumping ver (password change / reset) signs out old sessions.
// The master admin code (ADMIN_KEY) still works as the owner's recovery key.
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function sign(v) { return crypto.createHmac('sha256', store.settings.secret).update(v).digest('hex').slice(0, 32); }
function account(req) {
  const v = cookies(req).ra; if (!v) return null;
  const [id, ver, sig] = String(v).split('.');
  const a = store.admins.find((x) => x.id === id);
  if (!a || String(a.ver) !== ver || !sig) return null;
  const good = sign(id + '.' + ver);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return a;
}
function setAdminCookie(res, a) {
  res.setHeader('Set-Cookie', 'ra=' + a.id + '.' + a.ver + '.' + sign(a.id + '.' + a.ver) + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' +
    (PUBLIC_URL.startsWith('https') ? '; Secure' : ''));
}
function isManager(req) {
  const a = account(req); if (a) return !!a.manager;
  return (cookies(req).rk || '') === store.settings.admin_key;
}
function tempPassword() { return 'Rialto-' + randKey(6); }
function adminOut(a) { return { id: a.id, name: a.name, user: a.user, manager: !!a.manager, must_change: !!a.must_change, created_at: a.created_at, last_login: a.last_login || '' }; }
function role(req) {
  if (account(req)) return 'admin';
  const k = cookies(req).rk || req.headers['x-key'] || '';
  if (!k) return null;
  if (k === store.settings.admin_key) return 'admin';
  if (k === store.settings.crew_key) return 'crew';
  return null;
}
function setKeyCookie(res, key) {
  res.setHeader('Set-Cookie', 'rk=' + encodeURIComponent(key) + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' +
    (PUBLIC_URL.startsWith('https') ? '; Secure' : ''));
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return proto + '://' + req.headers.host;
}
function who(req) {
  const a = account(req); if (a) return a.name;           // signed-in admins are named by their account
  return s(decodeURIComponent(req.headers['x-user'] || ''), 60) || 'Someone';
}

// Login throttle: 12 wrong codes / 15 min / IP.
const loginFails = new Map();
function loginBlocked(ip) {
  const now = Date.now(); const a = (loginFails.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (a.length) loginFails.set(ip, a); else loginFails.delete(ip);
  return a.length >= 12;
}
function loginFailed(ip) { const a = loginFails.get(ip) || []; a.push(Date.now()); loginFails.set(ip, a); }
setInterval(() => { for (const ip of [...loginFails.keys()]) loginBlocked(ip); }, 10 * 60 * 1000).unref();

// ── Items ────────────────────────────────────────────────────────────────────
function findItem(code) { return store.items.find((i) => i.code === code || (i.aliases && i.aliases.includes(code))); }
function codeTaken(code) { return !!findItem(code) || store.removed.some((i) => i.code === code); }
function prefixOf(code) { return String(code).split('-')[0]; }
function bookNeedsShow(prefix, roles) { return prefix === 'BOOK' && !(Array.isArray(roles) && roles.some((r) => r && String(r.show || '').trim())); }
function deptByPrefix(p) { return store.settings.departments.find((d) => d.p === p); }
function deptByName(n) { n = String(n || '').toLowerCase(); return store.settings.departments.find((d) => d.name.toLowerCase() === n || d.p.toLowerCase() === n); }
function rosterShow(name, create) {
  let sh = store.shows.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!sh && create && name) { sh = { name, characters: [] }; store.shows.push(sh); store.shows.sort((a, b) => a.name.localeCompare(b.name)); }
  return sh;
}
// Shows/characters typed on an item join the roster, so they show up in the pick-lists.
function syncRoster(roles) {
  let changed = false;
  for (const r of roles || []) {
    if (!r.show) continue;
    const had = rosterShow(r.show, false); const sh = rosterShow(r.show, true); if (!had) changed = true;
    if (r.character && !sh.characters.some((c) => c.toLowerCase() === r.character.toLowerCase())) { sh.characters.push(r.character); sh.characters.sort((a, b) => a.localeCompare(b)); changed = true; }
  }
  return changed;
}
function findLoc(code) { return store.locations.find((l) => l.code === code); }
function pad(n, w) { return String(n).padStart(w, '0'); }
function codeNum(code) { return Number(String(code).split('-')[1]) || 0; }
function nextCode(prefix) {
  let n = store.settings.next[prefix] || 1;
  while (codeTaken(prefix + '-' + pad(n, 4))) n++;
  store.settings.next[prefix] = n + 1;
  return prefix + '-' + pad(n, 4);
}
function bumpPastCode(code) {
  const p = prefixOf(code), n = codeNum(code);
  if (n >= (store.settings.next[p] || 1)) store.settings.next[p] = n + 1;
}
function log(item, by, action, detail) {
  item.history.unshift({ at: new Date().toISOString(), by, action, detail: detail || '' });
  if (item.history.length > 60) item.history.length = 60;
}
const FITS = ["Men's", "Women's", "Unisex", "Children's"];
const TEXT_FIELDS = { name: 120, category: 60, description: 1500, color: 60, size: 60, period: 80,
  tags: 200, notes: 1500, holder: 80, show: 120, due: 20, location: 12, sublocation: 80, condition: 30, status: 30 };
function applyFields(item, b) {
  const changed = [];
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    let v = s(b[k], max);
    if (k === 'status' && v && !STATUSES.includes(v)) v = 'Available';
    if (k === 'condition' && v && !CONDITIONS.includes(v)) v = '';
    if (k === 'location' && v && !findLoc(v)) v = '';
    if (k === 'category') continue;
    if (k === 'name' && !v) continue;
    if ((item[k] || '') !== v) { item[k] = v; changed.push(k); }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'qty')) {
    const q = num(b.qty, 0, 100000, 1); if (item.qty !== q) { item.qty = q; changed.push('qty'); }
  }
  // Who it fits: any of Men's / Women's / Children's (several allowed, e.g. a unisex coat).
  if (Object.prototype.hasOwnProperty.call(b, 'fit')) {
    const fit = FITS.filter((f) => (Array.isArray(b.fit) ? b.fit : String(b.fit || '').split(/[;,]/).map((x) => x.trim())).some((x) => String(x).toLowerCase().replace(/[^a-z]/g, '').startsWith(f.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4))));
    if (JSON.stringify(item.fit || []) !== JSON.stringify(fit)) { item.fit = fit; changed.push('fit'); }
  }
  // Characters: which show + character this item belongs to (an item can serve several).
  if (Object.prototype.hasOwnProperty.call(b, 'roles')) {
    const seen = new Set(); const roles = [];
    for (const r of Array.isArray(b.roles) ? b.roles.slice(0, 20) : []) {
      const show = s(r && r.show, 120), character = s(r && r.character, 80);
      if (!character && !show) continue;      // show-only tags are allowed (set pieces, furniture for the whole show)
      const k = (show + '|' + character).toLowerCase(); if (seen.has(k)) continue;
      seen.add(k); roles.push({ show, character });
    }
    if (JSON.stringify(item.roles || []) !== JSON.stringify(roles)) { item.roles = roles; changed.push('characters'); }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'value')) {
    const v = money(b.value); if (item.value !== v) { item.value = v; changed.push('value'); }
  }
  return changed;
}
function itemOut(it) { const o = Object.assign({}, it); o.history = it.history.slice(0, 60); return o; }

// ── Tag reader: the AI reads the garment label in an item's photos and fills the blanks ──
// Runs by itself ~25 s after the last photo lands on an item that still needs details (so the tag
// shot taken right after the garment shot is included), and on demand from "Read tag again".
// Never overwrites anything a person typed: it only fills empty fields, or fields it filled itself
// earlier (item.auto_fields) and nobody has edited since.
const TAG_KEY = process.env.ANTHROPIC_API_KEY || '';
const TAG_MODEL = process.env.TAG_MODEL || 'claude-sonnet-5-5';
const TAG_API = process.env.TAG_API_URL || 'https://api.anthropic.com/v1/messages';
const TAG_DAILY_CAP = Number(process.env.TAG_DAILY_CAP || 400);   // cost guard: ~1-2 cents a read
const TAG_FIELDS = ['name', 'color', 'size', 'fit', 'description', 'tags', 'period', 'condition'];
const tagTimers = new Map();
const tagRunning = new Set();
function tagUsageOk() {
  const day = new Date().toISOString().slice(0, 10);
  store.tag_usage = store.tag_usage && store.tag_usage.day === day ? store.tag_usage : { day, reads: 0, total: (store.tag_usage && store.tag_usage.total) || 0 };
  return store.tag_usage.reads < TAG_DAILY_CAP;
}
function wantsTagRead(item) { return !!TAG_KEY && item.photos.length > 0 && (item.needs_details || !item.size); }
function scheduleTagRead(item) {
  if (!wantsTagRead(item)) return;
  clearTimeout(tagTimers.get(item.code));
  tagTimers.set(item.code, setTimeout(() => { tagTimers.delete(item.code); readTag(item.code, 'Tag reader').catch(() => {}); }, Number(process.env.TAG_DELAY_MS || 25000)));
}
async function photoBytes(pid) {
  try { return fs.readFileSync(path.join(PHOTO_DIR, pid + '.jpg')); } catch (e) { return fetchMirroredPhoto('rinv-' + pid); }
}
const TAG_PROMPT = `You are cataloguing a theatre's costume stock. These photos are all ONE item: usually the garment itself plus a close-up of its label or tag.
The small square sticker with a QR code and a code like COST-0012 is the theatre's own inventory sticker: ignore it.
Report ONLY what you can actually see. Never guess a size, brand or number you cannot read. Return ONLY a JSON object, no other text:
{"has_tag": true if a garment label/tag with readable text is visible, else false,
 "name": short plain name someone would search for, colour + garment type, max 6 words (e.g. "Olive green Marine service coat"),
 "color": main colour,
 "size": exactly as printed on the tag (e.g. "36L", "15 1/2", "M", "12MR"), "" if not readable,
 "fit": array with any of "Men's","Women's","Unisex","Children's" only if the tag says so (e.g. "Trousers, Men's") or it is unmistakable, else [],
 "description": 1-2 sentences with everything readable on the tag: brand, style/model or stock number (NSN), fabric content, care, maker, plus notable features (insignia, chevrons, pockets, damage),
 "tags": comma-separated search words (garment type, uniform type, service branch, colour words),
 "period": era/style only if obvious (e.g. "Modern", "1980s military"), else "",
 "condition": "New", "Good", "Fair", "Poor" or "Needs repair" only if clearly visible, else "",
 "confidence": "high" if size and label text are clearly readable, "medium" if partly, "low" if mostly guessed}`;
async function readTag(code, by, manual) {
  const item = findItem(code);
  if (!item || !TAG_KEY || !item.photos.length) return { ok: false, error: 'No photos to read.' };
  if (tagRunning.has(item.code)) return { ok: false, error: 'Already reading this tag.' };
  if (!tagUsageOk()) return { ok: false, error: 'Daily tag-reading limit reached (' + TAG_DAILY_CAP + '). Try again tomorrow.' };
  tagRunning.add(item.code);
  item.tag_read = { status: 'reading', at: new Date().toISOString() }; broadcast({ t: 'item', item: itemOut(item) });
  try {
    const content = [];
    for (const pid of item.photos.slice(0, 4)) {
      const buf = await photoBytes(pid);
      if (buf) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
    }
    if (!content.length) throw new Error('photos not found');
    content.push({ type: 'text', text: TAG_PROMPT });
    store.tag_usage.reads++; store.tag_usage.total = (store.tag_usage.total || 0) + 1;
    const r = await fetch(TAG_API, { method: 'POST', headers: { 'x-api-key': TAG_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: TAG_MODEL, max_tokens: 900, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error('reader answered ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const j = await r.json();
    const txt = ((j.content || []).find((c) => c.type === 'text') || {}).text || '';
    const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error('no answer');
    const x = JSON.parse(m[0]);
    const live = findItem(code); if (!live) return { ok: false, error: 'Item was removed.' };
    const auto = new Set(live.auto_fields || []);
    const open = (f) => auto.has(f) || (f === 'fit' ? !(live.fit || []).length : f === 'name' ? !!live.needs_details : !String(live[f] || '').trim());
    const b = {};
    if (x.has_tag !== false || manual) {
      TAG_FIELDS.forEach((f) => {
        const v = x[f];
        if (v == null || (Array.isArray(v) ? !v.length : !String(v).trim())) return;
        if (open(f)) b[f] = v;
      });
    }
    if (b.name && !x.has_tag && !live.needs_details) delete b.name;
    if (b.size && x.confidence && x.confidence !== 'high' && (open('notes'))) b.notes = 'Read from the tag photo; tag was hard to read. Double-check the size.';
    const changed = Object.keys(b).length ? applyFields(live, b) : [];
    if (live.needs_details && changed.includes('name') && live.name !== 'Details needed') delete live.needs_details;
    live.auto_fields = [...new Set([...auto].filter((f) => !changed.includes(f)).concat(changed.filter((f) => TAG_FIELDS.includes(f) || f === 'notes')))];
    live.tag_read = { status: x.has_tag ? 'done' : 'no_tag', at: new Date().toISOString(), confidence: x.confidence || '', filled: changed };
    if (changed.length) { live.updated_at = new Date().toISOString(); live.updated_by = by; log(live, by, 'Read tag', changed.join(', ')); }
    save(); broadcast({ t: 'item', item: itemOut(live) });
    return { ok: true, item: itemOut(live), filled: changed, has_tag: !!x.has_tag };
  } catch (e) {
    const live = findItem(code);
    if (live) { live.tag_read = { status: 'error', at: new Date().toISOString(), error: String(e.message || e).slice(0, 160) }; save(); broadcast({ t: 'item', item: itemOut(live) }); }
    console.log('tag read failed', code, e.message);
    return { ok: false, error: 'Could not read the tag: ' + String(e.message || e).slice(0, 120) };
  } finally { tagRunning.delete(code); }
}

// ── Static files ─────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  let data; try { data = fs.readFileSync(file); } catch (e) { return false; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': rel.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache' });
  res.end(data); return true;
}
// Fingerprint of the phone app's code: open pages compare it and refresh themselves after a deploy.
const BUILD = crypto.createHash('sha1').update(['index.html', 'app.js', 'app.css'].map((f) => {
  try { return fs.readFileSync(path.join(PUBLIC_DIR, f)); } catch (e) { return ''; }
}).join('|')).digest('hex').slice(0, 12);
const APP_ROUTES =/^\/(|i\/[^/]+|l\/[^/]+|add|browse|scan|locations|labels|settings|audit\/[^/]+|recent|characters|set|show|upload)$/i;

// ── QR → SVG (server side, for print pages) ──────────────────────────────────
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte'); q.make();
  const n = q.getModuleCount(); const m = 2; // quiet zone in modules (scanners like ≥2 on stickers)
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  const w = n + 2 * m;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + w + '" shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

// Label sizes. w/h in inches. 'sheet' = a letter page of many labels.
const SIZES = {
  '2x1':      { name: '2" × 1" thermal roll', w: 2, h: 1 },
  '2.25x1.25':{ name: '2¼" × 1¼" (Dymo 30334, Rollo)', w: 2.25, h: 1.25 },
  '1.5x1':    { name: '1½" × 1" small thermal', w: 1.5, h: 1 },
  '1x1':      { name: '1" × 1" square', w: 1, h: 1 },
  '2x2':      { name: '2" × 2" square', w: 2, h: 2 },
  '62x29mm':  { name: 'Brother 62 × 29 mm (DK-11209)', w: 62 / 25.4, h: 29 / 25.4 },
  '4x6':      { name: '4" × 6" shipping label (bins/racks)', w: 4, h: 6 },
  'avery5160':{ name: 'Avery 5160 letter sheet (30 per page)', w: 2.625, h: 1, sheet: { cols: 3, rows: 10, top: 0.5, left: 0.1875, gapx: 0.125, gapy: 0 } },
  'avery22806':{ name: 'Avery 22806 letter sheet (12 squares 2")', w: 2, h: 2, sheet: { cols: 3, rows: 4, top: 0.625, left: 0.625, gapx: 0.625, gapy: 0.5 } },
};

function printPage(req, url) {
  const base = baseUrl(req);
  const sizeKey = SIZES[url.searchParams.get('size')] ? url.searchParams.get('size') : '2x1';
  const size = SIZES[sizeKey];
  const showName = url.searchParams.get('names') !== '0';
  const kind = url.searchParams.get('kind') || 'items';
  let codes = (url.searchParams.get('codes') || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  const from = url.searchParams.get('from'), count = num(url.searchParams.get('count'), 1, 1000, 0);
  if (from && count) {
    const [p, n0] = from.toUpperCase().split('-'); const start = Number(n0) || 1;
    codes = []; for (let i = 0; i < count; i++) codes.push(p + '-' + pad(start + i, 4));
  }
  codes = codes.filter((c) => CODE_RE.test(c) || LOC_RE.test(c)).slice(0, 5000);
  const copies = num(url.searchParams.get('copies'), 1, 10, 1);
  const labels = [];
  for (const c of codes) {
    const isLoc = LOC_RE.test(c);
    const thing = isLoc ? findLoc(c) : findItem(c);
    const title = thing ? thing.name : '';
    for (let k = 0; k < copies; k++) labels.push({ code: c, isLoc, title, href: (base + (isLoc ? '/L/' : '/I/') + c).toUpperCase() });
  }
  const W = size.w, H = size.h;
  // Wide labels: QR left, text right. Square/tall labels: QR on top, code under it.
  const stacked = W < H * 1.5;
  const qrIn = stacked ? Math.min(W - 0.12, H * 0.68) : H - 0.12;
  const textW = stacked ? W - 0.12 : W - qrIn - 0.2;           // inches available for the code
  // A bold 6-char code is ~4 em wide → size the font to fit, capped by the label height.
  const font = Math.max(6, Math.min((textW * 72) / 4.2, stacked ? (H - qrIn) * 72 * 0.45 : H * 72 * 0.3, 40));
  const labs = labels.map((l) => {
    const txt = '<div class="t"><div class="c" style="font-size:' + font.toFixed(1) + 'pt">' + esc(l.code) + '</div>' +
      (showName && l.title && !(stacked && H < 1.6) ? '<div class="n" style="font-size:' + Math.max(5.5, font * 0.5).toFixed(1) + 'pt">' + esc(l.title) + '</div>' : '') +
      (stacked && H < 1.6 ? '' : '<div class="o" style="font-size:' + Math.max(5, font * 0.38).toFixed(1) + 'pt">' + esc(l.isLoc ? 'PLACE · ' + store.settings.org : store.settings.org) + '</div>') + '</div>';
    const qr = '<div class="q" style="width:' + qrIn.toFixed(3) + 'in;height:' + qrIn.toFixed(3) + 'in">' + qrSvg(l.href) + '</div>';
    return '<div class="lab' + (stacked ? ' por' : '') + '">' + qr + txt + '</div>';
  });
  if (size.sheet) {
    const sh = size.sheet;
    const pageCss = '@page{size:8.5in 11in;margin:0}' +
      '.sheet{width:8.5in;height:11in;padding:' + sh.top + 'in 0 0 ' + sh.left + 'in;box-sizing:border-box;display:grid;grid-template-columns:repeat(' + sh.cols + ',' + W + 'in);grid-auto-rows:' + H + 'in;column-gap:' + sh.gapx + 'in;row-gap:' + sh.gapy + 'in;align-content:start;page-break-after:always;break-after:page}' +
      '.lab{width:' + W + 'in;height:' + H + 'in}';
    const per = sh.cols * sh.rows;
    let html = ''; for (let i = 0; i < labs.length; i += per) html += '<div class="sheet">' + labs.slice(i, i + per).join('') + '</div>';
    return sendPrint(labels.length, sizeKey, pageCss, html, url);
  }
  const pageCss = '@page{size:' + W.toFixed(3) + 'in ' + H.toFixed(3) + 'in;margin:0}' +
    '.lab{width:' + W.toFixed(3) + 'in;height:' + H.toFixed(3) + 'in;page-break-after:always;break-after:page}';
  return sendPrint(labels.length, sizeKey, pageCss, labs.join(''), url);
}
function sendPrint(n, sizeKey, pageCss, body, url) {
  // Re-post the same selection when the size changes (code lists can be too long for an address).
  const keep = ['codes', 'kind', 'from', 'count', 'names', 'copies'].filter((k) => url.searchParams.get(k))
    .map((k) => '<input type="hidden" name="' + k + '" value="' + esc(url.searchParams.get(k)) + '">').join('');
  const opts = Object.entries(SIZES).map(([k, v]) => '<option value="' + k + '"' + (k === sizeKey ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Print labels</title><style>' +
    'html,body{margin:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}' + pageCss +
    '.lab{box-sizing:border-box;padding:.05in;display:flex;align-items:center;gap:.06in;overflow:hidden}' +
    '.lab.por{flex-direction:column;justify-content:center;text-align:center}' +
    '.q{flex:none}.q svg{width:100%;height:100%;display:block}' +
    '.t{min-width:0;flex:1;line-height:1.1}.c{font-weight:900;letter-spacing:.02em;white-space:nowrap}' +
    '.n{font-weight:700;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-top:.02in}' +
    '.o{color:#333;margin-top:.03in;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.bar{font:16px Arial;padding:12px 16px;background:#f3efe6;border-bottom:1px solid #ccc;display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
    '.bar button,.bar select{font-size:16px;padding:8px 12px}.bar b{margin-right:auto}' +
    '@media print{.bar{display:none}}' +
    '</style></head><body><div class="bar"><b>' + n + ' label' + (n === 1 ? '' : 's') + '</b>' +
    '<form method="post" action="/print" style="display:inline">' + keep + '<label>Size <select name="size" onchange="this.form.submit()">' + opts + '</select></label></form>' +
    '<button onclick="window.print()">Print</button><button onclick="history.length>1?history.back():location.href=\'/labels\'">Back</button></div>' +
    body + '</body></html>';
}

function posterPage(req) {
  const join = baseUrl(req) + '/join?k=' + encodeURIComponent(store.settings.crew_key);
  return '<!doctype html><html><head><meta charset="utf-8"><title>Join the inventory</title><style>@page{size:8.5in 11in;margin:.5in}' +
    'body{font-family:Arial,Helvetica,sans-serif;text-align:center;color:#000;margin:0}h1{font-size:44pt;margin:.2in 0 .1in}' +
    'p{font-size:20pt;margin:.1in 0}.q{width:5.2in;height:5.2in;margin:.25in auto}.q svg{width:100%;height:100%}' +
    'ol{text-align:left;font-size:18pt;max-width:6.5in;margin:.2in auto;line-height:1.5}.k{font-size:16pt;color:#333}' +
    '@media print{button{display:none}}button{font-size:18px;padding:10px 18px;margin:10px}</style></head><body>' +
    '<button onclick="print()">Print this poster</button>' +
    '<h1>Help inventory the Rialto</h1><p>Point your phone camera here to join</p><div class="q">' + qrSvg(join) + '</div>' +
    '<ol><li>Open your phone camera and point it at the code above.</li><li>Tap the link that pops up. Type your name once.</li>' +
    '<li>Scan any sticker on an item to see it, move it, or check it out.</li></ol>' +
    '<p class="k">No app to install · Crew code: <b>' + esc(store.settings.crew_key) + '</b><br>' + esc(join) + '</p></body></html>';
}

function loginPage(msg) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Rialto Inventory</title><link rel="stylesheet" href="/app.css"></head><body class="login"><main class="card narrow">' +
    '<h1>Rialto Inventory</h1><p>Enter the crew code to start. You only do this once on each phone.</p>' +
    (msg ? '<p class="err">' + esc(msg) + '</p>' : '') +
    '<form method="post" action="/login"><label>Crew code<input name="key" autocomplete="off" autocapitalize="characters" required autofocus></label>' +
    '<input type="hidden" name="next" value=""><button class="btn big">Start</button></form>' +
    '<p class="muted">No code? Ask whoever runs the inventory, or scan the crew poster.</p>' +
    '<hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><h2>Department heads</h2>' +
    '<form method="post" action="/login"><input type="hidden" name="mode" value="admin">' +
    '<label>Username<input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' +
    '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<label class="check"><input type="checkbox" onchange="this.form.password.type=this.checked?\'text\':\'password\'"> Show password</label>' +
    '<input type="hidden" name="next" value=""><button class="btn alt big">Sign in</button></form>' +
    '<script>document.querySelectorAll("[name=next]").forEach(function(e){e.value=location.pathname+location.search})</script></main></body></html>';
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  try {
    if (p === '/health') return sendJson(res, 200, { ok: true, items: store.items.length, restored: restoreDone });
    if (method === 'GET' && ['/app.css', '/manifest.webmanifest', '/icon.svg'].includes(p) && serveStatic(res, p.slice(1))) return;
    if (method === 'GET' && p === '/favicon.ico' && serveStatic(res, 'icon.svg')) return;

    // Sign-in
    if (method === 'GET' && p === '/join') {
      const k = s(url.searchParams.get('k'), 80).toUpperCase();
      const jip = clientIp(req);
      if (loginBlocked(jip)) return sendHtml(res, loginPage('Too many tries. Wait 15 minutes.'), 429);
      if (k && (k === store.settings.crew_key.toUpperCase() || k === store.settings.admin_key.toUpperCase())) {
        setKeyCookie(res, k === store.settings.admin_key.toUpperCase() ? store.settings.admin_key : store.settings.crew_key);
        res.writeHead(302, { Location: '/?welcome=1' }); return res.end();
      }
      loginFailed(jip);
      return sendHtml(res, loginPage('That join link is out of date. Ask for the current crew code.'), 401);
    }
    if (method === 'POST' && (p === '/login' || p === '/api/login')) {
      const ip = clientIp(req);
      if (loginBlocked(ip)) return p === '/login' ? sendHtml(res, loginPage('Too many tries. Wait 15 minutes.'), 429) : sendJson(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      let key = '', next = '/', user = '', password = '';
      if (p === '/login') {
        const t = await readText(req, 4096); const f = new URLSearchParams(t);
        key = s(f.get('key'), 80).toUpperCase(); next = s(f.get('next'), 200) || '/';
        user = s(f.get('user'), 40).toLowerCase(); password = String(f.get('password') || '').slice(0, 200);
      } else { const b = await readBody(req); key = s(b.key, 80).toUpperCase(); user = s(b.user, 40).toLowerCase(); password = String(b.password || '').slice(0, 200); }
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      if (user) {
        if (!restoreDone) return p === '/login' ? sendHtml(res, loginPage('Starting up. Try again in a few seconds.'), 503) : sendJson(res, 503, { error: 'Starting up. Try again in a few seconds.', starting: true });
        const a = store.admins.find((x) => x.user === user);
        const okPw = a && hashPw(password, a.salt) === a.hash;
        if (!okPw) {
          loginFailed(ip);
          return p === '/login' ? sendHtml(res, loginPage('Wrong username or password.'), 401) : sendJson(res, 401, { error: 'Wrong username or password.' });
        }
        a.last_login = new Date().toISOString(); save();
        setAdminCookie(res, a);
        if (p === '/login') { res.writeHead(303, { Location: safeNext }); return res.end(); }
        return sendJson(res, 200, { ok: true, role: 'admin', must_change: !!a.must_change });
      }
      const ok = key && (key === store.settings.crew_key.toUpperCase() || key === store.settings.admin_key.toUpperCase());
      if (!ok) {
        loginFailed(ip);
        return p === '/login' ? sendHtml(res, loginPage('That code did not work. Check it and try again.'), 401) : sendJson(res, 401, { error: 'Wrong code.' });
      }
      const real = key === store.settings.admin_key.toUpperCase() ? store.settings.admin_key : store.settings.crew_key;
      setKeyCookie(res, real);
      if (p === '/login') { res.writeHead(303, { Location: next.startsWith('/') && !next.startsWith('//') ? next : '/' }); return res.end(); }
      return sendJson(res, 200, { ok: true, role: real === store.settings.admin_key ? 'admin' : 'crew' });
    }
    if (p === '/logout') { res.setHeader('Set-Cookie', ['rk=; Path=/; Max-Age=0', 'ra=; Path=/; Max-Age=0']); res.writeHead(302, { Location: '/' }); return res.end(); }

    if (!restoreDone && (p.startsWith('/api/') || p.startsWith('/p/')))
      return sendJson(res, 503, { error: 'Starting up. Try again in a few seconds.', starting: true });
    const r = role(req);

    // Pages
    if (method === 'GET' && (APP_ROUTES.test(p))) {
      if (!r) return sendHtml(res, loginPage(''));
      return serveStatic(res, 'index.html') || sendHtml(res, 'missing index', 500);
    }
    if (method === 'GET' && (p === '/app.js' || p.startsWith('/vendor/'))) {
      if (serveStatic(res, p.slice(1))) return;
    }
    if (p === '/print' && (method === 'GET' || method === 'POST')) {
      if (!r) return sendHtml(res, loginPage(''));
      if (method === 'POST') { // long code lists arrive in a form body, not the address
        const f = new URLSearchParams(await readText(req, 512 * 1024));
        for (const [k, v] of f) url.searchParams.set(k, v);
      }
      return sendHtml(res, printPage(req, url));
    }
    if (method === 'GET' && p === '/poster') { if (r !== 'admin') return sendHtml(res, loginPage('The poster needs the admin code.')); return sendHtml(res, posterPage(req)); }

    // Photos
    const pm = p.match(/^\/p\/([a-f0-9]{16,40}(?:_t)?)\.jpg$/);
    if (method === 'GET' && pm) {
      if (!r) { res.writeHead(401); return res.end(); }
      const file = path.join(PHOTO_DIR, pm[1] + '.jpg');
      let buf = null; try { buf = fs.readFileSync(file); } catch (e) {
        buf = await fetchMirroredPhoto('rinv-' + pm[1]);
        if (buf) { try { fs.writeFileSync(file, buf); } catch (e2) { /* cache best-effort */ } }
      }
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(buf);
    }

    if (!p.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    if (!r) return sendJson(res, 401, { error: 'Sign in first.' });
    // Writes must carry our header: a cross-site form can't add one, so this blocks CSRF.
    if (method !== 'GET' && req.headers['x-rialto'] !== '1') return sendJson(res, 403, { error: 'Bad request origin.' });
    const by = who(req);
    const isAdmin = r === 'admin';

    if (method === 'GET' && p === '/api/data') {
      const st = store.settings;
      return sendJson(res, 200, {
        role: r, base: baseUrl(req), build: BUILD, tag_reader: !!TAG_KEY,
        me: account(req) ? adminOut(account(req)) : (isAdmin ? { name: 'Master admin code', manager: true, master: true } : null),
        admins: isManager(req) ? store.admins.map(adminOut) : [],
        settings: { title: st.title, org: st.org, departments: st.departments, next: st.next, next_loc: st.next_loc,
          categories: st.departments.map((d) => d.name),
          crew_key: isAdmin ? st.crew_key : undefined, admin_key: isAdmin ? st.admin_key : undefined },
        statuses: STATUSES, conditions: CONDITIONS, sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v.name])),
        items: store.items.map(itemOut), locations: store.locations, shows: store.shows,
        removed: isAdmin ? store.removed.map((i) => ({ code: i.code, name: i.name, removed_at: i.removed_at, removed_by: i.removed_by })) : [],
      });
    }

    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 4000\n\n'); clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (method === 'GET' && p === '/api/export.csv') {
      const cols = ['code', 'name', 'category', 'characters', 'qty', 'status', 'condition', 'location', 'location_name', 'sublocation', 'color', 'size', 'fit', 'period', 'tags', 'value', 'alterations', 'holder', 'show', 'due', 'description', 'notes', 'photos', 'last_seen', 'updated_at', 'updated_by'];
      const q = (v) => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const base = baseUrl(req);
      const rows = store.items.map((i) => cols.map((c) => c === 'location_name' ? ((findLoc(i.location) || {}).name || '') :
        c === 'characters' ? (i.roles || []).map((r) => (r.show ? r.show + ': ' : '') + r.character).join('; ') :
        c === 'fit' ? (i.fit || []).join('; ') :
        c === 'alterations' ? (i.alterations || []).map((a) => a.kind + (a.status === 'Undone' ? ' (undone)' : '') + ': ' + a.what + (a.show ? ' [' + a.show + ']' : '')).join('; ') :
        c === 'photos' ? i.photos.map((x) => base + '/p/' + x + '.jpg').join(' ') : i[c]).map(q).join(','));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rialto-inventory-' + new Date().toISOString().slice(0, 10) + '.csv"' });
      return res.end('﻿' + cols.join(',') + '\n' + rows.join('\n'));
    }

    // Add an item
    if (method === 'POST' && p === '/api/items') {
      const b = await readBody(req);
      if (b.needs_details && !s(b.name, 120)) b.name = 'Details needed';
      if (!s(b.name, 120)) return sendJson(res, 400, { error: 'Give the item a name.' });
      if (!b.needs_details && bookNeedsShow(b.code ? prefixOf(normCode(b.code) || '') : (deptByName(b.category) || {}).p, b.roles))
        return sendJson(res, 400, { error: 'Prompt books and scripts belong to a show: pick the show.' });
      let code = b.code ? normCode(b.code) : '';
      let dept;
      if (b.code) {
        if (!code || !CODE_RE.test(code)) return sendJson(res, 400, { error: 'That sticker code does not look right.' });
        if (codeTaken(code)) return sendJson(res, 409, { error: code + ' is already on another item.', code });
        dept = deptByPrefix(prefixOf(code));
        if (!dept) return sendJson(res, 400, { error: prefixOf(code) + ' is not a department code.' });
        bumpPastCode(code);
      } else {
        dept = deptByName(b.category);
        if (!dept) return sendJson(res, 400, { error: 'Pick a department.' });
        code = nextCode(dept.p);
      }
      const now = new Date().toISOString();
      const item = { code, name: '', category: dept.name, qty: 1, status: 'Available', condition: '', location: '', sublocation: '',
        color: '', size: '', period: '', tags: '', value: null, description: '', notes: '', holder: '', show: '', due: '',
        photos: [], history: [], aliases: [], created_at: now, created_by: by, updated_at: now, updated_by: by, last_seen: now };
      applyFields(item, b);
      if (b.needs_details) item.needs_details = true;
      log(item, by, 'Added', item.location ? 'at ' + ((findLoc(item.location) || {}).name || item.location) : '');
      store.items.push(item); if (syncRoster(item.roles)) broadcast({ t: 'shows', shows: store.shows }); save();
      broadcast({ t: 'item', item: itemOut(item) });
      return sendJson(res, 200, { ok: true, item: itemOut(item) });
    }

    const im = p.match(/^\/api\/items\/([A-Z0-9-]+)(\/.*)?$/i);
    if (im) {
      const code = normCode(im[1]) || im[1].toUpperCase(); const sub = im[2] || '';
      const item = findItem(code);
      if (!item) return sendJson(res, 404, { error: 'No item ' + code + ' yet.' });

      if (method === 'PATCH' && !sub) {
        const b = await readBody(req);
        const prevLoc = item.location;
        if (!item.needs_details && Object.prototype.hasOwnProperty.call(b, 'roles') && bookNeedsShow(prefixOf(item.code), b.roles))
          return sendJson(res, 400, { error: 'Prompt books and scripts belong to a show: pick the show.' });
        const changed = applyFields(item, b);
        if (item.auto_fields) item.auto_fields = item.auto_fields.filter((f) => !Object.prototype.hasOwnProperty.call(b, f));
        if (item.needs_details && changed.includes('name') && item.name !== 'Details needed') { delete item.needs_details; changed.push('details added'); }
        if (item.name === 'Details needed') item.needs_details = true;
        if (changed.length) {
          item.updated_at = new Date().toISOString(); item.updated_by = by;
          const rest = changed.filter((c) => c !== 'location').join(', ');
          const mv = changed.includes('location') ? 'moved ' + (prevLoc ? 'from ' + ((findLoc(prevLoc) || {}).name || prevLoc) + ' ' : '') + 'to ' + ((findLoc(item.location) || {}).name || 'no location') : '';
          log(item, by, 'Edited', [mv, rest].filter(Boolean).join('; '));
          if (syncRoster(item.roles)) broadcast({ t: 'shows', shows: store.shows });
          save(); broadcast({ t: 'item', item: itemOut(item) });
        }
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }

      if (method === 'DELETE' && !sub) {
        if (!isAdmin) return sendJson(res, 403, { error: 'Removing items needs the admin code. Mark it Retired instead.' });
        store.items = store.items.filter((i) => i !== item);
        item.removed_at = new Date().toISOString(); item.removed_by = by;
        store.removed.unshift(item); if (store.removed.length > 500) store.removed.length = 500;
        save(); broadcast({ t: 'del', code });
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'POST' && sub === '/action') {
        const b = await readBody(req);
        const a = s(b.action, 20); const now = new Date().toISOString();
        if (a === 'checkout') {
          if (item.status === 'Checked out' || item.status === 'In a show')
            return sendJson(res, 409, { error: 'Already with ' + (item.holder || 'someone') + '. Check it in first.', item: itemOut(item) });
          const holder = s(b.holder, 80); if (!holder) return sendJson(res, 400, { error: 'Who is taking it?' });
          item.holder = holder; item.show = s(b.show, 120); item.due = s(b.due, 20);
          item.status = b.in_show ? 'In a show' : 'Checked out';
          log(item, by, item.status === 'In a show' ? 'Pulled for show' : 'Checked out', holder + (item.show ? ' · ' + item.show : '') + (item.due ? ' · due ' + item.due : ''));
        } else if (a === 'checkin') {
          const was = item.holder;
          item.holder = ''; item.show = ''; item.due = ''; item.status = 'Available'; item.last_seen = now;
          if (b.location && findLoc(s(b.location, 12))) item.location = s(b.location, 12);
          log(item, by, 'Returned', (was ? 'from ' + was : '') + (item.location ? ' to ' + ((findLoc(item.location) || {}).name || item.location) : ''));
        } else if (a === 'move' || a === 'seen') {
          const loc = s(b.location, 12);
          if (loc && !findLoc(loc)) return sendJson(res, 400, { error: 'Unknown location.' });
          const moved = loc && loc !== item.location;
          if (loc) item.location = loc;
          if (Object.prototype.hasOwnProperty.call(b, 'sublocation')) item.sublocation = s(b.sublocation, 80);
          item.last_seen = now;
          if (item.status === 'Missing') item.status = 'Available';
          log(item, by, moved ? 'Moved' : 'Seen', loc ? ((moved ? 'to ' : 'at ') + findLoc(loc).name) : '');
        } else if (a === 'missing') {
          item.status = 'Missing'; log(item, by, 'Marked missing', s(b.note, 200));
        } else return sendJson(res, 400, { error: 'Unknown action.' });
        item.updated_at = now; item.updated_by = by;
        save(); broadcast({ t: 'item', item: itemOut(item) });
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }

      if (method === 'POST' && sub === '/photos') {
        if (item.photos.length >= 12) return sendJson(res, 400, { error: 'That item already has 12 photos. Remove one first.' });
        const b = await readBody(req, 6 * 1024 * 1024);
        const dec = (v) => { const m = String(v || '').match(/^data:image\/jpeg;base64,(.+)$/); return m ? Buffer.from(m[1], 'base64') : null; };
        const full = dec(b.full), thumb = dec(b.thumb);
        if (!full || full.length < 100 || full[0] !== 0xff || full[1] !== 0xd8) return sendJson(res, 400, { error: 'That photo could not be read.' });
        const pid = crypto.randomBytes(10).toString('hex');
        fs.writeFileSync(path.join(PHOTO_DIR, pid + '.jpg'), full);
        const th = thumb && thumb[0] === 0xff ? thumb : full;
        fs.writeFileSync(path.join(PHOTO_DIR, pid + '_t.jpg'), th);
        mirrorPhoto('rinv-' + pid, full); mirrorPhoto('rinv-' + pid + '_t', th);
        item.photos.push(pid); item.updated_at = new Date().toISOString(); item.updated_by = by;
        log(item, by, 'Added photo', ''); save(); broadcast({ t: 'item', item: itemOut(item) });
        scheduleTagRead(item);
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }
      const dm = sub.match(/^\/photos\/([a-f0-9]{16,40})$/);
      if (method === 'DELETE' && dm) {
        item.photos = item.photos.filter((x) => x !== dm[1]);
        log(item, by, 'Removed photo', ''); save(); broadcast({ t: 'item', item: itemOut(item) });
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }
      // Alterations: what was changed on the item, Permanent or Temporary (temporary ones must be undone).
      if (method === 'POST' && sub === '/alterations') {
        const b = await readBody(req);
        const what = s(b.what, 300); if (!what) return sendJson(res, 400, { error: 'Say what was altered.' });
        const kind = b.kind === 'Temporary' ? 'Temporary' : b.kind === 'Permanent' ? 'Permanent' : '';
        if (!kind) return sendJson(res, 400, { error: 'Pick Permanent or Temporary.' });
        const a = { id: crypto.randomBytes(5).toString('hex'), what, kind, show: s(b.show, 120), character: s(b.character, 80), notes: s(b.notes, 600),
          undo_by: kind === 'Temporary' ? s(b.undo_by, 20) : '', at: new Date().toISOString(), by, status: 'Active' };
        item.alterations = [a].concat(item.alterations || []).slice(0, 100);
        item.updated_at = a.at; item.updated_by = by;
        log(item, by, kind + ' alteration', what + (a.show ? ' (' + a.show + ')' : ''));
        if (a.show && rosterShow(a.show, true)) broadcast({ t: 'shows', shows: store.shows });
        save(); broadcast({ t: 'item', item: itemOut(item) });
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }
      const alm = sub.match(/^\/alterations\/([a-f0-9]{10})$/);
      if (method === 'POST' && alm) {
        const a = (item.alterations || []).find((x) => x.id === alm[1]);
        if (!a) return sendJson(res, 404, { error: 'No such alteration.' });
        const b = await readBody(req);
        if (b.action === 'undo') {
          if (a.kind !== 'Temporary' || a.status !== 'Active') return sendJson(res, 400, { error: 'Only an active temporary alteration can be marked undone.' });
          a.status = 'Undone'; a.undone_at = new Date().toISOString(); a.undone_by = by;
          log(item, by, 'Alteration undone', a.what);
        } else if (b.action === 'permanent') {
          if (a.kind !== 'Temporary' || a.status !== 'Active') return sendJson(res, 400, { error: 'Only an active temporary alteration can be kept.' });
          a.kind = 'Permanent'; a.undo_by = ''; log(item, by, 'Alteration kept (now permanent)', a.what);
        } else if (b.action === 'delete') {
          if (!isAdmin) return sendJson(res, 403, { error: 'Only an admin can delete an alteration record.' });
          item.alterations = item.alterations.filter((x) => x !== a); log(item, by, 'Alteration record deleted', a.what);
        } else return sendJson(res, 400, { error: 'Unknown action.' });
        item.updated_at = new Date().toISOString(); item.updated_by = by;
        save(); broadcast({ t: 'item', item: itemOut(item) });
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }
      if (method === 'POST' && sub === '/readtag') {
        if (!TAG_KEY) return sendJson(res, 400, { error: 'The tag reader is not switched on.' });
        clearTimeout(tagTimers.get(item.code)); tagTimers.delete(item.code);
        const out = await readTag(item.code, by, true);
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      if (method === 'POST' && sub === '/copies') {
        // Copy this item's details onto other stickers.
        //  codes: [...]  stickers already printed and stuck on: a photo-only "Details needed" item gets the
        //                details (keeping its own photos); an unused sticker becomes a new item. Nothing to print.
        //  count: N      N brand-new items on the next sticker numbers (they need stickers printed).
        const b = await readBody(req);
        if (item.needs_details || item.name === 'Details needed')
          return sendJson(res, 400, { error: 'Fill in the details of ' + item.code + ' first, then copy them to the others.' });
        const now = new Date().toISOString(); const made = [];
        const COPY = ['name', 'category', 'qty', 'location', 'sublocation', 'color', 'size', 'fit', 'period', 'condition', 'tags', 'description', 'notes', 'value', 'roles'];
        const clone = (v) => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
        if (Array.isArray(b.codes)) {
          const skipped = [];
          const codes = [...new Set(b.codes.slice(0, 100).map((c) => normCode(c)).filter(Boolean))];
          for (const code of codes) {
            if (code === item.code) continue;
            const dept = CODE_RE.test(code) && deptByPrefix(prefixOf(code));
            if (!dept) { skipped.push({ code, why: 'not a sticker code' }); continue; }
            if (dept.p !== prefixOf(item.code)) { skipped.push({ code, why: 'is a ' + dept.p + ' sticker, not ' + prefixOf(item.code) }); continue; }
            const ex = findItem(code);
            if (ex && !ex.needs_details) { skipped.push({ code, why: 'already has details: ' + ex.name }); continue; }
            if (!ex && codeTaken(code)) { skipped.push({ code, why: 'was removed from inventory' }); continue; }
            const c = ex || { code, aliases: [], status: 'Available', holder: '', show: '', due: '', photos: [], history: [],
              created_at: now, created_by: by, last_seen: now };
            COPY.forEach((f) => { c[f] = item[f] == null ? '' : clone(item[f]); });
            c.category = dept.name; delete c.needs_details; c.updated_at = now; c.updated_by = by;
            // One generic photo for identical items (ten green web belts): share it with any that have none.
            if (b.photo && !c.photos.length && item.photos.length) c.photos = item.photos.slice(0, 4);
            log(c, by, ex ? 'Details added' : 'Added', 'copied from ' + item.code);
            if (!ex) { bumpPastCode(code); store.items.push(c); }
            made.push(c);
          }
          if (!made.length) return sendJson(res, 400, { error: skipped.length ? skipped.map((x) => x.code + ' ' + x.why).join('; ') : 'Type at least one sticker number.' });
          syncRoster(item.roles); save(); made.forEach((c) => broadcast({ t: 'item', item: itemOut(c) }));
          return sendJson(res, 200, { ok: true, items: made.map(itemOut), skipped, existing: true });
        }
        const n = num(b.count, 1, 100, 0);
        if (!n) return sendJson(res, 400, { error: 'How many copies?' });
        for (let k = 0; k < n; k++) {
          const c = { code: nextCode(prefixOf(item.code)), aliases: [], status: 'Available', holder: '', show: '', due: '', photos: b.photo ? item.photos.slice(0, 1) : [],
            history: [], created_at: now, created_by: by, updated_at: now, updated_by: by, last_seen: '' };
          COPY.forEach((f) => { c[f] = item[f] == null ? '' : clone(item[f]); });
          log(c, by, 'Added', 'copied from ' + item.code);
          store.items.push(c); made.push(c);
        }
        save(); made.forEach((c) => broadcast({ t: 'item', item: itemOut(c) }));
        return sendJson(res, 200, { ok: true, items: made.map(itemOut) });
      }
      if (method === 'POST' && sub === '/recode') {
        const b = await readBody(req); const d = deptByName(b.department);
        if (!d) return sendJson(res, 400, { error: 'Pick a department.' });
        if (d.p === prefixOf(item.code)) return sendJson(res, 400, { error: 'It is already in ' + d.name + '.' });
        const old = item.code; let nc = b.code ? normCode(b.code) : '';
        if (nc) { if (prefixOf(nc) !== d.p) return sendJson(res, 400, { error: 'That sticker is not a ' + d.p + ' sticker.' });
          if (codeTaken(nc)) return sendJson(res, 409, { error: nc + ' is already used.' }); bumpPastCode(nc); }
        else nc = nextCode(d.p);
        item.aliases = (item.aliases || []).concat(old); item.code = nc; item.category = d.name;
        item.updated_at = new Date().toISOString(); item.updated_by = by;
        log(item, by, 'New sticker', old + ' → ' + nc + ' (' + d.name + ')');
        save(); broadcast({ t: 'reload' });
        return sendJson(res, 200, { ok: true, item: itemOut(item), old });
      }
      if (method === 'POST' && sub === '/cover') {
        const b = await readBody(req); const pid = s(b.pid, 40);
        if (item.photos.includes(pid)) { item.photos = [pid].concat(item.photos.filter((x) => x !== pid)); save(); broadcast({ t: 'item', item: itemOut(item) }); }
        return sendJson(res, 200, { ok: true, item: itemOut(item) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    // ── Shows roster (add a show, add its characters) ──
    if (method === 'POST' && p === '/api/shows') {
      const b = await readBody(req); const name = s(b.name, 120); const character = s(b.character, 80);
      if (!name) return sendJson(res, 400, { error: 'Type the name of the show.' });
      const sh = rosterShow(name, true);
      if (character && !sh.characters.some((c) => c.toLowerCase() === character.toLowerCase())) sh.characters.push(character);
      sh.characters.sort((a, c) => a.localeCompare(c));
      save(); broadcast({ t: 'shows', shows: store.shows });
      return sendJson(res, 200, { ok: true, show: sh, shows: store.shows });
    }
    if (method === 'POST' && p === '/api/shows/remove') {
      if (!isAdmin) return sendJson(res, 403, { error: 'Removing shows or characters needs an admin.' });
      const b = await readBody(req); const sh = rosterShow(s(b.name, 120), false);
      if (!sh) return sendJson(res, 404, { error: 'No such show.' });
      const character = s(b.character, 80);
      const used = store.items.some((i) => (i.roles || []).some((r) => r.show.toLowerCase() === sh.name.toLowerCase() && (!character || r.character.toLowerCase() === character.toLowerCase())));
      if (used) return sendJson(res, 409, { error: 'Items are still tagged with it. Remove the tag from those items first.' });
      if (character) sh.characters = sh.characters.filter((c) => c.toLowerCase() !== character.toLowerCase());
      else store.shows = store.shows.filter((x) => x !== sh);
      save(); broadcast({ t: 'shows', shows: store.shows });
      return sendJson(res, 200, { ok: true, shows: store.shows });
    }

    // Locations
    if (method === 'POST' && p === '/api/locations') {
      const b = await readBody(req);
      const name = s(b.name, 80); if (!name) return sendJson(res, 400, { error: 'Name the location (e.g. "Costume loft – rack 3").' });
      if (store.locations.find((l) => l.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, { error: 'There is already a location called ' + name + '.' });
      let n = store.settings.next_loc; while (findLoc(LOC_PREFIX + '-' + pad(n, 4))) n++;
      store.settings.next_loc = n + 1;
      const loc = { code: LOC_PREFIX + '-' + pad(n, 4), name, area: s(b.area, 80), notes: s(b.notes, 400), created_at: new Date().toISOString(), created_by: by };
      store.locations.push(loc); save(); broadcast({ t: 'loc', loc });
      return sendJson(res, 200, { ok: true, loc });
    }
    const lm = p.match(/^\/api\/locations\/((?:LOC|L)-\d+)$/i);
    if (lm) {
      const loc = findLoc(lm[1].toUpperCase()); if (!loc) return sendJson(res, 404, { error: 'No such location.' });
      if (method === 'PATCH') {
        const b = await readBody(req);
        if (b.name != null && s(b.name, 80)) loc.name = s(b.name, 80);
        if (b.area != null) loc.area = s(b.area, 80);
        if (b.notes != null) loc.notes = s(b.notes, 400);
        save(); broadcast({ t: 'loc', loc }); return sendJson(res, 200, { ok: true, loc });
      }
      if (method === 'DELETE') {
        if (!isAdmin) return sendJson(res, 403, { error: 'Needs the admin code.' });
        if (store.items.some((i) => i.location === loc.code)) return sendJson(res, 409, { error: 'Move the items out of ' + loc.name + ' first.' });
        store.locations = store.locations.filter((l) => l !== loc); save(); broadcast({ t: 'reload' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // Reserve a run of blank label codes for pre-printing
    if (method === 'POST' && p === '/api/reserve') {
      const b = await readBody(req); const count = num(b.count, 1, 1000, 30);
      const d = deptByName(b.department); if (!d) return sendJson(res, 400, { error: 'Pick a department.' });
      let start = store.settings.next[d.p] || 1; while (codeTaken(d.p + '-' + pad(start, 4))) start++;
      store.settings.next[d.p] = start + count; save(); broadcast({ t: 'settings' });
      const codes = []; for (let i = 0; i < count; i++) codes.push(d.p + '-' + pad(start + i, 4));
      return sendJson(res, 200, { ok: true, from: codes[0], count, codes });
    }

    // ── My password (any department-head account) ──
    if (method === 'POST' && p === '/api/account/password') {
      const a = account(req); if (!a) return sendJson(res, 403, { error: 'Sign in with your own username to change a password.' });
      const b = await readBody(req); const pw = String(b.password || '');
      if (hashPw(String(b.current || ''), a.salt) !== a.hash) { loginFailed(clientIp(req)); return sendJson(res, 400, { error: 'Your current password is not right.' }); }
      if (pw.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
      if (pw.toLowerCase().includes(a.user)) return sendJson(res, 400, { error: 'Do not put your username in your password.' });
      if (hashPw(pw, a.salt) === a.hash) return sendJson(res, 400, { error: 'Pick a password different from the old one.' });
      a.salt = crypto.randomBytes(16).toString('hex'); a.hash = hashPw(pw, a.salt); a.ver = (a.ver || 0) + 1; a.must_change = false;
      save(); setAdminCookie(res, a);  // other devices signed in as this person are signed out
      return sendJson(res, 200, { ok: true });
    }

    // ── Manage admin accounts (owner / manager only) ──
    if (p === '/api/admins' || p.startsWith('/api/admins/')) {
      if (!isManager(req)) return sendJson(res, 403, { error: 'Only the inventory owner can manage admin accounts.' });
      if (method === 'POST' && p === '/api/admins') {
        const b = await readBody(req);
        const name = s(b.name, 60); const user = s(b.user, 30).toLowerCase();
        if (!name) return sendJson(res, 400, { error: 'Give their name or role.' });
        if (!/^[a-z0-9._-]{3,30}$/.test(user)) return sendJson(res, 400, { error: 'Username: 3–30 letters, numbers, dots or dashes, no spaces.' });
        if (store.admins.some((x) => x.user === user)) return sendJson(res, 409, { error: 'That username is taken.' });
        const temp = tempPassword(); const salt = crypto.randomBytes(16).toString('hex');
        const a = { id: crypto.randomBytes(8).toString('hex'), name, user, salt, hash: hashPw(temp, salt), ver: 1, manager: !!b.manager, must_change: true, created_at: new Date().toISOString(), created_by: by };
        store.admins.push(a); save();
        return sendJson(res, 200, { ok: true, admin: adminOut(a), temp_password: temp });
      }
      const am = p.match(/^\/api\/admins\/([a-f0-9]{16})(\/reset)?$/);
      const a = am && store.admins.find((x) => x.id === am[1]);
      if (!a) return sendJson(res, 404, { error: 'No such account.' });
      if (method === 'POST' && am[2]) {
        const temp = tempPassword(); a.salt = crypto.randomBytes(16).toString('hex'); a.hash = hashPw(temp, a.salt);
        a.ver = (a.ver || 0) + 1; a.must_change = true; save();
        return sendJson(res, 200, { ok: true, admin: adminOut(a), temp_password: temp });
      }
      if (method === 'DELETE' && !am[2]) {
        const me = account(req);
        if (me && me.id === a.id) return sendJson(res, 400, { error: 'You cannot remove your own account.' });
        if (a.manager && store.admins.filter((x) => x.manager).length === 1) return sendJson(res, 400, { error: 'Keep at least one owner account.' });
        store.admins = store.admins.filter((x) => x !== a); save();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'Not allowed.' });
    }

    // ── Admin ──
    if (!isAdmin && (p === '/api/restore' || p === '/api/settings' || p === '/api/import' || p === '/api/forget'))
      return sendJson(res, 403, { error: 'That needs the admin code.' });

    if (method === 'POST' && p === '/api/restore') {
      const b = await readBody(req); const code = s(b.code, 16).toUpperCase();
      const it = store.removed.find((i) => i.code === code);
      if (!it) return sendJson(res, 404, { error: 'Not in the removed list.' });
      if (findItem(code)) return sendJson(res, 409, { error: code + ' is in use again.' });
      store.removed = store.removed.filter((i) => i !== it); delete it.removed_at; delete it.removed_by;
      log(it, by, 'Restored', ''); store.items.push(it); save(); broadcast({ t: 'item', item: itemOut(it) });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/settings') {
      const b = await readBody(req); const st = store.settings;
      if (b.title != null && s(b.title, 80)) st.title = s(b.title, 80);
      if (b.org != null && s(b.org, 80)) st.org = s(b.org, 80);
      // Restart numbering (only ever moves to a number no item or reserved sticker could clash with
      // when the inventory is empty; otherwise it can only move forward).
      if (b.reset_numbers && !store.items.length && !store.removed.length) st.next = {};
      if (b.next_loc != null) { const n = num(b.next_loc, 1, 99999, st.next_loc); if (!store.locations.length || n > st.next_loc) st.next_loc = n; }
      if (Array.isArray(b.departments)) {
        // A department in use keeps its prefix; names, rooms and colours can change; new ones can be added.
        const out = []; const seen = new Set();
        for (const x of b.departments.slice(0, 40)) {
          const pfx = s(x.p, 4).toUpperCase(); const name = s(x.name, 60);
          if (!/^[A-Z]{2,4}$/.test(pfx) || pfx === LOC_PREFIX || !name || seen.has(pfx)) continue;
          const color = /^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : '#616161';
          seen.add(pfx); out.push({ p: pfx, name, room: s(x.room, 60), color });
        }
        const used = new Set(store.items.map((i) => prefixOf(i.code)));
        const missing = [...used].filter((u) => !seen.has(u) && store.settings.departments.some((d) => d.p === u));
        if (missing.length) return sendJson(res, 400, { error: 'Items still use ' + missing.join(', ') + '. Keep those departments.' });
        if (!out.length) return sendJson(res, 400, { error: 'Keep at least one department.' });
        for (const i of store.items) { const d = out.find((o) => o.p === prefixOf(i.code)); if (d) i.category = d.name; }
        st.departments = out;
      }
      if ((b.crew_key != null || b.admin_key != null) && !isManager(req)) return sendJson(res, 403, { error: 'Only the inventory owner can change the crew or master codes.' });
      if (b.crew_key != null) { const k = s(b.crew_key, 40).toUpperCase(); if (k.length < 6) return sendJson(res, 400, { error: 'Crew code: at least 6 characters.' }); st.crew_key = k; st.crew_key_rotated = true; }
      if (b.admin_key != null) { const k = s(b.admin_key, 40).toUpperCase(); if (k.length < 8) return sendJson(res, 400, { error: 'Admin code: at least 8 characters.' }); st.admin_key = k; st.admin_key_rotated = true; setKeyCookie(res, k); }
      if (st.crew_key === st.admin_key) return sendJson(res, 400, { error: 'Crew and admin codes must differ.' });
      save(); broadcast({ t: 'settings' }); return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/forget') { store.removed = []; save(); return sendJson(res, 200, { ok: true }); }
    if (method === 'POST' && p === '/api/import') {
      // rows: [{name, category, qty, location (name), color, size, …}] parsed client-side from CSV
      const b = await readBody(req, 4 * 1024 * 1024);
      if (!Array.isArray(b.rows)) return sendJson(res, 400, { error: 'Nothing to import.' });
      let added = 0, locsMade = 0, skipped = 0; const now = new Date().toISOString();
      for (const row of b.rows.slice(0, 5000)) {
        const name = s(row.name, 120); if (!name) continue;
        let locCode = '';
        const ln = s(row.location, 80);
        if (ln) {
          let loc = store.locations.find((l) => l.name.toLowerCase() === ln.toLowerCase() || l.code === ln.toUpperCase());
          if (!loc) { let n = store.settings.next_loc; while (findLoc(LOC_PREFIX + '-' + pad(n, 4))) n++; store.settings.next_loc = n + 1;
            loc = { code: LOC_PREFIX + '-' + pad(n, 4), name: ln, area: '', notes: '', created_at: now, created_by: by }; store.locations.push(loc); locsMade++; }
          locCode = loc.code;
        }
        let code = normCode(row.code);
        const dept = (code && deptByPrefix(prefixOf(code))) || deptByName(row.category) || deptByName(row.department);
        if (!dept) { skipped++; continue; }
        if (!code || prefixOf(code) !== dept.p || codeTaken(code)) code = nextCode(dept.p); else bumpPastCode(code);
        const item = { code, name, category: dept.name, aliases: [], qty: 1, status: 'Available', condition: '', location: '', sublocation: '', color: '', size: '', period: '', tags: '',
          value: null, description: '', notes: '', holder: '', show: '', due: '', photos: [], history: [], created_at: now, created_by: by, updated_at: now, updated_by: by, last_seen: '' };
        applyFields(item, Object.assign({}, row, { location: locCode }));
        log(item, by, 'Imported', ''); store.items.push(item); added++;
      }
      save(); broadcast({ t: 'reload' });
      return sendJson(res, 200, { ok: true, added, locations: locsMade, skipped });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.message === 'too big') return sendJson(res, 413, { error: 'That was too large.' });
    console.error(e);
    sendJson(res, e.status || 500, { error: 'Something went wrong. Try again.' });
  }
});

process.on('SIGTERM', () => {
  Promise.resolve(pushBackup(true)).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Rialto Inventory on http://localhost:' + PORT);
    console.log('  crew code : ' + store.settings.crew_key);
    console.log('  admin code: ' + store.settings.admin_key);
    restoreFromBackup();
  });
}
module.exports = { server, _store: () => store };
