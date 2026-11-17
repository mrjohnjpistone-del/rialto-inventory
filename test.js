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
  let aud = start(AUD, { PORT: AUD_PORT, DATA_DIR: audDir, BLOB_KEY: BLOB, STAFF_KEY: 'x', WARM_URLS: '' });
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

    // locations (LOC-0001…)
    r = await call('POST', '/api/locations', { name: 'Costume loft – Rack 1', area: 'Costume loft' }); ok(r.s === 200 && r.j.loc.code === 'LOC-0001', 'add location LOC-0001');
    r = await call('POST', '/api/locations', { name: 'costume loft – rack 1' }); ok(r.s === 409, 'duplicate location blocked');
    await call('POST', '/api/locations', { name: 'Prop room shelf A', area: 'Prop room' });

    // department-coded items
    r = await call('POST', '/api/items', { name: 'Red velvet gown', category: 'Costumes', size: 'M', color: 'Red', location: 'LOC-0001', qty: 1 });
    ok(r.s === 200 && r.j.item.code === 'COST-0001' && r.j.item.category === 'Costumes', 'costume gets COST-0001');
    r = await call('POST', '/api/reserve', { count: 50, department: 'Costumes' }); ok(r.j.from === 'COST-0002' && r.j.codes.length === 50 && r.j.codes[49] === 'COST-0051', 'reserve 50 blank COST stickers');
    r = await call('POST', '/api/items', { name: 'Brass candlestick', category: 'Costumes', code: 'prop10', location: 'LOC-0002' });
    ok(r.s === 200 && r.j.item.code === 'PROP-0010' && r.j.item.category === 'Props & set dressing', 'typed "prop10" → PROP-0010, sticker decides department');
    r = await call('POST', '/api/items', { name: 'dup', code: 'PROP-0010' }); ok(r.s === 409, 'sticker reuse blocked');
    r = await call('POST', '/api/items', { name: 'x', code: 'ZZZ-0001' }); ok(r.s === 400, 'unknown department prefix refused');
    r = await call('POST', '/api/items', { name: 'x' }); ok(r.s === 400, 'department required without a sticker');
    r = await call('POST', '/api/items', { name: 'Wingback chair', category: 'Furniture' }); ok(r.j.item.code === 'FURN-0001', 'separate numbering per department: ' + r.j.item.code);
    r = await call('POST', '/api/items', { name: 'Another gown', category: 'COST' }); ok(r.j.item.code === 'COST-0052', 'next COST skips the reserved range: ' + r.j.item.code);
    r = await call('POST', '/api/items', { name: '' }); ok(r.s === 400, 'name required');
    r = await call('PATCH', '/api/items/COST-0001', { condition: 'Good', notes: 'hem loose', location: 'LOC-0002', category: 'Props & set dressing' });
    ok(r.j.item.condition === 'Good' && r.j.item.location === 'LOC-0002' && r.j.item.category === 'Costumes' && /moved from Costume loft/.test(r.j.item.history[0].detail), 'edit + move logged; category not changed by PATCH');
    r = await call('POST', '/api/items/cost1/action', { action: 'checkout', holder: 'Jane', show: 'Peter Pan', due: '2027-06-30' });
    ok(r.j.item.status === 'Checked out' && r.j.item.holder === 'Jane', 'checkout (lower-case short code accepted)');
    r = await call('POST', '/api/items/COST-0001/action', { action: 'checkin', location: 'LOC-0001' });
    ok(r.j.item.status === 'Available' && !r.j.item.holder && r.j.item.location === 'LOC-0001', 'checkin to location');
    r = await call('POST', '/api/items/PROP-0010/action', { action: 'missing' }); ok(r.j.item.status === 'Missing', 'mark missing');
    r = await call('POST', '/api/items/PROP-0010/action', { action: 'seen', location: 'LOC-0002' }); ok(r.j.item.status === 'Available', 'seen clears missing');
    r = await fetch(INV + '/I/COST-0001', { headers: { cookie } }); ok(r.status === 200 && (await r.text()).includes('app.js'), 'all-caps QR URL /I/COST-0001 opens the app');

    // photos
    r = await call('POST', '/api/items/COST-0001/photos', { full: JPG, thumb: JPG }); ok(r.s === 200 && r.j.item.photos.length === 1, 'photo upload');
    const pid = r.j.item.photos[0];
    r = await call('POST', '/api/items/COST-0001/photos', { full: 'data:image/jpeg;base64,AAAA' }); ok(r.s === 400, 'bad photo rejected');
    r = await fetch(INV + '/p/' + pid + '.jpg', { headers: { cookie } }); ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'photo served');
    r = await fetch(INV + '/p/' + pid + '.jpg'); ok(r.status === 401, 'photo needs login');

    // print + csv + poster
    r = await call('GET', '/print?size=2x1&codes=COST-0001,PROP-0010,LOC-0001'); ok(r.s === 200 && (r.t.match(/class="lab/g) || []).length === 3 && r.t.includes('<svg'), 'print 3 labels');
    r = await call('GET', '/print?size=avery5160&from=COST-0002&count=45'); ok((r.t.match(/class="sheet"/g) || []).length === 2 && (r.t.match(/class="lab/g) || []).length === 45, 'avery sheet chunking');
    r = await call('GET', '/api/export.csv'); ok(r.s === 200 && r.t.includes('Red velvet gown') && r.t.includes('Costume loft'), 'csv export');
    r = await call('GET', '/poster'); ok(r.t.includes('admin code'), 'poster needs admin');
    r = await call('DELETE', '/api/items/FURN-0001'); ok(r.s === 403, 'crew cannot delete');

    // admin
    r = await call('POST', '/api/login', { key: 'ADMIN-TESTKEY' }); cookie = (r.h.get('set-cookie') || '').split(';')[0]; ok(r.j.role === 'admin', 'admin login');
    r = await call('GET', '/poster'); ok(r.t.includes('/join?k=CREW-TEST'), 'poster has join link');
    r = await call('DELETE', '/api/items/FURN-0001'); ok(r.s === 200, 'admin delete');
    r = await call('POST', '/api/items', { name: 'New chair', category: 'Furniture' }); ok(r.j.item.code === 'FURN-0002', 'removed code is never reissued: ' + r.j.item.code);
    await call('DELETE', '/api/items/FURN-0002'); await call('POST', '/api/forget', {});
    r = await call('POST', '/api/restore', { code: 'FURN-0001' }); ok(r.s === 404, 'forgotten item cannot be restored');
    r = await call('POST', '/api/items', { name: 'Wingback chair', category: 'Furniture', code: 'FURN-0001' }); ok(r.s === 200, 're-add chair on its old sticker after forget');
    r = await call('POST', '/api/import', { rows: [{ name: 'Top hat', category: 'HAT', location: 'Hat boxes', qty: '3' }, { name: 'Ladder', category: 'Ladders' }, { name: '' }] });
    ok(r.j.added === 1 && r.j.locations === 1 && r.j.skipped === 1, 'import: known dept added, unknown dept skipped');
    r = await call('GET', '/api/data'); const hat = r.j.items.find((i) => i.name === 'Top hat');
    ok(hat && hat.code === 'HAT-0001' && hat.category === 'Hats' && hat.qty === 3 && r.j.settings.departments.length === 15, 'import maps dept code + qty');
    r = await call('POST', '/api/settings', { departments: [{ p: 'PROP', name: 'Props', color: '#f2c200' }] }); ok(r.s === 400 && /COST/.test(r.j.error), 'cannot drop a department that has items');

    // SSE
    const ctrl = new AbortController(); let got = '';
    fetch(INV + '/api/events', { headers: { cookie }, signal: ctrl.signal }).then(async (res) => { const rd = res.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; got += Buffer.from(value).toString(); } }).catch(() => {});
    await wait(300); await call('PATCH', '/api/items/PROP-0010', { color: 'Brass' }); await wait(400); ctrl.abort();
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
    r = await call('POST', '/api/items', { name: 'After restart', category: 'Props & set dressing' }); ok(r.j.item.code === 'PROP-0011', 'numbering continues after restore: ' + r.j.item.code);

    // ── Review fixes ──
    r = await call('POST', '/api/items/COST-0001/action', { action: 'checkout', holder: 'Ann' }); ok(r.s === 200, 'checkout once');
    r = await call('POST', '/api/items/COST-0001/action', { action: 'checkout', holder: 'Bob' });
    ok(r.s === 409 && /Ann/.test(r.j.error) && r.j.item.holder === 'Ann', 'double checkout refused, holder kept');
    await call('POST', '/api/items/COST-0001/action', { action: 'checkin' });
    r = await call('POST', '/api/items', { name: '=HYPERLINK("http://x","y")', category: 'Props & set dressing' });
    r = await call('GET', '/api/export.csv'); ok(r.t.includes(`"'=HYPERLINK`), 'csv neutralises formulas');
    const many = []; for (let i = 1; i <= 1200; i++) many.push('COST-' + String(i).padStart(4, '0'));
    r = await fetch(INV + '/print', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'size=2x1&codes=' + many.join(',') });
    let tx = await r.text(); ok((tx.match(/class="lab/g) || []).length === 1200 && tx.includes('name="codes"'), 'POST print of 1200 exact codes, size switch keeps them');
    for (let i = 0; i < 12; i++) await fetch(INV + '/join?k=NOPE' + i, { redirect: 'manual', headers: { 'x-forwarded-for': '9.9.9.' + i + ', 7.7.7.7' } });
    r = await fetch(INV + '/join?k=CREW-TEST', { redirect: 'manual', headers: { 'x-forwarded-for': '1.2.3.4, 7.7.7.7' } });
    ok(r.status === 429, 'join guesses limited by real (rightmost) IP, spoofed left entries ignored');

    // Copies: 40 Alpha coats, each its own COST code
    await call('PATCH', '/api/items/COST-0001', { name: 'USMC Alpha coat', size: '38S', description: 'Green, corporal' });
    await call('POST', '/api/items/COST-0001/action', { action: 'checkout', holder: 'Ann' });
    r = await call('POST', '/api/items/COST-0001/copies', { count: 39, photo: true });
    const cs = r.j.items || []; const codesSet = new Set(cs.map((c) => c.code));
    ok(r.s === 200 && cs.length === 39 && codesSet.size === 39 && !codesSet.has('COST-0001') && cs.every((c) => /^COST-\d{4}$/.test(c.code)), '39 copies, 39 unique COST codes');
    ok(cs.every((c) => c.size === '38S' && c.name === 'USMC Alpha coat' && c.status === 'Available' && !c.holder && c.photos.length === 1 && c.history.length === 1), 'copies carry details + photo, not status/holder/history');
    r = await call('GET', '/api/data'); ok(r.j.items.filter((i) => i.size === '38S').length === 40, '40 coats searchable by 38S');
    r = await call('POST', '/api/items', { name: 'USMC Alpha coat', size: '38S', code: cs[0].code }); ok(r.s === 409, 'copied coat sticker cannot be reused');
    await call('POST', '/api/items/COST-0001/action', { action: 'checkin' });

    // Re-sticker into another department: new code, old sticker still resolves
    r = await call('POST', '/api/items/PROP-0010/recode', { department: 'Furniture' });
    ok(r.s === 200 && r.j.item.code === 'FURN-0003' && r.j.item.category === 'Furniture' && r.j.item.aliases.includes('PROP-0010'), 'recode PROP-0010 → FURN-0003');
    r = await call('POST', '/api/items/PROP-0010/action', { action: 'seen' }); ok(r.s === 200 && r.j.item.code === 'FURN-0003', 'old sticker still opens the item');
    r = await call('POST', '/api/items', { name: 'x', code: 'PROP-0010' }); ok(r.s === 409, 'old code is never reissued');

    // Mirror down at boot: no writes until the restore lands, then the full copy loads.
    await wait(2600);
    inv.kill('SIGTERM'); await wait(800);
    fs.rmSync(invDir, { recursive: true, force: true });
    aud.kill(); await wait(500);
    inv = start(__dirname, invEnv(invDir)); await up(INV + '/health');
    r = await call('GET', '/api/data'); ok(r.s === 503, 'api answers 503 while restore is pending');
    r = await call('POST', '/api/items', { name: 'Should not land' }); ok(r.s === 503, 'writes refused while restore is pending');
    aud = start(AUD, { PORT: AUD_PORT, DATA_DIR: audDir, BLOB_KEY: BLOB, STAFF_KEY: 'x', WARM_URLS: '' });
    await up('http://localhost:' + AUD_PORT + '/health');
    for (let i = 0; i < 40 && r.s === 503; i++) { await wait(1000); r = await call('GET', '/api/data'); }
    ok(r.s === 200 && r.j.items.length === 46 && !r.j.items.some((i) => i.name === 'Should not land'), 'full inventory restored after mirror came back: ' + (r.j && r.j.items.length));
  } catch (e) { fails++; console.log('ERROR', e); console.log(inv.out); }
  inv.kill(); aud.kill();
  console.log(passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('--- inventory log ---\n' + inv.out); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
