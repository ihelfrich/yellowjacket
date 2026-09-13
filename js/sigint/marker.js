// A marker channel, and the moments it stops.
//
// Some transmitters exist to hold a frequency. UVB-76 has buzzed on 4625 kHz
// since the 1970s; the Russian navy's channel markers repeat a letter for
// years; NATO and Chinese nets keep similar guard channels alive. The traffic
// is not the marker. The traffic is the handful of seconds, sometimes years
// apart, when the marker stops and a voice reads a list of words, and then the
// buzzing resumes. Nobody outside the net knows what the words mean. That is
// the interesting part of the recording, and on a 28-hour capture it is a few
// seconds somewhere inside a hundred thousand.
//
// This finds them. It does not know what a buzzer sounds like. It measures
// whatever repeating pattern the recording actually has, then reports every
// span that departs from it:
//
//   1. The marker's band — the narrow band carrying the most persistent
//      energy, found rather than named.
//   2. Its cycle — the period of the on/off envelope in that band, from the
//      autocorrelation, with the duty and how regular it is.
//   3. The departures — a cycle where the marker should have been on and was
//      not (a HOLE), a span where the channel carries energy the marker's own
//      band does not explain (an INTRUSION), and a stretch where the cycle
//      itself changes (a SHIFT).
//
// It refuses when there is no repeating marker to depart from, because on a
// recording with no marker every second is a departure and a list of a hundred
// thousand of them is not a finding.
//
// Pure and worker-safe.
import { FFT } from '../fft.js';

export const DEFAULT_HOP_SEC = 0.02;

/**
 * A coarse spectrogram: magnitude per bin per frame. Deliberately its own,
 * not segment.js's — this needs long frames over long spans and no floor
 * model, and segment.js needs the opposite.
 */
export function bandFrames(x, sampleRate, { fftSize = 2048, hopSec = DEFAULT_HOP_SEC } = {}) {
  const size = 1 << Math.round(Math.log2(fftSize));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const plan = new FFT(size, { precision: 'f64' });
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  const frames = Math.max(0, Math.floor((x.length - size) / hop) + 1);
  const bins = size >> 1;
  const mag = new Float32Array(frames * bins);
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let t = 0; t < frames; t++) {
    const at = t * hop;
    for (let i = 0; i < size; i++) { re[i] = x[at + i] * w[i]; im[i] = 0; }
    plan.forward(re, im);
    for (let b = 0; b < bins; b++) mag[t * bins + b] = Math.hypot(re[b], im[b]);
  }
  return { mag, frames, bins, binHz: sampleRate / size, hopSec: hop / sampleRate, fftSize: size };
}

/**
 * The marker's band. A marker is narrow and almost always on, so the score is
 * the MEDIAN level of a band across the whole span — a band that is loud in a
 * few frames and quiet in the rest loses to one that is always there. Bands
 * are scanned at several widths so a 100 Hz buzz and a 600 Hz one both win on
 * their own terms.
 */
export function findMarkerBand(sp, { minHz = 150, maxHz = 3500, widths = [3, 6, 12, 24, 48] } = {}) {
  const { mag, frames, bins, binHz } = sp;
  const lo = Math.max(1, Math.floor(minHz / binHz)), hi = Math.min(bins - 1, Math.ceil(maxHz / binHz));
  if (hi - lo < 8 || frames < 16) return null;
  // Median per bin over time, in one pass per bin.
  const med = new Float64Array(bins);
  const col = new Float64Array(frames);
  for (let b = lo; b <= hi; b++) {
    for (let t = 0; t < frames; t++) col[t] = mag[t * bins + b];
    const s = Float64Array.from(col).sort();
    med[b] = s[frames >> 1];
  }
  // The background: the median of those medians, so a band is judged against
  // the rest of the channel rather than against silence.
  const spread = Float64Array.from(med.subarray(lo, hi + 1)).sort();
  const background = spread[spread.length >> 1] || 1e-12;
  let best = null;
  for (const wBins of widths) {
    let run = 0;
    for (let b = lo; b + wBins <= hi; b++) {
      if (b === lo) { run = 0; for (let k = 0; k < wBins; k++) run += med[b + k]; }
      else { run += med[b + wBins - 1] - med[b - 1]; }
      const mean = run / wBins;
      const overDb = 20 * Math.log10(mean / background);
      const score = overDb - 2 * Math.log2(wBins);   // prefer the narrowest band that explains it
      if (!best || score > best.score) best = { binLo: b, binHi: b + wBins - 1, overDb: +overDb.toFixed(1), score, widthBins: wBins };
    }
  }
  if (!best) return null;
  return { ...best, lowHz: +(best.binLo * binHz).toFixed(1), highHz: +((best.binHi + 1) * binHz).toFixed(1), background };
}

/** Energy in a band, per frame. */
export function bandEnvelope(sp, binLo, binHi) {
  const { mag, frames, bins } = sp;
  const env = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    let s = 0;
    for (let b = binLo; b <= binHi; b++) { const v = mag[t * bins + b]; s += v * v; }
    env[t] = Math.sqrt(s / (binHi - binLo + 1));
  }
  return env;
}

