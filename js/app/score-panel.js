// SCORE — the surface between what this bench can render and what a person can
// reach. A score is parts of notes in hertz and seconds: it carries pitches the
// twelve keys cannot spell, and a length the four-bar roll cannot hold. Until
// this panel existed the only way to build one was to write a JavaScript module
// and render it from a terminal, which is how "Thirteen Cards" was made.
//
// Nothing here holds a whole render: renderScoreBlocks hands over one block at
// a time and each block is quantised and pushed straight into the file's parts.
// A 13-minute piece needed about 1.1 GB the old way (three full-length 96 kHz
// buffers); a block is ten seconds.
import { scoreFromJson, scoreToJson, createScore, addPart, addNote, SCORE_FORMAT } from '../score/model.js';
import { renderScoreBlocks, ScoreRenderCache } from '../score/render.js';
import { FOUND_CARDS, foundCardUrl } from '../studio/found-cards.js';
import { SYMPHONY_CARD_IDS, MOVEMENTS } from '../score/symphony/index.js';
import { compileStudioScore } from '../studio/compile.js';
import { instrumentPool } from '../instrument/pool.js';
import { wavHeader, wavChunks, download } from '../export.js';

const BLOCK_SECONDS = 10;
// A 24-bit file never dithers (export.js resolveDither), so a block encoded on
// its own is byte-identical to the same span inside a whole-file encode. A
// 16-bit stream would have to carry the dither generator across blocks, so this
// path does not offer one.
export const BITS = 24;
// Above this the render is offered as a file only: handing it to the bench
// means decoding it into memory a second time.
const HEAR_LIMIT_BYTES = 180 * 1024 * 1024;

const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s - m * 60)).padStart(2, '0');
};

export function scoreSummary(score) {
  let notes = 0, last = 0, lowest = Infinity, highest = 0;
  const cards = new Set();
  for (const part of score.parts) {
    notes += part.notes.length;
    if (part.card && part.card.id) cards.add(part.card.id);
    for (const n of part.notes) {
      if (n.t + n.seconds > last) last = n.t + n.seconds;
      if (n.hz < lowest) lowest = n.hz;
      if (n.hz > highest) highest = n.hz;
    }
  }
  return { parts: score.parts.length, notes, seconds: last, cards: cards.size, lowest, highest };
}

export function summaryLine(score) {
  const s = scoreSummary(score);
  if (!s.notes) return (score.title || 'SCORE') + ' · ' + s.parts + ' PARTS · NO NOTES';
  return (score.title || 'SCORE').toUpperCase() + ' · ' + s.parts + ' PARTS · ' + s.notes + ' NOTES · '
    + fmtTime(s.seconds) + ' · ' + s.cards + ' CARDS · '
    + s.lowest.toFixed(1) + '–' + s.highest.toFixed(1) + ' Hz';
}

// A studio doc is four bars of steps; a score is notes in seconds and hertz.
// Only card-bearing parts cross over — the score renderer resynthesizes measured
// objects and has nothing to say about a two-oscillator synth preset.
export function studioAsScore(studio, { title = 'STUDIO' } = {}) {
  const events = compileStudioScore(studio);
  const score = createScore({ title });
  const parts = new Map();
  for (const event of events) {
    if (!event.audible) continue;
    const track = studio.tracks[event.trackIndex];
    // A track holds { card, excitation }; a part holds the card itself.
    const held = track && track.card;
    if (!held || !held.card || !Array.isArray(held.card.modes)) continue;
    let part = parts.get(event.trackIndex);
    if (!part) {
      part = addPart(score, {
        id: track.name || ('part-' + (event.trackIndex + 1)),
        card: held.card,
        excitation: held.excitation || 'strike',
        pan: Number.isFinite(track.pan) ? track.pan : 0,
      });
      parts.set(event.trackIndex, part);
    }
    for (const pitch of event.heardPitches) {
      addNote(part, {
        t: event.startSec,
        hz: 440 * Math.pow(2, (pitch - 69) / 12),
        velocity: event.velocity,
        seconds: event.durationSec,
      });
    }
  }
  return score;
}

async function fetchCard(id) {
  const res = await fetch(foundCardUrl(id, document.baseURI));
  if (!res.ok) throw new Error('card ' + id + ' · HTTP ' + res.status);
  return res.json();
}

