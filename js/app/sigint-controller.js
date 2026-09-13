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
import { designate } from '../sigint/designator.js';
import { WWV_WWVH } from '../sigint/tdoa.js';
import { sigintRunner } from '../sigint/runner.js';

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

/**
 * What to show a person from a survey. segment() returns two lists and names
 * the authoritative one in `classifyOn`; it also flags what is codec rather
 * than air (`aboveContentEdge`) and what sits in a band whose own floor stands
 * (`selfFloored`, whose SNR is honestly null). The first version of this panel
 * took `emissions` in time order and sliced the first forty, which on an MP3 of
 * a single 45 dB Morse tone put six full-length encoder ridges at −4 dB above
 * the real 30 dB bursts, because the ridges start at 0:00. The second version
 * ranked by `cells` and put a 4 kHz-wide ridge first, because cells reward
 * area. The evidence is `falseAlarmLog10`, the module's own log probability
 * that a component is noise: on M08 the real bursts read −6.9 M and −7.6 M
 * against −114 k for the ridge. Most negative first; a self-floored emission
 * has none and goes last.
 */
export function surveyRows(result, { limit = 40 } = {}) {
  if (!result) return { rows: [], setAside: { codec: 0 }, present: false, reason: 'no survey' };
  const listName = result.classifyOn && Array.isArray(result[result.classifyOn]) ? result.classifyOn : 'emissions';
  const all = Array.isArray(result[listName]) ? result[listName] : [];
  const air = all.filter((d) => !d.aboveContentEdge);
  const evidence = (d) => (Number.isFinite(d.falseAlarmLog10) ? d.falseAlarmLog10 : Infinity);
  // Keyed emissions first: a channel that switches on and off inside its own
  // span is the one a decoder can read, and evidence alone rewards area —
  // measured on M12 and the Marine Electric recording, a splatter component
  // and four long bursts each outranked the Morse beside them.
  const keyed = (d) => (d.keying && d.keying.keyed ? 1 : 0);
  const ranked = air.slice().sort((a, b) => keyed(b) - keyed(a) || evidence(a) - evidence(b) || (b.snrDb ?? -1e9) - (a.snrDb ?? -1e9) || (b.cells || 0) - (a.cells || 0));
  const rows = ranked.slice(0, limit).map((d, i) => ({ ...d, id: d.id ?? ('e' + (i + 1)), k: i + 1 }));
  return {
    rows,
    setAside: { codec: all.length - air.length, beyondLimit: Math.max(0, air.length - limit) },
    present: !!result.present,
    reason: result.reason || null,
    standingBands: Array.isArray(result.standingBands) ? result.standingBands.length : 0,
  };
}

/**
 * What each task is told about the region. A selected band narrows every
 * estimator to it: measure() and segment() take lowHz/highHz directly, classify
 * takes the selected emission, the Morse decoder searches for its tone inside
 * the band.
 *
 * The one trap is time. The worker is handed a SLICE that starts at zero, so an
 * emission's absolute times have to be rebased to it. Passed as-is on M08 they
 * addressed samples past the end of a 17.5 s slice, the classifier saw nothing,
 * and the panel printed 'unclear' in 0 ms; rebased, the same emission reads
 * ook-morse at 0.71.
 */
export function taskOptions(task, opts, state) {
  const r = (state && state.region) || {};
  const has = Number.isFinite(r.lowHz) && Number.isFinite(r.highHz) && r.highHz > r.lowHz;
  if (task === 'measure') return has ? { ...opts, lowHz: r.lowHz, highHz: r.highHz } : opts;
  if (task === 'classify') {
    const d = ((state && state.detections) || []).find((x) => x.id === state.selectedId);
    if (d) {
      const from = Number.isFinite(r.from) ? r.from : 0;
      const seconds = Number.isFinite(r.to) ? r.to - from : Infinity;
      return { ...opts, detection: { ...d, startSec: Math.max(0, d.startSec - from), endSec: Math.min(seconds, d.endSec - from) } };
    }
    return has ? { ...opts, lowHz: r.lowHz, highHz: r.highHz } : opts;
  }
  if (task === 'decode') return has ? { ...opts, cw: { ...(opts.cw || {}), searchLoHz: r.lowHz, searchHiHz: r.highHz } } : opts;
  return opts;
}

