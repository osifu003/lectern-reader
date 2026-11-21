// Book folders: chapters that came from the same book sit together, in chapter order, like a table of contents.
// Pure logic (no DOM), so it can be tested without a browser; app.js draws the library from view().
//
// The organization is kept apart from the books themselves (lib: { folders, items }), so moving or renaming
// never re-uploads a book, and app versions that don't know about folders keep working with the same books.
//   folders: { id: { title, key?, t, gone? } }          a book folder; key ties it to chapters detected as that book
//   items:   { bookId: { f, n?, title?, o?, t } }       f: folder id ('' = on its own); n, title: chapter number and
//                                                       title set by hand; o: place set by hand; t: when changed
// Anything without an entry is placed automatically from its file name and first page; nothing is written until the
// reader changes something, so every device works out the same arrangement on its own.
(function (root) {
  'use strict';

  const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', 'from', 'into', 'per']);
  const FRONT = /^(preface|foreword|introduction|contents|table of contents|acknowledg|dedication|about (the|this)|contributors|abbreviations|how to use|front matter|title page|copyright)/i;
  const BACK = /^(index|appendix|appendices|glossary|references|bibliography|answers|back matter|further reading)/i;
  const CH = /(^|[\s\-–—_.,:;(\[])(chapter|chap|ch)\.?\s*[-#:]?\s*(\d{1,3}|[ivxlc]{1,7})(?![\w])/i;
  const ELS = /B(97[89]\d{10})(\d{5})[\dX]/i; // Elsevier book-chapter PII, as in ScienceDirect/ClinicalKey downloads

  function roman(s) {
    const v = { i: 1, v: 5, x: 10, l: 50, c: 100 }; let n = 0;
    s = s.toLowerCase();
    for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] || 0; n += a < b ? -a : a; }
    return n > 0 && n < 400 ? n : null;
  }
  const num = s => /^\d/.test(s) ? +s : roman(s);

  // A file name as words: no extension, underscores, "(1)" download copies or "- Copy".
  function tidy(s) {
    return String(s || '')
      .replace(/\.(pdf|epub|docx?|txt|md|markdown|html?)$/i, '')
      .replace(/%20/g, ' ')
      .replace(/[_+]+/g, ' ')
      .replace(/\s*\((\d{1,2}|copy)\)\s*$/i, '')
      .replace(/\s*[-–]\s*copy$/i, '')
      .replace(/\s+/g, ' ').trim();
  }
  const edgeTrim = s => String(s || '').replace(/^[\s\-–—:;.,|#)\]]+|[\s\-–—:;,|#(\[]+$/g, '').trim();
  function niceCase(s) {
    s = String(s || '');
    if (!/\s/.test(s) && /[a-z][A-Z]/.test(s)) s = s.replace(/([a-z])([A-Z])/g, '$1 $2'); // ArterialAccess
    if (/[a-z]/.test(s) && s === s.toLowerCase()) { // all lower case: capitalise the words that a title capitalises
      s = s.split(' ').map((w, i) => i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    return s;
  }
  // Comparison form of a book name: case, accents and punctuation don't matter.
  const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

  // What a title or file name says: which book, which chapter number, and the chapter's own title.
  function parseName(raw) {
    let s = tidy(raw);
    const out = { n: null, title: '', book: '', isbn: '', seq: null };
    const e = ELS.exec(s);
    if (e) {
      out.isbn = e[1]; out.seq = +e[2];
      s = edgeTrim(s.replace(e[0], ' ').replace(/\b\d-s2\.0-?/i, ' ').replace(/(^|\s)-?main\b/i, ' ').replace(/\s+/g, ' '));
    }
    let title = s, book = '';
    const m = CH.exec(s);
    if (m && num(m[3]) != null) {
      out.n = num(m[3]);
      book = s.slice(0, m.index + m[1].length);
      title = s.slice(m.index + m[0].length);
    } else {
      const lead = /^(\d{1,3})(?:\s*[.):\-–—]\s*|\s+)(?=[A-Za-z])/.exec(s);
      if (lead) { out.n = +lead[1]; title = s.slice(lead[0].length); }
      else {
        const sep = /\s+[-–—|]\s+|:\s+/.exec(s);
        if (sep) { book = s.slice(0, sep.index); title = s.slice(sep.index + sep[0].length); out.split = true; }
      }
    }
    out.book = niceCase(edgeTrim(book));
    out.title = niceCase(edgeTrim(title));
    return out;
  }

  // A book name from a PDF's Subject, as publishers write it ("Image-Guided Interventions, 2020, Pages 23-30").
  function bookFromSubject(subject) {
    const s = String(subject || '').split(/,\s*(?=\(?\d{4}|pages?\b|pp\b|vol|doi|chapter)|\.\s*doi|doi:/i)[0].trim();
    return s.length >= 3 && s.length <= 120 && !/^(doi|http)/i.test(s) ? s : '';
  }

  // Everything known about one library item: { n, title, book, key, seq, part }.
  // part: 0 front matter, 1 numbered chapter, 2 other, 3 back matter (for ordering when there is no number).
  // bare: removes Skip-text marks from a line (skip.js), so the first page can be read.
  function detect(b, bare) {
    bare = bare || (x => x);
    const src = b.src || {};
    const p = parseName(b.title || src.file || '');
    const meta = src.title ? parseName(src.title) : null;
    const codeLike = !p.title || !!p.isbn || /^(main|document|untitled|scan(ned)?|img|image|file|download|book|chapter|doc)?[\s\d_\-.]*$/i.test(p.title);
    if (meta && codeLike && (meta.title || meta.n != null)) {
      if (meta.title) p.title = meta.title;
      if (p.n == null) p.n = meta.n;
      if (!p.book) p.book = meta.book;
    }
    const ch0 = b.chapters && b.chapters[0];
    if (ch0) { // "Chapter 12" on the first page, or a section title of that form
      const lines = [ch0.title].concat((ch0.paras || []).slice(0, 4)).map(x => bare(String(x || '')).replace(/\s+/g, ' ').trim());
      for (const l of lines) {
        const m = /^chapter\s+(\d{1,3}|[ivxlc]{1,7})\b[\s.:\-–—]*/i.exec(l);
        if (!m || num(m[1]) == null) continue;
        if (p.n == null) p.n = num(m[1]);
        const rest = edgeTrim(l.slice(m[0].length));
        if ((!p.title || codeLike) && rest && rest.length <= 90) p.title = niceCase(rest);
        break;
      }
    }
    let book = p.book;
    if (!book && p.isbn) book = bookFromSubject(src.subject) || 'Book ' + p.isbn;
    const key = p.isbn ? 'isbn:' + p.isbn : norm(book);
    const t = p.title || '';
    const part = p.n != null ? 1 : FRONT.test(t) ? 0 : BACK.test(t) ? 3 : 2;
    return { n: p.n, title: t, book, key, seq: p.seq, part };
  }

  function hash(s) { // FNV-1a, so every device names an automatic folder the same way
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  const autoId = key => 'k' + hash(key);
  // Two names for the same book, one longer: "Kandarpa" and "Kandarpa Handbook". The shorter must be a real name.
  const extends_ = (long, short) => long === short || (!/^isbn:/.test(long) && short.length >= 6 && long.startsWith(short + ' '));
  const sameBook = (a, b) => !!a && !!b && (extends_(a, b) || extends_(b, a));
  const byTitle = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  // The longest shared beginning of several titles, cut at a word ("Kandarpa 05", "Kandarpa 06" → "Kandarpa").
  function commonName(titles) {
    const ts = titles.map(tidy);
    if (ts.length < 2) return '';
    let p = ts[0];
    for (const t of ts) { let i = 0; while (i < p.length && i < t.length && p[i].toLowerCase() === t[i].toLowerCase()) i++; p = p.slice(0, i); }
    if (ts.some(t => t.length > p.length && /\w/.test(t[p.length] || '') && /\w$/.test(p))) p = p.replace(/\S+$/, '');
    p = edgeTrim(p.replace(CH, '$1').replace(/\b(chapter|chap|ch)\.?\s*$/i, ''));
    return p.length >= 3 && /[A-Za-z]/.test(p) ? niceCase(p) : '';
  }

  // The library as the reader sees it. items: books (not the built-in sample); lib: { folders, items }.
  // Returns { shelves: [...], where: Map(bookId → { shelf, idx }) } with shelves in title order. A shelf is
  // { id, title, key, auto, single, items: [{ b, n, title, label, explicit }] }; single shelves are a book on its own.
  function view(items, lib, bare) {
    lib = lib || {};
    const F = lib.folders || {}, E = lib.items || {};
    const det = new Map(items.map(b => [b.id, detect(b, bare)]));
    const shelves = new Map(), byKey = new Map();
    for (const id in F) {
      if (!F[id] || F[id].gone) continue;
      const s = { id, title: F[id].title || 'Untitled book', key: F[id].key || '', auto: false, single: false, items: [] };
      shelves.set(id, s);
    }
    for (const s of shelves.values()) if (s.key && !byKey.has(s.key)) byKey.set(s.key, s);
    for (const s of shelves.values()) { const k = norm(s.title); if (k && !byKey.has(k)) byKey.set(k, s); }
    const loose = [], pending = new Map();
    for (const b of items) {
      const e = E[b.id], d = det.get(b.id);
      if (e) { if (e.f && shelves.has(e.f)) shelves.get(e.f).items.push(b); else loose.push(b); continue; }
      let s = d.key && byKey.get(d.key);
      if (!s && d.key) for (const [k, x] of byKey) if (sameBook(k, d.key)) { s = x; break; }
      if (s) { s.items.push(b); continue; }
      if (d.key) { if (!pending.has(d.key)) pending.set(d.key, []); pending.get(d.key).push(b); }
      else loose.push(b);
    }
    for (const key of [...pending.keys()].sort((a, b) => a.length - b.length)) { // "Kandarpa Handbook" joins "Kandarpa"
      const short = [...pending.keys()].find(k => k !== key && k.length < key.length && sameBook(k, key));
      if (short) { pending.get(short).push(...pending.get(key)); pending.delete(key); }
    }
    for (const [key, list] of pending) { // two or more chapters of the same book: a folder of their own
      const id = autoId(key);
      if (list.length < 2 || F[id]) { loose.push(...list); continue; } // F[id] here is a folder the reader took apart
      const name = list.map(b => det.get(b.id).book).sort((a, b) => b.length - a.length)[0];
      shelves.set(id, { id, title: name, key, auto: true, single: false, items: list });
    }
    const entry = b => {
      const e = E[b.id] || {}, d = det.get(b.id);
      const n = 'n' in e ? (e.n == null ? null : +e.n) : d.n;
      const title = e.title ? e.title : d.title;
      return { b, n, title, label: title || (n != null ? 'Chapter ' + n : niceCase(tidy(b.title)) || 'Untitled'), o: e.o, part: n != null ? 1 : 'n' in e ? 2 : d.part, seq: d.seq, explicit: !!E[b.id] };
    };
    const natural = (a, b) => a.part - b.part || (a.part === 1 ? a.n - b.n : 0)
      || ((a.seq == null ? 1e9 : a.seq) - (b.seq == null ? 1e9 : b.seq)) || (a.b.added || 0) - (b.b.added || 0) || byTitle(a.label, b.label);
    const out = [];
    for (const s of shelves.values()) {
      s.items = s.items.map(entry).sort(natural);
      if (s.items.some(x => x.o != null)) { // placed by hand: that order, anything newer after it in natural order
        const rank = new Map(s.items.map((x, i) => [x, i]));
        s.items.sort((a, b) => (a.o == null ? 1e9 + rank.get(a) : a.o) - (b.o == null ? 1e9 + rank.get(b) : b.o));
      }
      out.push(s);
    }
    for (const b of loose) {
      const e = E[b.id] || {}, t = e.title || niceCase(tidy(b.title)) || b.title; // a lone file's name, tidied
      out.push({ id: b.id, title: t, key: '', auto: false, single: true, items: [{ b, n: null, title: t, label: t, explicit: !!E[b.id] }] });
    }
    out.sort((a, b) => byTitle(a.title, b.title));
    const where = new Map();
    for (const s of out) s.items.forEach((x, idx) => where.set(x.b.id, { shelf: s, idx }));
    return { shelves: out, where };
  }

  // Where several files added together belong: a folder when they are chapters of one book.
  // Returns null, or { id, title, key, existing } (existing: a folder already in the library).
  function placeBatch(added, lib, all, bare) {
    if (added.length < 2) return null;
    const ds = added.map(b => detect(b, bare));
    const keys = new Set(ds.map(d => d.key));
    const v = view(all, lib, bare);
    const older = s => !s.single && (!s.auto || s.items.some(x => !added.includes(x.b))); // a folder that was there before these files
    if (keys.size === 1 && ds[0].key) {
      const key = ds[0].key;
      const has = v.shelves.find(s => older(s) && (sameBook(s.key, key) || sameBook(norm(s.title), key)));
      if (has) return { id: has.id, title: has.title, key, existing: true };
      const name = ds.map(d => d.book).sort((a, b) => b.length - a.length)[0];
      return { id: autoId(key), title: name, key, existing: false };
    }
    const common = commonName(added.map(b => b.title));
    const numbered = ds.filter(d => d.n != null).length;
    if (common || numbered >= Math.max(2, added.length - 1)) {
      const has = common && v.shelves.find(s => older(s) && sameBook(norm(s.title), norm(common)));
      if (has) return { id: has.id, title: has.title, key: has.key, existing: true };
      return { id: common ? autoId(norm(common)) : 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: common || 'New book', key: common ? norm(common) : '', existing: false };
    }
    return null;
  }

  const api = { parseName, detect, view, placeBatch, commonName, tidy, niceCase, norm, autoId, bookFromSubject };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LecternShelf = api;
})(typeof self !== 'undefined' ? self : this);
