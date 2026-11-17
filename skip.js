// Skip text: which parts of a passage are left out of narration (brackets, web addresses, superscripts and
// subscripts, vertical text). Pure functions, so they can be tested without a browser. app.js builds every sentence
// with passage(): the text shown on the page stays whole, and only what is spoken leaves the skipped parts out.
(function (root) {
  'use strict';

  /* ---------- marks the importers leave in the text ---------- */
  // Superscripts, subscripts and vertical text are known only while a file is read (font size, baseline, rotation).
  // The importers wrap them in private-use characters that are stored with the paragraph, so they survive merging,
  // splitting and sync. Any private-use characters of ours already in a source file are removed first (scrub).
  const OPEN = { sup: '', sub: '', vert: '' };
  const CLOSE = { sup: '', sub: '', vert: '' };
  const KIND = { '': ['sup', 1], '': ['sup', -1], '': ['sub', 1], '': ['sub', -1], '': ['vert', 1], '': ['vert', -1] };
  const MARK_RE = /[-]/g;
  const scrub = s => String(s == null ? '' : s).replace(MARK_RE, '');
  function wrap(s, kind) {
    s = scrub(s);
    if (!s.trim() || !OPEN[kind]) return s;
    const lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
    return lead + OPEN[kind] + s.trim() + CLOSE[kind] + tail;
  }
  // The text with the marked parts left out: for the importers' checks of how a line ends.
  const bare = s => String(s).replace(/[^]*|[^]*|[^]*/g, '').replace(MARK_RE, '');

  // { t: text without marks, r: [[from, to, kind]] }. Tolerates marks that do not pair up.
  function unmark(s) {
    s = String(s == null ? '' : s);
    if (!/[-]/.test(s)) return { t: s, r: [] };
    let t = '', cur = null, start = 0;
    const r = [];
    const close = () => { if (cur && t.length > start) r.push([start, t.length, cur]); cur = null; };
    for (const ch of s) {
      const k = KIND[ch];
      if (!k) { t += ch; continue; }
      if (k[1] > 0) { close(); cur = k[0]; start = t.length; }
      else if (cur === k[0]) close();
    }
    close();
    return { t, r: merge(r, t, true) };
  }

  // Sorted ranges, overlapping ones joined; with sameKind, only touching ranges of one kind (or parted by spaces) join.
  function merge(ranges, text, sameKind) {
    const rs = ranges.filter(x => x[1] > x[0]).sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    const out = [];
    for (const x of rs) {
      const last = out[out.length - 1];
      if (last && (sameKind
        ? last[2] === x[2] && x[0] >= last[1] && !text.slice(last[1], x[0]).trim()
        : x[0] <= last[1])) last[1] = Math.max(last[1], x[1]);
      else out.push(x.slice());
    }
    return out;
  }

  /* ---------- what to skip ---------- */
  const ALL = ['round', 'square', 'curly', 'url', 'sup', 'vert'];
  function options(v) { // the setting is a comma-separated list of the kinds switched on
    const on = new Set(String(v == null ? '' : v).split(',').map(x => x.trim()).filter(Boolean));
    const o = {}; ALL.forEach(k => { o[k] = on.has(k); }); return o;
  }

  const OPENERS = { '(': 'round', '[': 'square', '{': 'curly' };
  const CLOSERS = { ')': '(', ']': '[', '}': '{' };
  // Matched brackets of the kinds switched on. Brackets nest; a closing bracket with no opener (a list's "a)") is
  // ignored; one that closes an outer bracket ends the brackets left open inside it; a bracket never closed is ignored,
  // so a stray "(" never silences the rest of a paragraph.
  function brackets(t, o) {
    const stack = [], out = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (OPENERS[c]) { stack.push(i); continue; }
      const want = CLOSERS[c];
      if (!want) continue;
      let j = stack.length - 1;
      while (j >= 0 && t[stack[j]] !== want) j--;
      if (j < 0) continue;
      // "a)" or "2)" numbering a list, after a "(" left open in an earlier sentence, is not that bracket's end
      if (c === ')' && /(^|\s)[a-z0-9]{1,3}$/i.test(t.slice(stack[j] + 1, i)) && /[.!?]["”’]?\s+\S/.test(t.slice(stack[j] + 1, i))) continue;
      const at = stack[j]; stack.length = j;
      const kind = OPENERS[want];
      if (o[kind]) out.push([at, i + 1, kind]);
    }
    return out;
  }

  // Web addresses: with a scheme, starting www., a DOI, or a domain followed by a path (example.org/page).
  // A bare name such as Amazon.com is left alone, since in prose it is usually a word.
  const URL_RE = /\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>"“”‘’]+|\bdoi:\s?10\.\d{3,9}\/[^\s<>"“”‘’]+/gi;
  const DOMAIN_RE = /(^|[^@\w.\/-])((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,24}\/[^\s<>"“”‘’]*)/gi;
  function urls(t) {
    const out = [], found = [];
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(t))) found.push([m.index, m[0]]);
    DOMAIN_RE.lastIndex = 0;
    while ((m = DOMAIN_RE.exec(t))) found.push([m.index + m[1].length, m[2]]);
    for (const f of found) {
      let a = f[0], s = f[1];
      for (;;) { // sentence punctuation after an address is not part of it; a bracket is only when the address opened one
        const last = s[s.length - 1];
        if (/[.,;:!?'*…]/.test(last)) { s = s.slice(0, -1); continue; }
        const pair = { ')': '(', ']': '[', '}': '{' }[last];
        if (pair && s.split(pair).length <= s.split(last).length) { s = s.slice(0, -1); continue; }
        break;
      }
      if (s.length < 4) continue;
      let b = a + s.length;
      if (t[a - 1] === '<' && t[b] === '>') { a--; b++; }
      out.push([a, b, 'url']);
    }
    return out;
  }

  // Superscript and subscript digits typed as characters (¹²³, ₁₂₃).
  const UNI_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+(?:[,\-–][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*|[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]+/g;
  // Is a superscript or subscript a note marker (skip it) or part of what is said (x², m³, H₂O, CO₂, 21st)?
  // Exponents and formulas sit right after a symbol of one or two letters; ordinals after a number.
  function noteLike(t, a, b) {
    const body = t.slice(a, b).trim();
    if (!body) return false;
    const before = t.slice(0, a);
    if (/\d$/.test(before) && /^(st|nd|rd|th|er|re|e|ème|o|a|º|ª)$/i.test(body)) return false;
    const word = (before.match(/[\p{L}]+$/u) || [''])[0];
    if (word && word.length <= 2 && /^[\d.,+\-−⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋nNixyzkmn]+$/u.test(body)) return false;
    if (/\d$/.test(before) && /^[-−+⁻⁺]?[\d⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2}$/.test(body)) return false; // 10⁶, 10⁻³
    if (/\)$/.test(before) && /^[\d₀₁₂₃₄₅₆₇₈₉²³]$/.test(body)) return false; // (OH)₂, (x+1)²
    return true;
  }
  function unicodeMarks(t) {
    const out = [];
    UNI_RE.lastIndex = 0;
    let m;
    while ((m = UNI_RE.exec(t))) if (noteLike(t, m.index, m.index + m[0].length)) out.push([m.index, m.index + m[0].length, 'sup']);
    return out;
  }

  // Ranges of a paragraph to leave out of narration. marks: the importer's ranges ([from, to, kind]).
  function skipRanges(t, o, marks) {
    const r = [];
    if (o.round || o.square || o.curly) r.push(...brackets(t, o));
    if (o.url) r.push(...urls(t));
    if (o.sup) {
      r.push(...unicodeMarks(t));
      for (const x of marks || []) if ((x[2] === 'sup' || x[2] === 'sub') && noteLike(t, x[0], x[1])) r.push([x[0], x[1], x[2]]);
    }
    if (o.vert) for (const x of marks || []) if (x[2] === 'vert') r.push([x[0], x[1], 'vert']);
    return merge(r, t, false).map(x => [x[0], x[1]]);
  }

  /* ---------- what is spoken ---------- */
  // The text with the ranges left out, spaces tidied, and each spoken word mapped back to where it sits on the page:
  // { say, words: [{ t, at (in say), a, b (in text) }] }.
  function spoken(text, ranges) {
    let say = '', ri = 0, gap = false;
    const map = [], joined = []; // joined[k]: say[k] follows skipped text with no space between (the "." of "word [1].")
    for (let i = 0; i < text.length;) {
      while (ri < ranges.length && ranges[ri][1] <= i) ri++;
      if (ri < ranges.length && i >= ranges[ri][0]) { i = ranges[ri][1]; gap = true; continue; }
      let c = text[i];
      if (/\s/.test(c)) {
        if (!say.length || /\s$/.test(say)) { i++; continue; }
        c = ' ';
      } else {
        if (gap && /^[.,;:!?…)\]}]/.test(c) && say.endsWith(' ')) { say = say.slice(0, -1); map.pop(); joined.pop(); } // "word [1]." -> "word."
      }
      say += c; map.push(i); joined.push(gap && !/\s/.test(c) && say.length > 1 && !/\s/.test(say[say.length - 2])); i++;
      if (!/\s/.test(c)) gap = false;
    }
    // On the page a word covers only its first unbroken stretch, so the highlight never runs over skipped text.
    const words = [], re = /\S+/g;
    let m;
    while ((m = re.exec(say))) {
      let e = m.index + 1;
      while (e < m.index + m[0].length && !joined[e]) e++;
      words.push({ t: m[0], at: m.index, a: map[m.index], b: map[e - 1] + 1 });
    }
    return { say, words };
  }

  /* ---------- sentences ---------- */
  // Sentence spans [from, to) of a paragraph. Superscripts and vertical text are blanked out before splitting, so a
  // note number after a full stop ("cells.12 The") still ends the sentence, and the split never depends on the toggles.
  function sentenceSpans(t, mask, segmenter) {
    const raw = [];
    if (segmenter) {
      let a = 0;
      for (const s of segmenter.segment(mask)) { raw.push([a, a + s.segment.length]); a += s.segment.length; }
    } else {
      const re = /[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g;
      let m;
      while ((m = re.exec(mask))) { if (!m[0].length) { re.lastIndex++; continue; } raw.push([m.index, m.index + m[0].length]); }
      if (!raw.length && mask.trim()) raw.push([0, mask.length]);
    }
    const out = [];
    for (const [a, b] of raw) {
      if (!t.slice(a, b).trim()) continue;
      // glue fragments with no letters or digits (stray quotes, dashes, a lone note number) to the previous sentence
      if (out.length && !/[\p{L}\p{N}]/u.test(mask.slice(a, b))) out[out.length - 1][1] = b; else out.push([a, b]);
    }
    return out;
  }

  // Every sentence of one stored paragraph: { text (shown), marks (raised, lowered or vertical, for display),
  // skip (dimmed, not spoken), say (spoken), words (spoken words and where each sits in text) }.
  function passage(para, o, segmenter) {
    const { t, r } = unmark(para);
    // what the sentence splitter sees: marked text and note numbers blanked, web addresses as one plain word, so the
    // "?" or "." inside an address does not end a sentence. None of it depends on the toggles.
    const cut = r.concat(unicodeMarks(t)), web = urls(t);
    let mask = t;
    if (cut.length || web.length) {
      const ch = t.split('');
      for (const [a, b] of web) for (let i = a; i < b; i++) ch[i] = 'x';
      for (const [a, b] of cut) for (let i = a; i < b; i++) ch[i] = ' ';
      mask = ch.join('');
    }
    const skip = skipRanges(t, o || {}, r);
    return sentenceSpans(t, mask, segmenter).map(([a, b]) => {
      const clip = list => list.filter(x => x[1] > a && x[0] < b).map(x => [Math.max(a, x[0]) - a, Math.min(b, x[1]) - a].concat(x.slice(2)));
      const text = t.slice(a, b), sk = clip(skip);
      const sp = spoken(text, sk);
      return { text, marks: clip(r), skip: sk, say: sp.say, words: sp.words };
    });
  }

  /* ---------- PDF ---------- */
  // Which text items of a PDF page are superscript, subscript or vertical, from the page's text layer (pdf.js
  // getTextContent): each item's font size and baseline from its transform, compared with the full-size text it sits
  // beside; vertical is text turned across the page's main direction, or set in a vertical font.
  function pdfKinds(items, styles) {
    items = items || [];
    const kinds = new Array(items.length).fill(null), info = [], orient = {};
    let chars = 0, vfont = 0;
    items.forEach(it => {
      if (!it || typeof it.str !== 'string' || !Array.isArray(it.transform) || !it.str.trim()) { info.push(null); return; }
      const [a, b, c, d, e, f] = it.transform;
      const o = ((Math.round(Math.atan2(b, a) / (Math.PI / 2)) % 4) + 4) % 4;
      const len = it.str.trim().length;
      const vf = !!(styles && styles[it.fontName] && styles[it.fontName].vertical);
      info.push({ o, size: Math.hypot(c, d) || Math.abs(it.height) || 0, e, f, w: Math.abs(it.width) || 0, len, s: it.str.trim(), vf });
      orient[o] = (orient[o] || 0) + len; chars += len; if (vf) vfont += len;
    });
    const main = +(Object.keys(orient).sort((x, y) => orient[y] - orient[x])[0] || 0);
    const byFont = vfont * 2 < chars; // a page set entirely in vertical type is the page itself, not a margin label
    info.forEach((x, i) => { if (x && ((x.o % 2) !== (main % 2) || (byFont && x.vf))) kinds[i] = 'vert'; });

    const ok = j => info[j] && !kinds[j];
    info.forEach((x, i) => {
      if (!ok(i) || x.len > 12 || !x.size) return;
      const ang = x.o * Math.PI / 2, ux = Math.round(Math.cos(ang)), uy = Math.round(Math.sin(ang));
      const along = p => ux * p.e + uy * p.f, up = p => -uy * p.e + ux * p.f;
      const fits = r => r.o === x.o && x.size <= r.size * 0.88 && x.size >= r.size * 0.4 && r.len >= 2;
      let ref = null, gap = 0;
      for (let j = i - 1; j >= Math.max(0, i - 4) && !ref; j--) if (ok(j) && fits(info[j])) { ref = info[j]; gap = along(x) - (along(ref) + ref.w); }
      for (let j = i + 1; j <= Math.min(info.length - 1, i + 2) && !ref; j++) if (ok(j) && fits(info[j])) { ref = info[j]; gap = along(ref) - (along(x) + x.w); }
      if (!ref || gap < -0.5 * ref.size || gap > 3 * ref.size) return;
      const dy = up(x) - up(ref);
      if (dy > 0.15 * ref.size && dy < 1.0 * ref.size) kinds[i] = 'sup';
      else if (dy < -0.08 * ref.size && dy > -0.75 * ref.size) kinds[i] = 'sub';
    });
    return kinds;
  }

  // Tags a reading model was asked to use around raised, lowered and vertical text, turned into marks.
  function fromTags(s) {
    return scrub(s).replace(/<(sup|sub|v)>([\s\S]*?)<\/\1>/gi, (_, k, x) => wrap(x, k.toLowerCase() === 'v' ? 'vert' : k.toLowerCase()))
      .replace(/<\/?(sup|sub|v)>/gi, '');
  }

  const api = { ALL, OPEN, CLOSE, scrub, wrap, bare, unmark, options, brackets, urls, unicodeMarks, noteLike, skipRanges, spoken, sentenceSpans, passage, pdfKinds, fromTags };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LecternSkip = api;
})(typeof self !== 'undefined' ? self : this);
