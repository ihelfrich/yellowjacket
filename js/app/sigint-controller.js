// SIGINT — the second state of the SIGNAL bench. SCOPE is the bench as it has
// always been: waveform, spectrogram, meters, repair. SIGINT is the same audio
// read as a transmission rather than as a recording: what is present, what its
// numbers are, what it might be, and what it says.
//
// It is a seventh surface and not a seventh tab on purpose. The work starts
// from a span of the spectrogram that is already on screen, and a new tab would
// have needed its own copy of that.
//
// One rule runs through all of it: a number without an uncertainty is not a
// measurement, and an estimator that cannot tell must say so. Every module
// behind this panel has a refusal path, and the panel prints refusals as
// prominently as answers — a bench that reads confident traffic out of hiss is
// worse than one that reads nothing.
import { measure } from '../sigint/measure.js';
import { designate } from '../sigint/designator.js';
import { classifySegment } from '../sigint/classify.js';
import { segment } from '../sigint/segment.js';
import { decodeCw, cutNumbers } from '../sigint/decode/cw.js';
import { decodeRtty } from '../sigint/decode/rtty.js';
import { identifySelcall } from '../sigint/decode/tones.js';
import { arrivalDifference, WWV_WWVH } from '../sigint/tdoa.js';

const fmt = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const clock = (s) => {
  const m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
};

/** Wrap prose to a width, so a long method string does not run off the panel. */
export function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The measured quantities, in the order a signals analyst writes them down.
 * `bandwidth` nests two of them because the two definitions disagree on
 * carrier-dominant emissions and the module says which to believe.
 */
export function quantities(m) {
  const rows = [
    ['floor', m.noiseFloor],
    ['SNR', m.snr],
    ['centre', m.centre],
    ['offset', m.carrierOffset],
    ['bandwidth', m.bandwidth && m.bandwidth.xdb],
    ['99% power', m.bandwidth && m.bandwidth.occupied99],
    ['drift', m.drift],
    ['symbol rate', m.symbolRate],
    ['FSK shift', m.fskShift],
  ];
  return rows.filter(([, q]) => q && typeof q === 'object');
}

/** Everything the panel prints, as plain data, so it can be tested without a DOM. */
export function reportLines(state, { methods = true } = {}) {
  const out = [];
  const { source, region, measured, classified, decodes, tdoa, detections } = state;
  out.push('YELLOWJACKET · SIGNAL / SIGINT');
  if (source) out.push('source   : ' + source);
  if (region) out.push('region   : ' + clock(region.from) + ' to ' + clock(region.to) + '  (' + fmt(region.to - region.from, 1) + ' s)');
  out.push('');
  if (detections) {
    out.push(`survey   : ${detections.length} emission${detections.length === 1 ? '' : 's'} above the floor`);
    for (const d of detections.slice(0, 12)) {
      out.push(`   ${clock(d.startSec)}–${clock(d.endSec)}  ${fmt(d.lowHz, 0)}–${fmt(d.highHz, 0)} Hz  `
        + `peak SNR ${fmt(d.snrDb, 1)} dB`);
    }
    out.push('');
  }
  if (measured) {
    out.push('measured :');
    // Every quantity this module returns has the same shape — a value with a
    // unit and an uncertainty and the method that produced it, or a null value
    // and the reason there is not one. Printing that shape rather than named
    // fields means a new measurement appears here without this code changing,
    // and a refusal prints its reason instead of an em dash.
    for (const [label, q] of quantities(measured)) {
      if (!q) continue;
      if (q.value == null) {
        out.push(`   ${label.padEnd(14)}not established`);
        if (q.reason) for (const l of wrap(q.reason, 58).slice(0, methods ? 99 : 2)) out.push('                 ' + l);
        continue;
      }
      const unc = Number.isFinite(q.uncertainty) ? ' ± ' + fmt(q.uncertainty, q.uncertainty < 1 ? 3 : 1) : '';
      out.push(`   ${label.padEnd(14)}${fmt(q.value, Math.abs(q.value) < 10 ? 3 : 2)} ${q.unit || ''}${unc}`);
      // On screen one line of provenance is orientation; in the copied report
      // the whole of it is the point, because it is what makes the number checkable.
      if (q.method) for (const l of wrap(q.method, 58).slice(0, methods ? 99 : 1)) out.push('                 ' + l);
    }
    if (measured.detection && measured.detection.reason) {
      out.push('   detection    ' + measured.detection.reason);
    }
    if (measured.designator && measured.designator.designator) {
      out.push('   designator  ' + measured.designator.designator);
      for (const a of measured.designator.assumptions || []) out.push('                 assumes ' + a);
    }
    out.push('');
  }
  if (classified) {
    out.push('classified:');
    for (const h of (classified.ranked || []).slice(0, 4)) {
      out.push(`   ${(h.label || h.id || '?').padEnd(22)} ${fmt(h.score, 2)}`);
      // Evidence arrives as { weight, claim }, and the weight is worth showing:
      // a hypothesis carried by three weight-1 tests is not the same as one
      // carried by a single weight-3 test.
      const claim = (e) => (e && typeof e === 'object' ? `[${e.weight}] ${e.claim}` : String(e));
      for (const e of (h.for || []).slice(0, 3)) out.push('      for     ' + claim(e));
      for (const e of (h.against || []).slice(0, 2)) out.push('      against ' + claim(e));
    }
    if (classified.verdict) out.push(`   verdict  ${classified.verdict}`);
    out.push('');
  }
  for (const d of decodes || []) {
    out.push(`${d.name} :`);
    if (!d.ok) { out.push('   refused — ' + d.reason); out.push(''); continue; }
    for (const line of String(d.text || '').split('\n')) out.push('   ' + line);
    if (d.note) out.push('   (' + d.note + ')');
    out.push('');
  }
  if (tdoa) {
    out.push('two stations:');
    if (!tdoa.ok) { out.push('   refused — ' + tdoa.reason); }
    else {
      out.push(`   arrival difference  ${fmt(tdoa.deltaMs)} ms   spread ${fmt(tdoa.spreadMs)} ms over ${tdoa.used} epochs`);
      out.push(`   path difference     ${fmt(tdoa.pathDifferenceKm, 0)} ± ${fmt(tdoa.pathDifferenceErrorKm, 0)} km`);
      out.push(`   bound               ${fmt(tdoa.boundMs, 1)} ms for this baseline · within it: ${tdoa.withinBound}`);
      for (const n of tdoa.notes || []) out.push('   note  ' + n);
    }
    out.push('');
  }
  out.push('Measured from a recording of a public broadcast. Every number above is');
  out.push('an estimate from this audio alone: nothing here knows the transmitter,');
  out.push('the receiver, or the path between them.');
  return out;
}

