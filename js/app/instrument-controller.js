// Instrument panel on the SIGNAL bench: read the loaded sound as an instrument
// — its modes, their decays, the family the ratios belong to, what was
// measured and what was assumed — then hear that card played by the engine's
// excitations at other pitches, and keep it. Nothing here touches the
// recording; the card is the instrument, not the sound.

import { modeQ } from '../instrument/card.js';
import { cardPitchHz } from '../instrument/family.js';
import { relatedScale } from '../instrument/tuning.js';
import { cardFromSource, CARD_SECONDS } from '../instrument/from-source.js';
import { instrumentPool } from '../instrument/pool.js';
import { download } from '../export.js';

export { cardFromSource, CARD_SECONDS };
export const AUDITION_SECONDS = 2.5;
export const PITCH_STEPS = [-12, -7, -5, 0, 4, 7, 12];
export const EXCITATIONS = ['strike', 'pluck', 'bow', 'breath'];
export const FAMILY_LABEL = Object.freeze({ string: 'string', bar: 'bar', cantilever: 'cantilever', membrane: 'membrane', plate: 'plate', bell: 'bell', unknown: 'no known family' });

/** Family in words: a bar names its tuning arch, a string its inharmonicity. */
export function familyLabel(family) {
  if (family.kind === 'bar') return family.arch >= 0.5 ? 'tuned bar' : family.arch >= 0.2 ? 'lightly tuned bar' : 'free bar';
  return FAMILY_LABEL[family.kind] || family.kind;
}
const IDLE = 'Reads the loaded sound as an instrument: its modes, their decays, and the family the ratios belong to.';
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

/** Nearest note name at A4 = 440 Hz. */
export function noteName(hz) {
  if (!(hz > 0)) return '—';
  const n = Math.round(12 * Math.log2(hz / 440)) + 57;
  return NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
}

/** The object's own scale from its partials (Sethares): the dissonance minima within an octave, in cents. */
export function cardScale(card) {
  if (!card || !card.modes || card.modes.length < 2) return [];
  return relatedScale(card.modes).map((s) => s.cents);
}
/** Those minima snapped to semitones for a twelve-tone STUDIO, 0 first, deduped. */
export function cardScaleIntervals(card) {
  const set = new Set([0]);
  for (const c of cardScale(card)) { const n = Math.round(c / 100); if (n > 0 && n < 12) set.add(n); }
  return [...set].sort((a, b) => a - b);
}
/** The scale line for the panel. */
export function scaleLine(card) {
  const cents = cardScale(card);
  if (!cents.length) return '';
  return 'ITS OWN SCALE · ' + cents.map((c) => Math.round(c)).join(' · ') + ' cents · snaps to ' + cardScaleIntervals(card).join(' ');
}

/**
 * What to call a card elsewhere on the bench: the file's name when it has one
 * (CARILLON, BOWL), else the note and family (C#5 TUNED BAR) — a Freesound
 * preview is a number, and a number names nothing.
 */
export function cardDisplayName(card, fileName = '') {
  const base = String(fileName || '').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  const letters = (base.match(/[a-z]/gi) || []).length;
  if (letters >= 3) return base.toUpperCase().slice(0, 16);
  const f1 = cardPitchHz(card);
  return `${noteName(f1)} ${familyLabel(card.family)}`.toUpperCase().slice(0, 16);
}

/** One list row per mode; pure so it can be tested without a DOM. */
export function cardRows(card, { limit = 8 } = {}) {
  const f1 = cardPitchHz(card);
  let top = 0;
  for (const m of card.modes) top = Math.max(top, m.amp);
  return card.modes.slice(0, limit).map((m) => {
    const q = modeQ(m), db = top > 0 && m.amp > 0 ? 20 * Math.log10(m.amp / top) : -99;
    return {
      hz: m.freqHz, ratio: m.freqHz / f1, q, db,
      text: `${m.freqHz < 1000 ? m.freqHz.toFixed(1) : m.freqHz.toFixed(0)} Hz · ${(m.freqHz / f1).toFixed(2)}×`,
      detail: `Q ${Math.round(q)} · ${db.toFixed(0)} dB`,
    };
  });
}

