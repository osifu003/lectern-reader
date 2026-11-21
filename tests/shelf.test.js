// Run with: node --test tests/shelf.test.js
const test = require('node:test');
const assert = require('node:assert');
const Sh = require('../shelf.js');
const Sy = require('../sync.js');

const bk = (id, title, extra) => Object.assign({ id, title, added: +id.replace(/\D/g, '') || 1, chapters: [{ title: 'Pages 1–10', paras: ['Some text.'] }] }, extra || {});
const lib0 = () => ({ folders: {}, items: {} });
const shelfOf = (v, id) => v.where.get(id).shelf;
const order = sh => sh.items.map(x => x.b.id);

test('file names give the book, the chapter number and a clean title', () => {
  const p = Sh.parseName;
  assert.deepStrictEqual([p('Kandarpa Handbook - Chapter 3 - Arterial Access').book, p('Kandarpa Handbook - Chapter 3 - Arterial Access').n, p('Kandarpa Handbook - Chapter 3 - Arterial Access').title], ['Kandarpa Handbook', 3, 'Arterial Access']);
  assert.strictEqual(p('Ch03_Arterial_Access.pdf').n, 3);
  assert.strictEqual(p('Ch03_Arterial_Access.pdf').title, 'Arterial Access');
  assert.deepStrictEqual([p('05 Venous Access').n, p('05 Venous Access').title], [5, 'Venous Access']);
  assert.deepStrictEqual([p('Abrams Angiography Chapter IV Aortic Arch').n, p('Abrams Angiography Chapter IV Aortic Arch').title], [4, 'Aortic Arch']);
  assert.deepStrictEqual([p('kandarpa ch 4 venous access (1)').book, p('kandarpa ch 4 venous access (1)').title], ['Kandarpa', 'Venous Access']);
  assert.strictEqual(p('Image-Guided Interventions Ch.7 TIPS').title, 'TIPS'); // capitals are kept
  assert.strictEqual(p('3D Printing in Medicine').n, null); // a number that is part of the title is not a chapter
  assert.strictEqual(p('Approach 3 to the liver').n, null);
  const els = p('1-s2.0-B9780323613415000035-main');
  assert.deepStrictEqual([els.isbn, els.seq], ['9780323613415', 3]);
});

test('the first page names the chapter when the file name does not', () => {
  const b = bk('b1', 'scan0042', { chapters: [{ title: 'Pages 1–10', paras: ['Chapter 12 Thoracic Duct Embolization', 'The thoracic duct…'] }] });
  const d = Sh.detect(b);
  assert.strictEqual(d.n, 12);
  assert.strictEqual(d.title, 'Thoracic Duct Embolization');
  const els = bk('b2', '1-s2.0-B9780323613415000035-main', { src: { title: 'Arterial Access', subject: 'Image-Guided Interventions (Third Edition), 2020, Pages 23-30' } });
  const e = Sh.detect(els);
  assert.deepStrictEqual([e.title, e.book, e.key], ['Arterial Access', 'Image-Guided Interventions (Third Edition)', 'isbn:9780323613415']);
});

test('chapters of one book already in the library are gathered into a folder, in chapter order', () => {
  const books = [bk('b1', 'Kandarpa Ch 10 Biliary'), bk('b2', 'Kandarpa Ch 2 Venous Access'), bk('b3', 'Kandarpa Ch 1 Arterial Access'), bk('b4', 'Moby Dick')];
  const v = Sh.view(books, lib0());
  const sh = shelfOf(v, 'b1');
  assert.ok(!sh.single && sh.auto);
  assert.strictEqual(sh.title, 'Kandarpa');
  assert.deepStrictEqual(order(sh), ['b3', 'b2', 'b1']); // 1, 2, 10 (not 1, 10, 2)
  assert.deepStrictEqual(sh.items.map(x => x.n), [1, 2, 10]);
  assert.deepStrictEqual(sh.items.map(x => x.label), ['Arterial Access', 'Venous Access', 'Biliary']);
  assert.ok(shelfOf(v, 'b4').single);
  assert.deepStrictEqual(v.shelves.map(s => s.title), ['Kandarpa', 'Moby Dick']);
});

test('a single chapter stays on its own until a second chapter of its book arrives', () => {
  const one = Sh.view([bk('b1', 'Kandarpa Ch 3 Renal')], lib0());
  assert.ok(shelfOf(one, 'b1').single);
  const two = Sh.view([bk('b1', 'Kandarpa Ch 3 Renal'), bk('b2', 'kandarpa - chapter 4 - hepatic')], lib0());
  assert.strictEqual(shelfOf(two, 'b1').id, shelfOf(two, 'b2').id);
});

