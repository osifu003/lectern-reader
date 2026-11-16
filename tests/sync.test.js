// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const S = require('../sync.js');

const now = 1_800_000_000_000;

test('newest reading position wins, per book', () => {
  const m = S.mergeState({ positions: { a: { c: 1, s: 5, t: 10 }, b: { c: 0, s: 1, t: 50 } } },
    { positions: { a: { c: 2, s: 0, t: 20 }, b: { c: 0, s: 0, t: 40 }, c: { c: 3, s: 3, t: 5 } } }, now);
  assert.deepStrictEqual(m.positions, { a: { c: 2, s: 0, t: 20 }, b: { c: 0, s: 1, t: 50 }, c: { c: 3, s: 3, t: 5 } });
  assert.deepStrictEqual(m.pulled.sort(), ['a', 'c']);
  assert.ok(m.remoteChanged && m.localChanged);
});

test('nothing to write when both sides agree', () => {
  const st = { positions: { a: { c: 1, s: 1, t: 1 } }, tombs: {} };
  const m = S.mergeState(st, JSON.parse(JSON.stringify(st)), now);
  assert.ok(!m.remoteChanged && !m.localChanged);
  assert.deepStrictEqual(m.pulled, []);
});

test('deleted books drop their positions; old tombstones expire', () => {
  const m = S.mergeState({ positions: { a: { c: 1, s: 1, t: 1 } }, tombs: { a: now - 1000 } },
    { positions: {}, tombs: { old: now - 200 * 864e5 } }, now);
  assert.deepStrictEqual(m.positions, {});
  assert.deepStrictEqual(Object.keys(m.tombs), ['a']);
});

test('plan: new local book uploads, new remote book downloads', () => {
  const p = S.planSync([{ id: 'l', v: 5, synced: false }], [{ fileId: 'F', id: 'r', v: 3 }], {});
  assert.deepStrictEqual(p.upload, [{ id: 'l' }]);
  assert.deepStrictEqual(p.download.map(r => r.id), ['r']);
});

test('plan: edited elsewhere downloads, edited here uploads, unchanged stays', () => {
  const p = S.planSync(
    [{ id: 'x', v: 5, synced: true }, { id: 'y', v: 9, synced: false }, { id: 'z', v: 4, synced: true }],
    [{ fileId: 'X', id: 'x', v: 7 }, { fileId: 'Y', id: 'y', v: 4 }, { fileId: 'Z', id: 'z', v: 4 }], {});
  assert.deepStrictEqual(p.download.map(r => r.id), ['x']);
  assert.deepStrictEqual(p.upload, [{ id: 'y', fileId: 'Y' }]);
});

test('plan: removed on another device is removed here, removed here is removed from Drive', () => {
  const p = S.planSync([{ id: 'gone', v: 3, synced: true }], [{ fileId: 'G', id: 'gone', v: 3 }, { fileId: 'H', id: 'mine', v: 2 }], { gone: 10, mine: 10 });
  assert.deepStrictEqual(p.deleteLocal, ['gone']);
  assert.deepStrictEqual(p.deleteRemote.sort(), ['G', 'H']);
  assert.deepStrictEqual(p.download, []);
});

test('plan: a book missing from Drive without a tombstone is uploaded again, never deleted', () => {
  const p = S.planSync([{ id: 'a', v: 3, synced: true }], [], {});
  assert.deepStrictEqual(p.upload, [{ id: 'a' }]);
  assert.deepStrictEqual(p.deleteLocal, []);
});

test('plan: an edit made after a removal elsewhere is kept', () => {
  const p = S.planSync([{ id: 'a', v: 20, synced: false }], [], { a: 10 });
  assert.deepStrictEqual(p.untomb, ['a']);
  assert.deepStrictEqual(p.upload, [{ id: 'a' }]);
});

test('plan: duplicate copies on Drive keep the newest', () => {
  const p = S.planSync([], [{ fileId: 'A', id: 'b', v: 1 }, { fileId: 'B', id: 'b', v: 2 }], {});
  assert.deepStrictEqual(p.deleteRemote, ['A']);
  assert.deepStrictEqual(p.download.map(r => r.fileId), ['B']);
});

