// Cyclostationary transcription: a signal's modulation spectrum, played.
//
// The cyclic detector (js/analysis/cyclic.js) reads a recording as a set of
// periodicities — each an alpha in Hz, the carrier band it rides on, its
// depth, and its phase. This turns that reading into a score an instrument
// can play: every periodicity becomes a layer whose rate is the *exact*
// alpha (not a grid quantisation), whose pitch comes from the carrier band,
// whose loudness comes from the depth, and whose onset phase is the phase
// the detector measured — so the layers keep the timing relations of the
// source. Sections follow the source in time, one per analysis window.
//
// Slow periodicities (< 1 Hz) become swells: a held note whose filter is
// moved at the alpha rate. Middling ones (1–8 Hz) become pulses. Fast ones
// (≥ 8 Hz) become buzzes: a note retriggered at the alpha rate. The piece is
// then a hypothesis about the source, and analysing the performance with
// the same detector says how much of the source's structure the instrument
// carried — that comparison is `scoreFidelity`.
//
// Targets the OP-Z over MIDI (channel = track, from config/midi.json), but
// nothing here is OP-Z-specific except the role table and the CC numbers.

import { analyseCyclic } from '../analysis/cyclic.js';
import { buildSmf } from '../export/opz-project.js';

// OP-Z incoming CC map (docs/lab/opz/README.md §2.3). Absolute CCs take
// 0–127; the paired relative CC takes 1 = one step up, 127 = one step down.
export const OPZ_CC = {
  param1: 1, param2: 2, cutoff: 3, resonance: 4,
  attack: 5, decay: 6, sustain: 7, release: 8,
  lfoDepth: 9, lfoSpeed: 10, lfoTarget: 11, lfoShape: 12,
  fx1: 13, fx2: 14, pan: 15, volume: 16,
};
export const OPZ_CC_RELATIVE_OFFSET = 31; // relative CC = absolute CC + 31

// Which track carries which carrier band. Channels are 0-based MIDI
// channels; channel 0 (MIDI channel 1) is never used because a factory OP-Z
// routes it to whichever track is selected (`channel_one_to_active`).
export const DEFAULT_ROLES = {
  low:  { tone: { name: 'bass', channel: 4, noteMin: 36, noteMax: 55 }, hit: { name: 'sample', channel: 3, noteMin: 53, noteMax: 76 } },
  mid:  { tone: { name: 'lead', channel: 5, noteMin: 55, noteMax: 84 }, hit: { name: 'snare', channel: 1, noteMin: 53, noteMax: 76 } },
  high: { tone: { name: 'snare', channel: 1, noteMin: 60, noteMax: 96 }, hit: { name: 'perc', channel: 2, noteMin: 53, noteMax: 76 } },
};
export const BAND_EDGES_HZ = { low: 250, mid: 2500 }; // below low → low; below mid → mid; else high
export const MOTION = { swell: 1, pulse: 8 }; // alpha below → swell; below → pulse; else buzz

export function bandOf(carrierHz) {
  if (carrierHz < BAND_EDGES_HZ.low) return 'low';
  if (carrierHz < BAND_EDGES_HZ.mid) return 'mid';
  return 'high';
}
export function motionOf(alphaHz) {
  if (alphaHz < MOTION.swell) return 'swell';
  if (alphaHz < MOTION.pulse) return 'pulse';
  return 'buzz';
}

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(Math.max(1, hz) / 440);
}

/** Fold a MIDI note into [min, max] by octaves. */
export function foldNote(note, min, max) {
  let n = Math.round(note);
  while (n < min) n += 12;
  while (n > max) n -= 12;
  return Math.max(min, Math.min(max, n));
}

/**
 * Where on the spectrum an alpha lives: the depth-over-floor-weighted mean
 * frequency of the bands that carry it (ratio ≥ 3, DC bin excluded). The
 * single strongest bin is a poor carrier estimate — for speech it is often
 * the DC bin.
 */
export function carrierCentroid(result, alphaIndex, { minRatio = 3 } = {}) {
  const { mod, bins, binHz } = result.spectrum;
  const floors = result.floors || [];
  if (!mod) return null;
  let num = 0, den = 0;
  for (let b = 1; b < bins; b++) {
    const floor = floors[b] ?? 1;
    const ratio = floor > 0 ? mod[alphaIndex * bins + b] / floor : 0;
    if (ratio >= minRatio) { num += ratio * b * binHz; den += ratio; }
  }
  return den > 0 ? num / den : null;
}

function velocityFor(strength) {
  return Math.max(40, Math.min(120, Math.round(50 + 6 * Math.sqrt(Math.max(0, strength)))));
}

/**
 * Analyse `mono` in consecutive windows and write one section per window.
 * Each section holds up to `maxLayers` non-harmonic periodicities, strongest
 * first. Returns the score; nothing is played.
 */
