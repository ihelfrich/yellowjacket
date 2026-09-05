#!/usr/bin/env node
// FIRESIDE — a song from public-domain culture, played by instruments derived
// from it. Every instrument is a card in docs/lab/cards; every rule below
// names its measurement.
//
//   key      G# minor   pitch classes of the 1921 Kid Ory chord card (B, G#)
//   tempo    81 bpm     the record's beat at 2.7 Hz, felt in half time
//   melody   FDR        voiced runs of the first fireside chat, in their own
//                       timing, pitch snapped to the scale an octave up;
//                       sung by the card made from one of FDR's own vowels
//   counter  Hiawatha   the LibriVox reader's intonation on her own vowel
//   bass     the Buzzer a UVB-76 burst as a card, plucked on the roots
//   chords   the band   the 1921 chord card, bowed
//   bell     carillon   the Eulenspiegel chime, struck on the tonic
//   clock    WWV        the tick, cut from the recording, every second
//   hats     Morse      dits cut from the 1942 code record, in their own rhythm
//   drum     thud       the OP-Z kick as a one-mode card, struck
//   last     WWV tone   the minute tone card, transposed to the fifth
//
//   node scripts/compose-fireside.mjs <found-dir> <out.wav>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, monoOf, writeWav24 } from './lib/wav.mjs';
import { trackPitch, voicedRuns } from '../js/analysis/pitch.js';
import { renderVoice, TRUTH_RATE } from '../js/instrument/render.js';
import { resample } from '../js/dsp/resample.js';

const [found, outPath] = process.argv.slice(2);
const card = (name) => JSON.parse(readFileSync(`docs/lab/cards/${name}.json`, 'utf8'));
const cards = { fdr: card('fdr-vowel'), hia: card('hiawatha-vowel'), buzz: card('uvb76-buzz'), band: card('ory-chord'), bell: card('carillon-bell'), thud: card('opz-thud'), tone: card('wwv-tone') };

// ---- key, tempo, scale ----------------------------------------------------
const BPM = 81, BEAT = 60 / BPM, BAR = 4 * BEAT;
const ROOT = 8; // G#
const MINOR = [0, 2, 3, 5, 7, 8, 10];                 // natural minor
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const snap = (midi) => { let best = null; for (let n = Math.floor(midi) - 6; n <= Math.ceil(midi) + 6; n++) if (MINOR.includes(((n - ROOT) % 12 + 12) % 12) && (best === null || Math.abs(n - midi) < Math.abs(best - midi))) best = n; return best; };
const CHORDS = { Gsm: [56, 59, 63], E: [52, 56, 59], B: [59, 63, 66], Fs: [54, 58, 61] }; // pad voicings
const ROOTS = { Gsm: 32, E: 28, B: 35, Fs: 30 };                                              // bass

// ---- melodies from intonation --------------------------------------------
function intonation(file, a, b, { minHz, maxHz, octave, minSec = 0.09 }) {
  const w = readWav(join(found, file)), sr = w.sampleRate, m = monoOf(w).subarray(Math.round(a * sr), Math.round(b * sr));
  const tr = trackPitch(m, sr, { minHz, maxHz });
  const runs = voicedRuns(tr, { minSec, maxStepCents: 150 });
  return runs.map((r, i) => {
    const next = runs[i + 1] ? runs[i + 1].startSec : r.endSec + 0.6;
    const dur = Math.max(0.18, Math.min(0.7, next - r.startSec - 0.04));
    const midi = snap(69 + 12 * Math.log2(r.meanHz / 440) + 12 * octave);
    const stress = Math.min(1, (r.endSec - r.startSec) / 0.3);
    return { t: r.startSec, dur, midi, vel: 0.55 + 0.45 * stress };
  });
}
const fdrA = intonation('fdr1933.wav', 20, 60, { minHz: 70, maxHz: 300, octave: 1 });
const fdrB = intonation('fdr1933.wav', 80, 120, { minHz: 70, maxHz: 300, octave: 1 });
const hia = intonation('hiawatha.wav', 80, 104, { minHz: 100, maxHz: 400, octave: 1, minSec: 0.12 });

