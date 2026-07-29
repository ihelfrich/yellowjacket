// HARVEST core: mine a whole song for its best playable material and label each
// slice by instrument role. Pure, worker-safe, no DOM. Contract:
// docs/CONTRACT-HARVEST.md section 1.
//
// Pipeline: onset -> candidate window -> eight features -> eight role scores ->
// quota selection with a diversity penalty -> timeline-ordered labelled picks.

import { FFT, hann } from '../fft.js';

// ---------------------------------------------------------------------------
// THRESHOLDS
// Every number below is stated in the unit it is measured in and was landed on
// the synthetic bench in scratch/test_harvest.mjs (60 Hz sine-burst kicks,
// 400-3k band-passed noise snares, hp-noise ticks, an 80 Hz saw, a 440 Hz
// vibrato tone, a rising white-noise riser). Ranges are deliberately wide so a
// real recording lands inside the ramp rather than on a cliff edge.
// ---------------------------------------------------------------------------

// Candidate windowing (contract: onset to min(next onset, 1.2 s)).
const MAX_WINDOW_SEC = 1.2;
const MIN_WINDOW_SEC = 0.040;   // shorter than this is a double-trigger, not a slice
const MIN_RMS_DB = -48;         // window RMS gate: below this the window is silence

// Feature sub-windows, seconds measured from the onset.
const ATTACK_HEAD_SEC = [0, 0.012];     // the transient itself
const ATTACK_BODY_SEC = [0.040, 0.120]; // what is left one syllable later
const SUSTAIN_HEAD_SEC = [0, 0.050];
const SUSTAIN_TAIL_SEC = [0.200, 0.400];
const RMS_FLOOR_DB = -90;       // an empty or silent sub-window reads as this
const RATIO_CLAMP_DB = 48;      // both dB ratios clamp here so silence cannot dominate

// Power spectrum: 2048-sample Hann frames, 50% overlap, averaged over the first
// 400 ms of the window (the part that carries the timbre a player hears).
const SPEC_SIZE = 2048;
const SPEC_HOP = 1024;
const SPEC_SPAN_SEC = 0.4;
const BAND_LOW_HZ = 150;        // low  = under 150 Hz
const BAND_MID_HZ = 2000;       // mid  = 150 Hz .. 2 kHz
const BAND_HIGH_HZ = 4000;      // high = above 4 kHz (2-4 kHz counts toward neither)

// Spectral flatness is measured INSIDE the candidate's own 5-95% cumulative
// energy band. Measured across the whole spectrum instead, a band-passed snare
// reads as "tonal" purely because it is band-limited, which is the wrong answer.
// The floor keeps the geometric mean finite; the minimum width stops a pure tone
// from collapsing the band to one bin and scoring a degenerate flatness of 1.
const FLATNESS_TAIL = 0.05;
const FLATNESS_FLOOR = 1e-6;    // relative to the loudest bin in the band
const FLATNESS_MIN_BINS = 24;

// Harmonicity: FFT-based biased normalised autocorrelation, peak searched over
// the lag band that corresponds to 40-1000 Hz.
const AC_FRAME = 8192;          // 186 ms at 44.1 kHz: 7 periods of an 80 Hz bass
const AC_FFT_SIZE = 16384;      // >= 2 * AC_FRAME so the correlation does not wrap
const AC_MIN_HZ = 40;
const AC_MAX_HZ = 1000;

// Soft membership ramps. up(x, a, b) is 0 at or below a, 1 at or above b.
const SHARP_DB = [3, 12];       // attack sharpness that reads as a struck transient
const SWELL_DB = [0, 12];       // inverted: 1 at or below 0 dB, 0 at or above 12
const BODY_DB = [6, 24];        // inverted, on |attackDb|: a steady body, neither
const SHORT_DB = [-30, -12];    // inverted, on sustainDb: 1 at or below -30 dB
const SUSTAIN_DB = [-18, -4];   // on sustainDb: 1 at or above -4 dB
const LOW_RATIO = [0.30, 0.60];
const MID_RATIO = [0.30, 0.60];
const HIGH_RATIO = [0.35, 0.65];
const FLAT_RANGE = [0.06, 0.25];  // noise lands near 0.5, a saw near 0.02, a tone under 1e-3
const HARM_RANGE = [0.30, 0.60];  // normalised autocorrelation peak

// Loudness term of the pick score: -48 dBFS peak scores 0, full scale scores 1.
const LOUD_FLOOR_DB = -48;

