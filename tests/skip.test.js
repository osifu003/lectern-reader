// Run with: node --test tests/skip.test.js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../skip.js');

const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
const ALL = S.options('round,square,curly,url,sup,vert');
const NONE = S.options('');
const only = k => S.options(k);
const say = (para, o) => S.passage(para, o, seg).map(s => s.say).join('').trim();

// Every spoken word must point at the right place on the page, or the highlight drifts.
function aligned(para, o) {
  for (const s of S.passage(para, o, seg)) {
    for (const w of s.words) {
      let shown = '';
      for (let i = w.a; i < w.b; i++) if (!s.skip.some(r => r[0] <= i && i < r[1])) shown += s.text[i];
      shown = shown.replace(/\s+/g, '');
      assert.ok(shown && w.t.startsWith(shown) && /^[^\p{L}\p{N}]*$/u.test(w.t.slice(shown.length)), `word "${w.t}" shown as "${shown}" in "${s.text}"`);
      assert.ok(!s.skip.some(r => r[0] > w.a && r[0] < w.b), `the highlight of "${w.t}" runs over skipped text`);
      assert.strictEqual(s.say.slice(w.at, w.at + w.t.length), w.t);
    }
    assert.deepStrictEqual(s.say.match(/\S+/g) || [], s.words.map(w => w.t));
  }
}

test('round brackets', () => {
  const p = 'So she was considering in her own mind (as well as she could, for the hot day made her feel very sleepy), whether to get up.';
  assert.strictEqual(say(p, only('round')), 'So she was considering in her own mind, whether to get up.');
  assert.strictEqual(say(p, NONE), p);
  assert.strictEqual(say(p, only('square')), p);
  aligned(p, only('round'));
});

test('square brackets, such as citations', () => {
  const p = 'Embolization reduced bleeding [12], as shown before [3–5]. He [the doctor] agreed.';
  assert.strictEqual(say(p, only('square')), 'Embolization reduced bleeding, as shown before. He agreed.');
  aligned(p, only('square'));
});

test('curly brackets', () => {
  const p = 'The set {1, 2, 3} has three members.';
  assert.strictEqual(say(p, only('curly')), 'The set has three members.');
  aligned(p, only('curly'));
});

test('brackets nest, and only the kinds switched on are skipped', () => {
  const p = 'One (two [three] four) five [six (seven)] eight.';
  assert.strictEqual(say(p, ALL), 'One five eight.');
  assert.strictEqual(say(p, only('square')), 'One (two four) five eight.');
  assert.strictEqual(say(p, only('round')), 'One five [six] eight.');
  aligned(p, only('square'));
});

test('unbalanced brackets never swallow the rest of a paragraph', () => {
  assert.strictEqual(say('An open (bracket that never closes. The story goes on.', ALL), 'An open (bracket that never closes. The story goes on.');
  assert.strictEqual(say('Choose a) the first or b) the second.', ALL), 'Choose a) the first or b) the second.');
  assert.strictEqual(say('Stray ] and } closers stay.', ALL), 'Stray ] and } closers stay.');
  // a list's "a)" after a bracket left open earlier is not that bracket's end
  assert.strictEqual(say('Notes (draft. Options: a) one.', only('round')), 'Notes (draft. Options: a) one.');
  // a closing bracket of another kind ends the brackets left open inside it
  assert.strictEqual(say('Mixed (a [b) c] end.', only('round')), 'Mixed c] end.');
});

test('a bracket can run across sentences', () => {
  const p = 'Before. (This aside has two sentences. Here is the second.) After.';
  const sents = S.passage(p, only('round'), seg);
  assert.ok(sents.length >= 3);
  assert.strictEqual(sents.map(s => s.say).join('').trim(), 'Before. After.');
  assert.ok(sents.some(s => s.say.trim() === ''), 'a sentence inside the brackets has nothing to say');
  aligned(p, only('round'));
});

