// Two transmitters on one channel, and the difference in when their marks
// arrive. If both are keyed to the same clock — which is exactly what a pair of
// time stations is — then that difference is the difference in path length, and
// a recording made by someone who never said where they were still says
// something about where they were.
//
// This is measurement, not magic, and the honest part is the bound. Two stations
// separated by a baseline B cannot produce an arrival difference larger than
// B/c by any path, so a result outside that bound is not a discovery, it is
// evidence the estimator is wrong, and this module says so rather than
// reporting it. What it cannot do is give a position: one difference gives a
// hyperbolic line of position on the Earth, not a point, and the ionosphere
// adds path length the geometry does not know about.
import { goertzel } from '../dsp/analytic.js';

export const C_KM_MS = 299.792458;   // km per millisecond, in vacuum

// The two NIST time stations, which share 2.5, 5, 10 and 15 MHz and mark each
// minute with 800 ms of tone at different frequencies — the whole reason this
// measurement is possible on a single-channel recording.
export const WWV_WWVH = Object.freeze({
  name: 'WWV / WWVH',
  a: { name: 'WWV', hz: 1000, place: 'Fort Collins, Colorado' },
  b: { name: 'WWVH', hz: 1200, place: 'Kekaha, Kauai' },
  burstSeconds: 0.8,
  epochSeconds: 60,
  baselineKm: 5430,          // great-circle Fort Collins to Kekaha
});

/**
 * A sliding narrowband envelope by Goertzel. The window length decides
 * everything here: it must resolve the two marker tones apart, or one detector
 * sees the other station and the difference it reports is an artefact of its own
 * sidelobes. `windowSeconds` is checked against the tone separation, not assumed.
 */
export function toneEnvelope(x, rate, hz, { windowSeconds = 0.02, hopSeconds = 0.001 } = {}) {
  const W = Math.max(4, Math.round(windowSeconds * rate));
  const H = Math.max(1, Math.round(hopSeconds * rate));
  const frames = Math.max(0, Math.floor((x.length - W) / H));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) out[f] = Math.sqrt(goertzel(x, rate, hz, { start: f * H, length: W }));
  return { env: out, hop: H / rate, window: W / rate, fps: rate / H };
}

/** A running mean of `seconds`, which is the matched filter for a burst that long. */
export function boxcar(env, fps, seconds) {
  const L = Math.max(1, Math.round(seconds * fps));
  if (env.length <= L) return new Float64Array(0);
  const out = new Float64Array(env.length - L);
  let s = 0;
  for (let i = 0; i < L; i++) s += env[i];
  for (let i = 0; i < out.length; i++) { out[i] = s / L; s += env[i + L] - env[i]; }
  return out;
}

function interpolatedPeak(f, k) {
  const y0 = f[k - 1], y1 = f[k], y2 = f[k + 1];
  const denom = y0 - 2 * y1 + y2;
  if (!denom) return k;
  const d = (y0 - y2) / (2 * denom);
  return Number.isFinite(d) ? k + Math.max(-1, Math.min(1, d)) : k;
}

function peakNear(f, centre, halfWidth, guardWidth) {
  const lo = Math.max(1, Math.round(centre - halfWidth));
  const hi = Math.min(f.length - 2, Math.round(centre + halfWidth));
  if (hi <= lo + 1) return null;
  let k = lo;
  for (let i = lo; i <= hi; i++) if (f[i] > f[k]) k = i;
  if (k <= lo || k >= hi) return null;          // peak on the edge: the window is wrong, not the answer
  // The floor has to come from outside the burst, which is wider than the
  // search window: looking for it inside the window found nothing at all and
  // rejected every epoch.
  const outer = Math.round(4 * guardWidth);
  const away = [];
  for (let i = Math.max(1, k - outer); i <= Math.min(f.length - 2, k + outer); i++) {
    if (Math.abs(i - k) > guardWidth) away.push(f[i]);
  }
  if (away.length < 8) return null;
  away.sort((p, q) => p - q);
  const floor = away[away.length >> 1];
  return { at: interpolatedPeak(f, k), snr: floor > 0 ? f[k] / floor : Infinity };
}

/**
 * The lag, in frames, that best lines up `b` on `a`, by normalised cross-
 * correlation with sub-frame interpolation. Differencing two independently
 * located peaks throws away the burst's shape and was measured 1.6 ms out on a
 * 4.5 ms truth; correlating uses both edges and everything between them.
 * Returns null when the best correlation is not clearly better than the next
 * best somewhere else, which is what a pair of unrelated envelopes looks like.
 */