// A fake Drive appDataFolder that speaks the same HTTP calls as the real one.
function fakeDrive() {
  const files = new Map(); let n = 0; const calls = [];
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url), m = opts.method || 'GET'; calls.push(m + ' ' + u.pathname);
    assert.match(opts.headers.Authorization, /^Bearer tok$/);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, headers: { get: () => null } });
    if (u.pathname === '/drive/v3/files' && m === 'GET') {
      assert.strictEqual(u.searchParams.get('spaces'), 'appDataFolder');
      return json({ files: [...files.values()].map(f => ({ id: f.id, name: f.name, modifiedTime: f.mod, appProperties: f.props })) });
    }
    const mm = u.pathname.match(/\/files\/([^/]+)$/);
    if (mm && m === 'GET') { const f = files.get(mm[1]); return f ? json(JSON.parse(f.body)) : json({ error: { message: 'nf' } }, 404); }
    if (mm && m === 'DELETE') { files.delete(mm[1]); return json({}, 204); }
    if (u.pathname.startsWith('/upload/drive/v3/files')) {
      const ct = opts.headers['Content-Type']; const b = ct.split('boundary=')[1];
      const parts = opts.body.split('--' + b).slice(1, -1).map(p => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const meta = JSON.parse(parts[0]), body = parts[1];
      let f;
      if (mm) { f = files.get(mm[1]); f.body = body; f.props = Object.assign({}, f.props, meta.appProperties); }
      else { assert.deepStrictEqual(meta.parents, ['appDataFolder']); f = { id: 'f' + (++n), name: meta.name, body, props: meta.appProperties }; files.set(f.id, f); }
      f.mod = new Date(1e12 + n * 1000 + calls.length).toISOString();
      return json({ id: f.id, modifiedTime: f.mod, appProperties: f.props });
    }
    throw new Error('unexpected ' + m + ' ' + url);
  }
  return { files, calls, fetchImpl };
}
function device(initial) {
  const st = { books: initial || [], positions: {}, tombs: {} };
  st.store = {
    books: () => st.books, positions: () => st.positions, tombs: () => st.tombs,
    async putBook(b) { st.books = st.books.filter(x => x.id !== b.id).concat(b); },
    async dropBook(id) { st.books = st.books.filter(x => x.id !== id); },
    async markSynced(id, v) { const b = st.books.find(x => x.id === id); if (b && S.bookVersion(b) <= v) { b.synced = true; b.updated = v; } },
    setPositions(p) { st.positions = p; },
    clearTombs(ids) { ids.forEach(id => delete st.tombs[id]); }
  };
  return st;
}

test('two devices: add on one, it appears on the other with the reading position; remove on one, it goes from both', async () => {
  const fd = fakeDrive(), drive = S.createDrive(() => 'tok', fd.fetchImpl);
  const book = { id: 'b1', title: 'Moby-Dick', added: 100, chapters: [{ title: 'Loomings', paras: ['Call me Ishmael.'] }] };
  const laptop = device([book]), phone = device([]);
  laptop.positions = { b1: { c: 0, s: 3, t: 500 } };

  let r = await S.runSync(drive, laptop.store, now);
  assert.strictEqual(r.uploaded, 1); assert.ok(laptop.books[0].synced);
  const stored = [...fd.files.values()].find(f => f.name === 'book-b1.json');
  assert.ok(!('synced' in JSON.parse(stored.body)), 'the local-only flag is not uploaded');

  r = await S.runSync(drive, phone.store, now);
  assert.strictEqual(r.downloaded, 1);
  assert.strictEqual(phone.books[0].title, 'Moby-Dick');
  assert.deepStrictEqual(phone.positions.b1, { c: 0, s: 3, t: 500 });
  assert.deepStrictEqual(r.pulled, ['b1']);

  phone.positions.b1 = { c: 0, s: 9, t: 900 }; // read further on the phone
  await S.runSync(drive, phone.store, now);
  r = await S.runSync(drive, laptop.store, now);
  assert.deepStrictEqual(laptop.positions.b1, { c: 0, s: 9, t: 900 });
  assert.strictEqual(r.uploaded + r.downloaded, 0, 'nothing moves when only the position changed');

  phone.books = []; phone.tombs = { b1: now - 10 }; delete phone.positions.b1; // removed on the phone
  await S.runSync(drive, phone.store, now);
  assert.ok(![...fd.files.values()].some(f => f.name === 'book-b1.json'));
  r = await S.runSync(drive, laptop.store, now);
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(laptop.books, []);
  assert.deepStrictEqual(laptop.positions, {});
});