export function initScorePanel(ctx) {
  const { $, status, statusFault } = ctx;
  const host = $('scoreHost');
  if (!host) return;

  const cards = new Map();
  let score = null;
  let cancelled = false;
  let rendering = false;
  let result = null;   // { blob, name, bytes, seconds }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };


  const note = el('p', 'yj-score-note');
  note.textContent = 'A score carries pitches the twelve keys cannot spell and a length the four-bar '
    + 'roll cannot hold. Open one, take the four movements of THIRTEEN CARDS, or turn what is on the '
    + 'STUDIO roll right now into one and render it here or on a terminal.';

  const sourceRow = el('div', 'yj-score-row');
  const btnOpen = el('button', 'yj-btn', 'OPEN A SCORE FILE');
  btnOpen.title = 'A .score.json written by this bench or by the CLI';
  const btnStudio = el('button', 'yj-btn', 'TAKE THE STUDIO ROLL');
  btnStudio.title = 'Every STUDIO part carrying a measured card becomes a part of a score';
  const btnSave = el('button', 'yj-btn', 'SAVE THE SCORE FILE');
  btnSave.title = 'Write it out; scripts/render-score.mjs renders the same file';
  btnSave.disabled = true;
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  sourceRow.append(btnOpen, btnStudio, btnSave, file);

  const pieceRow = el('div', 'yj-score-row');
  pieceRow.append(el('span', 'yj-score-kicker', 'THIRTEEN CARDS'));

  const line = el('p', 'yj-score-line');
  line.setAttribute('role', 'status');
  line.textContent = 'NO SCORE LOADED';

  const renderRow = el('div', 'yj-score-row');
  const btnRender = el('button', 'yj-btn yj-btn-primary', 'RENDER IT');
  btnRender.disabled = true;
  const btnCancel = el('button', 'yj-btn', 'CANCEL');
  btnCancel.hidden = true;
  const btnHear = el('button', 'yj-btn yj-btn-primary', 'HEAR IT ON THE BENCH');
  btnHear.hidden = true;
  const btnWav = el('button', 'yj-btn', 'SAVE THE WAV');
  btnWav.hidden = true;
  renderRow.append(btnRender, btnCancel, btnHear, btnWav);

  const bar = el('div', 'yj-score-bar');
  const fill = el('div', 'yj-score-fill');
  bar.appendChild(fill);
  bar.hidden = true;

  function setScore(next, what) {
    score = next;
    result = null;
    btnHear.hidden = true;
    btnWav.hidden = true;
    btnRender.disabled = !score || !score.parts.length;
    btnSave.disabled = !score;
    line.textContent = score ? summaryLine(score) : (what || 'NO SCORE LOADED');
  }

  async function symphonyCards() {
    const missing = SYMPHONY_CARD_IDS.filter((id) => !cards.has(id));
    if (missing.length) {
      line.textContent = 'LOADING ' + missing.length + ' MEASURED CARDS…';
      const loaded = await Promise.all(missing.map(fetchCard));
      missing.forEach((id, i) => cards.set(id, loaded[i]));
    }
    const map = {};
    for (const id of SYMPHONY_CARD_IDS) map[id] = cards.get(id);
    return map;
  }

  for (const movement of MOVEMENTS) {
    const b = el('button', 'yj-btn yj-score-mv', movement.numeral + ' ' + movement.title);
    b.title = movement.note;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const map = await symphonyCards();
        const mod = await import('../score/symphony/movement-' + movement.n + '.js');
        setScore(mod.movement({ cards: map }));
      } catch (err) {
        setScore(null, 'MOVEMENT ' + movement.numeral + ' DID NOT LOAD · ' + (err && err.message ? err.message : err));
      } finally { b.disabled = false; }
    });
    pieceRow.appendChild(b);
  }

  btnOpen.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const chosen = file.files && file.files[0];
    file.value = '';
    if (chosen) await openJson(chosen);
  });

  // Two kinds of JSON reach this bench and both used to be unopenable: a score,
  // and a card — which KEEP has always written and nothing could ever read back.
  async function openJson(chosen) {
    let json;
    try { json = JSON.parse(await chosen.text()); }
    catch (err) {
      setScore(null, chosen.name + ' IS NOT JSON · ' + (err && err.message ? err.message : err));
      return;
    }
    if (json && Array.isArray(json.modes)) {
      if (!ctx.api.studioSetCard) { setScore(null, 'THE STUDIO IS NOT READY FOR A CARD'); return; }
      try {
        const name = chosen.name.replace(/\.json$/i, '').replace(/-card$/i, '');
        ctx.api.studioSetCard(json, json.excitation || 'strike', name);
        status('CARD OPENED · ' + name.toUpperCase() + ' · ' + json.modes.length
          + ' MODES · PLAY IT WITH THE KEYS A W S E D F');
      } catch (err) {
        setScore(null, chosen.name + ' IS NOT A CARD · ' + (err && err.message ? err.message : err));
      }
      return;
    }
    try {
      // Resolve every found-card reference the file names before parsing it, so
      // a score written elsewhere opens without carrying 300 KB of measurements.
      const refs = new Set();
      for (const part of json.parts || []) if (part && part.card && part.card.ref) refs.add(part.card.ref);
      const map = {};
      for (const id of refs) {
        if (!cards.has(id)) cards.set(id, await fetchCard(id));
        map[id] = cards.get(id);
      }
      setScore(scoreFromJson(json, { cards: map }));
      status('SCORE OPENED · ' + chosen.name);
    } catch (err) {
      setScore(null, chosen.name + ' IS NEITHER A SCORE NOR A CARD · ' + (err && err.message ? err.message : err));
    }
  }

  btnStudio.addEventListener('click', () => {
    const studio = ctx.store && ctx.store.doc && ctx.store.doc.studio;
    if (!studio) { setScore(null, 'NO STUDIO TO TAKE'); return; }
    const next = studioAsScore(studio);
    if (!next.parts.length) {
      setScore(null, 'NO PART ON THE ROLL CARRIES A MEASURED CARD · PICK ONE IN THE STUDIO CHOOSER');
      return;
    }
    setScore(next);
  });

  btnSave.addEventListener('click', () => {
    if (!score) return;
    const json = JSON.stringify(scoreToJson(score), null, 1);
    download(new Blob([json], { type: 'application/json' }),
      (score.title || 'score').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.score.json', 'application/json');
    status('SCORE WRITTEN · ' + SCORE_FORMAT + ' · RENDER IT WITH scripts/render-score.mjs');
  });

  btnCancel.addEventListener('click', () => { cancelled = true; });

  btnRender.addEventListener('click', async () => {
    if (!score || rendering) return;
    rendering = true;
    cancelled = false;
    result = null;
    btnRender.disabled = true;
    btnCancel.hidden = false;
    btnHear.hidden = true;
    btnWav.hidden = true;
    bar.hidden = false;
    fill.style.width = '0%';
    const parts = [];
    let frames = 0, rate = score.sampleRate || 48000;
    const started = Date.now();
    try {
      const out = await renderScoreBlocks(score, {
        blockSeconds: BLOCK_SECONDS,
        // Note renders go to the worker pool: the page keeps its main thread,
        // and a movement's few hundred distinct renders run in parallel.
        cache: new ScoreRenderCache((inputs) => instrumentPool.render(inputs)),
        onProgress: (done, all) => {
          fill.style.width = Math.round(100 * done / Math.max(1, all)) + '%';
        },
        onBlock: ({ left, right, sampleRate }) => {
          if (cancelled) throw new Error('CANCELLED');
          rate = sampleRate;
          frames += left.length;
          for (const chunk of blockChunks(left, right, sampleRate)) parts.push(chunk);
        },
      });
      rate = out.sampleRate;
      const blob = new Blob([wavHeader({ channels: 2, frames, sampleRate: rate, bits: BITS }), ...parts],
        { type: 'audio/wav' });
      const name = (score.title || 'score').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.wav';
      result = { blob, name, bytes: blob.size, seconds: frames / rate };
      btnWav.hidden = false;
      btnHear.hidden = blob.size > HEAR_LIMIT_BYTES;
      const took = (Date.now() - started) / 1000;
      line.textContent = summaryLine(score) + ' · RENDERED ' + fmtTime(result.seconds) + ' IN '
        + took.toFixed(0) + ' s · ' + (blob.size / 1048576).toFixed(1) + ' MB'
        + (btnHear.hidden ? ' · TOO LARGE TO HAND THE BENCH — SAVE IT' : '');
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      line.textContent = why === 'CANCELLED' ? 'RENDER CANCELLED' : 'RENDER FAULT · ' + why;
      if (why !== 'CANCELLED' && statusFault) statusFault('SCORE · RENDER FAULT · ' + why);
    } finally {
      rendering = false;
      btnCancel.hidden = true;
      btnRender.disabled = false;
      bar.hidden = true;
    }
  });

  btnWav.addEventListener('click', () => {
    if (result) download(result.blob, result.name, 'audio/wav');
  });

  btnHear.addEventListener('click', async () => {
    if (!result || !ctx.api.loadArrayBuffer) return;
    status('HANDING THE RENDER TO THE BENCH…', true);
    try { await ctx.api.loadArrayBuffer(await result.blob.arrayBuffer(), result.name); }
    catch (err) { statusFault('SCORE · ' + (err && err.message ? err.message : err)); }
  });

  host.append(note, sourceRow, pieceRow, line, renderRow, bar);
  ctx.api.scoreSetScore = setScore;
  ctx.api.openJsonFile = openJson;
  ctx.api.scoreReveal = () => { host.scrollIntoView({ block: 'center' }); btnOpen.focus(); };
  ctx.api.scoreOpenFile = () => file.click();
}

// One block encoded on its own. wavChunks emits a header first, which a block
// past the first must not carry; the file's single header is written once the
// frame count is known.
export function blockChunks(left, right, sampleRate) {
  const buffer = {
    numberOfChannels: 2,
    length: left.length,
    sampleRate,
    getChannelData: (i) => (i ? right : left),
  };
  const out = [];
  let first = true;
  for (const chunk of wavChunks(buffer, BITS, { chunkFrames: Math.max(1, left.length) })) {
    if (first) { first = false; continue; }
    out.push(chunk);
  }
  return out;
}
