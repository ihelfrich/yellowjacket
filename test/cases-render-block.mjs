// The block renderer sums the same samples as the whole-buffer one, one block at a time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createScore, addPart, addNote, scoreSeconds } from '../js/score/model.js';
import { renderScore, renderScoreBlocks, renderPart, renderSeconds, ScoreRenderCache, CACHE_BYTES } from '../js/score/render.js';
import { TRUTH_RATE } from '../js/instrument/render.js';

const card = (id) => JSON.parse(readFileSync(new URL('../docs/lab/cards/' + id + '.json', import.meta.url), 'utf8'));
const struck = card('iowa-bells-plastic-ff-Cs5'), sustained = card('uvb76-buzz');
const cache = new ScoreRenderCache();
const BLOCK = 0.5, TAIL = 0.6;

// Attacks land mid-block on purpose, and every render outlasts a block: the
// struck card rings 3.75 s, the bowed note renders 2.25 s, the block is 0.5 s.
function crossingScore(sampleRate) {
  const score = createScore({ title: 'blocks', sampleRate });
  const bell = addPart(score, { id: 'bell', card: struck, excitation: 'strike', pan: -0.4, rmsDb: -20 });
  for (const t of [0.13, 0.62, 0.97, 1.44, 1.98, 2.51]) addNote(bell, { t, midi: 73, velocity: 0.9, seconds: 0.2 });
  const buzz = addPart(score, { id: 'buzz', card: sustained, excitation: 'bow', pan: 0.5, rmsDb: -26, gainDb: -2 });
  addNote(buzz, { t: 0.31, midi: 45, velocity: 0.7, seconds: 1.7 });
  addNote(buzz, { t: 2.24, midi: 52, velocity: 0.8, seconds: 0.8 });
  return score;
}

async function bothWays(sampleRate, blockSeconds = BLOCK) {
  const score = crossingScore(sampleRate);
  const whole = await renderScore(score, { cache, tail: TAIL });
  const left = new Float32Array(whole.left.length), right = new Float32Array(whole.right.length);
  const blocks = [];
  const meta = await renderScoreBlocks(score, {
    blockSeconds, cache, tail: TAIL,
    onBlock: (b) => { left.set(b.left, b.startSample); right.set(b.right, b.startSample); blocks.push(b); },
  });
  let worst = 0;
  for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i] - whole.left[i]), Math.abs(right[i] - whole.right[i]));
  return { whole, meta, blocks, left, worst };
}