/**
 * The marker's cycle: the period of its on/off pattern, from the
 * autocorrelation of the thresholded envelope. `regularity` is the
 * autocorrelation at that period, 0 to 1 — a buzzer sits high, a voice channel
 * near zero.
 */
export function markerCycle(env, hopSec, { minPeriodSec = 0.5, maxPeriodSec = 30 } = {}) {
  const n = env.length;
  if (n < 64) return { ok: false, reason: 'too few frames' };
  const s = Float64Array.from(env).sort();
  const lo = s[Math.floor(n * 0.15)], hi = s[Math.floor(n * 0.85)];
  const thr = Math.sqrt(Math.max(lo, 1e-12) * Math.max(hi, 1e-12));
  const contrastDb = 20 * Math.log10(Math.max(hi, 1e-12) / Math.max(lo, 1e-12));
  const on = new Float64Array(n);
  let onCount = 0;
  for (let i = 0; i < n; i++) { on[i] = env[i] > thr ? 1 : 0; onCount += on[i]; }
  const duty = onCount / n;
  if (duty <= 0.001 || duty >= 0.999) {
    return { ok: false, reason: `the band is ${duty > 0.5 ? 'never off' : 'never on'}, so it has no cycle to depart from`, duty, contrastDb, threshold: thr, on };
  }
  let mean = duty;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = on[i] - mean;
  let denom = 0; for (let i = 0; i < n; i++) denom += c[i] * c[i];
  if (denom <= 0) return { ok: false, reason: 'the on/off pattern has no variance', duty, contrastDb, threshold: thr, on };
  const lagMin = Math.max(2, Math.round(minPeriodSec / hopSec));
  const lagMax = Math.min(n >> 1, Math.round(maxPeriodSec / hopSec));
  if (lagMax <= lagMin + 2) return { ok: false, reason: 'the span is too short to hold a cycle', duty, contrastDb, threshold: thr, on };
  const r = new Float64Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += c[i] * c[i - lag];
    r[lag] = acc / denom;
  }
  // A PEAK, not the largest value. Autocorrelation runs high at short lags for
  // anything that varies slowly, so the largest value of a signal with no
  // cycle sits at whatever the search floor happens to be: the shelf's 2010
  // UVB-76 capture came back with a "0.3 s cycle", which was the floor, and
  // then reported 38 departures from a cycle that was not there. A period has
  // to be a local maximum with the lags either side below it.
  let bestLag = 0, bestR = -Infinity;
  for (let lag = lagMin + 1; lag < lagMax; lag++) {
    if (!(r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) continue;
    if (r[lag] > bestR) { bestR = r[lag]; bestLag = lag; }
  }
  // Prefer the fundamental: the earliest peak within 90% of the best is the
  // cycle, and the later ones are its multiples.
  if (bestLag) {
    for (let lag = lagMin + 1; lag < bestLag; lag++) {
      if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= 0.9 * bestR) { bestLag = lag; bestR = r[lag]; break; }
    }
  }
  if (!bestLag) {
    return { ok: false, reason: `the on/off pattern has no peak in its autocorrelation between ${minPeriodSec} and ${(lagMax * hopSec).toFixed(1)} s, so it does not cycle`, duty, contrastDb, threshold: thr, on };
  }
  return {
    ok: true,
    periodSec: +(bestLag * hopSec).toFixed(3),
    regularity: +Math.max(0, bestR).toFixed(3),
    duty: +duty.toFixed(3), contrastDb: +contrastDb.toFixed(1),
    threshold: thr, on,
  };
}

/**
 * Watch a recording for the moments its marker stops.
 *
 * `minRegularity` is how repeating the marker has to be before a departure
 * from it means anything; `minHoleSec` and `minIntrusionSec` are how long a
 * departure has to last before it is worth a line. Every threshold is
 * reported alongside the findings, because a watch is only as honest as its
 * bar.
 */