test('a longer form of the same book name joins it', () => {
  const v = Sh.view([bk('b1', 'Kandarpa Ch 3 Renal'), bk('b2', 'Kandarpa Handbook - Chapter 4 - Hepatic'), bk('b3', 'Kandarpa Handbook Ch 5')], lib0());
  assert.strictEqual(shelfOf(v, 'b1').id, shelfOf(v, 'b2').id);
  assert.strictEqual(shelfOf(v, 'b3').title, 'Kandarpa Handbook');
  const w = Sh.view([bk('b1', 'Liver Ch 3'), bk('b2', 'Liver Transplant Ch 4')], lib0()); // too short a name to be sure
  assert.notStrictEqual(shelfOf(w, 'b1').id, shelfOf(w, 'b2').id);
  const all = [bk('b1', 'Kandarpa Ch 3 Renal'), bk('b2', 'Kandarpa Ch 4 Hepatic')], add = [bk('n1', 'Kandarpa Handbook Ch 6'), bk('n2', 'Kandarpa Handbook Ch 7')];
  const p = Sh.placeBatch(add, lib0(), all.concat(add));
  assert.deepStrictEqual([p.id, p.existing], [Sh.view(all, lib0()).where.get('b1').shelf.id, true]);
});

test('the automatic folder id is the same on every device', () => {
  const a = Sh.view([bk('b1', 'Kandarpa Ch 3'), bk('b2', 'Kandarpa Ch 4')], lib0());
  const b = Sh.view([bk('b2', 'Kandarpa Ch 4'), bk('b1', 'Kandarpa Ch 3')], lib0());
  assert.strictEqual(shelfOf(a, 'b1').id, shelfOf(b, 'b1').id);
});

test('front matter goes first, appendices last, numbered chapters between', () => {
  const books = [bk('b1', 'Atlas - Index'), bk('b2', 'Atlas - Chapter 2 - Veins'), bk('b3', 'Atlas - Preface'), bk('b4', 'Atlas - Chapter 1 - Arteries')];
  const sh = shelfOf(Sh.view(books, lib0()), 'b1');
  assert.deepStrictEqual(order(sh), ['b3', 'b4', 'b2', 'b1']);
});

test('what the reader set by hand wins: folder, number, title and order', () => {
  const books = [bk('b1', 'Kandarpa Ch 1 A'), bk('b2', 'Kandarpa Ch 2 B'), bk('b3', 'Loose notes')];
  const id = shelfOf(Sh.view(books, lib0()), 'b1').id;
  const lib = {
    folders: { [id]: { title: 'Handbook of Interventional Radiology', key: 'kandarpa', t: 5 } },
    items: { b3: { f: id, n: 7, title: 'My notes', t: 6 }, b1: { f: id, o: 2, t: 5 }, b2: { f: id, o: 0, t: 5 } }
  };
  const v = Sh.view(books, lib);
  const sh = shelfOf(v, 'b1');
  assert.strictEqual(sh.title, 'Handbook of Interventional Radiology');
  assert.deepStrictEqual(order(sh), ['b2', 'b1', 'b3']); // b3 has no place set: after the ones placed by hand
  assert.deepStrictEqual(sh.items.find(x => x.b.id === 'b3').label, 'My notes');
  assert.strictEqual(v.shelves.length, 1);
  // a renamed folder still takes new chapters of the same book
  const v2 = Sh.view(books.concat(bk('b9', 'Kandarpa Ch 9 New')), lib);
  assert.strictEqual(shelfOf(v2, 'b9').id, id);
});

test('a folder taken apart stays apart, and an entry on its own keeps a chapter out of folders', () => {
  const books = [bk('b1', 'Kandarpa Ch 1 A'), bk('b2', 'Kandarpa Ch 2 B')];
  const id = shelfOf(Sh.view(books, lib0()), 'b1').id;
  const lib = { folders: { [id]: { title: 'Kandarpa', gone: true, t: 9 } }, items: { b1: { f: '', t: 9 }, b2: { f: '', t: 9 } } };
  const v = Sh.view(books.concat(bk('b3', 'Kandarpa Ch 3 C'), bk('b4', 'Kandarpa Ch 4 D')), lib);
  assert.ok(['b1', 'b2', 'b3', 'b4'].every(b => shelfOf(v, b).single));
});

test('an empty folder made by hand is listed; removed books leave nothing behind', () => {
  const v = Sh.view([], { folders: { f1: { title: 'Abrams', t: 1 } }, items: { gone: { f: 'f1', t: 1 } } });
  assert.deepStrictEqual(v.shelves.map(s => [s.title, s.items.length]), [['Abrams', 0]]);
});

