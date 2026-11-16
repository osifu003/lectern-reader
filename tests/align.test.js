// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const A = require('../align.js');

// A stand-in for narration: each word is a voiced burst whose length follows its syllables (with jitter),
// words in a phrase run together, and the voice pauses at punctuation for varying lengths, with a breath now and then.
function narrate(text, seed) {
  let x = seed || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rate = 24000, out = [], truth = [], words = [];
  const silence = s => { for (let i = 0; i < s * rate; i++) out.push((rnd() - 0.5) * 0.001); };
  const breath = s => { for (let i = 0; i < s * rate; i++) out.push((rnd() - 0.5) * 0.03 * Math.sin(Math.PI * i / (s * rate))); };
  silence(0.45);
  const paras = text.split(/\n\n/);
  paras.forEach((p, pi) => {
    const toks = p.match(/\S+/g);
    toks.forEach((t, k) => {
      const brk = A.breakAfter(t, false, k === toks.length - 1 && pi < paras.length - 1);
      words.push({ t, brk });
      truth.push(out.length / rate);
      const d = (0.08 + 0.17 * Math.max(0.6, A.syllables(t))) * (0.8 + 0.4 * rnd()), n = Math.round(d * rate), f = 110 + 60 * rnd();
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / 240, (n - i) / 240) * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * 4 * i / n)));
        out.push(0.3 * env * (Math.sin(2 * Math.PI * f * i / rate) + 0.5 * Math.sin(4 * Math.PI * f * i / rate)));
      }
      if (brk === 3) { silence(0.9 + 0.5 * rnd()); if (rnd() < 0.5) { breath(0.25); silence(0.05); } }
      else if (brk === 2) silence(0.35 + 0.4 * rnd());
      else if (brk === 1 && rnd() < 0.75) silence(0.15 + 0.2 * rnd());
    });
  });
  silence(0.6);
  return { samples: Float32Array.from(out), rate, truth, words };
}

const TEXT = 'It was the winter of 1987 when Dr. Elena Marsh first came to Halvard, a town of barely 4,000 people on the northern coast. ' +
  'She had expected quiet, perhaps loneliness; what she found instead was a place that seemed to be holding its breath.\n\n' +
  'The harbor had frozen early that year. Fishing boats sat locked in the ice like toys pressed into sugar, and the men who owned them ' +
  'spent their mornings at the café on Front Street, arguing about the weather, the price of diesel, and whether the new clinic would last the season.';

test('word times follow the narration, not an even spread', () => {
  for (const seed of [1, 7, 42]) {
    const n = narrate(TEXT, seed);
    const t = A.timeWords(n.samples, n.rate, n.words);
    assert.strictEqual(t.length, n.words.length);
    const err = t.map((x, i) => Math.abs(x - n.truth[i]));
    const mean = err.reduce((a, b) => a + b, 0) / err.length;
    assert.ok(mean < 0.12, `seed ${seed}: mean error ${mean.toFixed(3)} s`);
    assert.ok(Math.abs(t[0] - n.truth[0]) < 0.06, 'first word starts when speech starts, after the leading silence');
    for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], 'times never go backwards');
    // the old way: words spread evenly across the whole clip
    const dur = n.samples.length / n.rate, units = n.words.map(w => A.wordUnits(w.t)), total = units.reduce((a, b) => a + b, 0);
    let acc = 0; const even = units.map(u => { const v = acc / total * dur; acc += u; return v; });
    const evenMean = even.reduce((a, x, i) => a + Math.abs(x - n.truth[i]), 0) / even.length;
    assert.ok(mean < evenMean / 2, `audio timing (${mean.toFixed(3)} s) should beat an even spread (${evenMean.toFixed(3)} s)`);
  }
});

test('reads 16-bit WAV, as Gemini audio is wrapped', () => {
  const pcm = new Int16Array([0, 16384, -16384, 32767]), buf = new ArrayBuffer(44 + pcm.byteLength), v = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); put(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); put(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  const w = A.pcmFromWav(buf);
  assert.strictEqual(w.rate, 24000);
  assert.deepStrictEqual(Array.from(w.samples), [0, 0.5, -0.5, 32767 / 32768]);
  assert.strictEqual(A.pcmFromWav(new ArrayBuffer(100)), null, 'not a WAV: left to the decoder');
});

test('silence or flat noise gives no timing, so the estimate is used', () => {
  assert.strictEqual(A.timeWords(new Float32Array(48000), 24000, [{ t: 'hello', brk: 0 }]), null);
});

test('syllable estimates read numbers and compounds as spoken', () => {
  const s = A.syllables;
  assert.strictEqual(s('the'), 1);
  assert.strictEqual(s('café'), 2);
  assert.strictEqual(s('amputation.'), 4);
  assert.strictEqual(s('1964'), 5);           // nineteen sixty-four
  assert.ok(s('4,000') > 3 && s('4,000') < 4.5); // four thousand
  assert.ok(s('82-year-old') >= 5);
  assert.ok(s('CT') >= 2);
  assert.strictEqual(s('—'), 0);
});

test('punctuation sets how strongly a pause is expected', () => {
  assert.strictEqual(A.breakAfter('word', false, false), 0);
  assert.strictEqual(A.breakAfter('word,', false, false), 1);
  assert.strictEqual(A.breakAfter('said.”', false, false), 2);
  assert.strictEqual(A.breakAfter('word', true, false), 2);
  assert.strictEqual(A.breakAfter('end.', true, true), 3);
});