export function watchMarker(x, sampleRate, {
  minRegularity = 0.25, minHoleSec = 1.0, minIntrusionSec = 0.7, hopSec = DEFAULT_HOP_SEC,
  intrusionOverDb = 6, minHz = 150, maxHz = 3500,
} = {}) {
  if (!x || x.length < sampleRate * 8) return { ok: false, reason: 'a marker watch needs at least eight seconds' };
  const sp = bandFrames(x, sampleRate, { hopSec });
  const band = findMarkerBand(sp, { minHz, maxHz });
  if (!band) return { ok: false, reason: 'no band to watch: the span is too short or too narrow' };
  const env = bandEnvelope(sp, band.binLo, band.binHi);
  const cycle = markerCycle(env, sp.hopSec);
  if (!cycle.ok) {
    return { ok: false, reason: `nothing in ${band.lowHz}-${band.highHz} Hz repeats: ${cycle.reason}`, band, cycle };
  }
  if (cycle.regularity < minRegularity) {
    return {
      ok: false,
      reason: `the strongest band, ${band.lowHz}-${band.highHz} Hz, does not repeat regularly enough to call a marker `
        + `(its on/off pattern autocorrelates ${cycle.regularity} at ${cycle.periodSec} s, and ${minRegularity} is the bar). `
        + 'Without a marker, every second is a departure and a list of them is not a finding.',
      band, cycle,
    };
  }

  // The rest of the channel: everything outside the marker's band. An
  // intrusion is energy HERE, not in the marker's band, because a voice that
  // replaces a buzz occupies a different shape of spectrum.
  const { mag, frames, bins } = sp;
  const outside = new Float64Array(frames);
  const loBin = Math.max(1, Math.floor(minHz / sp.binHz)), hiBin = Math.min(bins - 1, Math.ceil(maxHz / sp.binHz));
  let outBins = 0;
  for (let b = loBin; b <= hiBin; b++) if (b < band.binLo || b > band.binHi) outBins++;
  for (let t = 0; t < frames; t++) {
    let s = 0;
    for (let b = loBin; b <= hiBin; b++) {
      if (b >= band.binLo && b <= band.binHi) continue;
      const v = mag[t * bins + b]; s += v * v;
    }
    outside[t] = Math.sqrt(s / Math.max(1, outBins));
  }
  const oSorted = Float64Array.from(outside).sort();
  const outBase = oSorted[frames >> 1] || 1e-12;
  const outThr = outBase * 10 ** (intrusionOverDb / 20);

  const events = [];
  const minHole = Math.round(minHoleSec / sp.hopSec);
  const minIntr = Math.round(minIntrusionSec / sp.hopSec);
  const at = (t) => +(t * sp.hopSec).toFixed(2);

  // Holes: the marker silent for longer than its own cycle allows.
  const holeFloor = Math.max(minHole, Math.round(1.5 * cycle.periodSec / sp.hopSec));
  let run = 0;
  for (let t = 0; t <= frames; t++) {
    const off = t < frames && !cycle.on[t];
    if (off) { run++; continue; }
    if (run >= holeFloor) {
      const a = t - run, b = t;
      let peakOut = 0;
      for (let i = a; i < b; i++) peakOut = Math.max(peakOut, outside[i]);
      events.push({
        kind: 'hole', startSec: at(a), endSec: at(b), seconds: +((b - a) * sp.hopSec).toFixed(2),
        otherEnergyOverDb: +(20 * Math.log10(peakOut / outBase)).toFixed(1),
        what: `the marker stopped for ${((b - a) * sp.hopSec).toFixed(1)} s`
          + (peakOut > outThr ? ' and something else was in the channel' : ' and the channel went quiet'),
      });
    }
    run = 0;
  }

  // Intrusions: energy outside the marker's band, above the channel's own
  // background, for long enough to be a transmission rather than a crash.
  run = 0;
  for (let t = 0; t <= frames; t++) {
    const hot = t < frames && outside[t] > outThr;
    if (hot) { run++; continue; }
    if (run >= minIntr) {
      const a = t - run, b = t;
      let peak = 0, markerOn = 0;
      for (let i = a; i < b; i++) { peak = Math.max(peak, outside[i]); markerOn += cycle.on[i]; }
      const overlapsHole = markerOn / (b - a) < 0.5;
      events.push({
        kind: 'intrusion', startSec: at(a), endSec: at(b), seconds: +((b - a) * sp.hopSec).toFixed(2),
        overDb: +(20 * Math.log10(peak / outBase)).toFixed(1),
        markerStillOn: !overlapsHole,
        what: `${((b - a) * sp.hopSec).toFixed(1)} s of something else, ${(20 * Math.log10(peak / outBase)).toFixed(0)} dB over the channel's background`
          + (overlapsHole ? ', while the marker was silent' : ', with the marker still running'),
      });
    }
    run = 0;
  }

  events.sort((a, b) => a.startSec - b.startSec || a.kind.localeCompare(b.kind));
  const holes = events.filter((e) => e.kind === 'hole');
  const intrusions = events.filter((e) => e.kind === 'intrusion');
  const spanSec = x.length / sampleRate;
  return {
    ok: true,
    band: { lowHz: band.lowHz, highHz: band.highHz, overDb: band.overDb },
    cycle: { periodSec: cycle.periodSec, duty: cycle.duty, regularity: cycle.regularity, contrastDb: cycle.contrastDb },
    events, holes: holes.length, intrusions: intrusions.length,
    spanSec: +spanSec.toFixed(1),
    thresholds: { minRegularity, minHoleSec: +(holeFloor * sp.hopSec).toFixed(2), minIntrusionSec, intrusionOverDb },
    text: `a marker at ${band.lowHz}-${band.highHz} Hz, ${cycle.periodSec} s cycle at ${(cycle.duty * 100).toFixed(0)}% duty`
      + ` · ${events.length ? `${holes.length} hole${holes.length === 1 ? '' : 's'} and ${intrusions.length} intrusion${intrusions.length === 1 ? '' : 's'} in ${spanSec.toFixed(0)} s` : `unbroken across ${spanSec.toFixed(0)} s`}`,
  };
}