test('a scanned book that gains pages on one device is replaced on the other', async () => {
  const fd = fakeDrive(), drive = S.createDrive(() => 'tok', fd.fetchImpl);
  const a = device([{ id: 's', title: 'Scan', added: 100, chapters: [{ title: 'Page 1', paras: ['one'] }] }]), b = device([]);
  await S.runSync(drive, a.store, now); await S.runSync(drive, b.store, now);
  Object.assign(a.books[0], { synced: false, updated: 200, chapters: [...a.books[0].chapters, { title: 'Page 2', paras: ['two'] }] });
  await S.runSync(drive, a.store, now);
  const r = await S.runSync(drive, b.store, now);
  assert.strictEqual(r.downloaded, 1);
  assert.strictEqual(b.books[0].chapters.length, 2);
});

test('expired sign-in and no connection are reported, not thrown away', async () => {
  const d401 = S.createDrive(() => 'tok', async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await assert.rejects(d401.list(), e => e.code === 'auth');
  const off = S.createDrive(() => 'tok', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(off.list(), e => e.code === 'offline');
  const none = S.createDrive(() => '', async () => { throw new Error('should not call'); });
  await assert.rejects(none.list(), e => e.code === 'auth');
});

// ---------- the Google key and voice settings ----------

test('settings: the newest change wins, field by field', () => {
  const m = S.mergePrefs(
    { gkey: { v: 'K1', t: 10 }, gstyle: { v: 'warm', t: 50 }, rate: { v: 1, t: 0 } },
    { gkey: { v: 'K2', t: 20 }, gstyle: { v: 'calm', t: 40 }, rate: { v: 1.5, t: 30 } });
  assert.deepStrictEqual(m.pulled, { gkey: { v: 'K2', t: 20 }, rate: { v: 1.5, t: 30 } });
  assert.strictEqual(m.prefs.gstyle.v, 'warm');
  assert.ok(m.remoteChanged, 'the newer style goes up');
});

test('settings: a fresh device takes the key; on a tie a set value beats an empty one, and nothing else moves', () => {
  const fresh = S.mergePrefs({ gkey: { v: '', t: 0 } }, { gkey: { v: 'K', t: 1 } });
  assert.deepStrictEqual(fresh.pulled, { gkey: { v: 'K', t: 1 } });
  const tieEmpty = S.mergePrefs({ gkey: { v: '', t: 1 } }, { gkey: { v: 'K', t: 1 } });
  assert.deepStrictEqual(tieEmpty.pulled, { gkey: { v: 'K', t: 1 } });
  const tieBoth = S.mergePrefs({ gengine: { v: 'm:a', t: 1 } }, { gengine: { v: 'm:b', t: 1 } });
  assert.deepStrictEqual(tieBoth.pulled, {}); assert.ok(!tieBoth.remoteChanged, 'automatic differences never ping-pong');
  const agree = S.mergePrefs({ gkey: { v: 'K', t: 5 } }, { gkey: { v: 'K', t: 5 } });
  assert.ok(!agree.remoteChanged); assert.deepStrictEqual(agree.pulled, {});
});

test('settings: a removal made later wins, a field kept to this device is neither sent nor taken, unknown fields stay on Drive', () => {
  const cleared = S.mergePrefs({ gkey: { v: 'K', t: 5 } }, { gkey: { v: '', t: 9 } });
  assert.deepStrictEqual(cleared.pulled, { gkey: { v: '', t: 9 } });
  const kept = S.mergePrefs({ gkey: { v: '', t: 99 }, rate: { v: 2, t: 99 } }, { gkey: { v: 'K', t: 5 }, future: { v: 'x', t: 1 } }, ['gkey']);
  assert.deepStrictEqual(kept.pulled, {});
  assert.deepStrictEqual(kept.prefs, { gkey: { v: 'K', t: 5 }, future: { v: 'x', t: 1 }, rate: { v: 2, t: 99 } });
});

function prefsDevice(initial, values, skip) {
  const st = device(initial);
  st.values = values || {}; st.skip = skip || [];
  st.store.prefs = () => ({ values: JSON.parse(JSON.stringify(st.values)), skip: st.skip });
  st.store.setPrefs = async p => { for (const k in p) st.values[k] = p[k]; };
  return st;
}
const blank = () => ({ gkey: { v: '', t: 0 }, gengine: { v: '', t: 0 }, voiceURI: { v: '', t: 0 }, gstyle: { v: 'Read this aloud', t: 0 }, rate: { v: 1, t: 0 } });

test('two devices: the key and voice from the desktop reach a new phone; a removal everywhere reaches it too', async () => {
  const fd = fakeDrive(), drive = S.createDrive(() => 'tok', fd.fetchImpl);
  const desktop = prefsDevice([], Object.assign(blank(), { gkey: { v: 'AIzaKEY', t: 1 }, gengine: { v: 'm:gemini-flash-lite-tts', t: 1 }, voiceURI: { v: 'm:Sulafat', t: 300 }, rate: { v: 1.25, t: 200 } }));
  const phone = prefsDevice([], blank());

  await S.runSync(drive, desktop.store, now);
  const file = [...fd.files.values()].find(f => f.name === S.PREFS);
  assert.ok(file, 'prefs.json is kept in the app data folder');
  assert.strictEqual(JSON.parse(file.body).prefs.gkey.v, 'AIzaKEY');

  let r = await S.runSync(drive, phone.store, now);
  assert.deepStrictEqual(r.prefs.sort(), ['gengine', 'gkey', 'rate', 'voiceURI']);
  assert.strictEqual(phone.values.gkey.v, 'AIzaKEY');
  assert.strictEqual(phone.values.voiceURI.v, 'm:Sulafat');
  assert.strictEqual(phone.values.rate.v, 1.25);
  assert.strictEqual(phone.values.gstyle.v, 'Read this aloud', 'an untouched default stays as it is');

  phone.values.voiceURI = { v: 'm:Kore', t: 500 }; // a new voice picked on the phone
  await S.runSync(drive, phone.store, now);
  r = await S.runSync(drive, desktop.store, now);
  assert.deepStrictEqual(r.prefs, ['voiceURI']);
  assert.strictEqual(desktop.values.voiceURI.v, 'm:Kore');

  desktop.values.gkey = { v: '', t: 900 }; // removed from all devices
  await S.runSync(drive, desktop.store, now);
  await S.runSync(drive, phone.store, now);
  assert.strictEqual(phone.values.gkey.v, '');
});

test('a key removed from one device only stays on Drive and on the others, and is not taken back there', async () => {
  const fd = fakeDrive(), drive = S.createDrive(() => 'tok', fd.fetchImpl);
  const desktop = prefsDevice([], Object.assign(blank(), { gkey: { v: 'K', t: 1 } }));
  await S.runSync(drive, desktop.store, now);
  const loaner = prefsDevice([], Object.assign(blank(), { gkey: { v: '', t: 50 } }), ['gkey']);
  const r = await S.runSync(drive, loaner.store, now);
  assert.ok(!r.prefs.includes('gkey'));
  assert.strictEqual(loaner.values.gkey.v, '');
  const onDrive = JSON.parse([...fd.files.values()].find(f => f.name === S.PREFS).body).prefs;
  assert.strictEqual(onDrive.gkey.v, 'K');
});

test('an older app version that does not share settings leaves them alone on Drive', async () => {
  const fd = fakeDrive(), drive = S.createDrive(() => 'tok', fd.fetchImpl);
  await S.runSync(drive, prefsDevice([], Object.assign(blank(), { gkey: { v: 'K', t: 1 } })).store, now);
  const before = [...fd.files.values()].find(f => f.name === S.PREFS).body;
  const old = device([{ id: 'b', title: 'Book', added: 1, chapters: [{ title: 'c', paras: ['p'] }] }]);
  await S.runSync(drive, old.store, now);
  assert.strictEqual([...fd.files.values()].find(f => f.name === S.PREFS).body, before);
});
