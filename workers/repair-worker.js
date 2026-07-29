// Spectral repair worker: RX-Attenuate-class context-aware repair. For each region,
// masked bins are pulled toward the log-magnitude that the surrounding frames
// predict, with raised-cosine feathering in time and frequency. Phase is untouched
// (attenuation needs no reconstruction), resynthesis is Hann/Hann OLA, and the
// processed patch is crossfaded into the original so everything outside the region
// stays bit-identical. Protocol per docs/CONTRACT-BRUSH.md.

import { FFT, hann } from '../js/fft.js';

const FFT_SIZE = 4096;
const HOP = 1024;
const CONTEXT_FRAMES = 16;
const TIME_FEATHER_FRAMES = 4;
const XFADE_SEC = 0.01;
const EPS = 1e-12;

const fft = new FFT(FFT_SIZE);
const win = hann(FFT_SIZE);
// Hann analysis x Hann synthesis at 4x overlap sums to 1.5 in the interior.
const COLA = 1.5;

function raisedCosine(x) {
  // 0 -> 0, 1 -> 1, smooth
  const t = Math.max(0, Math.min(1, x));
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

// Apply one region to one channel in place. Exported for the test harness.
export function repairChannel(x, sampleRate, region) {
  const n = x.length;
  const frames = Math.floor((n - FFT_SIZE) / HOP) + 1;
  if (frames < 3) return;

  const nyquist = sampleRate / 2;
  const binHz = sampleRate / FFT_SIZE;
  const bins = FFT_SIZE / 2;
  const f0 = Math.max(0, Math.min(region.f0, region.f1));
  const f1 = Math.min(nyquist, Math.max(region.f0, region.f1));
  const b0 = Math.max(1, Math.floor(f0 / binHz));
  const b1 = Math.min(bins - 1, Math.ceil(f1 / binHz));
  if (b1 <= b0) return;
  const bandBins = b1 - b0;
  const featherBins = Math.min(
    Math.max(1, Math.floor((bandBins + 1) / 2)),
    Math.max(4, Math.round(bandBins * 0.08))
  );

  // Frame indexing by window CENTER time.
  const frameTime = (f) => (f * HOP + FFT_SIZE / 2) / sampleRate;
  const t0 = Math.min(region.t0, region.t1);
  const t1 = Math.max(region.t0, region.t1);
  let first = frames;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    const t = frameTime(f);
    if (t >= t0 && t <= t1) {
      if (f < first) first = f;
      if (f > last) last = f;
    }
  }
  if (last < first) {
    // Region narrower than a hop: take the nearest frame.
    let best = 0;
    let bd = Infinity;
    for (let f = 0; f < frames; f++) {
      const d = Math.abs(frameTime(f) - (t0 + t1) / 2);
      if (d < bd) { bd = d; best = f; }
    }
    first = last = best;
  }

  // Context frame ranges, clipped to the span.
  const cB0 = Math.max(0, first - TIME_FEATHER_FRAMES - CONTEXT_FRAMES);
  const cB1 = Math.max(0, first - TIME_FEATHER_FRAMES);
  const cA0 = Math.min(frames, last + TIME_FEATHER_FRAMES + 1);
  const cA1 = Math.min(frames, last + TIME_FEATHER_FRAMES + 1 + CONTEXT_FRAMES);
  const nBefore = cB1 - cB0;
  const nAfter = cA1 - cA0;
  // With no flanking frames (a region spanning the whole span), horizontal
  // interpolation is impossible; fall back to VERTICAL mode: each frame's own
  // spectrum just outside the band predicts the band (RX's vertical direction,
  // and the correct physics for long tonal bands like hum).
  const vertical = nBefore <= 0 && nAfter <= 0;

  // Pass 1: analyze. Store spectra for edit frames, accumulate context means.
  const editFirst = Math.max(0, first - TIME_FEATHER_FRAMES);
  const editLast = Math.min(frames - 1, last + TIME_FEATHER_FRAMES);
  const editCount = editLast - editFirst + 1;
  const specRe = new Float32Array(editCount * FFT_SIZE);
  const specIm = new Float32Array(editCount * FFT_SIZE);
  const meanBefore = new Float64Array(bins);
  const meanAfter = new Float64Array(bins);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  const analyze = (f, keep) => {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (x[off + i] || 0) * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    if (keep) {
      specRe.set(re, (f - editFirst) * FFT_SIZE);
      specIm.set(im, (f - editFirst) * FFT_SIZE);
    }
    return null;
  };

  for (let f = cB0; f < cB1; f++) {
    analyze(f, false);
    for (let b = b0; b <= b1; b++) {
      meanBefore[b] += Math.log(Math.hypot(re[b], im[b]) + EPS);
    }
  }
  for (let f = cA0; f < cA1; f++) {
    analyze(f, false);
    for (let b = b0; b <= b1; b++) {
      meanAfter[b] += Math.log(Math.hypot(re[b], im[b]) + EPS);
    }
  }
  if (nBefore > 0) for (let b = b0; b <= b1; b++) meanBefore[b] /= nBefore;
  if (nAfter > 0) for (let b = b0; b <= b1; b++) meanAfter[b] /= nAfter;
  for (let f = editFirst; f <= editLast; f++) analyze(f, true);

  // Pass 2: edit magnitudes toward context, phase untouched.
  const tBefore = frameTime(Math.max(0, first - TIME_FEATHER_FRAMES));
  const tAfter = frameTime(Math.min(frames - 1, last + TIME_FEATHER_FRAMES));
  for (let f = editFirst; f <= editLast; f++) {
    const base = (f - editFirst) * FFT_SIZE;
    const t = frameTime(f);
    // time feather: full strength inside [first, last], cosine roll at the edges
    let tw = 1;
    if (f < first) tw = raisedCosine(1 - (first - f) / TIME_FEATHER_FRAMES);
    else if (f > last) tw = raisedCosine(1 - (f - last) / TIME_FEATHER_FRAMES);
    if (tw <= 0) continue;
    // interpolation weight across the region
    let w = 0.5;
    if (nBefore > 0 && nAfter > 0) {
      w = tAfter > tBefore ? (t - tBefore) / (tAfter - tBefore) : 0.5;
      w = Math.max(0, Math.min(1, w));
    } else if (nBefore > 0) w = 0;
    else w = 1;

    // Vertical mode: neighbors just outside the band, in THIS frame.
    let vLow = 0;
    let vHigh = 0;
    if (vertical) {
      const nb = Math.max(2, featherBins);
      let c = 0;
      for (let b = Math.max(1, b0 - nb); b < b0; b++) {
        vLow += Math.log(Math.hypot(specRe[base + b], specIm[base + b]) + EPS);
        c++;
      }
      vLow = c ? vLow / c : Math.log(EPS);
      c = 0;
      for (let b = b1 + 1; b <= Math.min(bins - 1, b1 + nb); b++) {
        vHigh += Math.log(Math.hypot(specRe[base + b], specIm[base + b]) + EPS);
        c++;
      }
      vHigh = c ? vHigh / c : vLow;
    }

    for (let b = b0; b <= b1; b++) {
      let fw = 1;
      if (b - b0 < featherBins) fw = raisedCosine((b - b0 + 1) / (featherBins + 1));
      else if (b1 - b < featherBins) fw = raisedCosine((b1 - b + 1) / (featherBins + 1));
      const amt = region.strength * tw * fw;
      if (amt <= 0) continue;
      const rr = specRe[base + b];
      const ii = specIm[base + b];
      const mag = Math.hypot(rr, ii);
      const logMag = Math.log(mag + EPS);
      const target = vertical
        ? vLow + (vHigh - vLow) * ((b - b0) / Math.max(1, bandBins))
        : (nBefore > 0 && nAfter > 0
          ? meanBefore[b] * (1 - w) + meanAfter[b] * w
          : (nBefore > 0 ? meanBefore[b] : meanAfter[b]));
      const newLog = logMag + (target - logMag) * amt;
      const scale = Math.exp(newLog) / (mag + EPS);
      specRe[base + b] = rr * scale;
      specIm[base + b] = ii * scale;
      // mirror bin keeps the signal real
      const mb = FFT_SIZE - b;
      specRe[base + mb] = specRe[base + b];
      specIm[base + mb] = -specIm[base + b];
    }
  }

  // Pass 3: resynthesize edit frames, overlap-add into a patch, crossfade into x.
  const patchStart = editFirst * HOP;
  const patchLen = (editLast - editFirst) * HOP + FFT_SIZE;
  const patch = new Float32Array(patchLen);
  const norm = new Float32Array(patchLen);
  for (let f = editFirst; f <= editLast; f++) {
    const base = (f - editFirst) * FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = specRe[base + i];
      im[i] = specIm[base + i];
    }
    fft.inverse(re, im);
    const off = (f - editFirst) * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      patch[off + i] += re[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < patchLen; i++) {
    patch[i] = norm[i] > 1e-6 ? patch[i] / norm[i] : (x[patchStart + i] || 0);
  }

  // Replace only the audible window: region plus feather plus crossfade, so audio
  // outside stays bit-identical to the input.
  const xfade = Math.max(8, Math.round(XFADE_SEC * sampleRate));
  const inner0 = Math.max(0, Math.floor(t0 * sampleRate) - TIME_FEATHER_FRAMES * HOP);
  const inner1 = Math.min(n, Math.ceil(t1 * sampleRate) + TIME_FEATHER_FRAMES * HOP);
  const r0 = Math.max(patchStart + 1, inner0 - xfade);
  const r1 = Math.min(patchStart + patchLen - 1, inner1 + xfade);
  for (let i = r0; i < r1; i++) {
    const p = patch[i - patchStart];
    let mix = 1;
    if (i - r0 < xfade) mix = raisedCosine((i - r0) / xfade);
    else if (r1 - i < xfade) mix = raisedCosine((r1 - i) / xfade);
    x[i] = x[i] * (1 - mix) + p * mix;
  }
}

// Guarded so the module also imports cleanly in node for the test harness.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type !== 'repair') return;
    try {
      const { channels, sampleRate, regions } = msg;
      for (const ch of channels) {
        for (const region of regions) {
          repairChannel(ch, sampleRate, region);
        }
      }
      self.postMessage({ type: 'done', channels }, channels.map((c) => c.buffer));
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  };
}
