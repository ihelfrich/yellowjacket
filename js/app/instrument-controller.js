// Instrument panel on the SIGNAL bench: read the loaded sound as an instrument
// — its modes, their decays, the family the ratios belong to, what was
// measured and what was assumed — then hear that card played by the engine's
// excitations at other pitches, and keep it. Nothing here touches the
// recording; the card is the instrument, not the sound.

import { highpass, bestHit } from '../instrument/hits.js';
import { spectralCard } from '../instrument/spectral.js';
import { trackPitch, voicedRuns } from '../analysis/pitch.js';
import { modeQ } from '../instrument/card.js';
import { cardPitchHz } from '../instrument/family.js';
import { renderVoice } from '../instrument/render.js';
import { download } from '../export.js';

export const CARD_SECONDS = 60;
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

/**
 * Card the source. A ringing hit, if the physics finds one, becomes a modal
 * card; otherwise the longest steady voiced run becomes a spectral card at its
 * own f0; failing both, the loudest half second is read as peaks. Pure.
 * → { card, path: 'struck' | 'sustained', how }
 */
export function cardFromSource(mono, sampleRate, { name = 'source', license = '', seconds = CARD_SECONDS } = {}) {
  const span = mono.subarray(0, Math.min(mono.length, Math.floor(seconds * sampleRate)));
  const hp = highpass(span, sampleRate);
  const best = bestHit(hp, sampleRate, { tries: 12, name, license, note: 'from the bench.' });
  if (best && best.card.modes.length >= 2) {
    return { card: best.card, path: 'struck', how: `struck · hit at ${best.hit.start.toFixed(2)} s · ${best.tried.length} candidate${best.tried.length === 1 ? '' : 's'} judged` };
  }
  const track = trackPitch(hp, sampleRate, { minHz: 50, maxHz: 1200 });
  const runs = voicedRuns(track, { minSec: 0.25 }).sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec));
  if (runs.length) {
    const run = runs[0];
    const s = Math.floor(run.startSec * sampleRate), e = Math.min(hp.length, Math.floor(Math.min(run.endSec, run.startSec + 1) * sampleRate));
    const card = spectralCard(hp.subarray(s, e), sampleRate, { name, license, f0Hz: run.meanHz, note: 'from the bench.' });
    return { card, path: 'sustained', how: `sustained · voiced ${(run.endSec - run.startSec).toFixed(1)} s at ${run.meanHz.toFixed(1)} Hz from ${run.startSec.toFixed(2)} s` };
  }
  const win = Math.floor(0.5 * sampleRate);
  let at = 0, most = -1;
  for (let i = 0; i + win <= hp.length; i += win >> 1) { let en = 0; for (let k = i; k < i + win; k++) en += hp[k] * hp[k]; if (en > most) { most = en; at = i; } }
  const card = spectralCard(hp.subarray(at, Math.min(hp.length, at + win)), sampleRate, { name, license, note: 'from the bench.' });
  return { card, path: 'sustained', how: `sustained · loudest half second at ${(at / sampleRate).toFixed(2)} s, read as peaks` };
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
  const exc = $('cardExcitation'), pitchSel = $('cardPitch'), play = $('btnCardPlay'), stop = $('btnCardStop'), keep = $('btnCardKeep');

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
      const r = cardFromSource(mono, rate, { name: (P && P.name) || 'source' });
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
      try { v = renderVoice({ card, pitchHz, excitation, seconds: AUDITION_SECONDS }); }
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

  keep.addEventListener('click', () => {
    if (!card) return;
    const base = ((P && P.name) || 'source').replace(/[^\w.-]+/g, '_');
    download(JSON.stringify(card, null, 1), `${base}-card.json`, 'application/json');
    status('CARD SAVED · THE INSTRUMENT, NOT THE RECORDING');
  });

  ctx.api.stopInstrument = stopPlayback;
}
