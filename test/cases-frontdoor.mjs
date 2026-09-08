// The intake overlay: the ten measured instruments offered there, the way out
// of the wall, and the rule that one Escape closes one surface.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FOUND_CARDS, foundCardUrl } from '../js/studio/found-cards.js';
import { cardPitchHz } from '../js/instrument/family.js';
import { SYMPHONY_CARD_IDS, MOVEMENTS } from '../js/score/symphony/index.js';

const read = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');

export const NAME = 'front door';

export const cases = [
  async function theOverlayOffersTheMeasuredInstrumentsAndAWayPastItself() {
    const html = await read('index.html');
    const drop = html.slice(html.indexOf('<div class="yj-drop"'), html.indexOf('<div class="yj-credit">'));
    assert.match(drop, /id="foundRow"/, 'the intake hosts the measured instruments');
    assert.match(drop, /id="btnLookAround"/, 'the intake offers a way past itself');
    // The row belongs above the shelf: it is the only offer on this overlay
    // that needs no file and no network.
    assert.ok(drop.indexOf('id="foundRow"') < drop.indexOf('id="fieldLibrary"'),
      'the measured instruments sit above the streamed shelf');
  },

  async function everyOfferedCardIsOnDiskAndSounds() {
    assert.equal(FOUND_CARDS.length, 11);
    for (const entry of FOUND_CARDS) {
      const card = JSON.parse(await read('docs/lab/cards/' + entry.id + '.json'));
      assert.ok(Array.isArray(card.modes) && card.modes.length > 0, entry.id + ' has modes');
      const hz = cardPitchHz(card);
      assert.ok(Number.isFinite(hz) && hz > 20 && hz < 20000, entry.id + ' has an audible pitch: ' + hz);
      assert.ok(['strike', 'bow', 'breath', 'pluck'].includes(entry.excitation), entry.id + ' excitation');
    }
  },

  async function theTwoMalletsAreActuallyDifferentInstruments() {
    // The row offers the same Iowa bell struck two ways. If the two cards were
    // near-identical that would be padding, so the claim is pinned: same pitch,
    // different partials, different ring.
    const plastic = JSON.parse(await read('docs/lab/cards/iowa-bells-plastic-ff-Cs5.json'));
    const brass = JSON.parse(await read('docs/lab/cards/iowa-bells-brass-Cs5.json'));
    const cents = 1200 * Math.log2(cardPitchHz(brass) / cardPitchHz(plastic));
    assert.ok(Math.abs(cents) < 5, 'same written pitch: ' + cents.toFixed(1) + ' cents apart');
    const second = (c) => 20 * Math.log10(c.modes[1].amp / c.modes[0].amp);
    assert.ok(second(brass) - second(plastic) > 20,
      'the brass mallet excites a second partial the plastic mallet barely touches: '
      + second(brass).toFixed(1) + ' dB against ' + second(plastic).toFixed(1));
    assert.ok(brass.modes[0].tauSec > 1.5 * plastic.modes[0].tauSec,
      'and rings the fundamental far longer: ' + brass.modes[0].tauSec.toFixed(2)
      + ' s against ' + plastic.modes[0].tauSec.toFixed(2));
  },

  async function theCardsTheOverlayOffersAreCachedForOffline() {
    const sw = await read('sw.js');
    for (const entry of FOUND_CARDS) {
      assert.ok(sw.includes('docs/lab/cards/' + entry.id + '.json'),
        entry.id + ' is precached; the row promises "nothing fetched"');
    }
  },

  async function theSymphonysCardsAreCachedTooOrItCannotRenderOffline() {
    const sw = await read('sw.js');
    assert.equal(SYMPHONY_CARD_IDS.length, 13, 'the piece is built from thirteen cards');
    for (const id of SYMPHONY_CARD_IDS) {
      assert.ok(sw.includes('docs/lab/cards/' + id + '.json'),
        id + ' is precached; the piece cannot render offline without it');
    }
    // The CLI reads the same list, so a card added to one is added to both.
    const compose = await read('scripts/compose-symphony.mjs');
    assert.match(compose, /SYMPHONY_CARD_IDS as CARD_IDS/, 'the CLI takes its card list from the module');
  },

  async function everyMovementIsPrecachedAndNamedOnce() {
    const sw = await read('sw.js');
    assert.equal(MOVEMENTS.length, 4);
    for (const m of MOVEMENTS) {
      assert.ok(sw.includes('js/score/symphony/movement-' + m.n + '.js'),
        'movement ' + m.n + ' is precached; the panel imports it on demand');
      const mod = await import('../js/score/symphony/movement-' + m.n + '.js');
      assert.equal(mod.SECONDS, m.seconds, 'movement ' + m.n + ' length matches what the panel promises');
    }
  },

  async function oneEscapeClosesOneSurface() {
    const [source, firstRun] = await Promise.all([
      read('js/app/source-controller.js'), read('js/app/firstrun-ui.js'),
    ]);
    // The intake's handler is on window and therefore runs last; the surfaces
    // above it mark the key consumed. Both halves have to hold.
    assert.match(source, /e\.key === 'Escape' && !e\.defaultPrevented/,
      'the intake declines an Escape another surface already took');
    assert.match(firstRun, /e\.preventDefault\(\);\n\s*this\._act\('dismiss'/,
      'the first-run panel marks Escape consumed');
  },

  async function deliberateNavigationClearsTheWall() {
    const main = await read('js/main.js');
    const jump = main.slice(main.indexOf('function jump(tab'), main.indexOf('function jump(tab') + 600);
    assert.match(jump, /dropZone'\)\.classList\.add\('is-hidden'\)/,
      'a command-deck jump does not switch tabs behind the intake wall');
  },

  async function theRowIsRegisteredAfterStudioSoItCanHandACardOver() {
    const main = await read('js/main.js');
    assert.ok(main.indexOf("['studio', initStudioController]") < main.indexOf("['found', initFoundRow]"),
      'the row needs api.studioSetCard, which the studio controller registers');
  },

  async function theCommandDeckKnowsTheNewSurfaces() {
    const [main, found, panel] = await Promise.all([
      read('js/main.js'), read('js/app/found-row.js'), read('js/app/score-panel.js'),
    ]);
    // The deck is the one searchable doorway to every surface; a capability it
    // does not name is a capability only its author can find.
    for (const [id, api, home] of [
      ['found-instruments', 'revealFoundRow', found],
      ['score-panel', 'scoreReveal', panel],
      ['score-open', 'scoreOpenFile', panel],
    ]) {
      assert.ok(main.includes("id: '" + id + "'"), id + ' is in the command deck');
      assert.ok(main.includes('ctx.api.' + api + '('), id + ' runs ' + api);
      assert.ok(home.includes('ctx.api.' + api + ' ='), api + ' is registered by its own surface');
    }
    // The measured instruments must not be gated on a loaded source: they are
    // the only thing here that sounds without one.
    const entry = main.slice(main.indexOf("id: 'found-instruments'"), main.indexOf("id: 'found-instruments'") + 700);
    assert.ok(!/enabled:|reason:/.test(entry.slice(0, entry.indexOf('},'))),
      'the measured instruments are never disabled for want of audio');
  },

  async function foundCardUrlResolvesAgainstThePage() {
    const url = foundCardUrl('opz-thud', 'https://example.test/yellowjacket/');
    assert.equal(url, 'https://example.test/yellowjacket/docs/lab/cards/opz-thud.json');
  },
];
