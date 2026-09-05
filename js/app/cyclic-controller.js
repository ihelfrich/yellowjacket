// Periodicities panel on the SIGNAL bench: read the loaded audio's modulation
// spectrum, list what repeats and on which carrier, transcribe it into a
// score at those exact rates, hear it on the stand-in instrument, and take it
// away as MIDI. The reading covers the first READ_SECONDS; the score covers
// the first SCORE_SECONDS in sections. Nothing here touches the recording.

import { analyseCyclic } from '../analysis/cyclic.js';
import { composeCyclic, scoreToSmf } from '../compose/cyclic-score.js';
import { renderScore } from '../compose/cyclic-synth.js';
import { download } from '../export.js';

export const READ_SECONDS = 60;
export const SCORE_SECONDS = 120;
export const SECTION_SECONDS = 20;
const RENDER_RATE = 22050;
const IDLE = 'Rates at which the bands rise and fall. Reads the loaded audio.';

const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

/** One list row per periodicity; pure so it can be tested without a DOM. */
export function peakRows(result, { limit = 8 } = {}) {
  if (!result) return [];
  return result.peaks.slice(0, limit).map((p) => {
    const bin = result.peakBin[p.index];
    return {
      alphaHz: p.alphaHz,
      period: 1 / p.alphaHz,
      carrierHz: bin * result.spectrum.binHz,
      bands: p.bands,
      strength: p.strength,
      harmonic: !!p.harmonicOf,
      text: `${p.alphaHz.toFixed(2)} Hz · ${(1 / p.alphaHz).toFixed(2)} s`,
      detail: `${Math.round(bin * result.spectrum.binHz)} Hz · ${p.bands} band${p.bands === 1 ? '' : 's'}${p.harmonicOf ? ' · harmonic' : ''}`,
    };
  });
}

/** One-line summary of a score for the panel. */
export function scoreSummary(score) {
  const layers = score.sections.flatMap((s) => s.layers);
  const count = (m) => layers.filter((L) => L.motion === m).length;
  const parts = [];
  if (count('swell')) parts.push(`${count('swell')} swell${count('swell') === 1 ? '' : 's'}`);
  if (count('pulse')) parts.push(`${count('pulse')} pulse${count('pulse') === 1 ? '' : 's'}`);
  if (count('buzz')) parts.push(`${count('buzz')} buzz${count('buzz') === 1 ? '' : 'es'}`);
  return `${score.sections.length} sections · ${layers.length} layers · ${parts.join(', ') || 'nothing above threshold'} · exact rates, measured phase`;
}

export function initCyclicController(ctx) {
  const { store, engine, $, status, statusFault } = ctx;
  const R = store.runtime;
  const P = store.project;
  const btn = $('btnCyclic');
  if (!btn) return;
  const list = $('cyclicList'), note = $('cyclicNote'), actions = $('cyclicActions');
  const play = $('btnCyclicPlay'), stop = $('btnCyclicStop'), midi = $('btnCyclicMidi'), scoreNote = $('cyclicScoreNote');

  let score = null;
  let rendered = null;
  let source = null;

  function stopPlayback() {
    if (source) { try { source.onended = null; source.stop(); } catch (_) { /* already stopped */ } }
    source = null;
    play.hidden = false;
    stop.hidden = true;
  }

  function reset() {
    stopPlayback();
    score = null; rendered = null;
    list.hidden = true; list.innerHTML = '';
    actions.hidden = true; scoreNote.hidden = true;
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
    status('READING PERIODICITIES', true);
    await yieldToPaint();
    try {
      const seconds = mono.length / rate;
      const r = analyseCyclic({ mono, sampleRate: rate, startSec: 0, endSec: Math.min(seconds, READ_SECONDS) });
      const rows = peakRows(r);
      list.innerHTML = '';
      for (const row of rows) {
        const li = document.createElement('li');
        if (row.harmonic) li.className = 'is-harmonic';
        const a = document.createElement('span'); a.textContent = row.text;
        const b = document.createElement('span'); b.textContent = row.detail;
        li.append(a, b);
        list.appendChild(li);
      }
      list.hidden = !rows.length;
      note.textContent = rows.length
        ? `${rows.length} periodicit${rows.length === 1 ? 'y' : 'ies'} in the first ${Math.round(Math.min(seconds, READ_SECONDS))} s · usable to ${r.spectrum.usableAlphaHz.toFixed(1)} Hz`
        : `Nothing repeats above threshold in the first ${Math.round(Math.min(seconds, READ_SECONDS))} s.`;
      status('TRANSCRIBING', true);
      await yieldToPaint();
      const span = Math.min(seconds, SCORE_SECONDS);
      score = composeCyclic({
        mono: mono.subarray(0, Math.floor(span * rate)), sampleRate: rate,
        sectionSec: SECTION_SECONDS, maxLayers: 4, title: `${(P && P.name) || 'source'} — cyclic transcription`,
      });
      rendered = null;
      const layers = score.sections.reduce((n, s) => n + s.layers.length, 0);
      scoreNote.textContent = scoreSummary(score);
      scoreNote.hidden = false;
      actions.hidden = !layers;
      status(layers ? 'TRANSCRIBED · ' + layers + ' LAYERS' : 'NOTHING TO TRANSCRIBE');
    } catch (err) {
      statusFault ? statusFault('PERIODICITIES FAILED · ' + (err && err.message ? err.message : err)) : status('PERIODICITIES FAILED');
    } finally {
      btn.disabled = false;
    }
  });

  play.addEventListener('click', async () => {
    if (!score) return;
    stopPlayback();
    if (!rendered) {
      status('RENDERING TRANSCRIPTION', true);
      await yieldToPaint();
      rendered = renderScore(score, { rate: RENDER_RATE });
    }
    source = engine.audition(rendered, { sampleRate: RENDER_RATE, gain: 0.9 });
    if (!source) { status('NO AUDIO CONTEXT · PLAY THE SOURCE ONCE FIRST'); return; }
    play.hidden = true;
    stop.hidden = false;
    status('TRANSCRIPTION · STAND-IN INSTRUMENT');
    source.onended = () => { if (source) { source = null; play.hidden = false; stop.hidden = true; } };
  });
  stop.addEventListener('click', () => { stopPlayback(); status('STOPPED'); });

  midi.addEventListener('click', () => {
    if (!score) return;
    const base = ((P && P.name) || 'source').replace(/[^\w.-]+/g, '_');
    download(scoreToSmf(score), `${base}-cyclic.mid`, 'audio/midi');
    status('MIDI SAVED · EXACT RATES ON A 960-TICK QUARTER');
  });

  ctx.api.stopCyclic = stopPlayback;
}