test('URLs', () => {
  const p = 'Read more at https://example.com/a_(b)?q=1. Or www.site.org, or doi:10.1000/182, or pubmed.ncbi.nlm.nih.gov/12345/ today. Amazon.com stays.';
  assert.strictEqual(say(p, only('url')), 'Read more at. Or, or, or today. Amazon.com stays.');
  assert.strictEqual(say('Links like <https://a.io/x> go.', only('url')), 'Links like go.');
  assert.strictEqual(say('(see https://x.org/p)', only('url')), '(see)');
  assert.strictEqual(say('(see https://x.org/p)', ALL), '');
  aligned(p, only('url'));
});

test('superscripts and subscripts marked by the importer', () => {
  const p = 'Cells divide rapidly.' + S.wrap('12', 'sup') + ' The next sentence' + S.wrap('3,4', 'sup') + ' ends here. ' +
    'Area x' + S.wrap('2', 'sup') + ' and H' + S.wrap('2', 'sub') + 'O on the 21' + S.wrap('st', 'sup') + '. A log' + S.wrap('10', 'sub') + ' scale.';
  const sents = S.passage(p, only('sup'), seg);
  assert.strictEqual(sents[0].text, 'Cells divide rapidly.12 ', 'a note number after a full stop still ends the sentence');
  assert.strictEqual(sents.map(s => s.say).join('').trim(), 'Cells divide rapidly. The next sentence ends here. Area x2 and H2O on the 21st. A log scale.');
  assert.deepStrictEqual(sents[0].marks, [[21, 23, 'sup']], 'kept for display');
  assert.strictEqual(say(p, NONE), 'Cells divide rapidly.12 The next sentence3,4 ends here. Area x2 and H2O on the 21st. A log10 scale.');
  aligned(p, only('sup'));
});

test('superscripts typed as characters', () => {
  assert.strictEqual(say('Shown in trials¹²,³ and in practice.⁴ Area is 5 m² and CO₂ rises.', only('sup')), 'Shown in trials and in practice. Area is 5 m² and CO₂ rises.');
  assert.strictEqual(say('A dose of 10⁻³ mol, (x+1)² and Ca(OH)₂ stay; so does E = mc².', only('sup')), 'A dose of 10⁻³ mol, (x+1)² and Ca(OH)₂ stay; so does E = mc².');
});

test('vertical text', () => {
  const p = 'The method ' + S.wrap('arXiv:2101.00001v1 [cs.CL] 1 Jan 2021', 'vert') + ' works well.';
  assert.strictEqual(say(p, only('vert')), 'The method works well.');
  assert.strictEqual(S.passage(p, only('vert'), seg).length, 1, 'the margin text does not split the sentence');
  assert.strictEqual(say(p, NONE), 'The method arXiv:2101.00001v1 [cs.CL] 1 Jan 2021 works well.');
  aligned(p, only('vert'));
});

test('a sentence that is all skipped says nothing, and sentences never move with the toggles', () => {
  assert.strictEqual(say('[1]', ALL), '');
  const p = 'First (aside). [Note.] https://a.org/x Second' + S.wrap('7', 'sup') + '. Third ' + S.wrap('MARGIN', 'vert') + 'one.';
  const on = S.passage(p, ALL, seg), off = S.passage(p, NONE, seg);
  assert.deepStrictEqual(on.map(s => s.text), off.map(s => s.text));
  aligned(p, ALL);
});

test('text without marks splits exactly as before', () => {
  const p = '“Curiouser and curiouser!” cried Alice (she was so much surprised). “Now I’m opening out!” — she said.';
  const sents = S.passage(p, NONE, seg);
  assert.strictEqual(sents.map(s => s.text).join(''), p);
  assert.ok(sents.every(s => s.say === s.text.replace(/\s+/g, ' ')));
  const fallback = S.passage(p, NONE, null);
  assert.strictEqual(fallback.map(s => s.text).join(''), p);
});

