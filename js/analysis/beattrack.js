// Tempo estimation + dynamic-programming beat tracking (Ellis 2007, "Beat Tracking by
// Dynamic Programming"). Worker-safe, pure. Contract: docs/CONTRACT-MACHINE.md.

const BPM_MIN = 60;
const BPM_MAX = 200;
const ALPHA = 680;          // Ellis' tightness, envelope normalized to unit std
const PRIOR_CENTER = 120;   // BPM
const PRIOR_SIGMA = 0.9;    // octaves

export function trackBeats(envelope, envelopeRate, opts = {}) {
  const empty = { tempo: 0, beats: new Float32Array(0), downbeat: 0, confidence: 0 };
  if (!envelope || envelope.length < 4 || !isFinite(envelopeRate) || envelopeRate <= 0) return empty;

  const n = envelope.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += envelope[i];
  if (sum <= 0) return empty;

  // Normalize to zero mean, unit std for both autocorrelation and the DP objective.
  const mean = sum / n;
  let varAcc = 0;
  for (let i = 0; i < n; i++) { const d = envelope[i] - mean; varAcc += d * d; }
  const std = Math.sqrt(varAcc / n);
  if (std <= 1e-12) return empty;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = (envelope[i] - mean) / std;

  // --- tempo: comb-weighted autocorrelation with a log-Gaussian prior ---
  const lagMin = Math.max(1, Math.floor(envelopeRate * 60 / BPM_MAX));
  const lagMax = Math.min(n - 2, Math.ceil(envelopeRate * 60 / BPM_MIN));
  if (lagMax <= lagMin) return empty;

  const acAt = (lag) => {
    if (lag < 1 || lag >= n) return 0;
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    return s / (n - lag);
  };

  const combScores = new Float32Array(lagMax + 1);
  let pinnedBpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : null;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const comb = acAt(lag) + 0.5 * acAt(2 * lag) + 0.25 * acAt(4 * lag);
    const bpm = envelopeRate * 60 / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PRIOR_CENTER) / PRIOR_SIGMA, 2));
    const score = comb * prior;
    combScores[lag] = score;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  // Confidence: chosen comb energy vs the median comb energy, squashed to 0..1.
  // The +0.1 floor keeps the ratio sane when the comb is all noise (median near 0):
  // with a unit-variance envelope, noise-level comb scores sit well under 0.1.
  const sorted = Array.from(combScores.subarray(lagMin, lagMax + 1)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let ratio = bestScore > 0 ? bestScore / (Math.max(median, 0) + 0.1) - 1 : 0;
  if (ratio < 0) ratio = 0;
  const confidence = ratio / (1 + ratio);

  const tempo = pinnedBpm != null ? pinnedBpm : envelopeRate * 60 / bestLag;
  const period = envelopeRate * 60 / tempo; // frames per beat

  // --- beats: Ellis 2007 dynamic programming ---
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const winLo = Math.max(1, Math.floor(period * 0.5));
  const winHi = Math.min(n - 1, Math.ceil(period * 2));
  for (let t = 0; t < n; t++) {
    let best = 0;
    let bestPrev = -1;
    const lo = t - winHi;
    const hi = t - winLo;
    for (let tau = Math.max(0, lo); tau <= hi; tau++) {
      const dt = t - tau;
      const logRatio = Math.log(dt / period);
      const trans = -ALPHA * logRatio * logRatio / 100; // scaled penalty, see note below
      const cand = score[tau] + trans;
      if (cand > best) { best = cand; bestPrev = tau; }
    }
    // Ellis weights transition vs onset strength; the /100 keeps the classic
    // alpha=680 usable against a unit-std envelope sampled at ~86 fps.
    score[t] = env[t] + best;
    back[t] = bestPrev;
  }

  // Backtrace from the best terminal within the last beat period.
  let end = n - 1;
  let endBest = -Infinity;
  for (let t = Math.max(0, n - 1 - Math.ceil(period)); t < n; t++) {
    if (score[t] > endBest) { endBest = score[t]; end = t; }
  }
  const beatFrames = [];
  for (let t = end; t >= 0; t = back[t]) {
    beatFrames.push(t);
    if (back[t] === -1) break;
  }
  beatFrames.reverse();
  if (beatFrames.length < 2) return { tempo, beats: new Float32Array(0), downbeat: 0, confidence: 0 };

  // +1 frame: the onset envelope's frame f is centered at f*hop + fftSize/2 samples,
  // and with fftSize = 2*hop (1024/512 per contract) that center offset is exactly
  // one envelope frame.
  let beats = new Float32Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) beats[i] = (beatFrames[i] + 1) / envelopeRate;

  // --- downbeat ---
  let downbeat = 0;
  const barOne = Number.isFinite(opts.barOneTime) ? opts.barOneTime : null;
  if (barOne != null) {
    let nearest = 0;
    let nd = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const d = Math.abs(beats[i] - barOne);
      if (d < nd) { nd = d; nearest = i; }
    }
    if (nd > 0.040) {
      // Phase-rotate the whole grid so a beat lands on the pin.
      const shift = barOne - beats[nearest];
      const shifted = new Float32Array(beats.length);
      for (let i = 0; i < beats.length; i++) shifted[i] = beats[i] + shift;
      beats = shifted;
    }
    downbeat = nearest;
  } else {
    // Beat phase maximizing mean envelope at 4-beat spacing over the first 16 bars.
    // Sample the local max within +-1 frame: beat times carry the window-center
    // correction, so the raw frame index can sit just past the envelope peak.
    let bestMean = -Infinity;
    for (let o = 0; o < 4 && o < beats.length; o++) {
      let s = 0;
      let c = 0;
      for (let i = o; i < beats.length && c < 16; i += 4, c++) {
        const f = Math.min(n - 1, Math.round(beats[i] * envelopeRate));
        let v = env[f];
        if (f > 0 && env[f - 1] > v) v = env[f - 1];
        if (f < n - 1 && env[f + 1] > v) v = env[f + 1];
        s += v;
      }
      if (c > 0 && s / c > bestMean) { bestMean = s / c; downbeat = o; }
    }
  }

  return { tempo, beats, downbeat, confidence };
}