export function composeCyclic({
  mono, sampleRate, sectionSec = 20, maxLayers = 5, roles = DEFAULT_ROLES,
  alphaMaxHz = undefined, minStrength = 0, title = 'cyclic transcription',
} = {}) {
  const total = mono.length / sampleRate;
  const sections = [];
  for (let start = 0; start + sectionSec * 0.75 <= total; start += sectionSec) {
    const end = Math.min(total, start + sectionSec);
    const r = analyseCyclic({ mono, sampleRate, startSec: start, endSec: end, ...(alphaMaxHz ? { alphaMaxHz } : {}) });
    const layers = [];
    if (r) {
      const picked = r.peaks.filter((p) => !p.harmonicOf && p.strength >= minStrength).slice(0, maxLayers);
      const pulsesInBand = {};
      for (const p of picked) {
        const bin = r.peakBin[p.index];
        const carrierHz = carrierCentroid(r, p.index) ?? bin * r.spectrum.binHz;
        const phase = r.spectrum.phase ? r.spectrum.phase[p.index * r.spectrum.bins + bin] : 0;
        const band = bandOf(carrierHz);
        const motion = motionOf(p.alphaHz);
        // Pulses in the same band alternate between the band's hit track and
        // its tone track, so three rates on one carrier are not one sound.
        const rank = motion === 'pulse' ? (pulsesInBand[band] = (pulsesInBand[band] || 0) + 1) - 1 : 0;
        const role = motion === 'pulse' && rank % 2 === 0 ? roles[band].hit : roles[band].tone;
        const period = 1 / p.alphaHz;
        // envelope ∝ cos(2π α t + φ) peaks first at t = −φ/(2πα), taken modulo one period
        const onset = (((-phase / (2 * Math.PI)) % 1) + 1) % 1 * period;
        layers.push({
          alphaHz: p.alphaHz, period, phase, onset,
          carrierHz, band, motion,
          channel: role.channel, track: role.name,
          note: foldNote(hzToMidi(carrierHz), role.noteMin, role.noteMax),
          velocity: velocityFor(p.strength),
          depth: Math.max(0, Math.min(1, (r.spectrum.mod?.[p.index * r.spectrum.bins + bin] ?? 0))),
          strength: p.strength, bands: p.bands, coherence: p.coherence ?? null,
        });
      }
    }
    sections.push({ startSec: start, seconds: end - start, layers, activeBands: r ? r.spectrum.activeBins : 0 });
  }
  return { title, sampleRate, seconds: total, sectionSec, sections };
}

// --- events ---------------------------------------------------------------

const CC_UPDATE_HZ = 25;       // swell filter updates per second
const SWELL_MAX_STEPS = 24;    // relative-CC excursion, in parameter steps
const SWELL_DEPTH_STEPS = 60;  // steps per unit of modulation depth

/**
 * Flatten a score into timed MIDI events, seconds from the start:
 * `{ t, kind: 'on'|'off'|'ccrel', channel, note|cc, value|delta }`.
 * Swells use the OP-Z's relative CCs and always sum to zero per section, so
 * a parameter ends exactly where it started.
 */
export function scoreEvents(score, { gapSec = 0.01 } = {}) {
  const ev = [];
  const push = (e) => ev.push(e);
  for (const s of score.sections) {
    const s0 = s.startSec, s1 = s.startSec + s.seconds;
    for (const L of s.layers) {
      if (L.motion === 'swell') {
        push({ t: s0, kind: 'on', channel: L.channel, note: L.note, value: L.velocity });
        push({ t: s1 - gapSec, kind: 'off', channel: L.channel, note: L.note, value: 0 });
        const amp = Math.min(SWELL_MAX_STEPS, Math.round(L.depth * SWELL_DEPTH_STEPS)) || 4;
        const cc = OPZ_CC.cutoff + OPZ_CC_RELATIVE_OFFSET;
        let pos = 0;
        const n = Math.floor((s.seconds - gapSec) * CC_UPDATE_HZ);
        for (let i = 1; i <= n; i++) {
          const t = s0 + i / CC_UPDATE_HZ;
          const target = Math.round(amp * Math.sin(2 * Math.PI * L.alphaHz * (t - s0 - L.onset) + Math.PI / 2));
          if (target !== pos) { push({ t, kind: 'ccrel', channel: L.channel, cc, delta: target - pos }); pos = target; }
        }
        if (pos !== 0) push({ t: s1 - gapSec, kind: 'ccrel', channel: L.channel, cc, delta: -pos });
      } else {
        const hold = L.motion === 'buzz' ? Math.min(0.03, L.period * 0.4) : Math.min(0.25, L.period * 0.5);
        for (let t = s0 + L.onset; t < s1 - gapSec; t += L.period) {
          push({ t, kind: 'on', channel: L.channel, note: L.note, value: L.velocity });
          push({ t: Math.min(t + hold, s1 - gapSec), kind: 'off', channel: L.channel, note: L.note, value: 0 });
        }
      }
    }
  }
  const order = { off: 0, ccrel: 1, on: 2 };
  ev.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
  return ev;
}

