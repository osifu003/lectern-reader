// Word timing for the highlight. Google's voices return audio only, with no word positions, so the timing is
// worked out from the audio itself: find where speech starts and stops and where the voice pauses, line those
// pauses up with the punctuation in the passage, and spread the words between pauses by how long each takes to say.
// Pure functions, so they can be tested without a browser; app.js calls timeWords() for each passage.
(function (root) {
  'use strict';

  const HOP = 0.01;          // analysis frame, seconds
  const MIN_PAUSE = 0.12;    // shorter gaps are part of speech (stop consonants, joins between words)

  /* ---------- audio ---------- */

  // A WAV file's samples as floats, mono. Gemini's audio is 16-bit PCM in a WAV wrapper, so no decoder is needed.
  function pcmFromWav(buf) {
    const v = new DataView(buf);
    const tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let o = 12, fmt = null, data = null;
    while (o + 8 <= buf.byteLength) {
      const id = tag(o), size = v.getUint32(o + 4, true);
      if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      else if (id === 'data') { data = { at: o + 8, size: Math.min(size, buf.byteLength - o - 8) }; break; }
      o += 8 + size + (size & 1);
    }
    if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.ch) return null;
    const n = Math.floor(data.size / (2 * fmt.ch)), out = new Float32Array(n);
    for (let i = 0, p = data.at; i < n; i++, p += 2 * fmt.ch) out[i] = v.getInt16(p, true) / 32768;
    return { samples: out, rate: fmt.rate };
  }

  // Loudness of each 10 ms frame, in dB.
  function envelope(samples, rate) {
    const len = Math.max(1, Math.round(rate * HOP)), n = Math.floor(samples.length / len), db = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      for (let i = f * len, e = i + len; i < e; i++) s += samples[i] * samples[i];
      db[f] = 10 * Math.log10(s / len + 1e-12);
    }
    return db;
  }

  const pct = (arr, p) => { const a = Array.from(arr).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

  // Where speech starts and ends, and the pauses in between ({a: start, b: end, d: length}, in seconds).
  function findPauses(db) {
    const n = db.length;
    if (!n) return null;
    const peak = pct(db, 0.95), floor = pct(db, 0.05);
    if (peak - floor < 12) return null; // no clear speech/silence contrast: leave it to the estimate
    const thr = Math.min(peak - 28, Math.max(floor + 0.4 * (peak - floor), peak - 50));
    const soft = peak - 24;  // breaths and room noise sit below this; every spoken word rises above it
    const loud = new Uint8Array(n);
    for (let f = 0; f < n; f++) loud[f] = db[f] > thr ? 1 : 0;
    // runs of speech, ignoring clicks shorter than 60 ms
    let runs = [];
    for (let f = 0; f < n;) {
      if (!loud[f]) { f++; continue; }
      let e = f; while (e < n && loud[e]) e++;
      if (e - f >= 6) runs.push([f, e]);
      f = e;
    }
    const maxOf = (a, b) => { let m = -Infinity; for (let f = a; f < b; f++) if (db[f] > m) m = db[f]; return m; };
    // a short run that never gets near speech level is a breath or a click, not a word
    runs = runs.filter(r => (r[1] - r[0]) * HOP >= 0.5 || maxOf(r[0], r[1]) >= peak - 22);
    if (!runs.length) return null;
    // join runs split by gaps too short to be a pause
    const joined = [runs[0].slice()];
    for (let k = 1; k < runs.length; k++) {
      const last = joined[joined.length - 1];
      if ((runs[k][0] - last[1]) * HOP < MIN_PAUSE) last[1] = runs[k][1]; else joined.push(runs[k].slice());
    }
    runs = joined;
    // a breath just before speech belongs to the pause: trim quiet onsets longer than 150 ms
    for (const r of runs) {
      let f = r[0]; while (f < r[1] && db[f] < soft) f++;
      if ((f - r[0]) * HOP >= 0.15 && f < r[1]) r[0] = f;
    }
    const pauses = [];
    for (let k = 1; k < runs.length; k++) {
      const a = runs[k - 1][1] * HOP, b = runs[k][0] * HOP;
      if (b - a >= MIN_PAUSE) pauses.push({ a, b, d: b - a });
    }
    return { start: runs[0][0] * HOP, end: runs[runs.length - 1][1] * HOP, pauses, duration: n * HOP };
  }

  /* ---------- text ---------- */

  const VOWELS = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/g;
  // Rough syllable count; numbers and initialisms are counted as they are read out.
  function numberSyllables(d) { // 1964 as a year, 4000 as four thousand, 412 as four hundred twelve
    if (d.length === 4 && !/000$/.test(d) && d[0] !== '0') return 5;
    const nonzero = d.replace(/^0+/, '').replace(/0/g, '').length;
    return Math.max(1, nonzero * 1.6 + Math.floor((d.replace(/^0+/, '').length - 1) / 3) * 2);
  }
  function syllables(word) {
    word = String(word).replace(/(\d),(?=\d{3}\b)/g, '$1');
    const raw = word.replace(/[^\p{L}\p{N}'’]/gu, '');
    if (!raw) return 0;
    const parts = word.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
    if (parts.length > 1) return parts.reduce((n, x) => n + syllables(x), 0); // X-ray, 82-year-old
    if (/\d/.test(raw)) {
      const nums = raw.match(/\d+/g), letters = raw.replace(/[\d'’]/g, '');
      return nums.reduce((n, d) => n + numberSyllables(d), 0) + (letters ? syllables(letters) : 0);
    }
    if (raw.length >= 2 && raw.length <= 5 && raw === raw.toUpperCase() && raw !== raw.toLowerCase() && !/[aeiouy]/i.test(raw.slice(1, -1))) return raw.length * 1.2;
    const t = raw.toLowerCase().replace(/[’']/g, '');
    const groups = t.match(VOWELS);
    if (!groups) return /\p{L}/u.test(t) ? Math.max(1, t.length / 3) : 0;
    let n = groups.length;
    if (n > 1 && /[^aeiouy]e$/.test(t) && !/[^aeiouy]le$/.test(t)) n--;              // silent final e
    if (n > 1 && /[^aeiouytd]ed$/.test(t)) n--;                                       // walked, played
    if (n > 1 && /[^aeiouysxzcgh]es$/.test(t)) n--;                                   // makes, notes
    return Math.max(1, n);
  }
  // How long a word takes to say, in rough syllable units.
  function wordUnits(word) { const s = syllables(word); return s ? 0.45 + s + Math.min(0.6, String(word).length * 0.02) : 0.2; }

  // How strongly the text calls for a pause after a word: 0 none, 1 comma, 2 sentence end, 3 paragraph end.
  function breakAfter(token, endOfSentence, endOfParagraph) {
    if (endOfParagraph) return 3;
    if (endOfSentence || /[.!?…]["”’»)\]]*$/.test(token)) return 2;
    if (/[,;:—–]["”’»)\]]*$/.test(token) || /^[—–-]+$/.test(token)) return 1;
    return 0;
  }

  /* ---------- alignment ---------- */

  // Tuning, checked against narrated passages with known word times (tests/align.test.js).
  const P = {
    skip: [0, 0.35, 1.6, 3],   // cost of a boundary the voice did not pause at, by break strength
    extra: [0, 0.25, 0.6, 1],  // time (in units) a short, undetected pause still takes
    match0: 1.1,               // cost of a pause where the text has no punctuation
    drop: [0.4, 5, 0.15],      // cost of treating a pause as part of a word: a + b * (length - c)
    tol: [0.18, 0.3]            // how far a stretch of speech may run from its predicted length: a * predicted + b seconds
  };
  const dropCost = d => P.drop[0] + P.drop[1] * Math.max(0, d - P.drop[2]);
  const huber = e => (e < 0 ? -e : e) <= 1 ? e * e : 2 * (e < 0 ? -e : e) - 1;

  // words: [{t: text, brk: 0..3}] in order. audio: findPauses() result. Returns each word's start time in seconds.
  function align(words, audio) {
    const N = words.length;
    if (!N) return [];
    const S = audio.start, E = Math.max(audio.end, audio.start + 0.05);
    const U = new Float64Array(N + 1), XS = new Float64Array(N + 1), SK = new Float64Array(N + 1), str = new Int8Array(N + 1);
    for (let k = 0; k < N; k++) U[k + 1] = U[k] + wordUnits(words[k].t);
    for (let j = 1; j < N; j++) {
      str[j] = words[j - 1].brk || 0;
      XS[j] = XS[j - 1] + P.extra[str[j]];
      SK[j] = SK[j - 1] + P.skip[str[j]];
    }
    XS[N] = XS[N - 1]; SK[N] = SK[N - 1];
    const ps = audio.pauses.filter(p => p.a > S && p.b < E);
    const M = ps.length;
    const node = [{ a: S, b: S, d: 0 }].concat(ps, [{ a: E, b: E, d: 0 }]);
    const DC = new Float64Array(M + 2);
    for (let i = 1; i <= M; i++) DC[i] = DC[i - 1] + dropCost(node[i].d);

    const MAXDROP = 6, MAXSPAN = Math.min(N, 90);
    let rate = ((E - S) - ps.reduce((t, p) => t + (p.d >= 0.3 ? p.d : 0), 0)) / (U[N] + XS[N - 1] * 0.5);
    if (!(rate > 0)) rate = (E - S) / U[N];
    let path = null;
    for (let pass = 0; pass < 3; pass++) {
      const f = [], from = [];
      for (let i = 0; i <= M + 1; i++) { f.push(new Float64Array(N + 1).fill(Infinity)); from.push(new Int32Array(N + 1).fill(-1)); }
      f[0][0] = 0;
      for (let i = 1; i <= M + 1; i++) {
        const last = i === M + 1, jlo = last ? N : 1, jhi = last ? N : N - 1;
        for (let j = jlo; j <= jhi; j++) {
          let best = Infinity, arg = -1;
          for (let ip = i - 1; ip >= 0 && ip >= i - 1 - MAXDROP; ip--) {
            const drop = DC[i - 1] - DC[ip], actual = node[i].a - node[ip].b;
            if (actual <= 0) continue;
            const j0 = ip === 0 ? 0 : Math.max(1, j - MAXSPAN), j1 = ip === 0 ? 0 : j - 1;
            for (let jp = j0; jp <= j1; jp++) {
              const prev = f[ip][jp];
              if (prev === Infinity) continue;
              const pred = rate * (U[j] - U[jp] + XS[j - 1] - XS[jp]);
              const c = prev + huber((actual - pred) / (P.tol[0] * pred + P.tol[1])) + drop + SK[j - 1] - SK[jp];
              if (c < best) { best = c; arg = ip * (N + 1) + jp; }
            }
          }
          if (arg < 0) continue;
          f[i][j] = best + (last || str[j] ? 0 : P.match0);
          from[i][j] = arg;
        }
      }
      if (f[M + 1][N] === Infinity) break;
      const p = []; let i = M + 1, j = N;
      while (i > 0) { p.push([i, j]); const a = from[i][j]; i = Math.floor(a / (N + 1)); j = a % (N + 1); }
      p.push([0, 0]); p.reverse();
      path = p;
      let tA = 0, tU = 0;
      for (let k = 1; k < p.length; k++) {
        const [ip, jp] = p[k - 1], [ii, jj] = p[k];
        tA += node[ii].a - node[ip].b; tU += U[jj] - U[jp] + XS[jj - 1] - XS[jp];
      }
      const r = tA / tU;
      if (!(r > 0) || Math.abs(r - rate) / rate < 0.01) break;
      rate = r;
    }
    if (!path) path = [[0, 0], [M + 1, N]];
    const out = new Array(N);
    for (let k = 1; k < path.length; k++) {
      const [ip, jp] = path[k - 1], [ii, jj] = path[k];
      const t0 = node[ip].b, t1 = node[ii].a;
      const total = U[jj] - U[jp] + XS[jj - 1] - XS[jp];
      let acc = 0;
      for (let w = jp; w < jj; w++) {
        out[w] = t0 + (t1 - t0) * (total ? acc / total : 0);
        acc += U[w + 1] - U[w] + (w + 1 < jj ? P.extra[str[w + 1]] : 0);
      }
    }
    return out;
  }

  // Everything in one call: samples and their rate, plus the passage's words. Returns start times or null.
  function timeWords(samples, rate, words) {
    if (!samples || !samples.length || !words.length) return null;
    const audio = findPauses(envelope(samples, rate));
    if (!audio) return null;
    return align(words, audio);
  }

  const api = { P, pcmFromWav, envelope, findPauses, syllables, wordUnits, breakAfter, align, timeWords };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LecternAlign = api;
})(typeof self !== 'undefined' ? self : this);
