(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  const WPM = 175;
  const S = window.LecternSkip; // skip.js: what is left out of narration
  const Shelf = window.LecternShelf; // shelf.js: book folders and chapter order

  /* ---------- sample (public domain: Lewis Carroll, 1865) ---------- */
  const SAMPLE = {
    id: 'sample-alice', sample: true,
    title: 'Alice’s Adventures in Wonderland (sample)',
    chapters: [
      { title: 'Down the Rabbit-Hole', paras: [
        'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use of a book,” thought Alice “without pictures or conversations?”',
        'So she was considering in her own mind (as well as she could, for the hot day made her feel very sleepy and stupid), whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies, when suddenly a White Rabbit with pink eyes ran close by her.',
        'There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, “Oh dear! Oh dear! I shall be late!” But when the Rabbit actually took a watch out of its waistcoat-pocket, and looked at it, and then hurried on, Alice started to her feet, for it flashed across her mind that she had never before seen a rabbit with either a waistcoat-pocket, or a watch to take out of it, and burning with curiosity, she ran across the field after it, and fortunately was just in time to see it pop down a large rabbit-hole under the hedge.',
        'In another moment down went Alice after it, never once considering how in the world she was to get out again.',
        'The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down, so suddenly that Alice had not a moment to think about stopping herself before she found herself falling down a very deep well.',
        'Either the well was very deep, or she fell very slowly, for she had plenty of time as she went down to look about her and to wonder what was going to happen next. First, she tried to look down and make out what she was coming to, but it was too dark to see anything; then she looked at the sides of the well, and noticed that they were filled with cupboards and book-shelves; here and there she saw maps and pictures hung upon pegs.'
      ]},
      { title: 'The Pool of Tears', paras: [
        '“Curiouser and curiouser!” cried Alice (she was so much surprised, that for the moment she quite forgot how to speak good English); “now I’m opening out like the largest telescope that ever was! Good-bye, feet!” (for when she looked down at her feet, they seemed to be almost out of sight, they were getting so far off).',
        '“Oh, my poor little feet, I wonder who will put on your shoes and stockings for you now, dears? I’m sure I shan’t be able! I shall be a great deal too far off to trouble myself about you: you must manage the best way you can;—but I must be kind to them,” thought Alice, “or perhaps they won’t walk the way I want to go! Let me see: I’ll give them a new pair of boots every Christmas.”'
      ]}
    ]
  };



  /* ---------- storage ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('lectern', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  async function idb(mode, fn, store = 'books') {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const tx = d.transaction(store, mode);
        const rq = fn(tx.objectStore(store));
        tx.oncomplete = () => res(rq && rq.result);
        tx.onerror = tx.onabort = () => rej(tx.error);
      });
    } catch { persistOk = false; return undefined; }
  }
  let persistOk = true;

  /* ---------- state ---------- */
  const DEFAULTS = { font: 'book', size: 20, lh: 1.7, width: 66, word: true, focus: false, scroll: true, voice: true, rate: 1, voiceURI: '', gkey: '', glang: '', gengine: '', gstyle: 'Read this aloud as a warm, natural audiobook narrator:', theme: 'auto', skip: 'square,curly,url,sup,vert' };
  const settings = Object.assign({}, DEFAULTS, ls.get('lectern.settings', {}));
  let positions = ls.get('lectern.pos', {});
  let lib = readLib(); // book folders and chapter placement (shelf.js); synced as library.json
  const openShelves = new Set(ls.get('lectern.shelfOpen', [])); let editing = '';
  let books = [SAMPLE];
  let book = SAMPLE, ci = 0, si = 0;
  let sents = [], suffix = [];
  let models = new Map(), chunkCache = new Map();
  // Google Chirp 3 HD voice engine; tts stays null until a working key is saved
  let tts = null, claudeVoices = [], pgen = 0, pseq = 0, pcur = null, plines = new Map(), pline = null, plastMs = 0, pk = 1, pStarted = 0, pmark = 0;
  let gModels = [], gOcrModel = '', ocrJob = null, ocrCtl = null, pPaused = null, gAll = [], wired = false;
  let gdrive = ls.get('lectern.drive', null), syncChain = Promise.resolve(), syncTimer = null, posDirty = false, firstSync = true, booksReady = null, syncing = false;
  let playing = false, tok = 0, timers = [], words = [], wordOn = null, activeEl = null, keep = null;

  const reader = $('reader'), stage = $('stage');

  /* ---------- text helpers ---------- */
  const segmenter = (window.Intl && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const HEAD = /^(chapter|part|book|section|prologue|epilogue|introduction|preface)\b.{0,70}$/i;

  function chaptersFromBlocks(blocks, fallbackTitle) {
    const chapters = []; let cur = null;
    for (const b of blocks) {
      if (!b.t) continue;
      const plain = S.scrub(b.t);
      const isHead = b.h || (plain.length < 80 && HEAD.test(plain) && !/[.,;]$/.test(plain));
      if (isHead) { cur = { title: plain, paras: [] }; chapters.push(cur); continue; }
      if (!cur) { cur = { title: fallbackTitle || 'Beginning', paras: [] }; chapters.push(cur); }
      cur.paras.push(b.t);
    }
    let out = chapters.filter(c => c.paras.length);
    if (out.length === 1 && out[0].paras.length > 120) {
      const all = out[0].paras; out = [];
      for (let i = 0; i < all.length; i += 60) out.push({ title: 'Part ' + (out.length + 1), paras: all.slice(i, i + 60) });
    }
    return out;
  }
  function textToBlocks(text) {
    text = text.replace(/\r\n?/g, '\n');
    const chunks = /\n\s*\n/.test(text) ? text.split(/\n\s*\n+/) : text.split('\n');
    return chunks.map(c => ({ t: clean(c.replace(/^#{1,6}\s+/, '')), h: /^#{1,3}\s+\S/.test(c.trim()) }));
  }
  function markInline(root) { // superscripts, subscripts and note references keep a mark in the text, for Skip text
    const kindOf = el => {
      const n = el.localName, st = (el.getAttribute('style') || '').toLowerCase(), ty = (el.getAttribute('epub:type') || '') + ' ' + (el.getAttribute('role') || '');
      if (n === 'sup' || /vertical-align\s*:\s*super/.test(st) || /\bnoteref\b/.test(ty)) return 'sup';
      if (n === 'sub' || /vertical-align\s*:\s*sub\b/.test(st)) return 'sub';
      return null;
    };
    const els = Array.from(root.querySelectorAll('sup,sub,a,span,[style]')).filter(el => kindOf(el));
    for (const el of els) {
      if (!el.isConnected) continue;
      let up = el.parentElement, inside = false;
      while (up && up !== root) { if (kindOf(up)) { inside = true; break; } up = up.parentElement; }
      if (!inside && !el.querySelector('p,div,li,blockquote,td,h1,h2,h3,h4,h5,h6')) el.textContent = S.wrap(el.textContent, kindOf(el));
    }
  }
  function domBlocks(root) {
    const sel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,div,td,dd,dt';
    const out = [];
    root.querySelectorAll('script,style,nav,noscript').forEach(n => n.remove());
    markInline(root);
    const els = root.querySelectorAll(sel);
    if (!els.length) { const t = clean(root.textContent || ''); return t ? [{ t }] : []; }
    els.forEach(el => {
      if (el.querySelector(sel)) return;
      const t = clean(el.textContent || '');
      if (t) out.push({ t, h: /^h[1-3]$/i.test(el.localName) });
    });
    return out;
  }

  /* ---------- book folders ---------- */
  function readLib() {
    const v = ls.get('lectern.lib', null);
    return { folders: (v && v.folders) || {}, items: (v && v.items) || {} };
  }
  function saveLib() { ls.set('lectern.lib', lib); syncSoon(); }
  const saveOpen = () => ls.set('lectern.shelfOpen', [...openShelves]);
  const userBooks = () => books.filter(b => !b.sample);
  const shelfView = () => Shelf.view(userBooks(), lib, S.bare);
  function placeOf(id) { // { shelf, idx, item } for a book in the library, or null for the built-in sample
    const w = shelfView().where.get(id);
    return w ? Object.assign({ item: w.shelf.items[w.idx] }, w) : null;
  }
  // Before the reader changes a folder that was put together automatically, write its arrangement down, so it stays
  // exactly as they see it on every device.
  function materialize(shelfId, t) {
    t = t || Date.now();
    const s = shelfView().shelves.find(x => x.id === shelfId);
    if (!s || s.single) return s;
    if (!lib.folders[s.id] || lib.folders[s.id].gone) lib.folders[s.id] = { title: s.title, key: s.key || undefined, t };
    for (const x of s.items) if (!lib.items[x.b.id]) lib.items[x.b.id] = { f: s.id, t };
    return s;
  }
  function setItem(id, patch) {
    const w = placeOf(id); if (!w) return;
    if (!w.shelf.single) materialize(w.shelf.id);
    const cur = lib.items[id] || { f: w.shelf.single ? '' : w.shelf.id };
    const next = Object.assign({}, cur, patch, { t: Date.now() });
    for (const k in next) if (next[k] === undefined) delete next[k];
    lib.items[id] = next;
  }

  /* ---------- importers ---------- */
  const loaded = {};
  function loadScript(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('Could not load the file reader. Check your connection and try again.')); };
      document.head.appendChild(s);
    }));
  }
  const JSZIP = 'vendor/jszip.min.js';
  const PDFJS = 'vendor/pdf.min.js';
  const PDFWK = 'vendor/pdf.worker.min.js';

  function parseXml(str, type) {
    let doc = new DOMParser().parseFromString(str, type);
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(str, 'text/html');
    return doc;
  }
  function resolvePath(base, href) {
    const parts = (base ? base.split('/') : []).concat(decodeURIComponent(href.split('#')[0]).split('/'));
    const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    return out.join('/');
  }
  async function parseEpub(file, name) {
    await loadScript(JSZIP);
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const container = zip.file('META-INF/container.xml');
    if (!container) throw new Error('This does not look like a valid EPUB file.');
    const cdoc = parseXml(await container.async('string'), 'application/xml');
    const opfPath = cdoc.querySelector('rootfile').getAttribute('full-path');
    const opf = parseXml(await zip.file(opfPath).async('string'), 'application/xml');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const tEl = opf.getElementsByTagNameNS('*', 'title')[0];
    const manifest = {};
    Array.from(opf.getElementsByTagNameNS('*', 'item')).forEach(it => manifest[it.getAttribute('id')] = it.getAttribute('href'));
    const spine = Array.from(opf.getElementsByTagNameNS('*', 'itemref')).map(r => manifest[r.getAttribute('idref')]).filter(Boolean);
    const chapters = [];
    for (let i = 0; i < spine.length; i++) {
      status(`Reading section ${i + 1} of ${spine.length}…`);
      const f = zip.file(resolvePath(base, spine[i]));
      if (!f) continue;
      const doc = parseXml(await f.async('string'), 'application/xhtml+xml');
      const body = doc.body || doc.documentElement;
      const blocks = domBlocks(body);
      if (!blocks.length) continue;
      let title = '';
      if (blocks[0].h) title = S.scrub(blocks.shift().t);
      const paras = blocks.map(b => b.t);
      if (!paras.length) continue;
      if (paras.join(' ').length < 200 && !title && chapters.length) { chapters[chapters.length - 1].paras.push(...paras); continue; }
      chapters.push({ title: title || 'Section ' + (chapters.length + 1), paras });
    }
    return { title: clean(tEl ? tEl.textContent : '') || name, chapters };
  }
  async function parseDocx(file, name) {
    await loadScript(JSZIP);
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('This does not look like a valid Word document.');
    const doc = parseXml(await f.async('string'), 'application/xml');
    const kid = (el, name) => Array.from(el.childNodes).filter(n => n.nodeName === name);
    const blocks = Array.from(doc.getElementsByTagName('w:p')).map(p => {
      const style = p.getElementsByTagName('w:pStyle')[0];
      const t = clean(Array.from(p.getElementsByTagName('w:r')).map(r => { // raised and lowered runs keep a mark, for Skip text
        const txt = kid(r, 'w:t').map(n => n.textContent).join('');
        const pr = kid(r, 'w:rPr')[0], va = pr && kid(pr, 'w:vertAlign')[0], v = va && va.getAttribute('w:val');
        return v === 'superscript' ? S.wrap(txt, 'sup') : v === 'subscript' ? S.wrap(txt, 'sub') : S.scrub(txt);
      }).join(''));
      return { t, h: !!style && /^(heading\s?[12]|title)$/i.test(style.getAttribute('w:val') || '') };
    });
    return { title: name, chapters: chaptersFromBlocks(blocks, name) };
  }
  async function parsePdf(file, name, batch) {
    await loadScript(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFWK;
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true }).promise;
    const pages = [null]; // the text lines of each page
    for (let n = 1; n <= pdf.numPages; n++) {
      status(`${batch || ''}Reading page ${n} of ${pdf.numPages}…`);
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const kinds = S.pdfKinds(tc.items, tc.styles); // superscripts, subscripts and vertical text keep a mark, for Skip text
      const lines = []; let line = '';
      tc.items.forEach((it, x) => {
        if (typeof it.str !== 'string') return;
        line += kinds[x] ? S.wrap(it.str, kinds[x]) : S.scrub(it.str);
        if (it.hasEOL) { lines.push(line); line = ''; }
      });
      lines.push(line, '');
      pages.push(lines);
      page.cleanup();
    }
    const paragraphs = (from, to) => {
      const lines = [].concat(...pages.slice(from, to + 1));
      const lens = lines.map(l => S.bare(l).trim().length).filter(Boolean).sort((a, b) => a - b);
      const full = lens.length ? lens[Math.floor(lens.length * 0.9)] : 0;
      const paras = []; let cur = '';
      const flush = () => { const t = clean(cur); if (t) paras.push(t); cur = ''; };
      for (const raw of lines) {
        const l = raw.trim();
        const lb = S.bare(l).trim(); // the line without its superscripts and margin text, for judging where it ends
        if (!l) { if (/[.!?]["”’)]?$/.test(S.bare(cur).trim())) flush(); continue; }
        if (/^\d{1,4}$/.test(l)) continue; // bare page numbers
        cur = /[A-Za-z]-$/.test(cur) ? cur.slice(0, -1) + l : (cur ? cur + ' ' + l : l);
        if (/[.!?]["”’)]?$/.test(lb) && lb.length < full * 0.8) flush();
      }
      flush();
      return paras;
    };
    const span = (a, b) => a === b ? `Page ${a}` : `Pages ${a}–${b}`;
    const chapters = [];
    const marks = await pdfOutline(pdf); // the PDF's own bookmarks give real chapter titles when it has them
    if (marks.length >= 2) {
      if (marks[0].page > 1) marks.unshift({ page: 1, title: 'Opening pages' });
      marks.forEach((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].page - 1 : pdf.numPages;
        const parts = Math.ceil((end - m.page + 1) / 30); // very long sections are read in parts
        for (let k = 0; k < parts; k++) {
          const a = m.page + k * 30, b = Math.min(end, a + 29);
          const paras = paragraphs(a, b);
          if (paras.length) chapters.push({ title: parts > 1 ? `${m.title} (part ${k + 1} of ${parts})` : m.title, paras });
        }
      });
    } else {
      for (let start = 1; start <= pdf.numPages; start += 10) {
        const end = Math.min(pdf.numPages, start + 9);
        const paras = paragraphs(start, end);
        if (paras.length) chapters.push({ title: span(start, end), paras });
      }
    }
    const chars = chapters.reduce((a, c) => a + c.paras.join('').length, 0);
    if (chars / pdf.numPages < 40) { // image-only pages: offer to read them with Cloud Vision
      if (!settings.gkey) throw new Error('This PDF is scanned images with no selectable text. Add your Google key in Settings and the app can read it.');
      if (batch) throw new Error(`“${name}” is scanned pages. Add it on its own to read it with Google.`);
      offerOcr({ title: name, key: 'pdf:' + file.name + ':' + file.size, n: pdf.numPages, blob: n => pdfPageBlob(pdf, n) });
      return null;
    }
    let info = {};
    try { info = (await pdf.getMetadata()).info || {}; } catch {}
    return { title: name, src: { file: file.name, title: clean(String(info.Title || '')).slice(0, 200), subject: clean(String(info.Subject || '')).slice(0, 300) }, chapters };
  }
  async function pdfOutline(pdf) { // [{ page, title }] from the top level of the bookmarks (or the level under a single top entry)
    try {
      let ol = await pdf.getOutline();
      if (!ol || !ol.length) return [];
      if (ol.length === 1 && ol[0].items && ol[0].items.length > 1) ol = ol[0].items;
      const out = [];
      for (const it of ol.slice(0, 400)) {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest) || dest[0] == null) continue;
        const page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
        const title = clean(S.scrub(String(it.title || '')));
        if (!title || !(page >= 1 && page <= pdf.numPages)) continue;
        if (out.length && out[out.length - 1].page === page) continue; // two bookmarks on one page: the first names it
        out.push({ page, title });
      }
      out.sort((a, b) => a.page - b.page);
      return out.filter((m, i) => !i || m.page !== out[i - 1].page);
    } catch { return []; }
  }
  async function pdfPageBlob(pdf, n) {
    const page = await pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(3, Math.sqrt(1.5e6 / (v1.width * v1.height))) });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('That page could not be drawn.')), 'image/jpeg', 0.85));
  }

  /* ---------- scanned pages, read with Google Cloud Vision ---------- */
  function offerOcr(job) {
    ocrJob = job; status('');
    $('ocrMsg').textContent = job.images
      ? `Reading ${job.n} page image${job.n === 1 ? '' : 's'}…`
      : `“${job.title}” is a scanned book: ${job.n} pages of images with no selectable text. The app can read the pages with Google using your key, which counts toward your Google usage, so start with a range.`;
    $('ocrRange').hidden = !!job.images;
    $('ocrFrom').max = $('ocrTo').max = job.n;
    $('ocrFrom').value = 1; $('ocrTo').value = Math.min(job.n, 20);
    $('ocrGo').hidden = !!job.images; $('ocrGo').disabled = false; $('ocrStop').hidden = true;
    $('ocrBox').hidden = false;
  }
  const OCR_COPY = { cancelled: 'Stopped.' };
  async function runOcr(from, to) {
    const job = ocrJob; if (!job || ocrCtl) return;
    const per = 4;
    const ctl = ocrCtl = new AbortController();
    $('ocrGo').disabled = true; $('ocrStop').hidden = false;
    const done = []; let fail = null;
    try {
      for (let a = from; a <= to && !ctl.signal.aborted; a += per) {
        const nums = []; for (let n = a; n < a + per && n <= to; n++) nums.push(n);
        status(`Reading page${nums.length > 1 ? 's' : ''} ${nums[0]}${nums.length > 1 ? '–' + nums[nums.length - 1] : ''} of ${to}…`);
        const blobs = []; for (const n of nums) blobs.push(await job.blob(n));
        if (ctl.signal.aborted) break;
        const pages = await ocrRead(blobs, nums, ctl.signal);
        pages.forEach((paras, i) => done.push({ n: nums[i], paras }));
      }
    } catch (e) { fail = e || {}; }
    ocrCtl = null; $('ocrStop').hidden = true; $('ocrGo').disabled = false;
    const why = ctl.signal.aborted ? OCR_COPY.cancelled : fail ? (OCR_COPY[fail.code] || fail.message && !fail.code && fail.message || 'Reading was interrupted.') : '';
    done.sort((x, y) => x.n - y.n);
    const chapters = [];
    for (const pg of done) {
      if (!pg.paras.length) continue;
      const lastCh = chapters[chapters.length - 1];
      if (lastCh && pg.n - lastCh.pg < 10) { lastCh.paras.push(...pg.paras); lastCh.end = pg.n; }
      else chapters.push({ pg: pg.n, end: pg.n, paras: pg.paras.slice() });
    }
    chapters.forEach(c => { c.title = job.images ? (chapters.length > 1 ? `Images ${c.pg}–${c.end}` : 'Scanned pages') : c.pg === c.end ? `Page ${c.pg}` : `Pages ${c.pg}–${c.end}`; });
    if (!chapters.length) { status((why ? why + ' ' : '') + 'No text was read from those pages.', true); if (job.images) $('ocrBox').hidden = true; return; }
    const lastPage = done[done.length - 1].n;
    const existing = !job.images && books.find(b => b.ocrKey === job.key);
    if (existing) {
      const starts = new Set(chapters.map(c => c.pg));
      existing.chapters = existing.chapters.filter(c => !starts.has(c.pg)).concat(chapters).sort((x, y) => (x.pg || 0) - (y.pg || 0));
      existing.synced = false; existing.updated = Date.now();
      await idb('readwrite', s => s.put(existing));
      syncSoon(existing);
      if (book.id === existing.id) openBook(existing.id); else renderBooks();
    } else {
      await addBookQuiet({ title: job.title, ocrKey: job.key, chapters });
    }
    if (job.images) { $('ocrBox').hidden = true; ocrJob = null; }
    else if (lastPage < job.n) { $('ocrFrom').value = lastPage + 1; $('ocrTo').value = Math.min(job.n, lastPage + 20); }
    const msg = (why ? why + ' ' : '') + (job.images ? `Added ${done.length} page${done.length === 1 ? '' : 's'}.` : `${done[0].n === lastPage ? 'Page ' + lastPage + ' is' : 'Pages ' + done[0].n + '–' + lastPage + ' are'} in your library${lastPage < job.n ? '. Read the next range when you are ready.' : '.'}`);
    status(msg, !!why && why !== OCR_COPY.cancelled);
  }
  async function addBookQuiet(b) {
    b.id = newId();
    b.added = Date.now(); books.push(b);
    await idb('readwrite', s => s.put(b));
    syncSoon(b);
    openBook(b.id);
  }
  const newId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  async function importFiles(files) {
    if (ocrCtl) { status('Wait for the current pages to finish, or press Stop.', true); return; }
    const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
    if (!imgs.length) {
      $('ocrBox').hidden = true; ocrJob = null;
      if (/\.json$/i.test(files[0].name)) return importBackup(files[0]);
      return importDocs(files.filter(f => !/\.json$/i.test(f.name)));
    }
    if (!settings.gkey) { status('Reading page photos needs your Google key. Add it in Settings.', true); return; }
    const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const good = imgs.filter(f => !okTypes.length || okTypes.includes(f.type));
    if (!good.length) { status('Those image types are not supported. Use JPEG or PNG photos of the pages.', true); return; }
    good.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    offerOcr({ images: true, title: good[0].name.replace(/\.[^.]+$/, '') + (good.length > 1 ? ` (${good.length} pages)` : ''), key: 'img:' + Date.now(), n: good.length, blob: n => shrinkImage(good[n - 1]) });
    runOcr(1, good.length);
  }
  // Several files at once (a book's chapters, say) are all added; chapters of one book go into that book's folder.
  async function importDocs(files) {
    files = files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const added = [], failed = [];
    for (let i = 0; i < files.length; i++) {
      const tag = files.length > 1 ? `${i + 1} of ${files.length} · ` : '';
      try { const b = await importFile(files[i], tag); if (b) added.push(b); }
      catch (e) { failed.push(e && e.message ? e.message : `“${files[i].name}” could not be opened.`); if (files.length === 1) { status(failed[0], true); return; } }
    }
    if (!added.length) { if (failed.length) status(failed.join(' '), true); return; }
    const place = Shelf.placeBatch(added, lib, userBooks(), S.bare);
    if (place) {
      const t = Date.now();
      if (!place.existing) lib.folders[place.id] = { title: place.title, key: place.key || undefined, t };
      else materialize(place.id, t);
      for (const b of added) lib.items[b.id] = { f: place.id, t };
      saveLib();
    }
    const v = shelfView(), w = v.where.get(added[0].id);
    const first = place ? v.where.get(added[0].id).shelf.items.find(x => added.includes(x.b)).b : added[0];
    openBook(first.id);
    const fail = failed.length ? ' ' + failed.join(' ') : '';
    const keep = !persistOk ? ' This browser is not saving books, so they will be gone when you close the page.' : '';
    if (place || (w && !w.shelf.single)) {
      const sh = v.where.get(first.id).shelf;
      openShelves.add(sh.id); saveOpen();
      if (sh.title === 'New book') editing = sh.id;
      renderBooks();
      status((added.length === 1 ? `Added “${v.where.get(added[0].id).shelf.items[v.where.get(added[0].id).idx].label}” to “${sh.title}”.` : `Added ${added.length} chapters to “${sh.title}”.`)
        + (sh.title === 'New book' ? ' Give the book its name above.' : '') + keep + fail, !!fail);
      return;
    }
    status((added.length === 1 ? `Added “${added[0].title}”.` : `Added ${added.length} books.`) + keep + fail, !!fail);
    if (!fail) $('libraryDlg').close();
  }
  async function importFile(file, tag) {
    const name = file.name.replace(/\.[^.]+$/, '');
    const ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    status(tag + 'Opening ' + file.name + '…');
    let b;
    if (ext === 'epub') b = await parseEpub(file, name);
    else if (ext === 'pdf') b = await parsePdf(file, name, tag);
    else if (ext === 'docx') b = await parseDocx(file, name);
    else if (ext === 'doc') throw new Error(`“${file.name}”: older .doc files are not supported. Save it as .docx or PDF and try again.`);
    else if (ext === 'html' || ext === 'htm') {
      const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
      b = { title: clean(doc.title) || name, chapters: chaptersFromBlocks(domBlocks(doc.body), name) };
    } else b = { title: name, chapters: chaptersFromBlocks(textToBlocks(await file.text()), name) };
    if (!b) return null;
    if (!b.chapters || !b.chapters.length) throw new Error(`No readable text was found in “${file.name}”.`);
    if (!b.src) b.src = { file: file.name };
    b.id = newId(); b.added = Date.now();
    books.push(b);
    await idb('readwrite', s => s.put(b));
    syncSoon(b);
    return b;
  }
  async function addBook(b) { // pasted text
    if (!b.chapters || !b.chapters.length) throw new Error('No readable text was found in that file.');
    b.id = newId();
    b.added = Date.now();
    books.push(b);
    await idb('readwrite', s => s.put(b));
    syncSoon(b);
    status(persistOk ? `Added “${b.title}”.` : `Added “${b.title}”. This browser is not saving books, so it will be gone when you close the page.`);
    openBook(b.id);
    $('libraryDlg').close();
  }

  /* ---------- rendering ---------- */
  function model(c) {
    let m = models.get(c);
    if (!m) {
      m = [];
      const o = S.options(settings.skip);
      book.chapters[c].paras.forEach((para, p) => { for (const x of S.passage(para, o, segmenter)) { x.p = p; m.push(x); } });
      models.set(c, m);
    }
    return m;
  }
  function openBook(id, at) {
    stop(); models = new Map(); chunkCache = new Map();
    book = books.find(b => b.id === id) || books[0];
    const p = at || positions[book.id] || { c: 0, s: 0 };
    ci = Math.min(Math.max(0, p.c || 0), book.chapters.length - 1);
    ls.set('lectern.last', book.id);
    header();
    renderChapter(p.s || 0);
    renderBooks();
  }
  // The top bar: the book's title, and a contents list. A chapter that sits in a book folder lists the whole book.
  function header() {
    const w = placeOf(book.id);
    $('bookTitle').textContent = w && !w.shelf.single ? w.shelf.title : w ? w.item.label : book.title;
    const sel = $('chapterSel'); sel.textContent = '';
    const cut = t => t.length > 60 ? t.slice(0, 58) + '…' : t;
    const opt = (parent, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = cut(text); parent.appendChild(o); };
    if (w && !w.shelf.single) {
      for (const x of w.shelf.items) {
        const name = (x.n != null ? x.n + '. ' : '') + x.label;
        if (x.b.chapters.length === 1) { opt(sel, x.b.id + ':0', name); continue; }
        const g = document.createElement('optgroup'); g.label = cut(name);
        x.b.chapters.forEach((c, i) => opt(g, x.b.id + ':' + i, c.title));
        sel.appendChild(g);
      }
    } else book.chapters.forEach((c, i) => opt(sel, book.id + ':' + i, c.title));
  }
  function neighbour(step) { // the chapter before or after this one in its book folder
    const w = placeOf(book.id);
    if (!w || w.shelf.single) return null;
    const x = w.shelf.items[w.idx + step];
    return x ? x.b : null;
  }
  function renderChapter(startAt) {
    const ch = book.chapters[ci];
    activeEl = null; wordOn = null; words = [];
    reader.textContent = ''; sents = [];
    const w = placeOf(book.id), inShelf = w && !w.shelf.single;
    const eb = document.createElement('p'); eb.className = 'eyebrow';
    const h = document.createElement('h2');
    const frag = document.createDocumentFragment(); frag.append(eb, h);
    if (inShelf) { // "Kandarpa Handbook · Chapter 3", the chapter's title, then which part of it this is
      eb.textContent = w.shelf.title + (w.item.n != null ? ` · Chapter ${w.item.n}` : '');
      h.textContent = w.item.label;
      if (book.chapters.length > 1) { const sub = document.createElement('p'); sub.className = 'subhead'; sub.textContent = `${ch.title} · ${ci + 1} of ${book.chapters.length}`; frag.appendChild(sub); }
    } else {
      eb.textContent = `${book.sample ? 'Sample · ' : ''}Chapter ${ci + 1} of ${book.chapters.length}`;
      h.textContent = ch.title;
    }
    let p = null, lastP = -1;
    for (const s of model(ci)) {
      if (s.p !== lastP) { p = document.createElement('p'); frag.appendChild(p); lastP = s.p; }
      const sp = document.createElement('span'); sp.className = 's'; sp.dataset.i = sents.length;
      const x = { el: sp, text: s.text, say: s.say, ws: s.words, skip: s.skip, marks: s.marks, n: s.words.length };
      sents.push(x); paint(sp, x, null);
      p.appendChild(sp);
    }
    reader.appendChild(frag);
    suffix = new Array(sents.length + 1).fill(0);
    for (let i = sents.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sents[i].n;
    $('chapterSel').value = book.id + ':' + ci; mediaMeta();
    $('seek').max = Math.max(0, sents.length - 1);
    $('prevCh').hidden = ci === 0 && !neighbour(-1);
    $('nextCh').hidden = ci >= book.chapters.length - 1 && !neighbour(1);
    si = Math.min(Math.max(0, startAt || 0), Math.max(0, sents.length - 1));
    stage.scrollTop = 0;
    activate(si, si > 0);
  }
  // Draws a sentence: skipped text stays on the page, dimmed; superscripts and subscripts are raised and lowered.
  // With out, each spoken word gets its own span for the highlight; at is its place in what is spoken.
  function paint(el, s, out) {
    if (!out && !s.skip.length && !s.marks.length) { el.textContent = s.text; return; }
    el.textContent = '';
    const piece = (parent, a, b) => {
      const pts = [a, b];
      for (const r of s.skip.concat(s.marks)) for (const x of [r[0], r[1]]) if (x > a && x < b) pts.push(x);
      pts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < pts.length; k++) {
        const x = pts[k], y = pts[k + 1]; if (x >= y) continue;
        let node = document.createTextNode(s.text.slice(x, y));
        const mk = s.marks.find(r => r[0] <= x && y <= r[1]);
        if (mk && mk[2] !== 'vert') { const e = document.createElement(mk[2]); e.appendChild(node); node = e; }
        if (s.skip.some(r => r[0] <= x && y <= r[1])) { const e = document.createElement('span'); e.className = 'skip'; e.appendChild(node); node = e; }
        parent.appendChild(node);
      }
    };
    let at = 0;
    if (out) for (const w of s.ws) {
      piece(el, at, w.a);
      const sp = document.createElement('span'); sp.className = 'w'; piece(sp, w.a, w.b); el.appendChild(sp);
      out.push({ el: sp, at: w.at, len: w.t.length, t: w.t }); at = w.b;
    }
    piece(el, at, s.text.length);
  }
  function deactivate() {
    if (!activeEl) return;
    const s = sents[+activeEl.dataset.i];
    paint(activeEl, s, null); activeEl.classList.remove('on');
    activeEl.parentNode.classList.remove('live');
    activeEl = null; words = []; wordOn = null;
  }
  function activate(i, scroll) {
    deactivate();
    const s = sents[i]; if (!s) return;
    si = i; activeEl = s.el;
    s.el.classList.add('on'); s.el.parentNode.classList.add('live');
    if (settings.word) paint(s.el, s, words);
    if (scroll !== false && settings.scroll) {
      const r = s.el.getBoundingClientRect(), v = stage.getBoundingClientRect();
      if (r.top < v.top + v.height * 0.15 || r.bottom > v.top + v.height * 0.7) {
        stage.scrollTo({ top: stage.scrollTop + r.top - v.top - v.height * 0.3 });
      }
    }
    updateProgress();
    const prev = positions[book.id];
    if (prev ? (prev.c !== ci || prev.s !== si) : (ci > 0 || si > 0)) {
      positions[book.id] = { c: ci, s: si, t: Date.now() }; ls.set('lectern.pos', positions);
      posDirty = true; schedulePos(15000);
    }
  }
  function setWord(k) {
    if (wordOn) wordOn.classList.remove('on');
    wordOn = words[k] ? words[k].el : null;
    if (wordOn) wordOn.classList.add('on');
  }
  function setWordByChar(c) {
    let k = -1;
    for (let j = 0; j < words.length; j++) { if (words[j].at <= c) k = j; else break; }
    if (k >= 0) setWord(k);
  }
  function updateProgress() {
    $('seek').value = si;
    $('posLabel').textContent = sents.length ? `${si + 1} / ${sents.length}` : '–';
    const mins = suffix[si] / (WPM * settings.rate);
    $('leftLabel').textContent = mins < 1 ? 'under 1 min left' : `${Math.round(mins)} min left`;
  }
  /* ---------- library: book folders, each opening to its contents ---------- */
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function libChanged() { // the arrangement changed by hand here
    saveLib(); header();
    if (!playing) renderChapter(si); else $('chapterSel').value = book.id + ':' + ci;
    renderBooks();
  }
  function renderBooks() {
    const ul = $('books'); ul.textContent = '';
    const v = shelfView(), here = v.where.get(book.id);
    const list = v.shelves.concat([{ id: SAMPLE.id, title: SAMPLE.title, single: true, sample: true, items: [{ b: SAMPLE, label: SAMPLE.title }] }]);
    if (editing && !list.some(x => x.id === editing)) editing = '';
    for (const sh of list) ul.appendChild(shelfEl(sh, sh.sample ? book.id === SAMPLE.id : !!here && here.shelf.id === sh.id, v));
  }
  function shelfMeta(sh) {
    if (!sh.single) {
      if (!sh.items.length) return 'No chapters yet';
      let last = null; // the chapter read most recently
      for (const x of sh.items) { const p = positions[x.b.id]; if (p && (!last || (p.t || 0) > (positions[last.b.id].t || 0))) last = x; }
      last = sh.items.find(x => x.b.id === book.id) || last; // the chapter open now
      return plural(sh.items.length, 'chapter') + (last ? ' · reading ' + (last.n != null ? 'chapter ' + last.n : '“' + last.label + '”') : '');
    }
    const b = sh.items[0].b, p = positions[b.id];
    return plural(b.chapters.length, 'chapter') + (p && b.chapters.length > 1 ? ` · at chapter ${Math.min(p.c, b.chapters.length - 1) + 1}` : '') + (b.sample ? ' · built-in example' : '');
  }
  function shelfEl(sh, isCur, v) {
    const li = mk('li', 'shelf' + (sh.single ? ' single' : ' folder') + (isCur ? ' cur' : ''));
    if (editing === sh.id) { li.classList.add('open', 'editing'); li.append(...(sh.single ? editSingle(sh, v) : editFolder(sh, v))); return li; }
    const open = openShelves.has(sh.id);
    li.classList.toggle('open', open);
    const head = mk('div', 'shelf-head');
    const tog = mk('button', 'shelf-toggle'); tog.type = 'button'; tog.setAttribute('aria-expanded', open ? 'true' : 'false');
    const ico = mk('span', 'shelf-ico'); ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = sh.single ? '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 11h7M9 15h7" stroke="currentColor" stroke-width="1.7"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    const txt = mk('span', 'shelf-txt');
    txt.append(mk('span', 'st', sh.title), mk('span', 'sm', shelfMeta(sh)));
    const caret = mk('span', 'caret'); caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    tog.append(ico, txt, caret);
    tog.onclick = () => { if (openShelves.has(sh.id)) openShelves.delete(sh.id); else openShelves.add(sh.id); saveOpen(); renderBooks(); };
    head.appendChild(tog);
    if (!sh.sample) {
      const ed = mk('button', 'btn quiet edit', 'Edit'); ed.type = 'button';
      ed.setAttribute('aria-label', 'Edit ' + sh.title);
      ed.onclick = () => { editing = sh.id; renderBooks(); };
      head.appendChild(ed);
    }
    li.appendChild(head);
    if (open) li.appendChild(sh.single ? sectionsToc(sh.items[0].b) : chaptersToc(sh));
    return li;
  }
  function tocRow(num, title, cur, onOpen, note) {
    const row = mk('li', cur ? 'cur' : '');
    const btn = mk('button', 'toc-row'); btn.type = 'button';
    btn.append(mk('span', 'tn', num == null ? '' : String(num)), mk('span', 'tt', title));
    if (note) btn.appendChild(mk('span', 'tm', note));
    btn.onclick = () => { onOpen(); $('libraryDlg').close(); };
    row.appendChild(btn);
    return row;
  }
  function chaptersToc(sh) { // a book folder: its chapters, numbered as the book numbers them
    const ol = mk('ol', 'toc');
    if (!sh.items.length) { ol.appendChild(mk('li', 'toc-empty', 'Move chapters here with Edit, or add a book’s chapter files together.')); return ol; }
    for (const x of sh.items) ol.appendChild(tocRow(x.n, x.label, x.b.id === book.id, () => openBook(x.b.id), x.b.id === book.id ? 'Reading' : ''));
    return ol;
  }
  function sectionsToc(b) { // a book on its own: the chapters inside it
    const ol = mk('ol', 'toc');
    const p = positions[b.id];
    b.chapters.forEach((c, i) => {
      const cur = b.id === book.id && i === ci;
      ol.appendChild(tocRow(i + 1, c.title, cur, () => openBook(b.id, p && p.c === i ? null : { c: i, s: 0 }), cur ? 'Reading' : ''));
    });
    return ol;
  }

  // Editing: names, chapter numbers, order, which book a chapter belongs to.
  function editHead(sh, label) {
    const head = mk('div', 'shelf-head edit-head');
    const inp = mk('input', 'edit-title'); inp.type = 'text'; inp.value = sh.title; inp.setAttribute('aria-label', label);
    inp.onchange = () => {
      const t = clean(inp.value); if (!t) { inp.value = sh.title; return; }
      if (sh.single) setItem(sh.items[0].b.id, { title: t === Shelf.niceCase(Shelf.tidy(sh.items[0].b.title)) ? undefined : t });
      else { materialize(sh.id); lib.folders[sh.id] = Object.assign({}, lib.folders[sh.id], { title: t, t: Date.now() }); }
      libChanged();
    };
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
    const done = mk('button', 'btn primary', 'Done'); done.type = 'button';
    done.onclick = () => { if (document.activeElement === inp) inp.onchange(); editing = ''; openShelves.add(sh.id); saveOpen(); renderBooks(); };
    head.append(inp, done);
    if (sh.title === 'New book') setTimeout(() => { if (inp.isConnected) { inp.focus(); inp.select(); } }, 30);
    return head;
  }
  function moveSel(b, from, v) { // "Move to…": another book folder, a new one, or on its own
    const sel = mk('select', 'move'); sel.setAttribute('aria-label', 'Move to another book');
    const add = (value, text) => { const o = mk('option', '', text); o.value = value; sel.appendChild(o); };
    add('', from.single ? 'Put in a book…' : 'Move to…');
    for (const s of v.shelves) if (!s.single && s.id !== from.id) add(s.id, s.title);
    add('__new', 'A new book…');
    if (!from.single) add('__own', 'On its own');
    sel.onchange = () => {
      const to = sel.value; if (!to) return;
      let target = to;
      if (to === '__own') target = '';
      else if (to === '__new') {
        target = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        lib.folders[target] = { title: Shelf.detect(b, S.bare).book || 'New book', t: Date.now() };
        editing = target;
      } else materialize(to);
      setItem(b.id, { f: target, o: undefined });
      if (target) openShelves.add(target); saveOpen();
      libChanged();
    };
    return sel;
  }
  function removeBtn(b) {
    const del = mk('button', 'btn quiet danger', 'Remove'); del.type = 'button';
    del.setAttribute('aria-label', 'Remove ' + b.title + ' from the library');
    del.onclick = async () => {
      if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Remove for good?'; setTimeout(() => { del.dataset.sure = ''; del.textContent = 'Remove'; }, 3500); return; }
      const w = placeOf(b.id);
      if (w && !w.shelf.single) materialize(w.shelf.id); // the rest of its book stays together
      books = books.filter(x => x.id !== b.id); delete positions[b.id]; ls.set('lectern.pos', positions);
      delete lib.items[b.id]; ls.set('lectern.lib', lib);
      await idb('readwrite', s => s.delete(b.id));
      if (gdrive) { const t = readTombs(); t[b.id] = Date.now(); ls.set('lectern.tomb', t); }
      syncSoon();
      if (book.id === b.id) openBook(books[0].id); else { header(); renderBooks(); }
    };
    return del;
  }
  function editSingle(sh, v) {
    const b = sh.items[0].b;
    const acts = mk('div', 'edit-acts');
    acts.append(moveSel(b, sh, v), removeBtn(b));
    return [editHead(sh, 'Title'), acts];
  }
  function editFolder(sh, v) {
    const ol = mk('ol', 'toc edit-list');
    sh.items.forEach((x, i) => {
      const row = mk('li', 'edit-row');
      const numIn = mk('input', 'num'); numIn.type = 'text'; numIn.inputMode = 'numeric'; numIn.value = x.n == null ? '' : x.n;
      numIn.placeholder = '#'; numIn.setAttribute('aria-label', 'Chapter number');
      numIn.onchange = () => { const t = numIn.value.trim(), n = parseInt(t, 10); setItem(x.b.id, { n: t === '' || !(n >= 0) ? null : n }); libChanged(); };
      const tIn = mk('input', 'etitle'); tIn.type = 'text'; tIn.value = x.label; tIn.setAttribute('aria-label', 'Chapter title');
      tIn.onchange = () => { const t = clean(tIn.value); setItem(x.b.id, { title: t || undefined }); libChanged(); };
      [numIn, tIn].forEach(el => { el.onkeydown = e => { if (e.key === 'Enter') el.blur(); }; });
      const up = mk('button', 'btn icon-btn', '↑'); up.type = 'button'; up.disabled = i === 0; up.setAttribute('aria-label', 'Move up');
      const dn = mk('button', 'btn icon-btn', '↓'); dn.type = 'button'; dn.disabled = i === sh.items.length - 1; dn.setAttribute('aria-label', 'Move down');
      up.onclick = () => reorder(sh, i, -1); dn.onclick = () => reorder(sh, i, 1);
      const line = mk('div', 'edit-line'); line.append(numIn, tIn);
      const acts = mk('div', 'edit-acts'); acts.append(up, dn, moveSel(x.b, sh, v), removeBtn(x.b));
      row.append(line, acts);
      ol.appendChild(row);
    });
    const foot = mk('div', 'edit-acts edit-foot');
    const loose = v.shelves.filter(s => s.single);
    if (loose.length) {
      const addSel = mk('select', 'move'); addSel.setAttribute('aria-label', 'Add a chapter from your library');
      const o0 = mk('option', '', 'Add a chapter…'); o0.value = ''; addSel.appendChild(o0);
      for (const s of loose) { const o = mk('option', '', s.title); o.value = s.items[0].b.id; addSel.appendChild(o); }
      addSel.onchange = () => { if (!addSel.value) return; materialize(sh.id); setItem(addSel.value, { f: sh.id, o: undefined }); libChanged(); };
      foot.appendChild(addSel);
    }
    if (sh.items.some(x => x.o != null)) {
      const sortB = mk('button', 'btn', 'Sort by chapter number'); sortB.type = 'button';
      sortB.onclick = () => { for (const x of sh.items) setItem(x.b.id, { o: undefined }); libChanged(); };
      foot.appendChild(sortB);
    }
    const apart = mk('button', 'btn quiet danger', sh.items.length ? 'Take apart' : 'Delete this book'); apart.type = 'button';
    apart.title = sh.items.length ? 'Its chapters stay in your library, each on its own' : '';
    apart.onclick = () => {
      if (apart.dataset.sure !== '1' && sh.items.length) { apart.dataset.sure = '1'; apart.textContent = 'Take apart? Chapters stay'; setTimeout(() => { apart.dataset.sure = ''; apart.textContent = 'Take apart'; }, 3500); return; }
      materialize(sh.id);
      for (const x of sh.items) setItem(x.b.id, { f: '', o: undefined });
      lib.folders[sh.id] = Object.assign({}, lib.folders[sh.id], { gone: true, t: Date.now() });
      editing = ''; openShelves.delete(sh.id); saveOpen();
      libChanged();
    };
    foot.appendChild(apart);
    return [editHead(sh, 'Book title'), ol, foot];
  }
  function reorder(sh, i, step) {
    const j = i + step; if (j < 0 || j >= sh.items.length) return;
    materialize(sh.id);
    const ids = sh.items.map(x => x.b.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const t = Date.now();
    ids.forEach((id, k) => { lib.items[id] = Object.assign({}, lib.items[id] || { f: sh.id }, { o: k, t }); });
    libChanged();
  }
  function newShelf() {
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    lib.folders[id] = { title: 'New book', t: Date.now() };
    editing = id; openShelves.add(id); saveOpen(); saveLib(); renderBooks();
  }

  /* ---------- backup ---------- */
  function exportBackup() {
    const data = { lectern: 1, saved: new Date().toISOString(), positions, lib, books: books.filter(b => !b.sample).map(b => { const c = Object.assign({}, b); delete c.synced; return c; }) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = 'lectern-library.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.lectern !== 1 || !Array.isArray(data.books)) throw new Error('That file is not a Lectern library backup.');
      let n = 0; const tombs = readTombs();
      for (const b of data.books) {
        if (!b || !b.id || !Array.isArray(b.chapters) || books.some(x => x.id === b.id)) continue;
        delete b.synced; b.updated = Date.now(); delete tombs[b.id]; // a restored book counts as added again, here and on other devices
        books.push(b); await idb('readwrite', st => st.put(b)); n++;
      }
      ls.set('lectern.tomb', tombs);
      for (const id in data.positions || {}) { const r = data.positions[id], l = positions[id]; if (!l || (r.t || 0) > (l.t || 0)) positions[id] = r; }
      ls.set('lectern.pos', positions);
      if (data.lib && SyncLib) { lib = SyncLib.mergeLib(lib, data.lib, {}).lib; ls.set('lectern.lib', lib); } // book folders come back too
      header(); renderBooks(); syncSoon();
      status(n ? `Restored ${n} book${n === 1 ? '' : 's'} and your reading positions.` : 'Every book in that backup is already here. Reading positions were updated.');
    } catch (e) { status(e.message || 'That backup could not be read.', true); }
  }

  /* ---------- sync through the reader's own Google Drive ---------- */
  // The OAuth client ID built in for every device (a public identifier, not a secret); a value saved in Settings overrides it.
  const DRIVE_CLIENT_ID = '213870681854-3r1oun4hg6q5okid6eod44j3mjjhnc9l.apps.googleusercontent.com';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const GIS = 'https://accounts.google.com/gsi/client';
  const SyncLib = window.LecternSync;
  const driveClient = () => (settings.driveClient || DRIVE_CLIENT_ID || '').trim();
  const tokenOk = () => !!(gdrive && gdrive.token && gdrive.exp > Date.now());
  const saveDrive = () => ls.set('lectern.drive', gdrive);
  const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  const appUrl = () => new URL('./', location.href).href;
  function readTombs() { const t = ls.get('lectern.tomb', {}); if (Array.isArray(t)) { const o = {}; t.forEach(id => { o[id] = Date.now(); }); return o; } return t || {}; }
  const drv = SyncLib && SyncLib.createDrive(() => tokenOk() ? gdrive.token : '');
  const store = {
    books: () => books.filter(b => !b.sample),
    positions: () => positions,
    tombs: readTombs,
    async putBook(b) {
      const i = books.findIndex(x => x.id === b.id);
      if (i >= 0) books[i] = b; else books.push(b);
      await idb('readwrite', s => s.put(b));
    },
    async dropBook(id) { books = books.filter(x => x.id !== id); await idb('readwrite', s => s.delete(id)); },
    async markSynced(id, v) {
      const b = books.find(x => x.id === id);
      if (!b || SyncLib.bookVersion(b) > v) return; // changed again while it was uploading: send it next time
      b.updated = v; b.synced = true; await idb('readwrite', s => s.put(b));
    },
    setPositions(p, tombs) { // keep any place this device moved to while the sync was running
      const out = {};
      for (const id of new Set([...Object.keys(p), ...Object.keys(positions)])) {
        if (tombs[id]) continue;
        const a = p[id], b = positions[id];
        out[id] = !a ? b : !b ? a : ((b.t || 0) > (a.t || 0) ? b : a);
      }
      positions = out; ls.set('lectern.pos', positions);
    },
    clearTombs(ids) { const t = readTombs(); ids.forEach(id => delete t[id]); ls.set('lectern.tomb', t); },
    prefs: () => ({ values: Object.fromEntries(PREF_KEYS.map(k => [k, { v: prefValue(k), t: prefT[k] || 0 }])), skip: prefsLocal() }),
    lib: () => JSON.parse(JSON.stringify(lib)),
    async setLib(pulled) { lib = SyncLib.mergeLib(lib, pulled, {}).lib; ls.set('lectern.lib', lib); }, // keeps any change made here while syncing
    async setPrefs(pulled) { applyPulledPrefs(pulled); }
  };

  /* ---------- the Google key and voice settings follow you through the same sync ---------- */
  // Each shared setting remembers when it was last changed by hand; the newest change wins on every device.
  const PREF_KEYS = (SyncLib && SyncLib.PREF_KEYS) || ['gkey', 'gengine', 'glang', 'gstyle', 'voiceURI', 'rate', 'skip'];
  const VOICE_KEYS = ['gkey', 'gengine', 'glang', 'voiceURI'];
  const prefValue = k => k === 'voiceURI' && !/^[gm]:/.test(settings.voiceURI) ? '' : settings[k]; // this device's own built-in voices stay here
  let prefT = ls.get('lectern.prefT', null);
  if (!prefT) { // first run with shared settings: anything already chosen here counts as an old change, so a fresh device takes it but no real change loses to it
    prefT = {};
    for (const k of PREF_KEYS) if (prefValue(k) !== DEFAULTS[k] && prefValue(k) !== '') prefT[k] = 1;
    ls.set('lectern.prefT', prefT);
  }
  function prefsLocal() { const v = ls.get('lectern.prefsLocal', []); return Array.isArray(v) ? v : []; }
  function setPrefLocal(k, on) { const v = prefsLocal().filter(x => x !== k); if (on) v.push(k); ls.set('lectern.prefsLocal', v); }
  function stampPref(...keys) { // a change made by hand: send it to the other devices
    const t = Date.now();
    for (const k of keys) prefT[k] = t; // choosing one of this device's own voices shares an empty voice, which other devices ignore
    ls.set('lectern.prefT', prefT); syncSoon();
  }
  function applyPulledPrefs(pulled) {
    const changed = [];
    for (const k in pulled) {
      if (!PREF_KEYS.includes(k)) continue;
      prefT[k] = pulled[k].t;
      let v = pulled[k].v;
      if (k === 'rate') { v = +v; if (!(v > 0)) continue; }
      else v = v == null ? '' : String(v);
      if (k === 'voiceURI' && !v) continue; // an empty shared voice leaves this device's own choice alone
      if (settings[k] !== v) { settings[k] = v; changed.push(k); }
    }
    ls.set('lectern.prefT', prefT);
    if (!changed.length) return;
    saveSettings();
    $('gKey').value = settings.gkey; $('gStyle').value = settings.gstyle;
    if (changed.includes('rate')) { applySettings(); updateProgress(); if (premium()) syncRate(); }
    if (changed.includes('skip')) { applySettings(); reskip(); }
    if (changed.some(k => VOICE_KEYS.includes(k))) {
      chunkCache = new Map();
      initGoogle().then(() => restartIfPlaying());
    } else if (changed.includes('gstyle')) restartIfPlaying();
    toast(changed.includes('gkey') ? (settings.gkey ? 'Your Google key and voice settings arrived from your other devices.' : 'Your Google key was removed on another device.') : changed.every(k => k === 'skip') ? 'Skip text settings updated from your other devices.' : 'Voice settings updated from your other devices.');
  }
  function renderKeyBtns() {
    const has = !!settings.gkey;
    $('gKeyBtns').hidden = !has;
    $('gRemoveHere').textContent = gdrive ? 'Remove from this device' : 'Remove key';
    $('gRemoveAll').hidden = !gdrive;
  }
  function removeKey(everywhere) {
    settings.gkey = ''; $('gKey').value = ''; saveSettings();
    if (everywhere) { setPrefLocal('gkey', false); stampPref('gkey'); }
    else setPrefLocal('gkey', true); // keep the copy in Drive for the other devices, and don't take it back here
    initGoogle(true).then(() => {
      gStatus(everywhere ? 'Key removed. Your other devices remove it the next time they sync.'
        : gdrive ? 'Key removed from this device only. Your other devices keep it. Save a key here to share it again.' : 'Key removed from this device.');
      renderKeyBtns();
    });
  }

  function syncSoon(ms) {
    if (!gdrive || !tokenOk()) { renderSync(); return; }
    clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), typeof ms === 'number' ? ms : 2000);
  }
  function schedulePos(ms) { if (gdrive && tokenOk()) syncSoon(ms); }
  function sync() {
    syncChain = syncChain.then(syncOnce, syncOnce);
    return syncChain;
  }
  async function syncOnce() {
    if (!gdrive || !drv) return;
    if (!tokenOk()) { renderSync(); return; }
    if (navigator.onLine === false) { gdrive.err = 'offline'; renderSync(); return; }
    await booksReady;
    syncing = true; renderSync(); posDirty = false;
    const wasBook = book.id, wasPos = positions[book.id] && Object.assign({}, positions[book.id]);
    try {
      const r = await SyncLib.runSync(drv, store);
      gdrive.last = Date.now(); gdrive.err = '';
      afterSync(r, wasBook, wasPos);
    } catch (e) {
      if (e.code === 'auth') { gdrive.token = ''; gdrive.err = ''; }
      else gdrive.err = e.code === 'offline' ? 'offline' : (e.message || 'Sync did not finish.');
    }
    syncing = false; saveDrive(); renderSync();
  }
  function afterSync(r, wasBook, wasPos) {
    const first = firstSync; firstSync = false;
    if (!books.some(b => b.id === book.id)) { openBook(books[0].id); }
    else if (!playing) {
      const cur = books.find(b => b.id === book.id), p = positions[book.id];
      const newer = p && r.pulled.includes(book.id) && (!wasPos || (p.t || 0) > (wasPos.t || 0)) && (p.c !== ci || p.s !== si);
      let latest = null; // on opening the app, carry on with whichever book was read most recently on any device
      if (first) for (const id in positions) if (books.some(b => b.id === id) && (!latest || (positions[id].t || 0) > (positions[latest].t || 0))) latest = id;
      if (first && latest && latest !== book.id && r.pulled.includes(latest) && (positions[latest].t || 0) > ((wasPos && wasPos.t) || 0)) {
        openBook(latest); toast('Picked up where you left off on another device.');
      } else if (newer || (cur !== book && r.downloadedIds.includes(book.id))) {
        openBook(book.id); if (newer) toast('Picked up where you left off on another device.');
      }
    }
    if (r.lib && books.some(b => b.id === book.id)) { // the arrangement changed on another device
      header(); $('chapterSel').value = book.id + ':' + ci;
      if (!playing) renderChapter(si);
    }
    if (r.downloaded || r.removed) {
      const parts = [];
      if (r.downloaded) parts.push(`${r.downloaded} book${r.downloaded === 1 ? '' : 's'} from your other devices`);
      if (r.removed) parts.push(`${r.removed} removed elsewhere`);
      if (!$('libraryDlg').open) toast('Library synced: ' + parts.join(', ') + '.');
    }
    renderBooks();
  }

  function onToken(token, expiresIn) {
    const prev = gdrive && gdrive.email;
    gdrive = Object.assign(gdrive || {}, { token, exp: Date.now() + (Math.max(60, +expiresIn || 3600) - 120) * 1000, err: '' });
    saveDrive(); renderSync();
    return drv.about().then(async a => {
      const email = (a && a.user && a.user.emailAddress) || '';
      if (prev && email && prev !== email) { // a different Google account: merge into it rather than mirror the old one
        for (const b of books) if (b.synced) { b.synced = false; await idb('readwrite', s => s.put(b)); }
      }
      gdrive.email = email; gdrive.name = (a && a.user && a.user.displayName) || ''; saveDrive();
    }).catch(() => {}).then(() => sync());
  }
  function syncSay(msg, err) { const el = $('syncStatus'); el.textContent = msg; el.classList.toggle('err', !!err); }
  async function signIn() {
    const id = driveClient();
    if (!id) { $('syncSetup').open = true; syncSay('Add your Google client ID first (see the setup steps below).', true); return; }
    if (navigator.onLine === false) { syncSay('Connect to the internet to sign in to Google.', true); return; }
    if (standalone()) { // home screen apps cannot use Google's sign-in window, so go to Google and come back
      const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      ls.set('lectern.oauthState', state);
      const q = new URLSearchParams({ client_id: id, redirect_uri: appUrl(), response_type: 'token', scope: DRIVE_SCOPE, include_granted_scopes: 'true', state });
      if (gdrive && gdrive.email) q.set('login_hint', gdrive.email);
      stop(); location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
      return;
    }
    try {
      if (!(window.google && google.accounts && google.accounts.oauth2)) await loadScript(GIS).catch(() => { throw new Error('Could not reach Google sign-in. Check your connection and try again.'); });
      const known = gdrive && gdrive.email;
      const res = await new Promise((ok, no) => {
        const c = google.accounts.oauth2.initTokenClient({
          client_id: id, scope: DRIVE_SCOPE,
          callback: r => r && r.access_token ? ok(r) : no(r || {}),
          error_callback: e => no(e || {})
        });
        c.requestAccessToken(known ? { prompt: '', hint: known } : { prompt: 'consent' });
      });
      if (!google.accounts.oauth2.hasGrantedAllScopes(res, DRIVE_SCOPE)) { syncSay('Google did not allow Drive access. Sign in again and tick the Drive box.', true); return; }
      await onToken(res.access_token, res.expires_in);
    } catch (e) {
      const t = e && (e.type || e.error);
      syncSay(t === 'popup_failed_to_open' ? 'Your browser blocked the Google window. Allow pop-ups for this site, then press the button again.'
        : t === 'popup_closed' || t === 'access_denied' ? 'Sign-in was cancelled.'
        : t === 'invalid_client' || /client/i.test(String(e && e.error_description || '')) ? 'Google did not recognise that client ID. Check it in the setup steps below.'
        : (e && e.message) || 'Google sign-in did not finish. Try again.', true);
    }
  }
  function takeRedirect() { // the answer from Google after signing in from a home screen app
    if (!/(^|[#&])(access_token|error)=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const want = ls.get('lectern.oauthState', ''); ls.set('lectern.oauthState', '');
    if (!want || h.get('state') !== want) return null;
    if (h.get('access_token')) return { token: h.get('access_token'), exp: h.get('expires_in') };
    return { error: h.get('error') };
  }
  async function signOut() {
    const t = gdrive && gdrive.token;
    clearTimeout(syncTimer);
    gdrive = null; ls.set('lectern.drive', null); ls.set('lectern.tomb', {});
    for (const b of books) if (b.synced) { b.synced = false; await idb('readwrite', s => s.put(b)); }
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => {});
    renderSync(); renderBooks();
    syncSay('Signed out. Your books and Google key stay on this device, and the copy in your Google Drive is kept.');
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString();
  }
  function renderSync() {
    const on = !!gdrive, live = tokenOk();
    $('syncIn').hidden = on && live; $('syncIn').textContent = on ? 'Reconnect to Google' : 'Sign in with Google';
    $('syncNow').hidden = !(on && live); $('syncOut').hidden = !on;
    $('libSync').hidden = !on;
    let line, err = false;
    if (!on) line = driveClient() ? 'Sign in to keep your library, reading positions, Google key and voice settings the same on every device.' : 'Not set up yet. Sync needs a one-time Google setup, below.';
    else if (syncing) line = 'Syncing with Google Drive…';
    else if (!live) line = `Sync is paused until you reconnect${gdrive.email ? ' as ' + gdrive.email : ''}. Changes here are kept and sent when you do.`;
    else if (gdrive.err === 'offline') line = 'Offline. Changes are kept here and sync when you are back online.';
    else if (gdrive.err) { line = gdrive.err; err = true; }
    else line = `Synced with ${gdrive.email || 'your Google Drive'}${gdrive.last ? ' · ' + ago(gdrive.last) : ''}.`;
    const el = $('syncStatus'); el.textContent = line; el.classList.toggle('err', err);
    $('libSyncMsg').textContent = !on ? '' : line;
    $('libSyncBtn').textContent = live ? 'Sync now' : 'Reconnect';
    $('libSyncBtn').disabled = syncing;
    $('syncBar').hidden = !(on && !live);
    renderKeyBtns();
    $('libNote').textContent = on ? 'Books, reading positions, your Google key and voice settings sync through your Google Drive. A backup file still works too.' : 'Books live in this browser. Sign in to Google in Settings to sync every device, or use a backup file.';
  }

  /* ---------- Google Cloud: Chirp 3 HD speech and Vision page reading ---------- */
  const G_TTS = 'https://texttospeech.googleapis.com/v1', GEM = 'https://generativelanguage.googleapis.com/v1beta';
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  function gStatus(msg, err) { const el = $('gStatus'); el.textContent = msg; el.classList.toggle('err', !!err); }
  async function gFetch(url, body, signal, api) {
    let r;
    try {
      r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(settings.gkey),
        body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('Google could not be reached. Check your connection; passages already saved on this device still play.');
    }
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const m = (j.error && j.error.message) || '';
    api = api || 'Cloud Text-to-Speech';
    const err = new Error(/API key not valid/i.test(m) ? 'Google did not accept that API key. Check it in Settings.'
      : /has not been used|is disabled|not enabled/i.test(m) ? `The ${api} API is not turned on for this key’s Google Cloud project. Enable it in the Google Cloud console, wait a minute, then try again.`
      : /referer|referrer|blocked/i.test(m) ? `This key is restricted and does not allow this site or the ${api} API. Adjust the key’s restrictions in the Google Cloud console.`
      : /billing/i.test(m) ? 'Google needs billing turned on for this project before it will answer.'
      : r.status === 429 ? 'Google’s rate or quota limit for this key was reached. Wait a minute and press play, or check the key’s quota.'
      : m || `Google returned an error (${r.status}).`);
    err.status = r.status; err.raw = m;
    throw err;
  }
  async function hashKey(str) {
    if (window.crypto && crypto.subtle) {
      const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
    }
    let a = 5381, b = 52711;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = (a * 33 ^ c) >>> 0; b = (b * 33 ^ c) >>> 0; }
    return a.toString(16) + b.toString(16) + str.length.toString(16);
  }
  function addUsage(n) {
    const month = new Date().toISOString().slice(0, 7), u = ls.get('lectern.usage', {});
    const v = { month, chars: (u.month === month ? u.chars : 0) + n };
    if (n) ls.set('lectern.usage', v);
    $('gUsage').textContent = `Sent to Google from this device this month: ${v.chars.toLocaleString()} characters. Passages you replay are not sent again.`;
  }
  const inflight = new Map();
  function synthLine(text, voice) { // returns the audio for one passage, from this device's saved audio when possible
    const gem = voice.startsWith('m:');
    const id = (gem ? settings.gengine + '|' + settings.gstyle + '|' + STYLE_V : '') + voice + '\n' + text;
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      const key = await hashKey(id);
      const hit = await idb('readonly', st => st.get(key), 'audio');
      if (hit && hit.blob) return hit.blob;
      const blob = gem ? await geminiSpeech(text, voice.slice(2)) : await chirpSpeech(text, voice.slice(2));
      addUsage(text.length);
      idb('readwrite', st => st.put({ key, blob, t: Date.now() }), 'audio');
      return blob;
    })();
    inflight.set(id, p);
    p.catch(() => {}).then(() => inflight.delete(id));
    return p;
  }
  function b64Bytes(b64) { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes; }
  async function chirpSpeech(text, voice) {
    const j = await gFetch(G_TTS + '/text:synthesize', {
      input: { text },
      voice: { languageCode: voice.slice(0, voice.indexOf('-Chirp')), name: voice },
      audioConfig: { audioEncoding: 'MP3' }
    });
    if (!j.audioContent) throw new Error('Google returned no audio for a passage.');
    return new Blob([b64Bytes(j.audioContent)], { type: 'audio/mpeg' });
  }
  function pcmToWav(inline) { // Gemini answers with raw 16-bit samples; browsers need a WAV header to play them
    const bytes = b64Bytes(inline.data), mime = inline.mimeType || '';
    if (bytes.length > 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF') return new Blob([bytes], { type: 'audio/wav' }); // already a WAV file
    if (!/L16|pcm/i.test(mime) && mime) return new Blob([bytes], { type: mime.split(';')[0] });
    const rate = +(/rate=(\d+)/.exec(mime) || [, 24000])[1], h = new DataView(new ArrayBuffer(44));
    const put = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    put(0, 'RIFF'); h.setUint32(4, 36 + bytes.length, true); put(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); put(36, 'data'); h.setUint32(40, bytes.length, true);
    return new Blob([h.buffer, bytes], { type: 'audio/wav' });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* The narration style steers the voice but must never be read out. Google's newer speech models (Gemini 3.x TTS)
     read the text they are sent word for word, so a style placed in front of the passage was spoken before every
     passage. Those models take the style separately, as speech_metadata on the Interactions API. Older models get it
     as a system instruction, or failing that as clearly marked director's notes above the transcript. */
  const STYLE_V = 's2|'; // audio saved before this change may have the style spoken in it, so it is not reused
  const noSystem = new Set(), noInteract = new Set(); // speech models that turned down each way of sending the style
  const useInteract = model => /^gemini-[3-9]/i.test(model) && !noInteract.has(model);
  function interactBody(text, voiceName, model) {
    const style = (settings.gstyle || '').trim().replace(/[:：]\s*$/, '');
    const part = { type: 'text', text };
    if (style) part.annotations = [{ type: 'speech_metadata', style }];
    return { model, input: [{ type: 'user_input', content: [part] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: voiceName }] } };
  }
  function interactAudio(j) { // the last audio item of the model's output
    let out = null;
    for (const st of (j && j.steps) || []) if (st && st.type === 'model_output') for (const c of st.content || []) if (c && c.type === 'audio' && c.data) out = c;
    if (!out && j && j.output_audio && j.output_audio.data) out = j.output_audio;
    return out && { data: out.data, mimeType: out.mime_type || out.mimeType || '' };
  }
  function speechBody(text, voiceName, model) {
    const style = (settings.gstyle || '').trim().replace(/[:：]\s*$/, '');
    const generationConfig = { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } };
    if (!style) return { contents: [{ role: 'user', parts: [{ text }] }], generationConfig };
    if (!noSystem.has(model)) return {
      systemInstruction: { parts: [{ text: 'You are the narrator of an audiobook. Speak only the text you are given, word for word. Never say these instructions aloud. How to speak: ' + style + '.' }] },
      contents: [{ role: 'user', parts: [{ text }] }], generationConfig
    };
    return { contents: [{ role: 'user', parts: [{ text: '### DIRECTOR\'S NOTES (direction only, never spoken)\n' + style + '.\n\n### TRANSCRIPT (speak only this, word for word)\n' + text }] }], generationConfig };
  }
  async function geminiSpeech(text, voiceName) {
    const model = settings.gengine.slice(2);
    for (let i = 0; ; i++) {
      try {
        let j, audio = null;
        if (useInteract(model)) {
          try { audio = interactAudio(await gFetch(GEM + '/interactions', interactBody(text, voiceName, model), null, 'Gemini')); if (!audio) throw Object.assign(new Error('Google returned no audio for a passage. Press play to try again.'), { retry: true }); }
          catch (e) { if (e.status !== 400 && e.status !== 404) throw e; noInteract.add(model); } // not offered for this model: use generateContent
        }
        if (!audio) {
          try { j = await gFetch(GEM + '/models/' + encodeURIComponent(model) + ':generateContent', speechBody(text, voiceName, model), null, 'Gemini'); }
          catch (e) {
            if (e.status !== 400 || noSystem.has(model) || !(settings.gstyle || '').trim() || !/instruction|system/i.test(e.raw || e.message)) throw e;
            noSystem.add(model); // this model takes no system instruction: send the style as director's notes
            j = await gFetch(GEM + '/models/' + encodeURIComponent(model) + ':generateContent', speechBody(text, voiceName, model), null, 'Gemini');
          }
        }
        if (audio) { if (i) note(''); return pcmToWav(audio); }
        const part = ((((j.candidates || [])[0] || {}).content || {}).parts || []).find(x => x.inlineData && x.inlineData.data);
        if (!part) throw Object.assign(new Error('Google returned no audio for a passage. Press play to try again.'), { retry: true });
        if (i) note('');
        return pcmToWav(part.inlineData);
      } catch (e) {
        if (i >= 3 || !(e.retry || e.status === 429 || e.status >= 500)) throw e;
        if (e.status === 429 && playing) note('Google’s rate limit for this key was reached. Waiting a moment, then carrying on…');
        await sleep([4000, 15000, 35000][i]);
      }
    }
  }
  const audioEl = new Audio(); audioEl.preload = 'auto';
  const gtts = (() => { // a small player: a queue of passages, fetched ahead and played back to back on one audio element
    const H = { line: [], pos: [], state: [], audio: [] };
    let q = [], cur = null, run = 0, rate = 1, voice = '', paused = false, busy = false;
    const emit = (k, e) => H[k].forEach(f => { try { f(e); } catch (err) { console.error(err); } });
    const drop = why => { for (const it of q) it.rej(why); if (cur) cur.rej(why); q = []; cur = null; };
    function enqueue(lines, opts) {
      if (opts && opts.voice) voice = opts.voice;
      if (opts && opts.rate) rate = opts.rate;
      return Promise.all(lines.map(l => new Promise((res, rej) => {
        const it = { id: l.id, res, rej, blob: synthLine(l.text, voice) };
        it.blob.then(blob => emit('audio', { id: l.id, blob }), () => {}); // lets the word timing be worked out before the passage plays
        q.push(it);
      })));
    }
    async function pump(my) {
      busy = true;
      while (my === run) {
        const it = q.shift();
        if (!it) { cur = null; busy = false; emit('state', { state: 'idle', reason: 'completed' }); return; }
        cur = it;
        let blob;
        try { blob = await it.blob; } catch (e) { if (my === run) { run++; busy = false; drop(e); } return; }
        if (my !== run) return;
        const url = URL.createObjectURL(blob);
        audioEl.src = url; audioEl.playbackRate = rate;
        try { if (!paused) await audioEl.play(); }
        catch (e) {
          if (my !== run) { URL.revokeObjectURL(url); return; }
          if (!e || e.name !== 'AbortError') { run++; busy = false; URL.revokeObjectURL(url); drop({ message: 'The browser blocked playback. Press play again.' }); return; }
        }
        emit('line', { id: it.id });
        await new Promise(done => {
          const tick = () => {
            if (my !== run || cur !== it || audioEl.ended || audioEl.error) return done();
            emit('pos', { ms: audioEl.currentTime * 1000, dur: (isFinite(audioEl.duration) ? audioEl.duration : 0) * 1000, id: it.id });
            setTimeout(tick, 30);
          };
          tick();
        });
        URL.revokeObjectURL(url);
        if (my !== run) return;
        it.res({ playedMs: 0 });
      }
    }
    return {
      speak(lines, opts) { run++; drop({ code: 'stopped' }); paused = false; const p = enqueue(lines, opts); pump(run); return p; },
      add(lines, opts) { const p = enqueue(lines, opts); if (!busy) pump(++run); return p; },
      stop() { run++; busy = false; paused = false; drop({ code: 'stopped' }); audioEl.pause(); return Promise.resolve(); },
      pause() { paused = true; audioEl.pause(); },
      resume() { paused = false; audioEl.playbackRate = rate; return audioEl.play().catch(() => {}); },
      unlock() { if (!busy) { audioEl.src = SILENCE; audioEl.play().catch(() => {}); } },
      setRate(r) { rate = r; audioEl.playbackRate = r; },
      active: () => busy, isPaused: () => busy && paused,
      onLine: f => H.line.push(f), onPosition: f => H.pos.push(f), onState: f => H.state.push(f), onAudio: f => H.audio.push(f)
    };
  })();
  const GEM_VOICES = [['Sulafat', 'warm'], ['Achird', 'friendly'], ['Vindemiatrix', 'gentle'], ['Achernar', 'soft'], ['Algieba', 'smooth'], ['Despina', 'smooth'], ['Charon', 'informative'], ['Rasalgethi', 'informative'],
    ['Sadaltager', 'knowledgeable'], ['Gacrux', 'mature'], ['Schedar', 'even'], ['Iapetus', 'clear'], ['Erinome', 'clear'], ['Kore', 'firm'], ['Orus', 'firm'], ['Alnilam', 'firm'], ['Aoede', 'breezy'],
    ['Callirrhoe', 'easy-going'], ['Umbriel', 'easy-going'], ['Zubenelgenubi', 'casual'], ['Zephyr', 'bright'], ['Autonoe', 'bright'], ['Puck', 'upbeat'], ['Laomedeia', 'upbeat'], ['Sadachbia', 'lively'],
    ['Fenrir', 'excitable'], ['Leda', 'youthful'], ['Enceladus', 'breathy'], ['Algenib', 'gravelly'], ['Pulcherrima', 'forward']];
  function pickLang() { // Chirp voices are per language
    const langs = Array.from(new Set(gAll.map(v => v.lang))).sort();
    const nav = navigator.language || 'en-US';
    if (!langs.includes(settings.glang)) settings.glang = langs.includes(nav) ? nav : langs.find(l => l.slice(0, 2) === nav.slice(0, 2)) || (langs.includes('en-US') ? 'en-US' : langs[0] || '');
    const sel = $('gLang'); sel.textContent = '';
    let names = null; try { names = new Intl.DisplayNames([nav], { type: 'language' }); } catch {}
    for (const l of langs) { const o = document.createElement('option'); o.value = l; let label = l; try { if (names) label = names.of(l) + ' (' + l + ')'; } catch {} o.textContent = label; sel.appendChild(o); }
    sel.value = settings.glang;
    return gAll.filter(v => v.lang === settings.glang).sort((a, b) => a.name.localeCompare(b.name))
      .map(v => ({ id: 'g:' + v.name, label: v.name.slice(v.name.indexOf('Chirp3-HD-') + 10) + (v.g === 'FEMALE' ? ' · female' : v.g === 'MALE' ? ' · male' : '') }));
  }
  function buildEngines(force) { // which Google speech engines this key can use, and the voices of the chosen one
    const engines = gModels.map(m => ({ v: 'm:' + m.id, label: 'Gemini · ' + m.label })).concat(gAll.length ? [{ v: 'chirp', label: 'Chirp 3 HD' }] : []);
    const sel = $('gEngine'); sel.textContent = '';
    for (const e of engines) { const o = document.createElement('option'); o.value = e.v; o.textContent = e.label; sel.appendChild(o); }
    if (!engines.some(e => e.v === settings.gengine)) settings.gengine = engines.length ? engines[0].v : '';
    sel.value = settings.gengine; sel.disabled = !engines.length;
    const chirp = settings.gengine === 'chirp';
    $('gLangWrap').hidden = !chirp; $('gStyleWrap').hidden = chirp || !engines.length;
    claudeVoices = !engines.length ? [] : chirp ? pickLang() : GEM_VOICES.map(([n, d]) => ({ id: 'm:' + n, label: n + ' · ' + d }));
    chunkCache = new Map();
    const premiumNow = /^[gm]:/.test(settings.voiceURI);
    if (claudeVoices.length && !claudeVoices.some(v => v.id === settings.voiceURI) && (premiumNow || force)) {
      const star = premiumNow ? settings.voiceURI.replace(/^.*[:-]/, '') : '';
      settings.voiceURI = (claudeVoices.find(v => star && v.id.endsWith(star)) || claudeVoices[0]).id;
    }
    if (!claudeVoices.length && premiumNow) settings.voiceURI = '';
  }
  async function initGoogle(fromButton) {
    addUsage(0); renderKeyBtns();
    $('gStyle').value = settings.gstyle;
    if (!settings.gkey) {
      tts = null; gAll = []; gModels = []; gOcrModel = ''; buildEngines(); applySettings(); loadVoices();
      gStatus('No key saved. The app is using this device’s own voice.');
      if (synth) note('For natural Google voices, add your Google key in Settings.');
      return;
    }
    gStatus('Checking the key with Google…');
    const [gem, chirp] = await Promise.allSettled([gFetch(GEM + '/models?pageSize=1000', null, null, 'Gemini'), gFetch(G_TTS + '/voices')]);
    if (gem.status === 'fulfilled') {
      const all = (gem.value.models || []).map(m => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name, gen: (m.supportedGenerationMethods || []).includes('generateContent') }));
      const tier = id => /flash-lite/i.test(id) ? 0 : /flash/i.test(id) ? 1 : 2; // cheapest first
      const order = (a, b) => tier(a.id) - tier(b.id) || b.id.localeCompare(a.id);
      gModels = all.filter(m => /tts/i.test(m.id)).sort(order).map(m => ({ id: m.id, label: m.label }));
      const readers = all.filter(m => m.gen && /^gemini-.*flash/i.test(m.id) && !/tts|image|audio|live|embed|native|robot|computer/i.test(m.id)).sort(order);
      gOcrModel = readers.length ? readers[0].id : '';
      ls.set('lectern.gmodels', { gModels, gOcrModel });
    } else if (!fromButton) { const c = ls.get('lectern.gmodels', {}); gModels = c.gModels || []; gOcrModel = c.gOcrModel || ''; }
    else { gModels = []; gOcrModel = ''; }
    if (chirp.status === 'fulfilled') {
      gAll = (chirp.value.voices || []).filter(v => /Chirp3-HD/.test(v.name)).map(v => ({ name: v.name, lang: v.name.slice(0, v.name.indexOf('-Chirp')), g: v.ssmlGender }));
      ls.set('lectern.gvoices', gAll);
    } else gAll = fromButton ? [] : ls.get('lectern.gvoices', []);
    if (!gModels.length && !gAll.length) {
      tts = null; buildEngines(); applySettings(); loadVoices();
      gStatus(gem.status === 'rejected' ? gem.reason.message : 'Google accepted the key, but it offers no speech models. Turn on the Gemini API for this key’s project.', true);
      return;
    }
    tts = gtts;
    if (!wired) { wired = true; wireTts(); }
    buildEngines(fromButton || !settings.premiumOffered);
    settings.premiumOffered = true;
    saveSettings(); note(''); applySettings(); loadVoices();
    gStatus('Connected. ' + (gModels.length ? `Gemini speech: ${gModels.map(m => m.label).join(', ')}. ` : 'Gemini speech is not available for this key. ') + (gAll.length ? 'Chirp 3 HD is available too.' : ''));
  }
  async function prepareChapter() { // fetch a whole chapter now so it plays without a connection later
    if (!premium()) { gStatus('Choose a Google voice first.', true); return; }
    const list = chunksFor(ci), voice = settings.voiceURI, btn = $('gOffline');
    btn.disabled = true; let done = 0, next = 0, failed = null;
    const worker = async () => { while (next < list.length && !failed) { const x = list[next++]; try { await synthLine(x.text, voice); } catch (e) { failed = e; } gStatus(`Saving “${book.chapters[ci].title}” for offline listening: ${++done} of ${list.length} passages…`); } };
    await Promise.all([worker(), worker(), worker()]);
    btn.disabled = false;
    gStatus(failed ? failed.message : `“${book.chapters[ci].title}” is saved on this device in this voice.`, !!failed);
  }
  function blobB64(blob) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error('That image could not be read.')); fr.readAsDataURL(blob); });
  }
  async function shrinkImage(file) { // phone photos are far larger than page reading needs
    try {
      const bmp = await createImageBitmap(file), k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 1500000) return file;
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.85));
    } catch { return file; }
  }
  async function ocrRead(blobs, nums, signal) {
    if (!gOcrModel) return visionRead(blobs, signal);
    const parts = [{ text: `The ${nums.length === 1 ? 'image is page' : 'images are pages'} ${nums.join(', ')} of a scanned book${nums.length > 1 ? ', in that order' : ''}. Transcribe the main body text exactly as printed, for reading aloud.\n` +
      'Rules: begin each page with a line of the form === PAGE <number> === using the page numbers given. Leave out running headers, footers and printed page numbers. Rejoin words hyphenated across line breaks. Write each paragraph on one line with a blank line between paragraphs. Put a chapter title or heading on its own line. Wrap superscript text (note and citation numbers) in <sup></sup>, subscript text in <sub></sub>, and text printed vertically in a margin in <v></v>. Describe nothing, add no comments, and if a page has no text write only its marker line.' }];
    for (const b of blobs) parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: await blobB64(b) } });
    const j = await gFetch(GEM + '/models/' + encodeURIComponent(gOcrModel) + ':generateContent', { contents: [{ parts }], generationConfig: { temperature: 0 } }, signal, 'Gemini');
    const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('');
    if (!text.trim()) throw new Error('Google returned no text for those pages.');
    const segs = text.split(/^\s*===\s*PAGE\s+(\d+)\s*===\s*$/mi), by = new Map();
    if (segs.length < 3) by.set(nums[0], text); else for (let i = 1; i < segs.length; i += 2) by.set(+segs[i], segs[i + 1] || '');
    return nums.map(n => (by.get(n) || '').split(/\n\s*\n/).map(x => clean(S.fromTags(x))).filter(Boolean));
  }
  async function visionRead(blobs, signal) {
    const requests = [];
    for (const b of blobs) requests.push({ image: { content: await blobB64(b) }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] });
    const j = await gFetch('https://vision.googleapis.com/v1/images:annotate', { requests }, signal, 'Cloud Vision');
    return (j.responses || []).map(r => {
      if (r.error) throw new Error(r.error.message || 'Google could not read one of the pages.');
      const paras = [];
      for (const pg of (r.fullTextAnnotation && r.fullTextAnnotation.pages) || []) for (const bl of pg.blocks || []) for (const pa of bl.paragraphs || []) {
        let t = '';
        for (const w of pa.words || []) for (const sy of w.symbols || []) {
          t += S.scrub(sy.text || '');
          const br = sy.property && sy.property.detectedBreak && sy.property.detectedBreak.type;
          if (br && br !== 'HYPHEN') t += ' '; // a line-end hyphen means the word continues on the next line
        }
        t = clean(t);
        if (t && !/^\d{1,4}$/.test(t)) paras.push(t);
      }
      return paras;
    });
  }
  function setupMedia() { // lock-screen and headset controls
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => { if (!playing) play(); });
      ms.setActionHandler('pause', () => { if (playing) toggle(); });
      ms.setActionHandler('previoustrack', () => $('prevBtn').click());
      ms.setActionHandler('nexttrack', () => $('nextBtn').click());
    } catch {}
  }
  function mediaMeta() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const w = placeOf(book.id), inShelf = w && !w.shelf.single;
    const title = inShelf ? (w.item.n != null ? w.item.n + '. ' : '') + w.item.label + (book.chapters.length > 1 ? ' · ' + book.chapters[ci].title : '') : book.chapters[ci].title;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist: inShelf ? w.shelf.title : w ? w.item.label : book.title, album: 'Lectern' }); } catch {}
  }

  /* ---------- playback ---------- */
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
  function wUnit(t) { // relative time a word takes to say, 1 = an average word
    return 0.45 + t.length / 8.5 + (/[.!?]["”’)]*$/.test(t) ? 0.9 : /[,;:—]$/.test(t) ? 0.45 : 0);
  }
  function wordMs(w) { return 60000 / (WPM * settings.rate) * wUnit(w.t); }
  function pace(token, silent, state) {
    const s = sents[si]; let k = 0;
    const list = words.length ? words : s.ws;
    const step = () => {
      if (token !== tok) return;
      if (!silent && state.real) return;       // the voice is reporting real word positions
      if (k >= list.length) { if (silent) advance(token); return; }
      if (words.length) setWord(k);
      later(step, wordMs(list[k++]));
    };
    step();
  }
  /* Chirp 3 HD: short passages are synthesised ahead of time and played back to back; the highlight follows the audio clock. */
  const premium = () => !!tts && settings.voice && /^[gm]:/.test(settings.voiceURI);
  const pRate = () => Math.min(3, Math.max(0.5, settings.rate));
  const P_BASE = 60000 / 165;
  function chunksFor(c) { // the same passages every time, so audio already paid for is reused
    let ch = chunkCache.get(c);
    if (!ch) {
      ch = []; const m = model(c), big = settings.voiceURI.startsWith('m:');
      const min = big ? 450 : 110, max = big ? 900 : 420;
      let lead = -1; // sentences with nothing to say (all skipped) ride along with a passage next to them
      for (let i = 0; i < m.length; i++) {
        const from = i; let text = m[i].say;
        while (text.trim().length < min && i + 1 < m.length && (big || m[i + 1].p === m[from].p) && text.length + m[i + 1].say.length <= max) {
          if (m[i + 1].p !== m[i].p && !/\s$/.test(text)) text += '\n\n';
          text += m[++i].say;
        }
        text = text.trim().slice(0, 1800);
        if (text) { ch.push({ from: lead < 0 ? from : lead, to: i, text }); lead = -1; }
        else if (ch.length) ch[ch.length - 1].to = i;
        else if (lead < 0) lead = from;
      }
      chunkCache.set(c, ch);
    }
    return ch;
  }
  function nextLine() {
    while (pcur && pcur.c < book.chapters.length) {
      const x = chunksFor(pcur.c).find(k => k.to >= pcur.s);
      if (!x) { pcur = { c: pcur.c + 1, s: 0 }; continue; }
      const line = { id: pgen + ':' + (pseq++), c: pcur.c, from: x.from, to: x.to, text: x.text };
      pcur = { c: pcur.c, s: x.to + 1 };
      plines.set(line.id, line);
      return line;
    }
    return null;
  }
  function lineMarks(line) {
    const m = model(line.c); line.marks = []; let acc = 0;
    for (let i = line.from; i <= line.to; i++) {
      const ws = m[i].words.map(w => w.t), para = i === line.to || m[i + 1].p !== m[i].p;
      ws.forEach((t, k) => {
        const brk = window.LecternAlign ? LecternAlign.breakAfter(t, k === ws.length - 1, para && k === ws.length - 1) : 0;
        line.marks.push({ s: i, k, at: acc, t, brk });
        acc += wUnit(t);
      });
    }
    line.total = acc;
  }
  /* Word timing from the audio itself: Google sends no word positions, so the pauses in each passage are found and
     matched to its punctuation, and the words between pauses are spread by how long each takes to say (align.js). */
  const timesCache = new Map();
  async function audioSamples(blob) {
    const buf = await (blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer());
    const wav = LecternAlign.pcmFromWav(buf); // Gemini's audio: read the samples directly, no decoder needed
    if (wav) return wav;
    const C = window.OfflineAudioContext || window.webkitOfflineAudioContext; // Chirp's MP3
    if (!C) return null;
    const ctx = new C(1, 1, 44100);
    const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    return { samples: ab.getChannelData(0), rate: ab.sampleRate };
  }
  function timeLine(line, blob) {
    if (!window.LecternAlign || line.times !== undefined) return;
    if (!line.marks) lineMarks(line);
    const key = settings.voiceURI + '|' + settings.gengine + '|' + settings.gstyle + '|' + STYLE_V + line.text;
    if (timesCache.has(key)) { line.times = timesCache.get(key); return; }
    line.times = null; // working on it; the estimate is used until it is ready
    audioSamples(blob).then(a => {
      const t = a && LecternAlign.timeWords(a.samples, a.rate, line.marks);
      if (!t || t.length !== line.marks.length) return;
      line.times = t;
      timesCache.set(key, t);
      if (timesCache.size > 60) timesCache.delete(timesCache.keys().next().value);
    }).catch(err => console.warn('Word timing unavailable for a passage; using the estimate.', err));
  }
  function calibrate() { // learn this voice's real pace from the line that just finished
    if (!pline || plastMs < 2500 || !pline.total) return;
    const k = plastMs / (pline.total * P_BASE / pRate());
    if (k > 0.4 && k < 2.5) pk = pk * 0.4 + k * 0.6;
  }
  const lineArg = l => ({ text: l.text, id: l.id });
  const pOpts = () => ({ voice: settings.voiceURI, rate: pRate() });
  const pErr = gen => e => { if (gen !== pgen || !playing || (e && e.code === 'stopped')) return; haltPremium(e && e.code, e && e.message); };
  function haltPremium(code, msg) {
    playing = false; tok++; pgen++; clearTimers(); setWord(-1); setPlayIcon();
    const quiet = ['viewer_stopped', 'interrupted', 'hidden', 'stopped', 'replaced'];
    if (quiet.includes(code)) return;
    note(msg || 'The voice was interrupted. Press play to continue.');
  }
  function startPremium() {
    const token = ++tok, gen = ++pgen; clearTimers(); pline = null;
    try { synth && synth.cancel(); } catch {}
    const go = () => {
      if (token !== tok || gen !== pgen) return;
      pStarted = Date.now(); pseq = 0; plines = new Map(); pline = null; plastMs = 0; pcur = { c: ci, s: si };
      const first = [nextLine(), nextLine(), nextLine()].filter(Boolean);
      if (!first.length) { stop(); return; }
      note(''); pPaused = null; tts.unlock();
      tts.speak(first.map(lineArg), pOpts()).catch(pErr(gen));
    };
    // skipping quickly through sentences should not start a reading per press
    if (Date.now() - pStarted > 700) go(); else later(go, 350);
  }
  function wireTts() {
    tts.onAudio(({ id, blob }) => { const line = plines.get(id); if (line) timeLine(line, blob); });
    tts.onLine(({ id }) => {
      const line = plines.get(id);
      if (!line || !playing || !String(id).startsWith(pgen + ':')) return;
      calibrate(); pline = line; plastMs = 0; pmark = 0; if (!line.marks) lineMarks(line);
      if (line.c !== ci) { ci = line.c; renderChapter(line.from); } else activate(line.from);
      setWord(0);
      const n = nextLine();
      if (n) tts.add([lineArg(n)], pOpts()).catch(pErr(pgen));
    });
    tts.onPosition(({ ms, dur, id }) => {
      if (!pline || id !== pline.id || !playing || pline.c !== ci) return;
      plastMs = ms;
      const marks = pline.marks, times = pline.times;
      if (times) { // timed from the audio: follow the clock both ways
        const t = ms / 1000 + 0.06; // a hair early, so the highlight lands as the word is heard
        while (pmark + 1 < marks.length && times[pmark + 1] <= t) pmark++;
        while (pmark > 0 && times[pmark] > t) pmark--;
      } else {
        const unit = dur ? ms / dur * pline.total : ms / (P_BASE / pRate() * pk);
        while (pmark + 1 < marks.length && marks[pmark + 1].at <= unit) pmark++;
      }
      const mk = marks[pmark]; if (!mk) return;
      if (mk.s !== si) activate(mk.s);
      setWord(mk.k);
    });
    tts.onState(({ state, reason }) => {
      if (state !== 'idle' || !playing || !premium()) return;
      if (reason === 'completed') {
        calibrate(); pline = null;
        const n = nextLine();
        if (n) tts.add([lineArg(n)], pOpts()).catch(pErr(pgen));
        else endOfItem();
      } else if (reason !== 'stopped' && reason !== 'replaced') haltPremium(reason);
    });
  }
  function quietTts() { if (tts && tts.active()) { pgen++; try { tts.stop().catch(() => {}); } catch {} } }

  function paceChunk(token, first, to, state) { // estimated highlight for voices that do not report word positions
    let i = first, k = 0;
    const step = () => {
      if (token !== tok || state.real || i > to) return;
      if (i !== si) activate(i);
      const ws = sents[i].ws;
      if (k < ws.length) { setWord(k); later(step, wordMs(ws[k++])); }
      else { i++; k = 0; step(); }
    };
    step();
  }
  function voiceScore(v) { // prefer the natural-sounding voices a device has over its basic default
    const n = v.name, lang = (navigator.language || 'en').toLowerCase(), vl = v.lang.toLowerCase().replace('_', '-');
    let sc = vl === lang ? 12 : vl.slice(0, 2) === lang.slice(0, 2) ? 8 : -100;
    if (/natural|neural/i.test(n)) sc += 50; else if (/premium/i.test(n)) sc += 45; else if (/enhanced/i.test(n)) sc += 40;
    else if (/siri/i.test(n)) sc += 35; else if (/online/i.test(n)) sc += 30; else if (/google/i.test(n)) sc += 20;
    if (/compact|espeak|eloquence/i.test(n)) sc -= 30;
    if (/^(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|wobble|zarvox)\b/i.test(n)) sc -= 60;
    return sc;
  }
  function bestVoice() {
    let best = null, top = 0;
    for (const v of voices) { const sc = voiceScore(v); if (sc > top) { top = sc; best = v; } }
    return best;
  }
  function speakCurrent() {
    if (settings.voice && premium()) { startPremium(); return; }
    quietTts();
    const token = ++tok; clearTimers();
    const s = sents[si]; if (!s) { stop(); return; }
    if (!settings.voice || !synth) { pace(token, true, {}); return; }
    const state = { real: false, started: false };
    try { if (synth.speaking || synth.pending) synth.cancel(); } catch {}
    const v = voices.find(x => x.voiceURI === settings.voiceURI) || bestVoice();
    // Whole passages flow far better than single sentences. Some streamed voices cut out on long text, so those stay short.
    const lim = !v || v.localService || /online|natural/i.test(v.name) ? 1000 : 180;
    const first = si, offs = [0]; let to = si, text = s.say;
    while (to + 1 < sents.length && text.length + sents[to + 1].say.length <= lim) {
      if (sents[to + 1].el.parentNode !== sents[to].el.parentNode && !/\s$/.test(text)) text += ' \n';
      offs.push(text.length); text += sents[++to].say;
    }
    if (!text.trim()) { later(() => { si = to; advance(token); }, 0); return; } // everything here is skipped
    const u = new SpeechSynthesisUtterance(text);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = settings.rate;
    u.onstart = () => { if (token !== tok) return; state.started = true; paceChunk(token, first, to, state); };
    u.onboundary = e => {
      if (token !== tok || (e.name && e.name !== 'word')) return;
      state.real = true;
      let j = offs.length - 1; while (j > 0 && offs[j] > e.charIndex) j--;
      if (first + j !== si) activate(first + j);
      setWordByChar(e.charIndex - offs[j]);
    };
    u.onend = () => { if (token !== tok) return; si = to; advance(token); };
    u.onerror = e => {
      if (token !== tok || e.error === 'interrupted' || e.error === 'canceled') return;
      silentFallback(token);
    };
    later(() => { if (token === tok && !state.started) silentFallback(token); }, 5000);
    keep = u; // hold a reference so the browser does not drop the callbacks
    try { synth.speak(u); if (synth.paused) synth.resume(); } catch { silentFallback(token); }
  }
  function silentFallback(token) {
    if (token !== tok) return;
    try { synth && synth.cancel(); } catch {}
    settings.voice = false; $('voiceC').checked = false; saveSettings();
    note('No voice responded in this view, so the highlight is pacing silently. Try opening this page in its own browser tab, then turn “Read aloud with a voice” back on under Display.');
    if (playing) speakCurrent();
  }
  function advance(token) {
    if (token !== tok) return;
    if (si + 1 < sents.length) { activate(si + 1); speakCurrent(); }
    else if (ci + 1 < book.chapters.length) { ci++; renderChapter(0); speakCurrent(); }
    else endOfItem();
  }
  function endOfItem() { // a chapter of a book folder carries on into the next chapter
    const nx = neighbour(1);
    if (!nx) { stop(); toast('End of the book.'); return; }
    openBook(nx.id, { c: 0, s: 0 });
    const w = placeOf(nx.id); toast('Next: ' + (w.item.n != null ? `Chapter ${w.item.n}, ` : '') + w.item.label);
    play();
  }
  function play() {
    if (!sents.length) return;
    playing = true; setPlayIcon();
    if (pPaused && premium() && tts.isPaused() && pPaused.c === ci && pPaused.s === si) { pPaused = null; tts.resume(); return; }
    pPaused = null; speakCurrent();
  }
  function toggle() {
    if (!playing) return play();
    if (premium() && tts.active() && pline) { // hold the audio exactly where it is
      tts.pause(); playing = false; pPaused = { c: ci, s: si }; setWord(-1); setPlayIcon();
    } else stop();
  }
  function stop() {
    playing = false; tok++; clearTimers();
    try { synth && synth.cancel(); } catch {}
    quietTts();
    if (posDirty) schedulePos(1500);
    setWord(-1); setPlayIcon();
  }
  function jump(i) {
    if (!sents.length) return;
    i = Math.min(Math.max(0, i), sents.length - 1);
    if (playing) { tok++; clearTimers(); }
    activate(i);
    if (playing) speakCurrent();
  }
  function goChapter(n) {
    if (n < 0 || n >= book.chapters.length) { // past either end: the chapter before or after it in the book folder
      const nb = neighbour(n < 0 ? -1 : 1); if (!nb) return;
      const was = playing;
      openBook(nb.id, { c: n < 0 ? nb.chapters.length - 1 : 0, s: 0 });
      if (was) play();
      return;
    }
    const was = playing; if (was) { tok++; clearTimers(); try { synth && synth.cancel(); } catch {} }
    ci = n; renderChapter(0);
    if (was) speakCurrent();
  }
  function setPlayIcon() {
    $('playIcon').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l14-8z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /* ---------- voices ---------- */
  let voices = [];
  function loadVoices() {
    voices = synth ? (synth.getVoices() || []) : [];
    const sel = $('voiceSel'); sel.textContent = '';
    if (claudeVoices.length) {
      const g = document.createElement('optgroup'); g.label = settings.gengine === 'chirp' ? 'Chirp 3 HD (Google)' : 'Gemini voices (Google)';
      for (const v of claudeVoices) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; g.appendChild(o); }
      sel.appendChild(g);
    }
    const dev = document.createElement('optgroup'); dev.label = 'Device voices'; sel.appendChild(dev);
    const def = document.createElement('option'); def.value = ''; const bv = bestVoice();
    def.textContent = !synth ? 'No device voice here' : bv ? 'Best on this device: ' + bv.name : 'Default device voice'; dev.appendChild(def);
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const sorted = voices.slice().sort((a, b) => {
      const am = a.lang.toLowerCase().startsWith(lang) ? 0 : 1, bm = b.lang.toLowerCase().startsWith(lang) ? 0 : 1;
      return am - bm || voiceScore(b) - voiceScore(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    for (const v of sorted) { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; dev.appendChild(o); }
    const ok = voices.some(v => v.voiceURI === settings.voiceURI) || claudeVoices.some(v => v.id === settings.voiceURI);
    sel.value = ok ? settings.voiceURI : '';
    sel.disabled = !synth && !claudeVoices.length;
    syncRate();
  }
  function syncRate() { if (tts) tts.setRate(pRate()); }

  /* ---------- settings ---------- */
  const FONTS = { book: 'var(--book)', atkinson: '"Atkinson Hyperlegible", Verdana, sans-serif', lexend: '"Lexend", Verdana, sans-serif', system: 'system-ui, -apple-system, "Segoe UI", sans-serif' };
  function saveSettings() { ls.set('lectern.settings', settings); }
  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--read-font', FONTS[settings.font] || FONTS.book);
    r.setProperty('--read-size', settings.size + 'px');
    r.setProperty('--read-lh', settings.lh);
    r.setProperty('--read-width', settings.width + 'ch');
    reader.classList.toggle('focus', !!settings.focus);
    if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme; else delete document.documentElement.dataset.theme;
    $('themeSel').value = settings.theme || 'auto';
    $('fontSel').value = settings.font;
    $('sizeR').value = settings.size; $('sizeO').textContent = settings.size + 'px';
    $('lhR').value = settings.lh; $('lhO').textContent = (+settings.lh).toFixed(2);
    $('widthR').value = settings.width; $('widthO').textContent = settings.width + 'ch';
    $('wordC').checked = settings.word; $('focusC').checked = settings.focus; $('scrollC').checked = settings.scroll;
    $('voiceC').checked = settings.voice && (!!synth || !!tts); $('voiceC').disabled = !synth && !tts;
    const sk = S.options(settings.skip);
    document.querySelectorAll('[data-skip]').forEach(c => { c.checked = !!sk[c.dataset.skip]; });
    $('rateSel').value = String(settings.rate);
    if (!$('rateSel').value) { settings.rate = 1; $('rateSel').value = '1'; }
  }
  function restartIfPlaying() { if (playing) speakCurrent(); }
  function reskip() { // the Skip text choices changed: rebuild what is spoken, keep the place
    models = new Map(); chunkCache = new Map();
    if (!book.chapters[ci]) return;
    const at = si, top = stage.scrollTop;
    renderChapter(at); stage.scrollTop = top;
    restartIfPlaying();
  }

  /* ---------- small UI helpers ---------- */
  function status(msg, err) { const el = $('status'); el.textContent = msg; el.classList.toggle('err', !!err); }
  let toastT;
  function toast(msg) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 3200); }
  function note(msg) { const el = $('voiceNote'); el.textContent = msg; el.hidden = !msg; }

  /* ---------- events ---------- */
  $('playBtn').onclick = () => toggle();
  $('prevBtn').onclick = () => jump(si - 1);
  $('nextBtn').onclick = () => { if (si + 1 < sents.length) jump(si + 1); else goChapter(ci + 1); };
  $('seek').oninput = e => jump(+e.target.value);
  $('chapterSel').onchange = e => {
    const v = e.target.value, k = v.lastIndexOf(':'), id = v.slice(0, k), c = +v.slice(k + 1);
    if (id === book.id) { goChapter(c); return; }
    const was = playing;
    openBook(id, c === ((positions[id] || {}).c || 0) ? null : { c, s: 0 });
    if (was) play();
  };
  $('prevCh').onclick = () => goChapter(ci - 1);
  $('nextCh').onclick = () => goChapter(ci + 1);
  $('rateSel').onchange = e => {
    settings.rate = +e.target.value; saveSettings(); stampPref('rate'); updateProgress();
    if (premium()) syncRate(); else restartIfPlaying(); // Chirp audio changes pace without restarting
  };
  $('voiceSel').onchange = e => { settings.voiceURI = e.target.value; chunkCache = new Map(); saveSettings(); stampPref('voiceURI'); note(''); syncRate(); restartIfPlaying(); };
  reader.addEventListener('click', e => {
    const s = e.target.closest('.s'); if (!s) return;
    if (String(window.getSelection && window.getSelection()).length) return;
    jump(+s.dataset.i);
  });
  $('libraryBtn').onclick = () => {
    status(''); renderBooks(); renderSync(); $('libraryDlg').showModal();
    if (gdrive && driveClient() && navigator.onLine !== false) { if (tokenOk()) syncSoon(0); else if (!standalone()) signIn(); } // opening the library brings in other devices' books
  };
  $('displayBtn').onclick = () => $('displayDlg').showModal();
  document.querySelectorAll('dialog.sheet').forEach(d => {
    d.querySelector('[data-close]').onclick = () => d.close();
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
  });
  $('pickBtn').onclick = () => $('fileIn').click();
  $('fileIn').onchange = e => { const fs = Array.from(e.target.files); e.target.value = ''; if (fs.length) importFiles(fs); };
  $('ocrGo').onclick = () => {
    if (!ocrJob) return;
    const from = Math.min(ocrJob.n, Math.max(1, Math.floor(+$('ocrFrom').value) || 1));
    const to = Math.min(ocrJob.n, Math.max(from, Math.floor(+$('ocrTo').value) || from));
    $('ocrFrom').value = from; $('ocrTo').value = to;
    runOcr(from, to);
  };
  $('ocrStop').onclick = () => { if (ocrCtl) ocrCtl.abort(); };
  $('pasteBtn').onclick = async () => {
    const text = $('pasteText').value;
    if (!text.trim()) { status('Paste some text first.', true); return; }
    const title = clean($('pasteTitle').value) || clean(text).split(' ').slice(0, 6).join(' ') + '…';
    try { await addBook({ title, chapters: chaptersFromBlocks(textToBlocks(text), title) }); $('pasteText').value = ''; $('pasteTitle').value = ''; }
    catch (e) { status(e.message, true); }
  };
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { dragDepth++; $('drop').classList.add('over'); $('dragVeil').classList.add('on'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $('drop').classList.remove('over'); $('dragVeil').classList.remove('on'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('drop').classList.remove('over'); $('dragVeil').classList.remove('on');
    const fs = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (fs.length) { if (!$('libraryDlg').open) $('libraryDlg').showModal(); importFiles(fs); }
  });

  $('fontSel').onchange = e => { settings.font = e.target.value; saveSettings(); applySettings(); };
  $('sizeR').oninput = e => { settings.size = +e.target.value; saveSettings(); applySettings(); };
  $('lhR').oninput = e => { settings.lh = +e.target.value; saveSettings(); applySettings(); };
  $('widthR').oninput = e => { settings.width = +e.target.value; saveSettings(); applySettings(); };
  $('focusC').onchange = e => { settings.focus = e.target.checked; saveSettings(); applySettings(); };
  $('scrollC').onchange = e => { settings.scroll = e.target.checked; saveSettings(); };
  $('wordC').onchange = e => { settings.word = e.target.checked; saveSettings(); activate(si, false); restartIfPlaying(); };
  $('voiceC').onchange = e => { settings.voice = e.target.checked; saveSettings(); note(''); restartIfPlaying(); };
  document.querySelectorAll('[data-skip]').forEach(c => c.onchange = () => {
    settings.skip = Array.from(document.querySelectorAll('[data-skip]')).filter(x => x.checked).map(x => x.dataset.skip).join(',');
    saveSettings(); stampPref('skip'); reskip();
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { if (e.target.closest('button')) return; e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); $('nextBtn').click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); $('prevBtn').click(); }
  });
  window.addEventListener('pagehide', () => { try { synth && synth.cancel(); } catch {} });

  $('themeSel').onchange = e => { settings.theme = e.target.value; saveSettings(); applySettings(); };
  $('gSave').onclick = () => {
    const k = $('gKey').value.trim();
    if (!k) { if (settings.gkey) removeKey(false); return; } // an empty box only clears this device
    settings.gkey = k; saveSettings(); setPrefLocal('gkey', false); stampPref('gkey'); initGoogle(true);
  };
  $('gRemoveHere').onclick = () => removeKey(false);
  $('gRemoveAll').onclick = () => {
    const b = $('gRemoveAll');
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Remove from every device?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Remove from all devices'; }, 3500); return; }
    b.dataset.sure = ''; b.textContent = 'Remove from all devices'; removeKey(true);
  };
  $('gLang').onchange = e => { settings.glang = e.target.value; buildEngines(); saveSettings(); stampPref('glang', 'voiceURI'); loadVoices(); restartIfPlaying(); };
  $('gEngine').onchange = e => { settings.gengine = e.target.value; buildEngines(true); saveSettings(); stampPref('gengine', 'voiceURI'); loadVoices(); restartIfPlaying(); };
  $('gStyle').onchange = e => { settings.gstyle = e.target.value.trim(); saveSettings(); stampPref('gstyle'); restartIfPlaying(); };
  $('gOffline').onclick = prepareChapter;
  $('gClear').onclick = async () => { await idb('readwrite', st => st.clear(), 'audio'); gStatus('Saved audio was cleared from this device.'); };
  $('syncIn').onclick = signIn;
  $('syncBarBtn').onclick = signIn;
  $('syncNow').onclick = () => sync();
  $('libSyncBtn').onclick = () => tokenOk() ? sync() : signIn();
  $('syncOut').onclick = () => { if ($('syncOut').dataset.sure !== '1') { $('syncOut').dataset.sure = '1'; $('syncOut').textContent = 'Sign out of sync?'; setTimeout(() => { $('syncOut').dataset.sure = ''; $('syncOut').textContent = 'Sign out'; }, 3500); return; } $('syncOut').dataset.sure = ''; $('syncOut').textContent = 'Sign out'; signOut(); };
  $('syncClientSave').onclick = () => {
    const v = $('syncClient').value.trim();
    if (v && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { syncSay('That does not look like a client ID. It ends in .apps.googleusercontent.com.', true); return; }
    settings.driveClient = v; saveSettings(); renderSync();
    if (v) { loadScript(GIS).catch(() => {}); syncSay('Client ID saved. Now press Sign in with Google.'); }
  };
  $('displayBtn').addEventListener('click', () => { renderSync(); if (driveClient() && !standalone()) loadScript(GIS).catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (!gdrive || !tokenOk()) { if (document.visibilityState === 'visible') renderSync(); return; }
    if (document.visibilityState === 'hidden') { if (posDirty) sync(); }
    else if (!gdrive.last || Date.now() - gdrive.last > 60000) syncSoon(500);
  });
  window.addEventListener('online', () => { if (gdrive && tokenOk()) syncSoon(500); });
  setInterval(() => { if (gdrive && tokenOk() && document.visibilityState === 'visible') sync(); else if (gdrive) renderSync(); }, 180000);
  $('exportBtn').onclick = exportBackup;
  $('newShelfBtn').onclick = newShelf;
  $('importBtn').onclick = () => $('backupIn').click();
  $('backupIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };

  /* ---------- start ---------- */
  applySettings();
  if (synth) {
    loadVoices();
    try { synth.addEventListener('voiceschanged', loadVoices); } catch { synth.onvoiceschanged = loadVoices; }
  } else {
    $('voiceSel').disabled = true;
    note('This browser has no built-in reading voice, so the highlight paces silently at the chosen speed.');
  }
  const lastId = ls.get('lectern.last', ''); // read before the sample opens, or the sample would always win
  openBook(SAMPLE.id);
  $('gKey').value = settings.gkey;
  initGoogle();
  setupMedia();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const back = takeRedirect();
  $('syncClient').value = settings.driveClient || '';
  if (/^https:|localhost/.test(location.origin)) { $('syncOrigin').textContent = location.origin; $('syncRedirect').textContent = appUrl(); }
  booksReady = idb('readonly', s => s.getAll()).then(saved => {
    if (saved && saved.length) {
      saved.sort((a, b) => (a.added || 0) - (b.added || 0));
      books = [SAMPLE, ...saved];
      if (lastId && lastId !== SAMPLE.id && books.some(b => b.id === lastId)) openBook(lastId); else { header(); renderBooks(); }
    }
  });
  renderSync();
  if (back && back.token) booksReady.then(() => onToken(back.token, back.exp));
  else if (back && back.error) toast(back.error === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in did not finish. Try again in Settings.', true);
  else if (gdrive && tokenOk()) sync();
  if (gdrive && driveClient() && !standalone()) loadScript(GIS).catch(() => {});
})();
