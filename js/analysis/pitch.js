// Fundamental-frequency tracking by the YIN difference function (de Cheveigné
// and Kawahara 2002) with cumulative-mean normalisation, parabolic refinement
// and a voicing decision. Pure and worker-safe. Frames of `frameSec`, hop
// `hopSec`; f0 search between minHz and maxHz.

/**
 * → { times: number[], f0: number[] (0 when unvoiced), voiced: boolean[],
 *     confidence: number[] (1 − d'min), level: number[] (frame RMS) }
 */
export function trackPitch(mono, sampleRate, { minHz = 60, maxHz = 500, frameSec = 0.04, hopSec = 0.01, threshold = 0.15 } = {}) {
  const frame = Math.round(frameSec * sampleRate), hop = Math.max(1, Math.round(hopSec * sampleRate));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz)), tauMax = Math.min(frame >> 1, Math.ceil(sampleRate / minHz));
  const times = [], f0 = [], voiced = [], confidence = [], level = [];
  const d = new Float32Array(tauMax + 1), cmnd = new Float32Array(tauMax + 1);
  for (let start = 0; start + frame <= mono.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += mono[start + i] * mono[start + i];
    const rms = Math.sqrt(energy / frame);
    // difference function over the first half of the frame
    const half = frame >> 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < half; i++) { const diff = mono[start + i] - mono[start + i + tau]; s += diff * diff; }
      d[tau] = s;
    }
    // cumulative mean normalised difference
    let running = 0;
    cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; cmnd[tau] = running > 0 ? d[tau] * tau / running : 1; }
    // first dip below threshold, then its local minimum
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) { while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
    }
    let best = tau, value = tau >= 0 ? cmnd[tau] : 1;
    if (tau < 0) { // no dip: take the global minimum for the confidence, unvoiced
      let m = 1; for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < m) { m = cmnd[t]; best = t; }
      value = m;
    }
    let period = best;
    if (best > 1 && best < tauMax) { // parabolic refinement
      const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1], den = a - 2 * b + c;
      if (den !== 0) period = best + 0.5 * (a - c) / den;
    }
    const isVoiced = tau >= 0 && rms > 1e-4;
    times.push((start + frame / 2) / sampleRate);
    f0.push(isVoiced ? sampleRate / period : 0);
    voiced.push(isVoiced);
    confidence.push(1 - value);
    level.push(rms);
  }
  return { times, f0, voiced, confidence, level, hopSec: hop / sampleRate };
}

/**
 * Voiced runs: contiguous voiced frames with a steady f0 (each step within
 * `maxStepCents`), at least `minSec` long. → [{ startSec, endSec, meanHz, frames }]
 */
export function voicedRuns(track, { minSec = 0.12, maxStepCents = 120 } = {}) {
  const runs = [];
  let start = -1;
  const flush = (end) => {
    if (start < 0) return;
    const n = end - start;
    if (n * track.hopSec >= minSec) {
      let sum = 0; for (let i = start; i < end; i++) sum += Math.log2(track.f0[i]);
      runs.push({ startSec: track.times[start], endSec: track.times[end - 1], meanHz: Math.pow(2, sum / n), frames: n });
    }
    start = -1;
  };
  for (let i = 0; i < track.f0.length; i++) {
    const ok = track.voiced[i] && (start < 0 || Math.abs(1200 * Math.log2(track.f0[i] / track.f0[i - 1])) <= maxStepCents);
    if (ok) { if (start < 0) start = i; }
    else { flush(i); if (track.voiced[i]) start = i; }
  }
  flush(track.f0.length);
  return runs;
}
