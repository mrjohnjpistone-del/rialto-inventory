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
    ok(hat && hat.code === 'HAT-0001' && hat.category === 'Hats' && hat.qty === 3 && r.j.settings.departments.length === 16, 'import maps dept code + qty');
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

    // ── Photo-only on the phone, details later on the computer ──
    r = await call('POST', '/api/items', { code: 'COST-0040', needs_details: true });
    ok(r.s === 200 && r.j.item.needs_details === true && r.j.item.name === 'Details needed' && r.j.item.category === 'Costumes', 'phone saves a blank sticker with no typing');
    r = await call('PATCH', '/api/items/COST-0040', { name: 'Navy peacoat', size: '42L' });
    ok(r.s === 200 && !r.j.item.needs_details && r.j.item.name === 'Navy peacoat', 'typing a real name on the computer clears "details needed"');
    r = await call('PATCH', '/api/items/COST-0040', { fit: ["Women's", "Men's", 'Unisex', 'bogus'] });
    ok(r.s === 200 && JSON.stringify(r.j.item.fit) === JSON.stringify(["Men's", "Women's", "Unisex"]), "Men's/Women's/Unisex ticks save, junk dropped: " + JSON.stringify(r.j.item.fit));
    // Copy details onto stickers already on the twins: a photo-only one keeps its photo, an unused one is created
    r = await call('POST', '/api/items', { code: 'COST-0041', needs_details: true });
    await call('POST', '/api/items/COST-0041/photos', { full: 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64'), thumb: 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64') });
    r = await call('POST', '/api/items/COST-0040/copies', { codes: ['cost41', 'COST-0042', 'COST-0040', 'PROP-0001'] });
    const c41 = r.j.items && r.j.items.find((x) => x.code === 'COST-0041'), c42 = r.j.items && r.j.items.find((x) => x.code === 'COST-0042');
    ok(r.s === 200 && c41 && c42 && c41.name === 'Navy peacoat' && !c41.needs_details && c42.name === 'Navy peacoat' && c42.size === '42L' && r.j.items.length === 2 && r.j.skipped.some((x) => x.code === 'PROP-0001') && JSON.stringify(c42.fit) === JSON.stringify(["Men's", "Women's", "Unisex"]),
      'copy onto existing stickers fills a photo-only one and creates an unused one, no new numbers: ' + JSON.stringify(r.j).slice(0, 200));
    // Alterations: temporary ones can be undone or kept; permanent ones stay; bad input refused
    r = await call('POST', '/api/items/COST-0040/alterations', { what: 'Hemmed 2 in.', kind: 'Temporary', show: 'A Few Good Men', undo_by: '2026-12-20' });
    const alt = r.j.item && r.j.item.alterations[0];
    ok(r.s === 200 && alt.kind === 'Temporary' && alt.status === 'Active' && alt.show === 'A Few Good Men', 'temporary alteration recorded');
    r = await call('POST', '/api/items/COST-0040/alterations', { what: 'x', kind: 'Sometimes' });
    ok(r.s === 400, 'alteration needs Permanent or Temporary');
    r = await call('POST', '/api/items/COST-0040/alterations/' + alt.id, { action: 'undo' });
    ok(r.s === 200 && r.j.item.alterations[0].status === 'Undone' && r.j.item.alterations[0].undone_by, 'temporary alteration marked undone');
    r = await call('POST', '/api/items/COST-0040/alterations', { what: 'Dyed black', kind: 'Permanent' });
    const pid2 = r.j.item.alterations[0].id;
    r = await call('POST', '/api/items/COST-0040/alterations/' + pid2, { action: 'undo' });
    ok(r.s === 400, 'a permanent alteration cannot be "undone"');
    r = await fetch(INV + '/api/export.csv', { headers: { cookie } }); const csv = await r.text();
    ok(/Permanent: Dyed black/.test(csv) && /Temporary \(undone\): Hemmed/.test(csv), 'alterations appear in the spreadsheet download');

    // Copying FROM an item that still says "Details needed" is refused (it would spread the placeholder name)
    r = await call('POST', '/api/items', { code: 'ACC-0080', needs_details: true });
    r = await call('POST', '/api/items/ACC-0080/copies', { codes: ['ACC-0081'] });
    ok(r.s === 400 && /first/.test(r.j.error), 'cannot copy from an item whose details are not filled in yet');
    r = await call('PATCH', '/api/items/ACC-0080', { name: 'Details needed' });
    ok(r.j.item.needs_details === true, 'an item named "Details needed" stays on the need-details list');
    await call('DELETE', '/api/items/ACC-0080');

    // Prompt books always belong to a show
    r = await call('POST', '/api/items', { code: 'BOOK-0001', name: 'SM prompt book' });
    ok(r.s === 400 && /show/.test(r.j.error), 'a prompt book without a show is refused');
    r = await call('POST', '/api/items', { code: 'BOOK-0001', name: 'A Few Good Men — Stage manager book', roles: [{ show: 'A Few Good Men', character: '' }] });
    ok(r.s === 200 && r.j.item.category === 'Scripts & prompt books', 'a prompt book with its show saves: ' + (r.j.error || ''));
    r = await call('PATCH', '/api/items/BOOK-0001', { roles: [] });
    ok(r.s === 400, 'cannot take the show off a prompt book');
    r = await call('POST', '/api/items', { code: 'BOOK-0002', needs_details: true });
    ok(r.s === 200, 'phone photo-only save of a book sticker still works');
    await call('DELETE', '/api/items/BOOK-0001'); await call('DELETE', '/api/items/BOOK-0002');

    // One generic photo shared by identical items (green web belts)
    r = await call('POST', '/api/items', { name: 'Green web belt', category: 'ACC', size: 'One size' });
    const belt = r.j.item.code;
    await call('POST', '/api/items/' + belt + '/photos', { full: JPG, thumb: JPG });
    r = await call('POST', '/api/items/' + belt + '/copies', { codes: ['ACC-0090', 'ACC-0091'], photo: true });
    const bp = r.j.items && r.j.items.map((x) => x.photos[0]);
    r = await call('GET', '/api/data'); const src = r.j.items.find((x) => x.code === belt);
    ok(bp && bp.length === 2 && bp.every((p) => p && p === src.photos[0]), 'scanned belt stickers share the one generic photo: ' + JSON.stringify(bp));
    for (const c of [belt, 'ACC-0090', 'ACC-0091']) await call('DELETE', '/api/items/' + c);
    r = await call('POST', '/api/items/COST-0040/copies', { codes: ['COST-0042'] });
    ok(r.s === 400 && /already has details/.test(r.j.error), 'never overwrites an item that already has details');
    await call('DELETE', '/api/items/COST-0041'); await call('DELETE', '/api/items/COST-0042');
    r = await call('PATCH', '/api/items/COST-0040', { fit: [] });
    ok(r.s === 200 && r.j.item.fit.length === 0, 'unticking all clears who-it-fits');
    await call('DELETE', '/api/items/COST-0040');

    // ── Character sets ──
    r = await call('PATCH', '/api/items/COST-0001', { roles: [{ show: 'A Few Good Men', character: 'Galloway' }, { show: 'a few good men', character: 'galloway' }, { show: '', character: '' }] });
    ok(r.s === 200 && r.j.item.roles.length === 1 && r.j.item.roles[0].character === 'Galloway', 'character tag saved, duplicates and blanks dropped');
    r = await call('POST', '/api/items', { name: 'Galloway ribbons', category: 'Accessories & jewelry', roles: [{ show: 'A Few Good Men', character: 'Galloway' }] });
    ok(r.s === 200 && r.j.item.roles.length === 1, 'new item created with a character');
    r = await call('GET', '/api/export.csv'); ok(r.t.includes('A Few Good Men: Galloway'), 'csv lists characters');
    r = await call('PATCH', '/api/items/FURN-0001', { roles: [{ show: 'Romeo and Juliet', character: '' }] });
    ok(r.s === 200 && r.j.item.roles.length === 1 && r.j.item.roles[0].show === 'Romeo and Juliet', 'show-only tag (whole show) accepted');
    r = await fetch(INV + '/show?show=Romeo%20and%20Juliet', { headers: { cookie } }); ok(r.status === 200, 'show page route serves the app');
    await call('PATCH', '/api/items/FURN-0001', { roles: [] });
    r = await fetch(INV + '/set?show=A%20Few%20Good%20Men&character=Galloway', { headers: { cookie } }); ok(r.status === 200, 'set page route serves the app');
    await call('DELETE', '/api/items/' + (await call('GET', '/api/data')).j.items.find((i) => i.name === 'Galloway ribbons').code);

    // ── Department-head accounts ──
    const masterCookie = cookie;
    r = await call('POST', '/api/admins', { name: 'Costume Shop Head', user: 'Costumes' });
    ok(r.s === 200 && r.j.admin.user === 'costumes' && /^Rialto-[A-Z0-9]{6}$/.test(r.j.temp_password) && r.j.admin.must_change, 'owner creates account with temp password');
    const temp = r.j.temp_password, cid = r.j.admin.id;
    r = await call('POST', '/api/admins', { name: 'Dup', user: 'costumes' }); ok(r.s === 409, 'duplicate username refused');
    cookie = '';
    r = await call('POST', '/api/login', { user: 'costumes', password: 'nope' }); ok(r.s === 401, 'wrong password refused');
    r = await call('POST', '/api/login', { user: 'COSTUMES', password: temp }); ok(r.s === 200 && r.j.must_change === true, 'login with temp password, must change');
    cookie = (r.h.get('set-cookie') || '').split(';')[0]; const tempCookie = cookie;
    r = await call('GET', '/api/data'); ok(r.j.role === 'admin' && r.j.me.name === 'Costume Shop Head' && !r.j.me.manager && r.j.admins.length === 0, 'dept head is admin, not owner, sees no account list');
    r = await call('POST', '/api/items', { name: 'Feather boa', category: 'Accessories & jewelry' }); ok(r.j.item.created_by === 'Costume Shop Head', 'history records the account name');
    await call('DELETE', '/api/items/' + r.j.item.code); ok(true, 'dept head can delete');
    r = await call('POST', '/api/admins', { name: 'x', user: 'xxx' }); ok(r.s === 403, 'dept head cannot add accounts');
    r = await call('POST', '/api/settings', { crew_key: 'NEWCREW1' }); ok(r.s === 403, 'dept head cannot change crew code');
    r = await call('POST', '/api/account/password', { current: 'bad', password: 'Gowns&Hats2027' }); ok(r.s === 400, 'change needs current password');
    r = await call('POST', '/api/account/password', { current: temp, password: 'short' }); ok(r.s === 400, 'short password refused');
    r = await call('POST', '/api/account/password', { current: temp, password: 'Gowns&Hats2027' }); ok(r.s === 200, 'password changed');
    cookie = (r.h.get('set-cookie') || '').split(';')[0];
    r = await call('GET', '/api/data'); ok(r.s === 200 && r.j.me.must_change === false, 'new session valid, must_change cleared');
    cookie = tempCookie; r = await call('GET', '/api/data'); ok(r.s === 401, 'old sessions signed out after password change');
    cookie = ''; r = await call('POST', '/api/login', { user: 'costumes', password: temp }); ok(r.s === 401, 'temp password no longer works');
    r = await call('POST', '/api/login', { user: 'costumes', password: 'Gowns&Hats2027' }); ok(r.s === 200 && !r.j.must_change, 'login with own password');
    cookie = masterCookie;
    r = await call('POST', '/api/admins/' + cid + '/reset'); ok(r.s === 200 && r.j.temp_password && r.j.admin.must_change, 'owner resets a forgotten password');
    cookie = ''; r = await call('POST', '/api/login', { user: 'costumes', password: 'Gowns&Hats2027' }); ok(r.s === 401, 'old password dead after reset');
    cookie = masterCookie;
    r = await call('DELETE', '/api/admins/' + cid); ok(r.s === 200, 'owner removes account');
    r = await call('GET', '/api/data'); ok(r.j.admins.length === 0, 'account gone');

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
    ok(r.s === 200 && r.j.items.length === 46 && !r.j.items.some((i) => i.name === 'Should not land'), 'full inventory restored after mirror came back: ' + (r.j && r.j.items.length) + ' ' + (r.j && r.j.items.map((i) => i.code).filter((c) => /COST-004/.test(c)).join(' ')));

    // Brand-new install with no backup configured: admin sign-in form must work (regression: no secret → 500)
    const solo = start(__dirname, { PORT: 3913, DATA_DIR: path.join(tmp, 'solo'), CREW_KEY: 'CREW-SOLO', ADMIN_KEY: 'ADMIN-SOLOKEY' });
    await up('http://localhost:3913/health');
    const S = 'http://localhost:3913';
    let sr = await fetch(S + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'ADMIN-SOLOKEY' }) });
    const sc = sr.headers.get('set-cookie').split(';')[0];
    sr = await fetch(S + '/api/admins', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rialto': '1', cookie: sc }, body: JSON.stringify({ name: 'Props', user: 'props' }) });
    const sj = await sr.json();
    sr = await fetch(S + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'mode=admin&user=props&password=' + encodeURIComponent(sj.temp_password) + '&next=%2Fsettings' });
    ok(sr.status === 303 && sr.headers.get('location') === '/settings' && /ra=/.test(sr.headers.get('set-cookie') || ''), 'admin sign-in form works on a fresh install with no backup');
    solo.kill();

    // Tag reader, against a fake AI endpoint (costs nothing): auto-fills blanks after a photo, never overwrites typed fields
    let aiCalls = 0, aiSawImage = false;
    const fake = require('http').createServer((q, s2) => { let b = ''; q.on('data', (d) => b += d); q.on('end', () => {
      aiCalls++; try { aiSawImage = JSON.parse(b).messages[0].content.some((c) => c.type === 'image'); } catch (e) { /* */ }
      s2.writeHead(200, { 'Content-Type': 'application/json' });
      s2.end(JSON.stringify({ content: [{ type: 'text', text: 'Here: {"has_tag":true,"name":"Marine green service trousers","color":"Olive green","size":"36L","fit":["Men\'s"],"description":"Coates Brothers, 55% polyester / 45% wool","tags":"pants, USMC","period":"","condition":"","confidence":"high"}' }] }));
    }); }).listen(3915);
    const T = 'http://localhost:3914';
    const tagApp = start(__dirname, { PORT: 3914, DATA_DIR: path.join(tmp, 'tag'), CREW_KEY: 'CREW-TAG', ADMIN_KEY: 'ADMIN-TAGKEY', ANTHROPIC_API_KEY: 'test-key', TAG_API_URL: 'http://localhost:3915/v1/messages', TAG_DELAY_MS: '300' });
    await up(T + '/health');
    const tc = (await fetch(T + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'CREW-TAG' }) })).headers.get('set-cookie').split(';')[0];
    const tcall = async (m, p2, body) => { const rr = await fetch(T + p2, { method: m, headers: { 'Content-Type': 'application/json', 'x-rialto': '1', cookie: tc }, body: body ? JSON.stringify(body) : undefined }); return { s: rr.status, j: await rr.json() }; };
    let tr = await tcall('GET', '/api/data'); ok(tr.j.tag_reader === true, 'site reports the tag reader is on');
    await tcall('POST', '/api/items', { code: 'COST-0100', needs_details: true });
    await tcall('POST', '/api/items/COST-0100/photos', { full: JPG, thumb: JPG });
    for (let i = 0; i < 30; i++) { await wait(200); tr = await tcall('GET', '/api/data'); if (tr.j.items[0].tag_read && tr.j.items[0].tag_read.status === 'done') break; }
    let ti = tr.j.items[0];
    ok(aiCalls === 1 && aiSawImage && ti.name === 'Marine green service trousers' && ti.size === '36L' && ti.fit[0] === "Men's" && !ti.needs_details && ti.tag_read.status === 'done',
      'photo on a blank sticker gets read automatically: ' + JSON.stringify({ aiCalls, aiSawImage, name: ti.name, size: ti.size, st: ti.tag_read }));
    await tcall('PATCH', '/api/items/COST-0100', { size: '38L' });
    tr = await tcall('POST', '/api/items/COST-0100/readtag', {});
    ok(tr.s === 200 && tr.j.item.size === '38L' && tr.j.item.name === 'Marine green service trousers', 'Read tag again never overwrites a size a person typed');
    await tcall('POST', '/api/items', { name: 'Typed by hand', category: 'Costumes', size: 'M' });
    tr = await tcall('GET', '/api/data');
    const typed = tr.j.items.find((x) => x.name === 'Typed by hand');
    await tcall('POST', '/api/items/' + typed.code + '/photos', { full: JPG, thumb: JPG });
    const before = aiCalls; await wait(900);
    ok(aiCalls === before, 'items that already have their details are not sent to the reader (no cost)');
    tagApp.kill(); fake.close();
  } catch (e) { fails++; console.log('ERROR', e); console.log(inv.out); }
  inv.kill(); aud.kill();
  console.log(passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('--- inventory log ---\n' + inv.out); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
