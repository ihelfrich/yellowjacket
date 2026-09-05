// Stand-in instrument for a cyclic score.
//
// Renders the score's events to mono float samples with the plainest voices
// that still carry the structure: noise bursts for the perc channel, sine
// tones for everything else, held notes shaped by their own swell rate. It
// exists so a transcription can be heard and measured without hardware, and
// so the fidelity of a real instrument has a baseline to beat.

import { scoreEvents } from './cyclic-score.js';

const PERC_CHANNEL = 2;

function noteHz(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

/**
 * Render `score` at `rate` Hz. Returns a Float32Array of `seconds` (default:
 * the score's length plus a one-second tail). Deterministic: the noise voice
 * is a seeded xorshift.
 */
export function renderScore(score, { rate = 22050, seconds = null, gain = 0.3 } = {}) {
  const total = seconds ?? score.seconds + 1;
  const out = new Float32Array(Math.ceil(total * rate));
  let seed = 7;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  const open = new Map();
  for (const e of scoreEvents(score)) {
    if (e.kind !== 'on' && e.kind !== 'off') continue;
    const key = e.channel * 128 + e.note;
    if (e.kind === 'on') { open.set(key, e); continue; }
    const on = open.get(key);
    if (!on) continue;
    open.delete(key);
    const t0 = on.t, at = Math.floor(t0 * rate), len = Math.floor(Math.min(e.t - t0, 30) * rate);
    if (at >= out.length) continue;
    const section = score.sections.find((s) => s.startSec <= t0 && t0 < s.startSec + s.seconds);
    const layer = section && section.layers.find((L) => L.channel === e.channel && L.note === e.note);
    const hz = noteHz(e.note), g = gain * (on.value / 127), perc = e.channel === PERC_CHANNEL;
    const held = len > rate;
    for (let i = 0; i < len && at + i < out.length; i++) {
      const tt = i / rate;
      let env = perc ? Math.exp(-tt / 0.012) : Math.min(1, tt / 0.005) * (held ? 1 : Math.exp(-tt / 0.05));
      if (layer && layer.motion === 'swell') env *= 0.55 + 0.45 * Math.cos(2 * Math.PI * layer.alphaHz * (t0 + tt - section.startSec - layer.onset));
      out[at + i] += g * env * (perc ? rnd() : Math.sin(2 * Math.PI * hz * tt));
    }
  }
  return out;
}