test('marks survive storage and are removed from source text', () => {
  const w = S.wrap(' 12 ', 'sup');
  assert.strictEqual(w, ' 12 ');
  assert.deepStrictEqual(S.unmark('a' + S.wrap('1', 'sup') + S.wrap(',', 'sup') + ' ' + S.wrap('2', 'sup') + 'b'), { t: 'a1, 2b', r: [[1, 5, 'sup']] });
  assert.strictEqual(S.scrub('xy'), 'xy');
  assert.strictEqual(S.bare('end.' + S.wrap('3', 'sup')), 'end.');
  assert.deepStrictEqual(S.unmark('odd  marks open').t, 'odd  marks open');
  assert.strictEqual(S.fromTags('Text<sup>12</sup> and <v>side</v>.'), 'Text' + S.wrap('12', 'sup') + ' and ' + S.wrap('side', 'vert') + '.');
});

/* ---------- PDF text layer ---------- */
// pdf.js items: transform [a, b, c, d, x, y] (y grows upward), width along the baseline.
const item = (str, x, y, size, width, rot) => ({ str, transform: rot ? [0, size, -size, 0, x, y] : [size, 0, 0, size, x, y], width: width == null ? str.length * size * 0.5 : width, height: size, fontName: 'f1', hasEOL: false });

test('PDF: raised small text after a word is a superscript, lowered is a subscript', () => {
  const items = [
    item('Bleeding stopped after embolization.', 72, 700, 10, 170),
    item('12', 242, 704, 6, 6),
    item(' Water is H', 248, 700, 10, 50),
    item('2', 298, 697, 6, 3),
    item('O and the next line is normal.', 301, 700, 10, 140),
    item('A second line of ordinary text', 72, 686, 10, 150)
  ];
  assert.deepStrictEqual(S.pdfKinds(items, {}), [null, 'sup', null, 'sub', null, null]);
});

test('PDF: a footnote marker before its note, and comma-separated citations', () => {
  const items = [
    item('1', 72, 104, 5, 3),
    item('Smith et al., Radiology 2020.', 75, 100, 8, 110),
    item('as reported', 72, 500, 10, 55),
    item('3', 127, 504, 6, 3), item(',', 130, 504, 6, 2), item('4', 132, 504, 6, 3),
    item(' in trials.', 135, 500, 10, 45)
  ];
  assert.deepStrictEqual(S.pdfKinds(items, {}), ['sup', null, null, 'sup', 'sup', 'sup', null]);
});

test('PDF: headings, drop caps and small print on their own lines are not superscripts', () => {
  const items = [
    item('Chapter One', 72, 760, 18, 120),
    item('The first line under a heading.', 72, 730, 10, 150),
    item('A', 72, 680, 36, 24),
    item('lice was beginning to get tired', 98, 700, 10, 150),
    item('Small print caption on its own line', 72, 600, 7, 120),
    item('Body text continues here at full size.', 72, 590, 10, 180)
  ];
  assert.deepStrictEqual(S.pdfKinds(items, {}), [null, null, null, null, null, null]);
});

test('PDF: text turned across the page is vertical; a whole turned page is not', () => {
  const items = [
    item('arXiv:2101.00001v1 [cs.CL] 1 Jan 2021', 20, 300, 14, 280, true),
    item('Main text of the page runs across as usual.', 72, 700, 10, 200),
    item('And keeps going on the next line here.', 72, 686, 10, 190)
  ];
  assert.deepStrictEqual(S.pdfKinds(items, {}), ['vert', null, null]);
  const turned = [item('A landscape page printed sideways.', 100, 72, 10, 200, true), item('Its second line, also sideways.', 114, 72, 10, 180, true)];
  assert.deepStrictEqual(S.pdfKinds(turned, {}), [null, null]);
  const vfont = [item('縦書き', 500, 700, 10, 30), item('Main text here at length and more.', 72, 700, 10, 160)];
  assert.deepStrictEqual(S.pdfKinds(vfont, { f1: {} }), [null, null]);
});