/** A DAW-readable Standard MIDI File of the score, one track per channel. */
export function scoreToSmf(score, { division = 960, tempoBpm = 120 } = {}) {
  const tps = division * tempoBpm / 60; // ticks per second
  const byChannel = new Map();
  const track = (ch) => { if (!byChannel.has(ch)) byChannel.set(ch, { name: `ch ${ch + 1}`, channel: ch, notes: [], controls: [] }); return byChannel.get(ch); };
  const open = new Map();
  for (const e of scoreEvents(score)) {
    const key = e.channel * 128 + (e.note ?? 0);
    if (e.kind === 'on') open.set(key, e);
    else if (e.kind === 'off' && open.has(key)) {
      const on = open.get(key); open.delete(key);
      track(e.channel).notes.push({ note: on.note, velocity: on.value, startTicks: Math.round(on.t * tps), durationTicks: Math.max(1, Math.round((e.t - on.t) * tps)) });
    }
  }
  // swells as absolute cutoff around the centre, sampled, so a DAW shows the motion
  for (const s of score.sections) for (const L of s.layers) if (L.motion === 'swell') {
    const amp = Math.min(SWELL_MAX_STEPS, Math.round(L.depth * SWELL_DEPTH_STEPS)) || 4;
    for (let t = 0; t < s.seconds; t += 0.05) {
      const value = Math.max(0, Math.min(127, Math.round(64 + amp * Math.sin(2 * Math.PI * L.alphaHz * (t - L.onset) + Math.PI / 2))));
      track(L.channel).controls.push({ ticks: Math.round((s.startSec + t) * tps), cc: OPZ_CC.cutoff, value });
    }
  }
  for (const t of byChannel.values()) { const n = t.name; t.name = `${n} ${[...new Set(score.sections.flatMap((s) => s.layers.filter((L) => L.channel === t.channel).map((L) => L.track)))].join('/')}`; }
  return buildSmf({
    name: score.title, division, tempoBpm,
    tracks: [...byChannel.values()].sort((a, b) => a.channel - b.channel),
    endTicks: Math.round(score.seconds * tps),
  });
}

/** One-screen reading of a score. */
export function describeScore(score) {
  const lines = [`${score.title}: ${score.seconds.toFixed(1)} s, ${score.sections.length} sections of ${score.sectionSec} s`];
  for (const s of score.sections) {
    lines.push(`section ${s.startSec.toFixed(0)}–${(s.startSec + s.seconds).toFixed(0)} s  (${s.activeBands} active bands)`);
    if (!s.layers.length) lines.push('  (silence: no periodicity above threshold)');
    for (const L of s.layers) {
      lines.push(`  ${L.motion.padEnd(5)} ${L.alphaHz.toFixed(3).padStart(7)} Hz  ${L.period.toFixed(3)} s  ${L.band.padEnd(4)} ${Math.round(L.carrierHz).toString().padStart(5)} Hz -> ${L.track.padEnd(6)} ch${String(L.channel + 1).padStart(2)} note ${L.note} vel ${L.velocity}  depth ${L.depth.toFixed(3)}  x${Math.round(L.strength)}  onset ${L.onset.toFixed(3)} s`);
    }
  }
  return lines.join('\n');
}

/**
 * How much of the score's structure a performance carried: analyse the
 * recording section by section and look for each layer's alpha. `offsetSec`
 * is where the score's t=0 sits in the recording.
 */
export function scoreFidelity(score, { mono, sampleRate, offsetSec = 0, tolBins = 1.5 } = {}) {
  const sections = [];
  let found = 0, total = 0;
  for (const s of score.sections) {
    const r = analyseCyclic({ mono, sampleRate, startSec: offsetSec + s.startSec, endSec: offsetSec + s.startSec + s.seconds });
    const layers = s.layers.map((L) => {
      total++;
      const tol = r ? tolBins * r.spectrum.alphaStep : 0;
      const hit = r ? r.peaks.find((p) => Math.abs(p.alphaHz - L.alphaHz) <= tol) : null;
      if (hit) found++;
      return { alphaHz: L.alphaHz, motion: L.motion, track: L.track, detected: hit ? hit.alphaHz : null, strength: hit ? hit.strength : 0, bands: hit ? hit.bands : 0 };
    });
    sections.push({ startSec: s.startSec, layers, peaks: r ? r.peaks.slice(0, 8).map((p) => ({ alphaHz: p.alphaHz, strength: p.strength, bands: p.bands })) : [] });
  }
  return { found, total, rate: total ? found / total : 0, sections };
}