export const NAME = 'score render in blocks';
export const cases = [
  async function blocksConcatenateToTheWholeRender() {
    const { whole, meta, blocks, worst } = await bothWays(48000);
    assert.equal(meta.sampleRate, whole.sampleRate);
    assert.deepEqual(meta.parts, whole.parts, 'the same measured levels and gains');
    assert.ok(!('left' in meta) && !('right' in meta), 'the block path returns metadata, not buffers');
    let at = 0;
    for (const b of blocks) { assert.equal(b.startSample, at, 'blocks arrive in order and touch'); assert.equal(b.left.length, b.right.length); assert.equal(b.sampleRate, 48000); at += b.left.length; }
    assert.equal(at, whole.left.length, 'and cover the whole piece');
    assert.ok(blocks.length >= 6, blocks.length + ' blocks');
    // measured 0: 96 k → 48 k is a whole ratio, so the blocks are bit-identical
    assert.ok(worst <= 1e-9, 'sample for sample: ' + worst.toExponential(3));
    // the last note attacks at 2.51 s; the final block still carries its ring
    const tailBlock = blocks[blocks.length - 1];
    let ring = 0; for (const v of tailBlock.left) ring = Math.max(ring, Math.abs(v));
    assert.ok(ring > 1e-4, 'a render outlasting many blocks is carried, not cut: ' + ring.toExponential(2));
  },
  async function theSameHoldsWithoutResamplingAndWithABlockPerQuarterSecond() {
    const same = await bothWays(96000);
    assert.ok(same.worst <= 1e-9, 'truth rate, no resampling: ' + same.worst.toExponential(3));
    const finer = await bothWays(48000, 0.25);
    assert.ok(finer.blocks.length >= 13 && finer.worst <= 1e-9, finer.blocks.length + ' blocks, worst ' + finer.worst.toExponential(3));
  },
  async function anUnevenOutputRateStaysUnderTheQuietestBit() {
    // 96 k → 44.1 k is not a whole ratio, so a block's sample positions differ
    // from the whole buffer's in the last bit of a double. That flips whether
    // the resampling kernel's outermost tap is inside the window at the output
    // samples that land exactly on an input sample: measured 2.7e-7 (−131 dBFS)
    // on 438 of 160,524 samples, four LSBs of the 24-bit file it is written to.
    // Only the ceiling is asserted. The residual is a property of the ratio and
    // of how the two paths reach the same position, not something to hold on to:
    // a resampler that agreed to the bit would drive it to zero, and that is an
    // improvement. Asserting `worst > 0` would have made the phase error
    // mandatory and read the fix as a regression.
    const { worst } = await bothWays(44100);
    assert.ok(worst < 1e-6, 'inaudibly close: ' + worst.toExponential(3));
  },

  async function aPartStoredOutOfOrderRendersTheSameDownBothPaths() {
    // Nothing sorts a part, and the production score does not: movement-4 holds
    // brass note 231 at t=192 after 193.5, and thud 88 and 210 likewise. Both
    // paths sum every note into one accumulator and float addition is not
    // associative, so while the block path can only add notes in time order, the
    // whole-buffer path added them in array order — measured 2.980e-8 apart on
    // the bell part below, which is inaudible and still not the invariant this
    // file exists to hold.
    const shuffled = crossingScore(48000);
    const order = [4, 0, 5, 1, 3, 2];
    shuffled.parts[0].notes = order.map((i) => shuffled.parts[0].notes[i]);
    const whole = await renderScore(shuffled, { cache, tail: TAIL });
    const left = new Float32Array(whole.left.length), right = new Float32Array(whole.right.length);
    await renderScoreBlocks(shuffled, { blockSeconds: BLOCK, cache, tail: TAIL, onBlock: (b) => { left.set(b.left, b.startSample); right.set(b.right, b.startSample); } });
    let worst = 0;
    for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i] - whole.left[i]), Math.abs(right[i] - whole.right[i]));
    assert.ok(worst <= 1e-9, 'sample for sample: ' + worst.toExponential(3));
    assert.deepEqual(shuffled.parts[0].notes.map((n) => n.t), [1.98, 0.13, 2.51, 0.62, 1.44, 0.97], "the caller's score is not sorted under it");
    // and the order a part is stored in is not audible either way
    const ordered = await renderScore(crossingScore(48000), { cache, tail: TAIL });
    let drift = 0;
    for (let i = 0; i < ordered.left.length; i++) drift = Math.max(drift, Math.abs(whole.left[i] - ordered.left[i]), Math.abs(whole.right[i] - ordered.right[i]));
    assert.equal(drift, 0, 'the same samples as the chronological score: ' + drift);
  },

  async function theRenderCacheIsBoundedByBytesNotEntries() {
    // Measured over the four symphony movements: 182 / 52 / 87 / 115 distinct
    // renders costing 259 / 124 / 86 / 165 MB. A render averages 1.0–2.4 MB and
    // a 16 s driven one is 6.1 MB. The old bound of 512 entries was never
    // reached by any movement, so it never evicted anything and never held
    // movement 1 under 259 MB; counting entries did not bound the megabytes,
    // and the block renderer exists so that the audio is not what fills the tab.
    const each = TRUTH_RATE * 4, room = 10 * each; // ten one-second renders
    let renders = 0;
    const stub = (samples) => () => { renders++; return { samples: new Float32Array(samples), sampleRate: TRUTH_RATE, meta: { peak: 1 } }; };
    const c = new ScoreRenderCache(stub(TRUTH_RATE), { bytes: room });
    for (let i = 0; i < 20; i++) await c.get(sustained, 'bow', 200 + i, 0.8, 0.5);
    assert.equal(renders, 20, 'twenty pitches, twenty renders');
    assert.equal(c.map.size, 10, 'ten of them fit the budget, not twenty: ' + c.map.size);
    assert.ok(c.used <= room && c.used > room - each, c.used + ' of ' + room + ' bytes held');
    await c.get(sustained, 'bow', 219, 0.8, 0.5);
    assert.equal(renders, 20, 'the most recent survived');
    await c.get(sustained, 'bow', 200, 0.8, 0.5);
    assert.equal(renders, 21, 'the least recently used was dropped and is rendered again');
    // and the number of entries is not itself a bound: 600 cheap renders live at
    // once under the default, where the old limit would have shed 88 of them.
    const many = new ScoreRenderCache(stub(8), { bytes: CACHE_BYTES });
    for (let i = 0; i < 600; i++) await many.get(sustained, 'bow', 200 + i, 0.8, 0.5);
    assert.equal(many.map.size, 600, 'entries are not counted: ' + many.map.size);
    // The second argument used to be that count. `new ScoreRenderCache(fn, 512)`
    // destructures to `{}` and would take the 256 MB default without a word,
    // which is a quarter of a gigabyte where half a gigabyte of headroom was
    // meant; a budget that is not a budget is refused instead.
    for (const stale of [512, 0, '256e6', null]) assert.throws(() => new ScoreRenderCache(null, stale), TypeError, String(stale));
    assert.throws(() => new ScoreRenderCache(null, { bytes: 0 }), /bytes is 0, not a budget/);
    assert.equal(new ScoreRenderCache().bytes, CACHE_BYTES, 'and no second argument still means the default');
  },

  async function twoPartsOnOneCardThatDifferOnlyInParamsGetOneRenderEach() {
    // js/instrument/render.js spreads a part's params into the excitation, so
    // params decide the samples — but the cache key carried card, excitation,
    // pitch, dynamic and length and not params, so a soft mallet and a hard one
    // on the same bell at the same pitch collapsed onto one entry and whichever
    // part rendered first struck for both. The same defect as keying on card.id,
    // one field over.
    const score = createScore({ title: 'mallets', sampleRate: TRUTH_RATE });
    for (const [id, hardness] of [['soft', 0.05], ['hard', 0.95]]) {
      addNote(addPart(score, { id, card: struck, excitation: 'strike', pan: 0, rmsDb: null, params: { hardness } }), { t: 0, midi: 73, velocity: 0.8, seconds: 0.2 });
    }
    const shared = new ScoreRenderCache();
    const soft = await renderPart(score.parts[0], 1, { cache: shared });
    const hard = await renderPart(score.parts[1], 1, { cache: shared });
    assert.equal(shared.map.size, 2, 'one entry per mallet, not one for both: ' + shared.map.size);
    let apart = 0;
    for (let i = 0; i < soft.length; i++) apart = Math.max(apart, Math.abs(soft[i] - hard[i]));
    assert.ok(apart > 1e-2, 'and the two mallets are audibly different: ' + apart.toExponential(3));
    // what the shared cache handed the second part is what a cache of its own would
    const alone = await renderPart(score.parts[1], 1, { cache: new ScoreRenderCache() });
    let drift = 0;
    for (let i = 0; i < hard.length; i++) drift = Math.max(drift, Math.abs(hard[i] - alone[i]));
    assert.equal(drift, 0, 'the second part got its own mallet: ' + drift);
    // and a part with no params keys as {} rather than as some other part's
    const bare = shared.key(struck, 'strike', 554.365, 0.8, 0.2);
    assert.equal(bare, shared.key(struck, 'strike', 554.365, 0.8, 0.2, {}), 'no params is the empty params');
    assert.notEqual(bare, shared.key(struck, 'strike', 554.365, 0.8, 0.2, { hardness: 0.95 }));
    // key order is not identity: canonicalJson sorts, so { a, b } and { b, a } are one entry
    assert.equal(shared.key(struck, 'strike', 440, 0.8, 0.2, { hardness: 0.3, position: 0.2 }),
      shared.key(struck, 'strike', 440, 0.8, 0.2, { position: 0.2, hardness: 0.3 }));
  },

  async function evictionCostsRendersAndNothingElse() {
    // A budget of one byte keeps exactly one render, so the block path — which
    // changes part every block — re-renders almost every note. Re-rendering is
    // deterministic, so the samples must not move at all.
    const score = crossingScore(48000);
    const roomy = await renderScore(score, { cache, tail: TAIL });
    const tight = new ScoreRenderCache(null, { bytes: 1 });
    const whole = await renderScore(score, { cache: tight, tail: TAIL });
    const left = new Float32Array(roomy.left.length), right = new Float32Array(roomy.right.length);
    await renderScoreBlocks(score, { blockSeconds: BLOCK, cache: tight, tail: TAIL, onBlock: (b) => { left.set(b.left, b.startSample); right.set(b.right, b.startSample); } });
    assert.equal(tight.map.size, 1, 'the budget holds one render, whatever it costs');
    let worst = 0;
    for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i] - roomy.left[i]), Math.abs(whole.left[i] - roomy.left[i]), Math.abs(right[i] - roomy.right[i]));
    assert.equal(worst, 0, 'a re-rendered note is the same note: ' + worst);
  },
  async function progressCountsBothPassesAndTheBlocksStayBlockSized() {
    const score = crossingScore(48000);
    const seen = [];
    const sizes = [];
    const meta = await renderScoreBlocks(score, { blockSeconds: BLOCK, cache, tail: TAIL, onBlock: (b) => sizes.push(b.left.length), onProgress: (done, all, id) => seen.push([done, all, id]) });
    const notes = score.parts.reduce((s, p) => s + p.notes.length, 0);
    assert.equal(seen.length, notes * 2, 'every note is placed twice: measured, then summed');
    assert.deepEqual(seen[notes - 1], [notes, notes * 2, 'buzz'], 'the level pass runs part by part');
    assert.deepEqual(seen[seen.length - 1], [notes * 2, notes * 2, 'bell'], 'the sum pass runs block by block, so it ends on the last attack');
    assert.ok(Math.max(...sizes) <= BLOCK * meta.sampleRate, 'largest block ' + Math.max(...sizes) + ' samples');
    const quiet = await renderScoreBlocks(score, { blockSeconds: BLOCK, cache, tail: TAIL });
    assert.deepEqual(quiet.parts, meta.parts, 'the levels do not depend on there being a sink');
  },
  async function nothingAsLongAsThePieceIsEverAllocated() {
    // The same two parts over twenty seconds, so the piece is far longer than
    // any one ring. Count every Float32Array either path allocates; the note
    // renders come from one warm cache, so what is left is each path's own audio.
    const score = createScore({ title: 'sparse', sampleRate: TRUTH_RATE });
    const bell = addPart(score, { id: 'bell', card: struck, excitation: 'strike', pan: -0.4, rmsDb: -20 });
    for (const t of [0.13, 9.62, 18.51]) addNote(bell, { t, midi: 73, velocity: 0.9, seconds: 0.2 });
    const buzz = addPart(score, { id: 'buzz', card: sustained, excitation: 'bow', pan: 0.5, rmsDb: -26 });
    for (const t of [0.31, 12.24]) addNote(buzz, { t, midi: 45, velocity: 0.7, seconds: 1.7 });
    const samples = Math.ceil(scoreSeconds(score, { tail: TAIL }) * TRUTH_RATE);
    const Real = Float32Array;
    const count = async (fn) => {
      const log = [];
      globalThis.Float32Array = class extends Real { constructor(...a) { super(...a); if (typeof a[0] === 'number') log.push(this.length); } };
      try { await fn(); } finally { globalThis.Float32Array = Real; }
      return { max: Math.max(...log), bytes: log.reduce((s, n) => s + n, 0) * 4 };
    };
    for (const p of score.parts) for (const n of p.notes) await cache.get(p.card, p.excitation, n.hz, n.velocity, n.seconds, p.params);
    const whole = await count(() => renderScore(score, { cache, tail: TAIL }));
    const blocked = await count(() => renderScoreBlocks(score, { blockSeconds: BLOCK, cache, tail: TAIL, onBlock: () => {} }));
    assert.ok(whole.max >= samples, 'the whole-buffer path holds the piece: ' + whole.max + ' of ' + samples);
    // The block path's longest array is a part's carry — one note's ring, never
    // the piece. renderSeconds caps that at 4 s struck, 16 s driven.
    const ring = Math.max(...score.parts.flatMap((p) => p.notes.map((n) => renderSeconds(p.card, p.excitation, n.seconds)))) * TRUTH_RATE;
    assert.ok(blocked.max <= ring, blocked.max + ' > ' + ring);
    assert.ok(blocked.max < samples / 4, 'and a fraction of the piece: ' + blocked.max + ' of ' + samples);
    // Total bytes is churn, not residency: most of the block path's are the
    // per-block resampler output, live for one block. Residency is the line above.
    assert.ok(blocked.bytes < whole.bytes, 'total allocated: ' + (blocked.bytes / 1e6).toFixed(1) + ' MB against ' + (whole.bytes / 1e6).toFixed(1) + ' MB');
  },
];