export function correlationLag(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  if (n < 8 || maxLag < 1) return null;
  const centre = (v) => {
    const m = Float64Array.from(v).sort()[v.length >> 1];
    const out = new Float64Array(v.length);
    let e = 0;
    for (let i = 0; i < v.length; i++) { out[i] = v[i] - m; e += out[i] * out[i]; }
    return { out, norm: Math.sqrt(e) || 1 };
  };
  const A = centre(a.subarray(0, n)), B = centre(b.subarray(0, n));
  const lags = Math.min(maxLag, Math.floor(n / 3));
  const r = new Float64Array(2 * lags + 1);
  for (let L = -lags; L <= lags; L++) {
    let acc = 0;
    const from = Math.max(0, -L), to = Math.min(n, n - L);
    for (let i = from; i < to; i++) acc += A.out[i] * B.out[i + L];
    r[L + lags] = acc / (A.norm * B.norm);
  }
  let k = 0;
  for (let i = 1; i < r.length; i++) if (r[i] > r[k]) k = i;
  if (k === 0 || k === r.length - 1) return null;      // best lag is at the edge of the search
  // Two bursts of length T correlate into a lobe 2T wide, so "the next best
  // peak" has to be looked for outside that lobe, not four frames away — the
  // first attempt excluded four frames, found the same lobe, and rejected every
  // epoch as unconvincing.
  let rival = -Infinity;
  const lobe = Math.max(8, Math.round(r.length / 6));
  for (let i = 0; i < r.length; i++) if (Math.abs(i - k) > lobe && r[i] > rival) rival = r[i];
  const y0 = r[k - 1], y1 = r[k], y2 = r[k + 1];
  const denom = y0 - 2 * y1 + y2;
  const d = denom ? Math.max(-1, Math.min(1, (y0 - y2) / (2 * denom))) : 0;
  return { lag: k - lags + d, peak: y1, margin: y1 - rival };
}

const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN; };
function robust(values) {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const sigma = 1.4826 * mad;
  return { median: med, sigma, standardError: sigma / Math.sqrt(values.length), n: values.length };
}

/** Ordinary least squares slope of y on x, with the slope's standard error. */
export function trend(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: null, standardError: null, reason: 'fewer than three epochs' };
  const mx = xs.reduce((p, c) => p + c, 0) / n, my = ys.reduce((p, c) => p + c, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!sxx) return { slope: null, standardError: null, reason: 'no spread in time' };
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (my + slope * (xs[i] - mx))) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { slope, standardError: se, significant: Math.abs(slope) > 2 * se };
}

/**
 * Measure the arrival-time difference between two tone-marked stations.
 * Returns per-epoch values and never collapses them into a single number
 * without saying whether they agree: on a real HF path they do not, and the
 * disagreement is the interesting part rather than an error to be averaged out.
 */