/** One line: pitch, family and confidence, mode count, Q range, what is assumed, what bends. */
export function cardSummary(card) {
  const modes = card.modes;
  if (!modes.length) return 'nothing to card';
  const qs = modes.map(modeQ), lo = Math.round(Math.min(...qs)), hi = Math.round(Math.max(...qs));
  const kind = familyLabel(card.family);
  const conf = card.family.kind === 'unknown' ? '' : ` (${Math.round(card.family.confidence * 100)}%)`;
  const f1 = cardPitchHz(card);
  const parts = [`${noteName(f1)} · ${f1.toFixed(1)} Hz`, `${kind}${conf}`, `${modes.length} mode${modes.length === 1 ? '' : 's'}`, `Q ${lo === hi ? lo : lo + '–' + hi}${card.damping.assumed ? ' assumed' : ''}`];
  if (card.nonlinearity && card.nonlinearity.length) parts.push(`bends ${Math.round(Math.max(...card.nonlinearity.map((l) => l.cents || 0)))} cents with level`);
  return parts.join(' · ');
}

export function initInstrumentController(ctx) {
  const { store, engine, $, status, statusFault } = ctx;
  const R = store.runtime;
  const P = store.project;
  const btn = $('btnCard');
  if (!btn) return;
  const note = $('cardNote'), summary = $('cardSummary'), list = $('cardList'), actions = $('cardActions');
  const exc = $('cardExcitation'), pitchSel = $('cardPitch'), play = $('btnCardPlay'), stop = $('btnCardStop'), keep = $('btnCardKeep'), toStudio = $('btnCardStudio');
  const toPads = $('btnCardPads'), useScale = $('btnCardScale'), scaleNote = $('cardScale');

  let card = null;
  let source = null;
  const rendered = new Map();

  for (const e of EXCITATIONS) { const o = document.createElement('option'); o.value = e; o.textContent = e.toUpperCase(); exc.appendChild(o); }

  function fillPitches() {
    pitchSel.innerHTML = '';
    const f1 = cardPitchHz(card);
    for (const st of PITCH_STEPS) {
      const o = document.createElement('option');
      o.value = String(st);
      o.textContent = `${noteName(f1 * Math.pow(2, st / 12))}${st === 0 ? ' · AS RECORDED' : ' · ' + (st > 0 ? '+' : '') + st}`;
      if (st === 0) o.selected = true;
      pitchSel.appendChild(o);
    }
  }

  function stopPlayback() {
    if (source) { try { source.onended = null; source.stop(); } catch (_) { /* already stopped */ } }
    source = null;
    play.hidden = false;
    stop.hidden = true;
  }

  function reset() {
    stopPlayback();
    card = null; rendered.clear();
    list.hidden = true; list.innerHTML = '';
    summary.hidden = true; actions.hidden = true;
    if (scaleNote) scaleNote.hidden = true;
    note.textContent = IDLE;
    btn.disabled = !(R.mono && R.mono.length);
  }

  store.addEventListener('change', (e) => {
    const kind = e.detail && e.detail.kind;
    if (kind === 'source' || kind === 'source-clear') reset();
  });
  reset();

  btn.addEventListener('click', async () => {
    const mono = R.mono, rate = R.sampleRate;
    if (!mono || !mono.length || !rate) return;
    stopPlayback();
    btn.disabled = true;
    status('CARDING THE SOUND', true);
    await yieldToPaint();
    try {
      // The carding runs in the instrument worker; the page only hears progress.
      const r = await instrumentPool.card(mono, rate, { name: (P && (P.fileName || P.name)) || 'source' },
        (done, total) => { note.textContent = `CARDING · ${done} OF ${total} HITS JUDGED`; status(`CARDING · ${done}/${total}`, true); });
      card = r.card; rendered.clear();
      summary.textContent = cardSummary(card);
      summary.hidden = false;
      const rows = cardRows(card);
      list.innerHTML = '';
      for (const row of rows) {
        const li = document.createElement('li');
        const a = document.createElement('span'); a.textContent = row.text;
        const b = document.createElement('span'); b.textContent = row.detail;
        li.append(a, b);
        list.appendChild(li);
      }
      list.hidden = !rows.length;
      note.textContent = r.how + (card.damping.assumed ? ' · decays assumed, not measured' : '');
      if (scaleNote) { const line = scaleLine(card); scaleNote.textContent = line; scaleNote.hidden = !line; }
      if (card.modes.length) fillPitches();
      actions.hidden = !card.modes.length;
      status(card.modes.length ? `CARDED · ${card.modes.length} MODES · ${familyLabel(card.family).toUpperCase()}` : 'NOTHING TO CARD');
    } catch (err) {
      statusFault ? statusFault('CARD FAILED · ' + (err && err.message ? err.message : err)) : status('CARD FAILED');
    } finally {
      btn.disabled = false;
    }
  });

  play.addEventListener('click', async () => {
    if (!card) return;
    stopPlayback();
    const excitation = exc.value, step = Number(pitchSel.value) || 0;
    const pitchHz = cardPitchHz(card) * Math.pow(2, step / 12);
    const key = excitation + '@' + step;
    let v = rendered.get(key);
    if (!v) {
      status('RENDERING ' + excitation.toUpperCase(), true);
      await yieldToPaint();
      try { v = await instrumentPool.render({ card, pitchHz, excitation, seconds: AUDITION_SECONDS }); }
      catch (err) { statusFault ? statusFault('RENDER FAILED · ' + (err && err.message ? err.message : err)) : status('RENDER FAILED'); return; }
      rendered.set(key, v);
    }
    const peak = v.meta.peak || 0;
    if (peak < 1e-4) { status(`SILENT · THIS CARD DOES NOT SPEAK UNDER ${excitation.toUpperCase()}`); return; }
    source = engine.audition(v.samples, { sampleRate: v.sampleRate, gain: Math.min(1, 0.5 / peak) });
    if (!source) { status('NO AUDIO CONTEXT · PLAY THE SOURCE ONCE FIRST'); return; }
    play.hidden = true;
    stop.hidden = false;
    status(`${excitation.toUpperCase()} · ${noteName(pitchHz)} · ${v.meta.used.path} · ${v.meta.decay60Sec.toFixed(2)} s TO −60 dB`);
    source.onended = () => { if (source) { source = null; play.hidden = false; stop.hidden = true; } };
  });
  stop.addEventListener('click', () => { stopPlayback(); status('STOPPED'); });

  if (toPads) toPads.addEventListener('click', async () => {
    if (!card || !ctx.api.machineAddSample) return;
    stopPlayback();
    const excitation = exc.value;
    status('RENDERING ' + excitation.toUpperCase() + ' FOR THE PADS', true);
    try {
      const v = await instrumentPool.render({ card, pitchHz: cardPitchHz(card), excitation, seconds: AUDITION_SECONDS });
      const peak = v.meta.peak || 0;
      if (peak < 1e-4) { status(`SILENT · THIS CARD DOES NOT SPEAK UNDER ${excitation.toUpperCase()}`); return; }
      const pcm = new Float32Array(v.samples.length);
      const g = Math.min(1, 0.5 / peak);
      for (let i = 0; i < pcm.length; i++) pcm[i] = v.samples[i] * g;
      const label = cardDisplayName(card, P && (P.fileName || P.name)).slice(0, 12) + ' ' + excitation.toUpperCase();
      const slot = ctx.api.machineAddSample({ pcm, sampleRate: v.sampleRate, label, role: 'TONE', kind: 'card', meta: { cardId: card.id, excitation, pitchHz: cardPitchHz(card) } });
      if (slot >= 0 && ctx.api.jump) ctx.api.jump('machine');
    } catch (err) { statusFault ? statusFault('PADS · ' + (err && err.message ? err.message : err)) : status('PADS FAILED'); }
  });

  if (useScale) useScale.addEventListener('click', () => {
    if (!card || !ctx.api.studioSetScale) return;
    const intervals = cardScaleIntervals(card);
    if (intervals.length < 2) { status('NO SCALE · THIS CARD HAS ONE PARTIAL'); return; }
    ctx.api.studioSetScale(intervals, cardDisplayName(card, P && (P.fileName || P.name)).slice(0, 12));
    if (ctx.api.jump) ctx.api.jump('studio');
  });

  if (toStudio) toStudio.addEventListener('click', () => {
    if (!card || !ctx.api.studioSetCard) return;
    stopPlayback();
    ctx.api.studioSetCard(card, exc.value, cardDisplayName(card, P && (P.fileName || P.name)));
  });

  keep.addEventListener('click', () => {
    if (!card) return;
    const base = ((P && P.name) || 'source').replace(/[^\w.-]+/g, '_');
    download(JSON.stringify(card, null, 1), `${base}-card.json`, 'application/json');
    status('CARD SAVED · THE INSTRUMENT, NOT THE RECORDING');
  });

  ctx.api.stopInstrument = stopPlayback;
}