// ---- one-shots cut from the recordings ------------------------------------
function cutOneShot(file, fromSec, toSec, lenSec) {
  const w = readWav(join(found, file)), sr = w.sampleRate, m = monoOf(w);
  const hop = Math.round(0.002 * sr); let best = { j: -1, i: 0 };
  for (let i = Math.round(fromSec * sr) + hop; i < Math.round(toSec * sr) - hop; i += hop) {
    let e = 0, p = 0; for (let k = 0; k < hop; k++) { e += m[i + k] ** 2; p += m[i - hop + k] ** 2; }
    const j = Math.log((e + 1e-9) / (p + 1e-9)); if (j > best.j) best = { j, i };
  }
  const n = Math.round(lenSec * sr), out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = (m[best.i + k] || 0) * (k > n - 200 ? (n - k) / 200 : 1);
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let k = 0; k < n; k++) out[k] /= peak || 1;
  return { samples: resample(out, sr, TRUTH_RATE, { cutoffScale: 0.45 }), at: best.i / sr };
}
const tick = cutOneShot('wwv.wav', 75.9, 76.3, 0.06);
const dit = cutOneShot('code1942.wav', 30, 34, 0.09);
// the Morse record's own rhythm: onsets in an 8 s stretch, looped as the hat pattern
function onsets(file, a, b, minGap = 0.05) {
  const w = readWav(join(found, file)), sr = w.sampleRate, m = monoOf(w);
  const hop = Math.round(0.005 * sr), out = []; let last = -1;
  const e = []; for (let i = Math.round(a * sr); i + hop < Math.round(b * sr); i += hop) { let s = 0; for (let k = 0; k < hop; k++) s += m[i + k] ** 2; e.push(Math.log(1e-9 + s / hop)); }
  for (let f = 2; f < e.length; f++) { const t = a + f * hop / sr; if (e[f] - Math.max(e[f - 1], e[f - 2]) > 2 && t - last > minGap) { out.push(t - a); last = t; } }
  return out;
}
const morse = onsets('code1942.wav', 30, 38);

// ---- the form ---------------------------------------------------------------
const SECTIONS = [
  { name: 'intro',  seconds: 16, chords: ['Gsm', 'Gsm', 'E', 'E'], bell: true, tick: true, bass: 'bow' },
  { name: 'A',      seconds: 40, chords: ['Gsm', 'E', 'B', 'Fs'], tick: true, bass: 'pluck', pad: true, kick: true, hats: true, melody: fdrA, voice: 'fdr' },
  { name: 'B',      seconds: 24, chords: ['E', 'Fs', 'Gsm', 'Gsm'], tick: true, bass: 'pluck', pad: true, melody: hia, voice: 'hia', bell: true },
  { name: "A'",     seconds: 40, chords: ['Gsm', 'E', 'B', 'Fs'], tick: true, bass: 'pluck', pad: true, kick: true, hats: true, melody: fdrB, voice: 'fdr', counter: hia },
  { name: 'outro',  seconds: 30, chords: ['Gsm', 'E', 'Gsm', 'Gsm'], tick: true, bell: true, bass: 'bow', final: true },
];
const total = SECTIONS.reduce((s, x) => s + x.seconds, 0) + 3;
const bus = {}; // name → Float32Array at TRUTH_RATE
const track = (name) => (bus[name] ||= new Float32Array(Math.ceil(total * TRUTH_RATE)));
const place = (name, samples, atSec, gain = 1) => { const b = track(name), o = Math.round(atSec * TRUTH_RATE); for (let i = 0; i < samples.length && o + i < b.length; i++) b[o + i] += samples[i] * gain; };
const play = (name, c, midi, excitation, seconds, dynamics, atSec, gain = 1, params = {}) => place(name, renderVoice({ card: c, pitchHz: hz(midi), excitation, seconds, dynamics, params }).samples, atSec, gain);

let t0 = 0, count = 0;
const sheet = [];
for (const S of SECTIONS) {
  const end = t0 + S.seconds, bars = Math.ceil(S.seconds / BAR);
  sheet.push(`${S.name.padEnd(6)} ${t0.toFixed(1).padStart(6)}–${end.toFixed(1)} s  ${S.chords.join(' ')}`);
  for (let b = 0; b < bars; b++) {
    const bt = t0 + b * BAR; if (bt >= end) break;
    const chord = S.chords[b % S.chords.length];
    if (S.pad) { for (const n of CHORDS[chord]) { play('pad', cards.band, n, 'bow', BAR - 0.05, 0.5, bt, 0.35, { force: 0.5 }); count++; } }
    if (S.bass === 'pluck') for (let k = 0; k < 4; k++) { if (k === 1) continue; play('bass', cards.buzz, ROOTS[chord] + (k === 3 ? 12 : 0), 'pluck', 0.6, k === 0 ? 1 : 0.7, bt + k * BEAT, 0.7, { position: 0.15 }); count++; }
    if (S.bass === 'bow') { play('bass', cards.buzz, ROOTS[chord], 'bow', BAR - 0.1, 0.6, bt, 0.5, { force: 0.45 }); count++; }
    if (S.kick) for (const k of [0, 2]) { play('drum', cards.thud, 36, 'strike', 0.5, k === 0 ? 1 : 0.8, bt + k * BEAT, 0.9, { hardness: 0.7 }); count++; }
    if (S.hats) for (const o of morse) { if (o < BAR * 2 && b % 2 === 0) place('hats', dit.samples, bt + o, 0.25); }
    if (S.bell && b % 4 === 0) { play('bell', cards.bell, 56 + (b % 8 === 0 ? 0 : 7), 'strike', 4, 0.9, bt, 0.55, { hardness: 0.6 }); count++; }
  }
  if (S.tick) for (let t = Math.ceil(t0); t < end; t += 1) place('tick', tick.samples, t, S.final ? 0.5 : 0.35);
  if (S.melody) for (const n of S.melody) { if (n.t + n.dur > S.seconds) continue; play('voice', cards[S.voice], n.midi, 'breath', n.dur, 0.6 + 0.6 * n.vel, t0 + n.t, 0.9, { pressure: 0.7, noise: 0.08 }); count++; }
  if (S.counter) for (const n of S.counter) { if (n.t + n.dur > S.seconds) continue; play('counter', cards.hia, n.midi + 12, 'breath', n.dur * 0.8, 0.45 + 0.3 * n.vel, t0 + n.t, 0.45, { pressure: 0.6 }); count++; }
  if (S.final) { play('voice', cards.tone, 63, 'bow', 8, 0.5, end - 10, 0.12, { force: 0.4 }); play('bell', cards.bell, 56, 'strike', 6, 0.8, end - 4, 0.4, { hardness: 0.4 }); count += 2; }
  t0 = end;
}