test('files added together: one folder for one book, named from what they share', () => {
  const lib = lib0();
  const a = [bk('n1', 'Kandarpa Ch 5 Renal'), bk('n2', 'Kandarpa Ch 6 Hepatic')];
  const p = Sh.placeBatch(a, lib, a);
  assert.deepStrictEqual([p.title, p.existing], ['Kandarpa', false]);
  assert.strictEqual(p.id, Sh.autoId('kandarpa'));
  const b = [bk('n3', '05 Renal'), bk('n4', '06 Hepatic'), bk('n5', '07 Biliary')];
  assert.strictEqual(Sh.placeBatch(b, lib, b).title, 'New book');
  const c = [bk('n6', 'Moby Dick'), bk('n7', 'War and Peace')];
  assert.strictEqual(Sh.placeBatch(c, lib, c), null);
  const d = [bk('n8', 'Abrams 12'), bk('n9', 'Abrams 13')];
  assert.strictEqual(Sh.placeBatch(d, lib, d).title, 'Abrams');
  const has = { folders: { f1: { title: 'Kandarpa', t: 1 } }, items: {} };
  const e = Sh.placeBatch(a, has, a);
  assert.deepStrictEqual([e.id, e.existing], ['f1', true]);
});

test('sync: newest entry wins, removed books drop their entries, old taken-apart folders expire', () => {
  const now = 1_800_000_000_000;
  const local = { folders: { f1: { title: 'Mine', t: 10 }, old: { title: 'x', gone: true, t: now - 200 * 864e5 } }, items: { a: { f: 'f1', t: 10 }, b: { f: 'f1', t: 3 }, del: { f: 'f1', t: 1 } } };
  const remote = { folders: { f1: { title: 'Theirs', t: 12 }, f2: { title: 'New', t: 1 } }, items: { a: { f: '', t: 8 }, b: { f: 'f2', t: 7 } } };
  const m = Sy.mergeLib(local, remote, { del: now - 1000 }, now);
  assert.deepStrictEqual(m.lib, { folders: { f1: { title: 'Theirs', t: 12 }, f2: { title: 'New', t: 1 } }, items: { a: { f: 'f1', t: 10 }, b: { f: 'f2', t: 7 } } });
  assert.ok(m.remoteChanged && m.localChanged);
  const same = Sy.mergeLib(m.lib, JSON.parse(JSON.stringify(m.lib)), {}, now);
  assert.ok(!same.remoteChanged && !same.localChanged);
});

test('sync: library.json travels with the books, and a version without folders is left alone', async () => {
  const files = new Map(); let n = 0;
  const drive = {
    async list() { return [...files.values()].map(f => ({ id: f.id, name: f.name, modifiedTime: '', appProperties: f.props })); },
    async read(id) { return JSON.parse(JSON.stringify([...files.values()].find(f => f.id === id).data)); },
    async write(id, name, data, props) { id = id || 'F' + (++n); files.set(id, { id, name: files.get(id) ? files.get(id).name : name, data: JSON.parse(JSON.stringify(data)), props }); return { id }; },
    async remove(id) { files.delete(id); }
  };
  const mkStore = (books, lib) => {
    const st = { books: () => books, positions: () => ({}), tombs: () => ({}), putBook: async b => books.push(b), dropBook: async () => {}, markSynced: async () => {}, setPositions() {}, clearTombs() {} };
    if (lib) { st.libv = lib; st.lib = () => st.libv; st.setLib = async l => { st.libv = l; }; }
    return st;
  };
  const A = mkStore([bk('b1', 'Kandarpa Ch 1 A'), bk('b2', 'Kandarpa Ch 2 B')], { folders: { f1: { title: 'Handbook', t: 5 } }, items: { b1: { f: 'f1', t: 5 }, b2: { f: 'f1', t: 5 } } });
  await Sy.runSync(drive, A, 1e12);
  assert.ok([...files.values()].some(f => f.name === 'library.json'));
  const old = mkStore([], null); // an app version from before book folders
  await Sy.runSync(drive, old, 1e12);
  const B = mkStore([], { folders: {}, items: {} });
  const r = await Sy.runSync(drive, B, 1e12);
  assert.ok(r.lib);
  assert.deepStrictEqual(B.libv.folders.f1.title, 'Handbook');
  assert.strictEqual(Sh.view(B.books(), B.libv).where.get('b1').shelf.title, 'Handbook');
});
