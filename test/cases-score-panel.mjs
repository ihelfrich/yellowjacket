// The SCORE surface: a studio roll becoming a score, and the file the block
// renderer writes being the same file the whole-buffer renderer writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { blockChunks, studioAsScore, summaryLine, scoreSummary, BITS } from '../js/app/score-panel.js';
import { createScore, addPart, addNote } from '../js/score/model.js';
import { renderScore, renderScoreBlocks, ScoreRenderCache } from '../js/score/render.js';
import { createStudio, applyCardInstrument, normalizeStep } from '../js/studio/model.js';
import { encodeWavWithStats, wavHeader } from '../js/export.js';
import { MOVEMENTS, SYMPHONY_CARD_IDS } from '../js/score/symphony/index.js';

const read = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');

const card = async (id) => JSON.parse(await readFile(new URL('../docs/lab/cards/' + id + '.json', import.meta.url), 'utf8'));

function tinyScore(bell) {
  const score = createScore({ title: 'probe', sampleRate: 48000 });
  const part = addPart(score, { id: 'bell', card: bell, excitation: 'strike', pan: -0.3 });
  addNote(part, { t: 0.05, hz: 511.7, velocity: 0.8, seconds: 0.2 });
  addNote(part, { t: 0.6, hz: 623.3, velocity: 0.5, seconds: 0.2 });
  return score;
}

export const NAME = 'score panel';

export const cases = [
  async function aStudioRollBecomesAScoreCarryingItsCents() {
    const bell = await card('iowa-bells-brass-Cs5');
    const studio = createStudio();
    applyCardInstrument(studio.tracks[0], bell, 'strike', 'BRASS');
    studio.tracks[0].steps[0] = normalizeStep({ note: 72, cents: 38, velocity: 0.8 });
    studio.tracks[0].steps[4] = normalizeStep({ note: 72, velocity: 0.8 });
    const score = studioAsScore(studio);
    assert.equal(score.parts.length, 1, 'one card-bearing part crosses over');
    const hz = score.parts[0].notes.map((n) => n.hz);
    assert.equal(hz.length, 2);
    // 38 cents is 0.38 of a semitone: the two steps sit in the same column and
    // must not arrive at the same frequency.
    assert.ok(Math.abs(hz[0] / hz[1] - Math.pow(2, 38 / 1200)) < 1e-9,
      'the step keeps its cents into the score: ' + hz[0] + ' vs ' + hz[1]);
  },

  async function aPartWithoutACardIsLeftBehindAndSaidSo() {
    const studio = createStudio();
    studio.tracks[0].steps[0] = normalizeStep({ note: 60, velocity: 0.8 });
    const score = studioAsScore(studio);
    assert.equal(score.parts.length, 0,
      'the score renderer resynthesizes measured objects; a synth preset has nothing to hand it');
  },

  async function theFileTheBlocksWriteIsTheFileTheWholeBufferWrites() {
    const bell = await card('opz-thud');
    const score = tinyScore(bell);
    const whole = await renderScore(score, { cache: new ScoreRenderCache(), tail: 0.3 });
    const buffer = {
      numberOfChannels: 2, length: whole.left.length, sampleRate: whole.sampleRate,
      getChannelData: (i) => (i ? whole.right : whole.left),
    };
    const wholeBytes = new Uint8Array(await encodeWavWithStats(buffer, BITS).blob.arrayBuffer());

    const parts = [];
    let frames = 0, rate = 0;
    await renderScoreBlocks(score, {
      blockSeconds: 0.25, cache: new ScoreRenderCache(), tail: 0.3,
      onBlock: ({ left, right, sampleRate }) => {
        rate = sampleRate; frames += left.length;
        for (const chunk of blockChunks(left, right, sampleRate)) parts.push(chunk);
      },
    });
    const head = wavHeader({ channels: 2, frames, sampleRate: rate, bits: BITS });
    const streamed = new Uint8Array(head.length + parts.reduce((n, p) => n + p.length, 0));
    streamed.set(head, 0);
    let at = head.length;
    for (const p of parts) { streamed.set(p, at); at += p.length; }

    assert.equal(streamed.length, wholeBytes.length, 'same file length');
    let differing = 0;
    for (let i = 0; i < streamed.length; i++) if (streamed[i] !== wholeBytes[i]) differing++;
    assert.equal(differing, 0, 'a 24-bit file never dithers, so a block encoded alone is the same bytes');
  },

  async function aCardOrAScoreOpensLikeAnyOtherFile() {
    const [source, panel, html] = await Promise.all([
      read('js/app/source-controller.js'), read('js/app/score-panel.js'), read('index.html'),
    ]);
    // KEEP has always written a card .json that nothing could read back.
    assert.match(source, /\\.json\$\/i\.test\(file/, 'the ordinary open path dispatches JSON');
    assert.match(source, /ctx\.api\.openJsonFile/, 'and hands it to the score surface');
    assert.match(panel, /Array\.isArray\(json\.modes\)/, 'a card is recognised by its modes');
    assert.match(panel, /ctx\.api\.openJsonFile = openJson/, 'the surface registers the opener');
    assert.match(html, /accept="[^"]*\.json"/, 'the file picker offers JSON');
  },

  async function theSummaryReportsWhatIsActuallyInTheScore() {
    const bell = await card('opz-thud');
    const score = tinyScore(bell);
    const s = scoreSummary(score);
    assert.equal(s.parts, 1);
    assert.equal(s.notes, 2);
    assert.ok(Math.abs(s.seconds - 0.8) < 1e-9);
    assert.equal(s.lowest, 511.7);
    assert.equal(s.highest, 623.3);
    assert.match(summaryLine(score), /^PROBE · 1 PARTS · 2 NOTES · 0:00 · 1 CARDS · 511\.7–623\.3 Hz$/);
  },

  async function everyMovementTheePanelOffersBuildsFromTheThirteenCards() {
    const cards = {};
    for (const id of SYMPHONY_CARD_IDS) cards[id] = await card(id);
    for (const m of MOVEMENTS) {
      const mod = await import('../js/score/symphony/movement-' + m.n + '.js');
      const score = mod.movement({ cards });
      const s = scoreSummary(score);
      assert.ok(s.notes > 0, 'movement ' + m.n + ' has notes');
      // The design length is where the last event is placed; a struck card
      // rings past it, so the sounding end runs a little long by construction.
      assert.ok(s.seconds > m.seconds - 20 && s.seconds <= m.seconds + 5,
        'movement ' + m.n + ' fills the length the panel names: ' + s.seconds.toFixed(1) + ' vs ' + m.seconds);
      assert.ok(Number.isFinite(s.lowest) && s.lowest > 20, 'movement ' + m.n + ' pitches are audible');
    }
  },
];