// ---- mix: gains, pans, a gentle bus -----------------------------------------
// Each bus is first normalised to a stated RMS (not a peak), so a sustained
// instrument cannot dominate by being continuous; then panned and summed.
const PAN = { voice: 0, counter: 0.35, pad: -0.3, bass: 0, drum: 0, hats: 0.5, tick: -0.5, bell: 0.2 };
const RMS_DB = { voice: -16, counter: -22, pad: -22, bass: -20, drum: -18, hats: -26, tick: -28, bell: -22 };
const n = Math.ceil(total * TRUTH_RATE), L = new Float32Array(n), R = new Float32Array(n);
const stems = process.argv.includes('--stems');
const report = [];
for (const [name, buf] of Object.entries(bus)) {
  let e = 0, cnt = 0, peak = 0;
  for (const v of buf) { if (v !== 0) { e += v * v; cnt++; } peak = Math.max(peak, Math.abs(v)); }
  const rms = Math.sqrt(e / Math.max(1, cnt)); // over the bus's sounding samples
  const g = rms > 0 ? Math.pow(10, (RMS_DB[name] ?? -20) / 20) / rms : 0;
  report.push(`${name.padEnd(8)} raw rms ${(20 * Math.log10(rms + 1e-9)).toFixed(1).padStart(6)} dB peak ${(20 * Math.log10(peak + 1e-9)).toFixed(1).padStart(6)} dB crest ${(20 * Math.log10(peak / (rms + 1e-9))).toFixed(1).padStart(5)} dB -> gain ${(20 * Math.log10(g + 1e-9)).toFixed(1)} dB`);
  const p = PAN[name] ?? 0, gl = g * Math.cos((p + 1) * Math.PI / 4), gr = g * Math.sin((p + 1) * Math.PI / 4);
  for (let i = 0; i < n; i++) { L[i] += buf[i] * gl; R[i] += buf[i] * gr; }
  if (stems) { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = buf[i] * g; writeWav24(outPath.replace(/\.wav$/, `-${name}.wav`), [resample(s, TRUTH_RATE, 48000, { cutoffScale: 0.45 })], 48000); }
}
let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? Math.pow(10, -3 / 20) / peak : 1;
for (let i = 0; i < n; i++) { L[i] *= norm; R[i] *= norm; }
writeWav24(outPath, [resample(L, TRUTH_RATE, 48000, { cutoffScale: 0.45 }), resample(R, TRUTH_RATE, 48000, { cutoffScale: 0.45 })], 48000);
console.log(`FIRESIDE: ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}, ${count} rendered notes, melody runs A ${fdrA.length} / B ${fdrB.length} / Hiawatha ${hia.length}, morse pattern ${morse.length} onsets in 8 s`);
for (const l of sheet) console.log('  ' + l);
console.log('  one-shots: WWV tick at ' + tick.at.toFixed(2) + ' s, Morse dit at ' + dit.at.toFixed(2) + ' s');
for (const r of report) console.log('  ' + r);
{ let e = 0, pk = 0; for (let i = 0; i < n; i++) { e += L[i] * L[i] + R[i] * R[i]; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); } const rms = Math.sqrt(e / (2 * n)); console.log(`  mix: rms ${(20 * Math.log10(rms)).toFixed(1)} dB, peak ${(20 * Math.log10(pk)).toFixed(1)} dB, crest ${(20 * Math.log10(pk / rms)).toFixed(1)} dB`); }
