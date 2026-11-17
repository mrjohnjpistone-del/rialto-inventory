// End-to-end test: boots a local audition-signin (the mirror) + this app, exercises
// every route, then wipes this app's disk and restarts to prove data AND photos
// come back from the mirror. Run: node test.js  (needs ../audition-signin)
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const AUD = path.join(__dirname, '..', 'audition-signin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rinv-'));
const AUD_PORT = 3911, INV_PORT = 3912, BLOB = 'test-blob-key-123';
const INV = 'http://localhost:' + INV_PORT;
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('  FAIL: ' + m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmdDir, env) {
  const p = spawn(process.execPath, ['server.js'], { cwd: cmdDir, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.stdout.on('data', (d) => p.out += d); p.stderr.on('data', (d) => p.out += d);
  return p;
}
async function up(url) { for (let i = 0; i < 50; i++) { try { const r = await fetch(url); if (r.ok) return; } catch (e) { /* not yet */ } await wait(150); } throw new Error('no boot ' + url); }
const invEnv = (dir) => ({ PORT: INV_PORT, DATA_DIR: dir, CREW_KEY: 'CREW-TEST', ADMIN_KEY: 'ADMIN-TESTKEY',
  BACKUP_URL: 'http://localhost:' + AUD_PORT + '/api/blob/rialto-inventory', BACKUP_FILES_URL: 'http://localhost:' + AUD_PORT + '/api/file', BACKUP_KEY: BLOB });
let cookie = '';
async function call(method, p, body, extra) {
  const h = Object.assign({ 'x-rialto': '1', 'x-user': 'Tester', cookie }, extra || {});
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(INV + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* html */ }
  return { s: r.status, j, t, h: r.headers };
}
// tiny valid JPEG (1x1) as data URL
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

(async () => {
  const audDir = path.join(tmp, 'aud'), invDir = path.join(tmp, 'inv');
  const aud = start(AUD, { PORT: AUD_PORT, DATA_DIR: audDir, BLOB_KEY: BLOB, STAFF_KEY: 'x', WARM_URLS: '' });
  await up('http://localhost:' + AUD_PORT + '/health');
  let inv = start(__dirname, invEnv(invDir));
  await up(INV + '/health');
  try {
    // auth
    let r = await call('GET', '/api/data'); ok(r.s === 401, 'data needs login');
    r = await call('GET', '/'); ok(r.s === 200 && r.t.includes('Crew code'), 'root shows login page');
    r = await call('POST', '/api/login', { key: 'wrong' }); ok(r.s === 401, 'wrong code rejected');
    r = await call('POST', '/api/login', { key: 'crew-test' }); ok(r.s === 200 && r.j.role === 'crew', 'crew login (case-insensitive)');
    cookie = (r.h.get('set-cookie') || '').split(';')[0];
    r = await call('GET', '/join?k=CREW-TEST'); ok(r.s === 302 && /rk=/.test(r.h.get('set-cookie') || ''), 'join link sets cookie');
    r = await call('GET', '/'); ok(r.s === 200 && r.t.includes('app.js'), 'app loads after login');
    r = await call('POST', '/api/items', { name: 'x' }, { 'x-rialto': '' }); ok(r.s === 403, 'write without x-rialto blocked (CSRF)');

    // locations
    r = await call('POST', '/api/locations', { name: 'Costume loft – Rack 1', area: 'Costume loft' }); ok(r.s === 200 && r.j.loc.code === 'L-001', 'add location');
    r = await call('POST', '/api/locations', { name: 'costume loft – rack 1' }); ok(r.s === 409, 'duplicate location blocked');
    await call('POST', '/api/locations', { name: 'Prop room shelf A', area: 'Prop room' });

    // items
    r = await call('POST', '/api/items', { name: 'Red velvet gown', category: 'Wardrobe', size: 'M', color: 'Red', location: 'L-001', qty: 1 });
    ok(r.s === 200 && r.j.item.code === 'R-0001', 'add item gets R-0001');
    r = await call('POST', '/api/reserve', { count: 50 }); ok(r.j.from === 'R-0002' && r.j.count === 50, 'reserve blank range');
    r = await call('POST', '/api/items', { name: 'Brass candlestick', category: 'Props', code: 'r-0010', location: 'L-002' });
    ok(r.s === 200 && r.j.item.code === 'R-0010', 'claim pre-printed sticker');
    r = await call('POST', '/api/items', { name: 'dup', code: 'R-0010' }); ok(r.s === 409, 'sticker reuse blocked');
    r = await call('POST', '/api/items', { name: 'Wingback chair', category: 'Furniture' }); ok(r.j.item.code === 'R-0052', 'next code after reserved range: ' + r.j.item.code);
    r = await call('POST', '/api/items', { name: '' }); ok(r.s === 400, 'name required');
    r = await call('PATCH', '/api/items/R-0001', { condition: 'Good', notes: 'hem loose', location: 'L-002' });
    ok(r.j.item.condition === 'Good' && r.j.item.location === 'L-002' && /moved from Costume loft/.test(r.j.item.history[0].detail), 'edit + move logged');
    r = await call('POST', '/api/items/R-0001/action', { action: 'checkout', holder: 'Jane', show: 'Peter Pan', due: '2027-06-30' });
    ok(r.j.item.status === 'Checked out' && r.j.item.holder === 'Jane', 'checkout');
    r = await call('POST', '/api/items/R-0001/action', { action: 'checkin', location: 'L-001' });
    ok(r.j.item.status === 'Available' && !r.j.item.holder && r.j.item.location === 'L-001', 'checkin to location');
    r = await call('POST', '/api/items/R-0010/action', { action: 'missing' }); ok(r.j.item.status === 'Missing', 'mark missing');
    r = await call('POST', '/api/items/R-0010/action', { action: 'seen', location: 'L-002' }); ok(r.j.item.status === 'Available', 'seen clears missing');

    // photos
    r = await call('POST', '/api/items/R-0001/photos', { full: JPG, thumb: JPG }); ok(r.s === 200 && r.j.item.photos.length === 1, 'photo upload');
    const pid = r.j.item.photos[0];
    r = await call('POST', '/api/items/R-0001/photos', { full: 'data:image/jpeg;base64,AAAA' }); ok(r.s === 400, 'bad photo rejected');
    r = await fetch(INV + '/p/' + pid + '.jpg', { headers: { cookie } }); ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'photo served');
    r = await fetch(INV + '/p/' + pid + '.jpg'); ok(r.status === 401, 'photo needs login');

    // print + csv + poster
    r = await call('GET', '/print?size=2x1&codes=R-0001,R-0010,L-001'); ok(r.s === 200 && (r.t.match(/class="lab/g) || []).length === 3 && r.t.includes('<svg'), 'print 3 labels');
    r = await call('GET', '/print?size=avery5160&from=R-0002&count=45'); ok((r.t.match(/class="sheet"/g) || []).length === 2 && (r.t.match(/class="lab/g) || []).length === 45, 'avery sheet chunking');
    r = await call('GET', '/api/export.csv'); ok(r.s === 200 && r.t.includes('Red velvet gown') && r.t.includes('Costume loft'), 'csv export');
    r = await call('GET', '/poster'); ok(r.t.includes('admin code'), 'poster needs admin');
    r = await call('DELETE', '/api/items/R-0052'); ok(r.s === 403, 'crew cannot delete');

    // admin
    r = await call('POST', '/api/login', { key: 'ADMIN-TESTKEY' }); cookie = (r.h.get('set-cookie') || '').split(';')[0]; ok(r.j.role === 'admin', 'admin login');
    r = await call('GET', '/poster'); ok(r.t.includes('/join?k=CREW-TEST'), 'poster has join link');
    r = await call('DELETE', '/api/items/R-0052'); ok(r.s === 200, 'admin delete');
    r = await call('POST', '/api/restore', { code: 'R-0052' }); ok(r.s === 200, 'restore');
    r = await call('POST', '/api/import', { rows: [{ name: 'Top hat', category: 'wardrobe', location: 'Hat boxes', qty: '3' }, { name: 'Ladder', category: 'Ladders' }, { name: '' }] });
    ok(r.j.added === 2 && r.j.locations === 1, 'import 2 rows + 1 new place');
    r = await call('GET', '/api/data'); const hat = r.j.items.find((i) => i.name === 'Top hat');
    ok(hat && hat.category === 'Wardrobe' && hat.qty === 3 && r.j.settings.categories.includes('Ladders'), 'import maps category + qty + adds new category');

    // SSE
    const ctrl = new AbortController(); let got = '';
    fetch(INV + '/api/events', { headers: { cookie }, signal: ctrl.signal }).then(async (res) => { const rd = res.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; got += Buffer.from(value).toString(); } }).catch(() => {});
    await wait(300); await call('PATCH', '/api/items/R-0010', { color: 'Brass' }); await wait(400); ctrl.abort();
    ok(got.includes('"t":"item"') && got.includes('Brass'), 'live update pushed over SSE');

    // durability: wait for debounced mirror push, kill, wipe disk, restart
    await wait(2600);
    inv.kill('SIGTERM'); await wait(800);
    fs.rmSync(invDir, { recursive: true, force: true });
    inv = start(__dirname, invEnv(invDir)); await up(INV + '/health');
    await wait(800);
    r = await call('GET', '/api/data');
    ok(r.s === 200 && r.j.items.length === 5, 'items restored from mirror after wipe: ' + (r.j && r.j.items.length));
    r = await fetch(INV + '/p/' + pid + '.jpg', { headers: { cookie } }); ok(r.status === 200, 'photo restored from mirror after wipe');
    r = await call('POST', '/api/items', { name: 'After restart' }); ok(r.j.item.code === 'R-0055', 'numbering continues after restore: ' + r.j.item.code);
  } catch (e) { fails++; console.log('ERROR', e); console.log(inv.out); }
  inv.kill(); aud.kill();
  console.log(passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('--- inventory log ---\n' + inv.out); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