// Selection.
const QUOTAS = Object.freeze({ KICK: 3, SNARE: 3, HAT: 3, BASS: 3, TONE: 4, VOX: 4, FX: 2, CRASH: 2 });
const MAX_PICKS = 24;
const DIVERSITY_WINDOW_SEC = 2.0;
const DIVERSITY_PENALTY = 0.5;  // per already-picked neighbour inside the window
// A candidate that has been penalised AND already has a same-role pick inside the
// window is a near-duplicate. It only earns a slot if, even after the penalty, it
// still beats the median candidate in the song. Without this gate the penalty can
// only reorder picks, never suppress one, so on any song with fewer than 24
// candidates the two kicks half a second apart would both land in the kit.
const DUPLICATE_ADMIT_QUANTILE = 0.5;

export const ROLES = Object.freeze(Object.keys(QUOTAS));
export const ROLE_QUOTAS = QUOTAS;
export const HARVEST_MAX_PICKS = MAX_PICKS;

const EPS = 1e-20;

let specFft = null;
let acFft = null;

function clamp01(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function up(x, a, b) {
  if (!(b > a)) return x >= b ? 1 : 0;
  return clamp01((x - a) / (b - a));
}

function down(x, a, b) {
  return 1 - up(x, a, b);
}

function geo3(a, b, c) {
  return Math.cbrt(Math.max(0, a) * Math.max(0, b) * Math.max(0, c));
}

function dbOf(amp) {
  return amp > 0 ? 20 * Math.log10(amp) : RMS_FLOOR_DB;
}

// RMS of [t0 + a, t0 + b) in dBFS, clipped to the candidate window and the buffer.
function rmsDbRange(mono, sampleRate, t0, range, endSample) {
  const from = Math.max(0, Math.round((t0 + range[0]) * sampleRate));
  const to = Math.min(endSample, Math.round((t0 + range[1]) * sampleRate), mono.length);
  if (to <= from) return RMS_FLOOR_DB;
  let sum = 0;
  for (let i = from; i < to; i++) sum += mono[i] * mono[i];
  return Math.max(RMS_FLOOR_DB, dbOf(Math.sqrt(sum / (to - from))));
}

// Averaged Hann power spectrum over the first SPEC_SPAN_SEC of the window.
// Samples past the window end are zero, so a candidate never borrows timbre
// from the event that follows it.
function powerSpectrum(mono, startSample, endSample) {
  if (!specFft) specFft = new FFT(SPEC_SIZE);
  const win = hann(SPEC_SIZE);
  const bins = SPEC_SIZE / 2;
  const power = new Float64Array(bins);
  const re = new Float32Array(SPEC_SIZE);
  const im = new Float32Array(SPEC_SIZE);
  const span = endSample - startSample;
  const frames = span >= SPEC_SIZE ? Math.floor((span - SPEC_SIZE) / SPEC_HOP) + 1 : 1;
  for (let f = 0; f < frames; f++) {
    const off = startSample + f * SPEC_HOP;
    for (let i = 0; i < SPEC_SIZE; i++) {
      const s = off + i;
      re[i] = s < endSample && s < mono.length ? mono[s] * win[i] : 0;
      im[i] = 0;
    }
    specFft.forward(re, im);
    for (let b = 0; b < bins; b++) power[b] += re[b] * re[b] + im[b] * im[b];
  }
  for (let b = 0; b < bins; b++) power[b] /= frames;
  return power;
}

function bandFeatures(power, sampleRate) {
  const bins = power.length;
  const binHz = sampleRate / SPEC_SIZE;
  let total = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  let centroidNum = 0;
  for (let b = 1; b < bins; b++) {
    const p = power[b];
    const hz = b * binHz;
    total += p;
    centroidNum += p * hz;
    if (hz < BAND_LOW_HZ) low += p;
    else if (hz < BAND_MID_HZ) mid += p;
    else if (hz > BAND_HIGH_HZ) high += p;
  }
  if (total <= 0) return { low: 0, mid: 0, high: 0, centroidHz: 0, flatness: 0 };

  // 5-95% cumulative energy band, widened to FLATNESS_MIN_BINS around its centre.
  let cum = 0;
  let b0 = 1;
  let b1 = bins - 1;
  for (let b = 1; b < bins; b++) {
    cum += power[b];
    if (cum >= FLATNESS_TAIL * total) { b0 = b; break; }
  }
  cum = 0;
  for (let b = 1; b < bins; b++) {
    cum += power[b];
    if (cum >= (1 - FLATNESS_TAIL) * total) { b1 = b; break; }
  }
  if (b1 < b0) b1 = b0;
  if (b1 - b0 + 1 < FLATNESS_MIN_BINS) {
    const centre = (b0 + b1) / 2;
    b0 = Math.max(1, Math.round(centre - FLATNESS_MIN_BINS / 2));
    b1 = Math.min(bins - 1, b0 + FLATNESS_MIN_BINS - 1);
    b0 = Math.max(1, b1 - FLATNESS_MIN_BINS + 1);
  }
  let peak = 0;
  for (let b = b0; b <= b1; b++) if (power[b] > peak) peak = power[b];
  const floor = peak * FLATNESS_FLOOR;
  let logSum = 0;
  let arith = 0;
  const n = b1 - b0 + 1;
  for (let b = b0; b <= b1; b++) {
    const p = Math.max(power[b], floor) + EPS;
    logSum += Math.log(p);
    arith += p;
  }
  const flatness = arith > 0 ? clamp01(Math.exp(logSum / n) / (arith / n)) : 0;

  return {
    low: low / total,
    mid: mid / total,
    high: high / total,
    centroidHz: centroidNum / total,
    flatness,
  };
}

// Biased normalised autocorrelation via FFT (Wiener-Khinchin), peak over the
// 40-1000 Hz lag band. Biased (divide by r[0]) rather than unbiased on purpose:
// the taper makes long-lag noise peaks lose to genuine short-lag periodicity.
function harmonicity(mono, sampleRate, startSample, endSample) {
  const avail = Math.min(endSample, mono.length) - startSample;
  const frame = Math.min(AC_FRAME, avail);
  if (frame < 512) return 0;
  if (!acFft) acFft = new FFT(AC_FFT_SIZE);
  const re = new Float32Array(AC_FFT_SIZE);
  const im = new Float32Array(AC_FFT_SIZE);
  let mean = 0;
  for (let i = 0; i < frame; i++) mean += mono[startSample + i];
  mean /= frame;
  for (let i = 0; i < frame; i++) re[i] = mono[startSample + i] - mean;
  acFft.forward(re, im);
  for (let i = 0; i < AC_FFT_SIZE; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  acFft.inverse(re, im);
  const r0 = re[0];
  if (!(r0 > 0)) return 0;
  const minLag = Math.max(2, Math.floor(sampleRate / AC_MAX_HZ));
  const maxLag = Math.min(Math.floor(sampleRate / AC_MIN_HZ), Math.floor(frame / 2));
  let best = 0;
  for (let l = minLag; l <= maxLag; l++) {
    const v = re[l] / r0;
    if (v > best) best = v;
  }
  return clamp01(best);
}

function featuresFor(mono, sampleRate, t0, t1) {
  const startSample = Math.max(0, Math.round(t0 * sampleRate));
  const endSample = Math.min(mono.length, Math.round(t1 * sampleRate));
  let peak = 0;
  let sum = 0;
  for (let i = startSample; i < endSample; i++) {
    const a = mono[i] < 0 ? -mono[i] : mono[i];
    if (a > peak) peak = a;
    sum += mono[i] * mono[i];
  }
  const count = Math.max(1, endSample - startSample);
  const rmsDb = Math.max(RMS_FLOOR_DB, dbOf(Math.sqrt(sum / count)));
  const peakDb = Math.max(RMS_FLOOR_DB, dbOf(peak));

  const head = rmsDbRange(mono, sampleRate, t0, ATTACK_HEAD_SEC, endSample);
  const body = rmsDbRange(mono, sampleRate, t0, ATTACK_BODY_SEC, endSample);
  const early = rmsDbRange(mono, sampleRate, t0, SUSTAIN_HEAD_SEC, endSample);
  const tail = rmsDbRange(mono, sampleRate, t0, SUSTAIN_TAIL_SEC, endSample);
  const attackDb = Math.max(-RATIO_CLAMP_DB, Math.min(RATIO_CLAMP_DB, head - body));
  const sustainDb = Math.max(-RATIO_CLAMP_DB, Math.min(RATIO_CLAMP_DB, tail - early));

  const specEnd = Math.min(endSample, startSample + Math.round(SPEC_SPAN_SEC * sampleRate));
  const band = bandFeatures(powerSpectrum(mono, startSample, specEnd), sampleRate);

  return {
    attackDb,
    sustainDb,
    low: band.low,
    mid: band.mid,
    high: band.high,
    centroidHz: band.centroidHz,
    flatness: band.flatness,
    harmonicity: harmonicity(mono, sampleRate, startSample, endSample),
    peakDb,
    rmsDb,
  };
}

// The eight role heuristics of the contract, each a geometric mean of three soft
// memberships so any one failing term kills the role outright. FX and CRASH share
// "noisy/high + sustained", so the attack breaks the tie: a crash is struck, an FX
// swells. That third term is the only addition to the contract's word list.
function roleScores(f) {
  const sharp = up(f.attackDb, SHARP_DB[0], SHARP_DB[1]);
  const swell = down(f.attackDb, SWELL_DB[0], SWELL_DB[1]);
  const body = down(Math.abs(f.attackDb), BODY_DB[0], BODY_DB[1]);
  const short = down(f.sustainDb, SHORT_DB[0], SHORT_DB[1]);
  const sustained = up(f.sustainDb, SUSTAIN_DB[0], SUSTAIN_DB[1]);
  const lowB = up(f.low, LOW_RATIO[0], LOW_RATIO[1]);
  const midB = up(f.mid, MID_RATIO[0], MID_RATIO[1]);
  const highB = up(f.high, HIGH_RATIO[0], HIGH_RATIO[1]);
  const flat = up(f.flatness, FLAT_RANGE[0], FLAT_RANGE[1]);
  const harm = up(f.harmonicity, HARM_RANGE[0], HARM_RANGE[1]);
  return {
    terms: { sharp, swell, body, short, sustained, lowB, midB, highB, flat, harm },
    scores: {
      KICK: geo3(lowB, sharp, short),
      SNARE: geo3(midB, flat, sharp),
      HAT: geo3(highB, flat, short),
      BASS: geo3(harm, lowB, sustained),
      TONE: geo3(harm, midB, short),
      VOX: geo3(harm, midB, sustained),
      FX: geo3(flat, sustained, swell),
      CRASH: geo3(highB, sustained, sharp),
    },
  };
}

// Contract: score = loudness x sharpness fit. "Fit" is the attack term the assigned
// role wants, so a role picks the takes whose transient actually behaves like one.
function attackFit(role, terms) {
  if (role === 'BASS' || role === 'TONE' || role === 'VOX') return terms.body;
  if (role === 'FX') return terms.swell;
  return terms.sharp;
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function select(candidates) {
  const admitFloor = medianOf(candidates.map((c) => c.score)) * (DUPLICATE_ADMIT_QUANTILE * 2);
  const used = {};
  for (const role of ROLES) used[role] = 0;
  const taken = new Array(candidates.length).fill(false);
  const rejected = new Array(candidates.length).fill(false);
  const picked = [];

  // Phase 0 fills the per-role quotas; phase 1 hands every unfilled slot to the
  // best remaining candidate of any role.
  for (let phase = 0; phase < 2; phase++) {
    while (picked.length < MAX_PICKS) {
      let best = -1;
      let bestScore = -1;
      let bestNear = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (taken[i] || rejected[i]) continue;
        const c = candidates[i];
        if (phase === 0 && used[c.role] >= QUOTAS[c.role]) continue;
        let near = 0;
        for (const j of picked) {
          if (Math.abs(candidates[j].t0 - c.t0) < DIVERSITY_WINDOW_SEC) near++;
        }
        const score = c.score * Math.pow(DIVERSITY_PENALTY, near);
        // Candidates are already in timeline order, so a strict > keeps the
        // earliest of any tie and the whole selection stays deterministic.
        if (score > bestScore) { bestScore = score; best = i; bestNear = near; }
      }
      if (best < 0) break;
      const chosen = candidates[best];
      if (bestNear > 0 && bestScore < admitFloor) {
        let sameRoleNear = false;
        for (const j of picked) {
          const p = candidates[j];
          if (p.role === chosen.role && Math.abs(p.t0 - chosen.t0) < DIVERSITY_WINDOW_SEC) {
            sameRoleNear = true;
            break;
          }
        }
        if (sameRoleNear) { rejected[best] = true; continue; }
      }
      taken[best] = true;
      used[chosen.role]++;
      picked.push(best);
    }
  }

  const order = picked.slice().sort((a, b) => candidates[a].t0 - candidates[b].t0);
  const counters = {};
  for (const role of ROLES) counters[role] = 0;
  const picks = [];
  for (const i of order) {
    const c = candidates[i];
    c.picked = true;
    counters[c.role]++;
    c.label = `${c.role} ${counters[c.role]}`;
    picks.push({ t0: c.t0, t1: c.t1, role: c.role, label: c.label, score: c.score });
  }
  return picks;
}

// Sustained material (pads, risers, held vocals) produces no spectral-flux
// peak, so an onset-only harvest returns a drum-biased kit. Verified on the
// synthetic fixture: a 1.5 s vocal tone and a 3 s riser were both invisible to
// the real detector. These seed extra windows on a coarse grid wherever the
// gap between onsets is long enough to hold sustained sound.
const SUSTAIN_GAP_SEC = 0.9;    // gaps shorter than this are already covered
const SUSTAIN_STRIDE_SEC = 0.6; // seed spacing inside a long gap
const SUSTAIN_LEAD_SEC = 0.5;   // clear of the onset that opened the gap
// A seeded window starts mid-sound, so it misses the attack that makes a slice
// playable, yet it scores HIGHER on sustained roles precisely because it has no
// attack in it. Score tuning cannot resolve that; instead a seed is absorbed
// when it only repeats an onset-anchored slice of the same role just before it.
// Seeds then survive exactly where they earn their keep: material the onset
// detector never saw.
// Matches DIVERSITY_WINDOW_SEC on purpose: inside the diversity radius a seed
// would penalize the very onset it duplicates, so it must never get that far.
const SUSTAIN_ABSORB_SEC = 2.0;

function sustainSeeds(times, duration) {
  const seeds = [];
  const edges = times.length ? times : [0];
  for (let i = 0; i <= edges.length; i++) {
    const from = i === 0 ? 0 : edges[i - 1];
    const to = i < edges.length ? edges[i] : duration;
    if (to - from < SUSTAIN_GAP_SEC) continue;
    for (let t = from + SUSTAIN_LEAD_SEC; t < to - MIN_WINDOW_SEC; t += SUSTAIN_STRIDE_SEC) {
      seeds.push(t);
    }
  }
  return seeds;
}

export function harvest(mono, sampleRate, onsets) {
  if (!mono || !mono.length || !isFinite(sampleRate) || sampleRate <= 0) {
    return { picks: [], candidates: [] };
  }
  const duration = mono.length / sampleRate;
  const onsetTimes = Array.from(onsets || [])
    .filter((t) => isFinite(t) && t >= 0 && t < duration)
    .sort((a, b) => a - b);
  const seeded = new Set(sustainSeeds(onsetTimes, duration));
  const times = onsetTimes.concat(Array.from(seeded)).sort((a, b) => a - b);
  // A real onset's window must be bounded by the next REAL onset, never by a
  // synthetic seed: otherwise a seed at 0.5 s truncates a one-second held note
  // to its first half and the rest of the sound is lost (Codex finding 8,
  // reproduced: a 1 s 440 Hz tone with onsets=[0] yielded only [0, 0.5]).
  const nextRealAfter = (t) => {
    for (let i = 0; i < onsetTimes.length; i++) if (onsetTimes[i] > t) return onsetTimes[i];
    return Infinity;
  };

  const candidates = [];
  for (let i = 0; i < times.length; i++) {
    const t0 = times[i];
    const nextAny = i + 1 < times.length ? times[i + 1] : Infinity;
    const next = seeded.has(t0) ? nextAny : nextRealAfter(t0);
    const t1 = Math.min(next, t0 + MAX_WINDOW_SEC, duration);
    if (t1 - t0 < MIN_WINDOW_SEC) continue;
    const features = featuresFor(mono, sampleRate, t0, t1);
    if (features.rmsDb < MIN_RMS_DB) continue;
    const { terms, scores } = roleScores(features);
    let role = ROLES[0];
    for (const name of ROLES) if (scores[name] > scores[role]) role = name;
    // A window that matches NO role is not material: without this it fell
    // through to ROLES[0] and shipped as a confident "KICK 1" with score 0
    // (Codex finding 11, reproduced on a bare 3 kHz sine).
    if (!(scores[role] > 0)) continue;
    const loudness = clamp01((features.peakDb - LOUD_FLOOR_DB) / -LOUD_FLOOR_DB);
    candidates.push({
      index: candidates.length,
      t0,
      t1,
      role,
      label: null,
      score: loudness * attackFit(role, terms),
      seeded: seeded.has(t0),
      loudness,
      roleScores: scores,
      features,
      picked: false,
    });
  }

  const lastOnsetOf = {};
  const kept = [];
  for (const c of candidates) {
    if (c.seeded) {
      const prior = lastOnsetOf[c.role];
      if (prior != null && c.t0 - prior <= SUSTAIN_ABSORB_SEC) continue;
    } else {
      lastOnsetOf[c.role] = c.t0;
    }
    c.index = kept.length;
    kept.push(c);
  }

  return { picks: select(kept), candidates: kept };
}