export function arrivalDifference(x, rate, station = WWV_WWVH, opts = {}) {
  const {
    windowSeconds = 0.02,
    hopSeconds = 0.001,
    minEpochs = 4,
    minSnr = 3,
  } = opts;
  const notes = [];
  const sep = Math.abs(station.a.hz - station.b.hz);
  // A window of length T resolves 1/T. Two tones closer than three resolution
  // widths cannot be told apart, and the measurement is meaningless before it
  // starts.
  const resolution = 1 / windowSeconds;
  if (sep < 3 * resolution) {
    return { ok: false, reason: `the two markers are ${sep} Hz apart and a ${(windowSeconds * 1000).toFixed(0)} ms window `
      + `resolves ${resolution.toFixed(0)} Hz; three resolution widths are needed and this gives ${(sep / resolution).toFixed(1)}`,
      epochs: [] };
  }
  const seconds = x.length / rate;
  if (seconds < 2 * station.epochSeconds) {
    return { ok: false, reason: `the recording is ${seconds.toFixed(1)} s and holds fewer than two ${station.epochSeconds} s epochs`, epochs: [] };
  }

  const ea = toneEnvelope(x, rate, station.a.hz, { windowSeconds, hopSeconds });
  const eb = toneEnvelope(x, rate, station.b.hz, { windowSeconds, hopSeconds });
  const fps = ea.fps;
  const ca = boxcar(ea.env, fps, station.burstSeconds);
  const cb = boxcar(eb.env, fps, station.burstSeconds);
  const guard = 1.2 * station.burstSeconds * fps;

  // Epoch grid from the stronger station alone: taking the loudest N from both
  // finds voice and interference as readily as markers.
  const order = [...ca.keys()].sort((p, q) => ca[q] - ca[p]);
  const grid = [];
  const apart = 0.4 * station.epochSeconds * fps;
  for (const i of order) {
    if (grid.every((g) => Math.abs(g - i) > apart)) grid.push(i);
    if (grid.length >= Math.ceil(seconds / station.epochSeconds) + 2) break;
  }
  grid.sort((p, q) => p - q);

  const bound = station.baselineKm != null ? station.baselineKm / C_KM_MS : null;
  const epochs = [];
  for (const g of grid) {
    const a = peakNear(ca, g, 0.5 * station.epochSeconds * fps * 0.02, guard);
    if (!a || a.snr < minSnr) { epochs.push({ atSeconds: g / fps, used: false, why: 'no marker from ' + station.a.name }); continue; }
    const b = peakNear(cb, a.at, 0.25 * fps, guard);
    if (!b || b.snr < minSnr) { epochs.push({ atSeconds: a.at / fps, used: false, why: 'no marker from ' + station.b.name }); continue; }
    // Locate the epoch on the strong station, then take the delay from the
    // correlation of the two envelopes across it rather than from the gap
    // between two separately found peaks.
    const from = Math.max(0, Math.round(a.at - 0.6 * station.burstSeconds * fps));
    const to = Math.min(ea.env.length, Math.round(a.at + 2.0 * station.burstSeconds * fps));
    const lag = correlationLag(ea.env.subarray(from, to), eb.env.subarray(from, to), Math.round(0.25 * fps));
    // A normalised correlation of 0.5 is far above what two unrelated envelopes
    // reach: smoothed white noise over this many lags peaks near 0.3.
    if (!lag || lag.peak < 0.5) {
      epochs.push({ atSeconds: a.at / fps, used: false, why: 'the two envelopes do not line up at any one lag' });
      continue;
    }
    const deltaMs = lag.lag / fps * 1000;
    // The baseline bounds any single epoch too, not only the summary: a value
    // light could not produce is a failed measurement, and leaving it in to be
    // medianed away hides that one was made.
    if (bound != null && Math.abs(deltaMs) > bound) {
      epochs.push({ atSeconds: a.at / fps, used: false, deltaMs,
        why: `${deltaMs.toFixed(1)} ms is outside the ${bound.toFixed(1)} ms this baseline allows` });
      continue;
    }
    epochs.push({
      atSeconds: a.at / fps,
      deltaMs,
      snrA: a.snr, snrB: b.snr, correlation: lag.peak, used: true,
    });
  }
  const used = epochs.filter((e) => e.used);
  const impossible = epochs.filter((e) => !e.used && /outside the/.test(e.why || ''));
  if (used.length < minEpochs) {
    // Distinguish "the second station was not audible" from "every epoch
    // measured something light cannot do". The second is a broken measurement
    // and must not be reported as a quiet band.
    if (impossible.length > used.length) {
      return {
        ok: false, withinBound: false, epochs,
        reason: `${impossible.length} of ${epochs.length} epochs measured a difference outside the `
          + `${bound.toFixed(1)} ms this ${station.baselineKm} km baseline allows`,
        notes: [`Every usable epoch exceeds the bound, so the measurement is wrong rather than surprising: `
          + `a difference larger than the baseline over c cannot be produced by any path.`],
      };
    }
    return { ok: false, reason: `only ${used.length} epochs carried both markers; ${minEpochs} are needed`, epochs, notes: [] };
  }

  const values = used.map((e) => e.deltaMs);
  const stat = robust(values);
  const tr = trend(used.map((e) => e.atSeconds), values);
  // Split-half is the test that decides whether the standard error means
  // anything. Two halves of the same recording must agree inside it.
  const half = Math.floor(used.length / 2);
  const firstHalf = median(values.slice(0, half));
  const secondHalf = median(values.slice(half));
  const halfGap = Math.abs(firstHalf - secondHalf);
  // Three standard errors, but never finer than the estimator's own resolution:
  // a very precise estimator drives the standard error toward zero, and then
  // any difference at all fails the test. Measured, a constant 6 ms delay came
  // back with a 0.015 ms standard error and halves 0.065 ms apart — agreement
  // by any sane reading, and called unstable until this floor existed.
  const resolutionMs = hopSeconds * 1000;
  const tolerance = Math.max(3 * stat.standardError, resolutionMs);
  const stable = halfGap <= tolerance;
  if (!stable) {
    notes.push(`the two halves of this recording give ${firstHalf.toFixed(2)} ms and ${secondHalf.toFixed(2)} ms, `
      + `a gap of ${halfGap.toFixed(2)} ms where ${tolerance.toFixed(2)} ms would still be agreement. `
      + 'The difference is moving, so the standard error understates it and the spread is the honest figure.');
  }

  const withinBound = bound == null ? null : Math.abs(stat.median) <= bound;
  if (withinBound === false) {
    notes.push(`|${stat.median.toFixed(2)}| ms exceeds the ${bound.toFixed(1)} ms this pair can produce over a `
      + `${station.baselineKm} km baseline. That is not a result: something in the measurement is wrong.`);
  }

  return {
    ok: withinBound !== false,
    station: station.name,
    epochs,
    used: used.length,
    deltaMs: stat.median,
    spreadMs: stat.sigma,
    standardErrorMs: stat.standardError,
    stable,
    halves: [firstHalf, secondHalf],
    stabilityToleranceMs: tolerance,
    driftMsPerMinute: tr.slope == null ? null : tr.slope * 60,
    driftSignificant: tr.significant ?? null,
    pathDifferenceKm: stat.median * C_KM_MS,
    // The honest error on the path difference is the spread, not the standard
    // error, whenever the halves disagree — averaging a moving thing does not
    // make it stand still.
    pathDifferenceErrorKm: (stable ? stat.standardError : stat.sigma) * C_KM_MS,
    boundMs: bound,
    withinBound,
    notes,
  };
}