export function initSigintController(ctx) {
  const { $, store, status, statusFault } = ctx;
  const host = $('sigintHost');
  if (!host) return;

  const state = { source: null, region: null, measured: null, classified: null, decodes: [], tdoa: null, detections: null };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const head = el('div', 'yj-sigint-head');
  head.append(el('span', 'yj-sigint-title', 'SIGINT'),
    el('span', 'yj-sigint-sub', 'WHAT IS HERE · WHAT ITS NUMBERS ARE · WHAT IT SAYS'));
  const note = el('p', 'yj-sigint-note',
    'The loaded recording read as a transmission. Every estimator here can refuse, '
    + 'and a refusal is printed as plainly as an answer: a bench that reads confident '
    + 'traffic out of hiss is worse than one that reads nothing.');

  const row = el('div', 'yj-sigint-row');
  const btnSurvey = el('button', 'yj-btn', 'SURVEY');
  btnSurvey.title = 'Find the emissions above the noise floor and list them';
  const btnMeasure = el('button', 'yj-btn yj-btn-primary', 'MEASURE');
  btnMeasure.title = 'Centre, bandwidth, drift, symbol rate, shift, SNR — each with its uncertainty';
  const btnClassify = el('button', 'yj-btn', 'CLASSIFY');
  btnClassify.title = 'Ranked hypotheses with the evidence for and against each';
  const btnDecode = el('button', 'yj-btn', 'DECODE');
  btnDecode.title = 'Try the decoders the classification makes plausible';
  const btnTwo = el('button', 'yj-btn', 'TWO STATIONS');
  btnTwo.title = 'Arrival-time difference between two time stations sharing this channel';
  const btnCopy = el('button', 'yj-btn', 'COPY REPORT');
  row.append(btnSurvey, btnMeasure, btnClassify, btnDecode, btnTwo, btnCopy);

  const line = el('p', 'yj-sigint-line');
  line.setAttribute('role', 'status');
  line.textContent = 'LOAD A RECORDING';
  const pre = el('pre', 'yj-sigint-report');
  pre.textContent = '';

  const redraw = () => { pre.textContent = reportLines(state, { methods: false }).join('\n'); };

  // Most of this panel characterises a transmission, for which two minutes is
  // ample. The two-station measurement counts whole minutes, so it needs the
  // recording rather than a window of it.
  function mono(maxSeconds = 120) {
    const buf = store.runtime && store.runtime.buffer;
    if (!buf) { line.textContent = 'NO AUDIO LOADED'; return null; }
    state.source = (store.runtime.name || 'source') + ' · ' + buf.sampleRate + ' Hz';
    const ch = buf.getChannelData(0);
    // A whole hour is neither needed nor affordable; the bench's own selection
    // wins when there is one, and otherwise the first two minutes are plenty to
    // characterise a transmission.
    const sel = ctx.api.getLiftRange && ctx.api.getLiftRange();
    const from = sel && sel.end > sel.start ? sel.start : 0;
    const to = sel && sel.end > sel.start ? sel.end : Math.min(buf.duration, maxSeconds);
    state.region = { from, to };
    const a = Math.max(0, Math.floor(from * buf.sampleRate));
    const b = Math.min(ch.length, Math.ceil(to * buf.sampleRate));
    return { x: ch.subarray(a, b), rate: buf.sampleRate };
  }

  async function run(name, fn, maxSeconds = 120) {
    const src = mono(maxSeconds);
    if (!src) return;
    line.textContent = name + '…';
    await new Promise((r) => setTimeout(r, 0));
    const t0 = Date.now();
    try {
      await fn(src);
      line.textContent = name + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s';
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      line.textContent = name + ' FAULT · ' + why;
      if (statusFault) statusFault('SIGINT · ' + why);
    }
    redraw();
  }

  btnSurvey.addEventListener('click', () => run('SURVEY', ({ x, rate }) => {
    const s = segment(x, rate);
    state.detections = (s.emissions || s.detections || []).slice(0, 40);
    status(`SIGINT · ${state.detections.length} emissions above the floor`);
  }));

  btnMeasure.addEventListener('click', () => run('MEASURE', ({ x, rate }) => {
    state.measured = measure(x, rate);
    if (state.classified && state.classified.verdict) {
      try {
        state.measured.designator = designate(state.classified.verdict, { measurement: state.measured });
      } catch (_) { /* the designator refuses on its own terms; nothing to add */ }
    }
  }));

  btnClassify.addEventListener('click', () => run('CLASSIFY', ({ x, rate }) => {
    state.classified = classifySegment(x, rate, null);
  }));

  btnDecode.addEventListener('click', () => run('DECODE', ({ x, rate }) => {
    state.decodes = [];
    const cw = decodeCw(x, rate);
    state.decodes.push({ name: 'MORSE', ok: !!(cw && cw.ok !== false && cw.text), text: cw && cw.text,
      reason: (cw && cw.reason) || 'nothing that keys like Morse',
      note: cw && cw.wpm ? `${cw.wpm.toFixed(1)} wpm` : null });
    // Figure groups are sent as abbreviated numerals, so a stream of letters
    // that fits that alphabet is almost certainly digits. Offered only when it
    // fits, and the characters that do not are shown rather than smoothed away.
    if (cw && cw.ok !== false && cw.chars) {
      const cut = cutNumbers(cw.chars);
      if (cut.ok) {
        const odd = cut.unmapped.map((u) => `${u.pattern} x${u.count}`).join(', ');
        state.decodes.push({ name: 'AS ABBREVIATED NUMERALS', ok: true, text: cut.text,
          note: `${Math.round(cut.fit * 100)}% of the characters are cut numerals`
            + (odd ? `; these are not: ${odd}` : '') });
      }
    }
    const rtty = decodeRtty(x, rate);
    state.decodes.push({ name: 'RTTY', ok: !!(rtty && rtty.ok && rtty.text), text: rtty && rtty.text,
      reason: (rtty && rtty.reason) || 'no teleprinter framing found' });
    const sel = identifySelcall(x, rate);
    state.decodes.push({ name: 'SELCALL', ok: !!(sel && sel.ok), text: sel && (sel.text || (sel.calls || []).join(' ')),
      reason: (sel && sel.reason) || 'no selective-calling tones' });
  }));

  btnTwo.addEventListener('click', () => run('TWO STATIONS', ({ x, rate }) => {
    state.tdoa = arrivalDifference(x, rate, WWV_WWVH);
    if (state.tdoa.ok) status(`SIGINT · ${state.tdoa.deltaMs.toFixed(1)} ms between the two stations`);
  }, 3600));

  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportLines(state).join('\n'));
      line.textContent = 'REPORT COPIED';
    } catch (_) {
      line.textContent = 'CLIPBOARD REFUSED · SELECT THE TEXT AND COPY IT';
    }
  });

  host.append(head, note, row, line, pre);
  ctx.api.sigintState = () => state;
}