/** Everything the panel prints, as plain data, so it can be tested without a DOM. */
export function reportLines(state, { methods = true } = {}) {
  const out = [];
  const { source, region, measured, classified, decodes, tdoa, marker, crypto, detections } = state;
  out.push('YELLOWJACKET · SIGNAL / SIGINT');
  if (source) out.push('source   : ' + source);
  if (region) {
    out.push('region   : ' + clock(region.from) + ' to ' + clock(region.to) + '  (' + fmt(region.to - region.from, 1) + ' s)'
      + (Number.isFinite(region.lowHz) && Number.isFinite(region.highHz)
        ? '  · ' + fmt(region.lowHz, 0) + '–' + fmt(region.highHz, 0) + ' Hz' : '  · full band')
      + (region.how ? '  · ' + region.how : ''));
  }
  out.push('');
  if (detections) {
    const aside = state.survey && state.survey.setAside ? state.survey.setAside : { codec: 0 };
    out.push(`survey   : ${detections.length} emission${detections.length === 1 ? '' : 's'} above the floor, strongest evidence first`
      + (aside.codec ? `; ${aside.codec} above the recording's content edge set aside as codec, not air` : ''));
    for (const d of detections.slice(0, 12)) {
      out.push(`   #${d.k ?? '?'}  ${clock(d.startSec)}–${clock(d.endSec)}  ${fmt(d.lowHz, 0)}–${fmt(d.highHz, 0)} Hz  `
        + (d.selfFloored ? 'own floor' : `SNR ${fmt(d.snrDb, 1)} dB`)
        + (Number.isFinite(d.cells) ? `  ${d.cells} cells` : ''));
    }
    if (!detections.length && state.survey && state.survey.reason) out.push('   ' + state.survey.reason);
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
    if (d.image) out.push(`   (the picture is drawn above: ${d.image.width}x${d.image.height}, ${d.image.lines} lines read)`);
    out.push('');
  }
  if (marker) {
    out.push('marker watch:');
    if (!marker.ok) out.push('   refused — ' + marker.reason);
    else {
      out.push('   ' + marker.text);
      out.push(`   band ${marker.band.lowHz}-${marker.band.highHz} Hz, ${marker.band.overDb} dB over the rest of the channel`);
      out.push(`   cycle ${marker.cycle.periodSec} s at ${(marker.cycle.duty * 100).toFixed(0)}% duty, repeating ${marker.cycle.regularity}`);
      for (const e of marker.events.slice(0, 24)) out.push(`   ${e.startSec.toFixed(2)}s  ${e.kind.toUpperCase().padEnd(9)} ${e.what}`);
      if (marker.events.length > 24) out.push(`   … and ${marker.events.length - 24} more`);
      out.push(`   bars: a hole is over ${marker.thresholds.minHoleSec} s of silence, an intrusion over ${marker.thresholds.minIntrusionSec} s at ${marker.thresholds.intrusionOverDb} dB`);
    }
    out.push('');
  }
  if (crypto) {
    out.push('cipher:');
    const st = crypto.structure;
    if (!st || !st.ok) out.push('   ' + ((st && st.reason) || 'nothing to analyse'));
    else {
      out.push(`   ${st.symbols} ${st.alphabet} · ${st.text}`);
      out.push(`   index of coincidence ${st.ic.value} against ${st.ic.expected} expected (${st.ic.z} standard errors)`);
      for (const f of st.findings) out.push(`   found  ${f.test}: ${f.what}`);
      for (const f of st.findings) out.push(`          ${f.means}`);
      if (!st.breakable) for (const line of wrap(st.verdict, 74)) out.push('   ' + line);
    }
    const cl = crypto.classical;
    if (cl) {
      if (cl.ok) {
        out.push(`   ${cl.best.cipher} · key ${cl.best.key !== undefined ? cl.best.key : cl.best.order} · z ${cl.best.z}`);
        for (const line of wrap(cl.best.plaintext, 72)) out.push('   ' + line);
      } else {
        out.push('   ' + (cl.reason || 'no classical cipher fits'));
        out.push('   tried: ' + cl.ranked.map((r) => `${r.cipher} z ${r.z}`).join(', '));
      }
    }
    const en = crypto.enigma;
    if (en) {
      out.push(en.ok ? '   enigma:' : '   enigma: ' + (en.reason || 'not an Enigma message'));
      if (en.ok) {
        out.push(`      rotors ${en.setting.rotors.join(' ')} · reflector ${en.setting.reflector} · rings ${en.setting.rings} · positions ${en.setting.positions}`);
        out.push(`      plugboard ${en.setting.plugboard || '(none)'} · z ${en.z}`);
        for (const line of wrap(en.plaintext, 72)) out.push('      ' + line);
        if (en.caution) for (const line of wrap(en.caution, 70)) out.push('      ! ' + line);
      }
    }
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

  const state = { source: null, region: null, measured: null, classified: null, decodes: [], tdoa: null, marker: null, crypto: null, detections: null, selectedId: null };
  const spec = ctx.views && ctx.views.spec;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

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
  const btnMarker = el('button', 'yj-btn', 'MARKER WATCH');
  btnMarker.title = 'Find the moments a channel marker stops — the few seconds of a long recording that are not the buzzing';
  const btnCipher = el('button', 'yj-btn', 'CIPHER');
  btnCipher.title = 'Take what the decoders read and ask what it is: a pad, a code book, a classical cipher, or an Enigma message';
  const btnCopy = el('button', 'yj-btn', 'COPY REPORT');
  row.append(btnSurvey, btnMeasure, btnClassify, btnDecode, btnTwo, btnMarker, btnCipher, btnCopy);

  const line = el('p', 'yj-sigint-line');
  line.setAttribute('role', 'status');
  line.textContent = 'LOAD A RECORDING';
  // The numbers go in readout wells, the bench's own idiom for a measured value;
  // the classification, the decodes and the two-station result stay as text.
  // The copied report carries all of it with full provenance.
  // The survey, as a list a person can click; the same emissions are outlined
  // on the spectrogram, and clicking either selects the region for everything
  // else on this rail.
  const list = el('div', 'yj-sigint-list');
  list.hidden = true;
  const readouts = document.createElement('dl');
  readouts.className = 'yj-readouts yj-sigint-readouts';
  readouts.hidden = true;
  const designator = el('p', 'yj-sigint-designator');
  designator.hidden = true;
  // Where a decoded picture goes. Hidden until something returns one.
  const picture = el('figure', 'yj-sigint-picture');
  picture.hidden = true;
  const canvas = document.createElement('canvas');
  const caption = document.createElement('figcaption');
  picture.append(canvas, caption);

  /** Paint the first decoder result that carried an image, or hide the frame. */
  function showPicture(decodes) {
    const withImage = (decodes || []).find((d) => d && d.ok && d.image && d.image.rgba);
    if (!withImage) { picture.hidden = true; return; }
    const im = withImage.image;
    canvas.width = im.width; canvas.height = im.height;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) { picture.hidden = true; return; }
    const data = new ImageData(new Uint8ClampedArray(im.rgba), im.width, im.height);
    ctx2d.putImageData(data, 0, 0);
    caption.textContent = `${withImage.name} · ${withImage.text}`;
    picture.hidden = false;
  }

  const pre = el('pre', 'yj-sigint-report');
  pre.textContent = '';

  const detRect = (d) => ({ t0: d.startSec, t1: d.endSec, f0: d.lowHz, f1: d.highHz });
  const selectDetection = (id, { fromSpectrogram = false } = {}) => {
    state.selectedId = id;
    const d = (state.detections || []).find((x) => x.id === id) || null;
    if (d && spec && !fromSpectrogram && spec.setRegion) spec.setRegion(detRect(d));
    if (spec && spec.setDetections) spec.setDetections(state.detections || [], id);
    if (d) {
      state.region = { from: d.startSec, to: d.endSec, lowHz: d.lowHz, highHz: d.highHz, how: 'emission ' + (d.k ?? id) };
      line.textContent = 'SELECTED ' + clock(d.startSec) + '–' + clock(d.endSec) + ' · '
        + fmt(d.lowHz, 0) + '–' + fmt(d.highHz, 0) + ' Hz · MEASURE, CLASSIFY OR DECODE IT';
    }
    redraw();
  };
  const redraw = () => {
    list.textContent = '';
    const dets = state.detections || [];
    for (const d of dets) {
      const b = el('button', 'yj-sigint-det' + (d.id === state.selectedId ? ' is-selected' : ''));
      b.type = 'button';
      const k = el('span', 'k', '#' + (d.k ?? d.id));
      const where = el('span', '', clock(d.startSec) + '–' + clock(d.endSec) + ' · ' + fmt(d.lowHz, 0) + '–' + fmt(d.highHz, 0) + ' Hz');
      // A self-floored emission has no honest SNR: its band's own floor is the
      // signal. Saying so beats printing a dash a reader will fill in.
      const snr = el('span', 'snr', d.selfFloored ? 'own floor' : (Number.isFinite(d.snrDb) ? fmt(d.snrDb, 1) + ' dB' : ''));
      if (d.selfFloored) b.title = 'This band\'s own floor stands above its surroundings: an SNR against itself would be meaningless';
      b.append(k, where, snr);
      if (!b.title) b.title = 'Select this emission as the region';
      b.addEventListener('click', () => selectDetection(d.id));
      list.appendChild(b);
    }
    list.hidden = !dets.length;
    readouts.textContent = '';
    const m = state.measured;
    if (m) {
      for (const [label, q] of quantities(m)) {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.className = 'yj-well';
        if (q.value == null) {
          dd.classList.add('is-off');
          dd.textContent = 'not established';
          if (q.reason) { dd.title = q.reason; dt.title = q.reason; }
        } else {
          const unc = Number.isFinite(q.uncertainty) ? ' ± ' + fmt(q.uncertainty, q.uncertainty < 1 ? 3 : 1) : '';
          dd.textContent = fmt(q.value, Math.abs(q.value) < 10 ? 3 : 2) + ' ' + (q.unit || '') + unc;
          if (q.method) dd.title = q.method;
        }
        row.append(dt, dd);
        readouts.appendChild(row);
      }
      const d = m.designator && m.designator.designator;
      designator.textContent = d ? 'emission designator ' + d
        : (m.detection && m.detection.reason ? m.detection.reason : '');
      designator.hidden = !designator.textContent;
    }
    readouts.hidden = !m;
    // everything that is not a number, without repeating the numbers
    pre.textContent = reportLines({ ...state, measured: null }, { methods: false }).join('\n');
  };

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
    // The region, in order of how deliberately it was chosen: a rectangle drawn
    // or clicked on the spectrogram (time and band), then the bench's own time
    // selection, then the first two minutes.
    const r = spec && spec.region;
    const sel = ctx.api.getLiftRange && ctx.api.getLiftRange();
    let from, to, lowHz = null, highHz = null, how;
    if (r && r.t1 > r.t0) {
      from = r.t0; to = Math.min(r.t1, r.t0 + maxSeconds); lowHz = r.f0; highHz = r.f1;
      how = state.selectedId != null && state.region && state.region.how ? state.region.how : 'spectrogram selection';
    } else if (sel && sel.end > sel.start) {
      from = sel.start; to = Math.min(sel.end, sel.start + maxSeconds); how = 'bench selection';
    } else {
      from = 0; to = Math.min(buf.duration, maxSeconds); how = 'first ' + Math.round(to) + ' s';
    }
    state.region = { from, to, lowHz, highHz, how };
    const a = Math.max(0, Math.floor(from * buf.sampleRate));
    const b = Math.min(ch.length, Math.ceil(to * buf.sampleRate));
    // A copy, not a subarray: the runner transfers the buffer to the worker,
    // and a detached view of a live AudioBuffer channel would take the page's
    // own audio with it.
    return { x: ch.slice(a, b), rate: buf.sampleRate };
  }

  let running = false;
  async function run(name, task, opts = {}, maxSeconds = 120) {
    if (running) { line.textContent = 'ALREADY WORKING · ' + line.textContent; return; }
    const src = mono(maxSeconds);
    if (!src) return;
    running = true;
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    line.textContent = name + (sigintRunner.available ? ' (off the main thread)…' : '…');
    await new Promise((r) => setTimeout(r, 0));
    const t0 = Date.now();
    try {
      const band = bandOpts(task, opts);
      const result = await sigintRunner.run(task, src.x, src.rate, band);
      apply(task, result);
      line.textContent = name + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s';
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      line.textContent = name + ' FAULT · ' + why;
      if (statusFault) statusFault('SIGINT · ' + why);
    } finally {
      running = false;
      for (const b of row.querySelectorAll('button')) b.disabled = false;
    }
    redraw();
  }

  const bandOpts = (task, opts) => taskOptions(task, opts, state);

  function apply(task, result) {
    if (task === 'segment') {
      const read = surveyRows(result);
      state.detections = read.rows;
      state.survey = read;
      state.selectedId = null;
      if (spec && spec.setDetections) spec.setDetections(state.detections, null);
      const aside = read.setAside.codec ? ` · ${read.setAside.codec} codec ridge${read.setAside.codec === 1 ? '' : 's'} set aside` : '';
      status(read.rows.length
        ? `SIGINT · ${read.rows.length} emissions above the floor${aside} · click one on the spectrogram or below`
        : `SIGINT · nothing above the floor${aside}${read.reason ? ' · ' + read.reason : ''}`);
    } else if (task === 'measure') {
      state.measured = result;
    } else if (task === 'classify') {
      state.classified = result;
    } else if (task === 'decode') {
      state.decodes = result;
      showPicture(result);
    } else if (task === 'crypto') {
      state.crypto = result;
      const st = result.structure;
      status(result.classical && result.classical.ok
        ? `SIGINT · ${result.classical.best.cipher} solved at z ${result.classical.best.z}`
        : (result.enigma && result.enigma.ok
          ? `SIGINT · enigma solved, rotors ${result.enigma.setting.rotors.join(' ')}`
          : `SIGINT · ${st && st.ok ? (st.breakable ? 'structure found: ' + st.findings.map((f) => f.test).join(', ') : 'consistent with a one-time pad') : 'nothing to analyse'}`));
    } else if (task === 'marker') {
      state.marker = result;
      if (result.ok) {
        status(`SIGINT · ${result.events.length ? `${result.holes} hole${result.holes === 1 ? '' : 's'}, ${result.intrusions} intrusion${result.intrusions === 1 ? '' : 's'}` : 'marker unbroken'} in ${result.spanSec} s`);
      }
    } else if (task === 'tdoa') {
      state.tdoa = result;
      if (result.ok) status(`SIGINT · ${result.deltaMs.toFixed(1)} ms between the two stations`);
    }
  }

  btnSurvey.addEventListener('click', () => run('SURVEY', 'segment'));
  btnMeasure.addEventListener('click', () => run('MEASURE', 'measure'));
  btnClassify.addEventListener('click', () => run('CLASSIFY', 'classify'));
  btnDecode.addEventListener('click', () => run('DECODE', 'decode'));
  btnTwo.addEventListener('click', () => run('TWO STATIONS', 'tdoa', { station: WWV_WWVH }, 3600));
  // The whole recording, not a selection: the point is to find a few seconds
  // inside hours.
  btnMarker.addEventListener('click', () => run('MARKER WATCH', 'marker', {}, 7200));
  // The cipher task reads TEXT, not audio, so it takes whatever the decoders
  // produced. Nothing decoded means nothing to analyse, and it says so rather
  // than running a search on an empty string.
  btnCipher.addEventListener('click', () => {
    const parts = [];
    for (const d of state.decodes || []) if (d && d.ok && d.text) parts.push(String(d.text));
    const text = parts.join(' ');
    if (!text.replace(/[^A-Za-z0-9]/g, '')) {
      statusFault('CIPHER · nothing has been decoded yet — press DECODE first');
      return;
    }
    run('CIPHER', 'crypto', { text }, 1);
  });

  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportLines(state).join('\n'));
      line.textContent = 'REPORT COPIED';
    } catch (_) {
      line.textContent = 'CLIPBOARD REFUSED · SELECT THE TEXT AND COPY IT';
    }
  });

  if (spec && spec.addEventListener) {
    spec.addEventListener('detectionselect', (e) => selectDetection(e.detail.id, { fromSpectrogram: true }));
    spec.addEventListener('regionselect', (e) => {
      const r = e.detail;
      if (!r) { state.selectedId = null; if (spec.setDetections) spec.setDetections(state.detections || [], null); redraw(); return; }
      // A drawn rectangle is a region without being an emission.
      if (state.selectedId != null) { state.selectedId = null; if (spec.setDetections) spec.setDetections(state.detections || [], null); }
      line.textContent = 'REGION ' + clock(r.t0) + '–' + clock(r.t1) + ' · ' + fmt(r.f0, 0) + '–' + fmt(r.f1, 0) + ' Hz · MEASURE, CLASSIFY OR DECODE IT';
      redraw();
    });
  }
  // The survey outlines belong to SIGINT; SCOPE gets its spectrogram back clean.
  ctx.api.sigintStateShown = (on) => {
    if (!spec || !spec.setDetections) return;
    spec.setDetections(on ? (state.detections || []) : [], on ? state.selectedId : null);
  };

  host.append(note, row, line, list, readouts, designator, picture, pre);
  ctx.api.sigintState = () => state;
}
