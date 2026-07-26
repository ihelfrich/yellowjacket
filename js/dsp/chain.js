// DSP rack orchestration: canonical registry, cut splicing, chain rendering.

import { descriptor as eqDesc, highpassDesc } from './eq.js';
import { descriptor as dehumDesc } from './dehum.js';
import { descriptor as denoiseDesc } from './denoise.js';
import { descriptor as deessDesc } from './deess.js';
import { descriptor as gateDesc } from './gate.js';
import { descriptor as compressorDesc } from './compressor.js';
import { descriptor as limiterDesc } from './limiter.js';
import { descriptor as loudnormDesc } from './loudnorm.js';

// Canonical rack order.
export const REGISTRY = [
  highpassDesc,
  dehumDesc,
  denoiseDesc,
  deessDesc,
  eqDesc,
  gateDesc,
  compressorDesc,
  limiterDesc,
  loudnormDesc
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Splice cut ranges out of a buffer with 6 ms equal-power crossfades at each
// join. Cuts at the very start or end simply shorten the buffer (no join, no
// fade partner). Returns the input buffer untouched when no cut survives
// normalization.
export function spliceCuts(buffer, cuts) {
  if (!buffer || !cuts || !cuts.length || buffer.length === 0) return buffer;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const channelCount = buffer.numberOfChannels;

  const ranges = [];
  for (const c of cuts) {
    if (!c) continue;
    let s = Math.round(Number(c.start) * sampleRate);
    let e = Math.round(Number(c.end) * sampleRate);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = clamp(s, 0, length);
    e = clamp(e, 0, length);
    if (e > s) ranges.push([s, e]);
  }
  if (!ranges.length) return buffer;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i]);
  }

  const kept = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) kept.push([pos, s]);
    pos = e;
  }
  if (pos < length) kept.push([pos, length]);

  if (!kept.length) {
    // Everything cut. AudioBuffer cannot be zero-length; return one silent sample.
    return new AudioBuffer({ length: 1, numberOfChannels: channelCount, sampleRate });
  }

  // Per-join fade lengths. A join's fade can never consume more of the
  // previous segment than remains after that segment's own head fade.
  const fadeMax = Math.round(0.006 * sampleRate);
  const fades = new Array(kept.length).fill(0);
  for (let i = 1; i < kept.length; i++) {
    const prevAvail = kept[i - 1][1] - kept[i - 1][0] - fades[i - 1];
    const curLen = kept[i][1] - kept[i][0];
    fades[i] = Math.max(0, Math.min(fadeMax, prevAvail, curLen));
  }
  let outLength = 0;
  for (let i = 0; i < kept.length; i++) outLength += kept[i][1] - kept[i][0] - fades[i];

  const out = new AudioBuffer({
    length: outLength,
    numberOfChannels: channelCount,
    sampleRate
  });
  const halfPi = Math.PI / 2;
  for (let channel = 0; channel < channelCount; channel++) {
    const src = buffer.getChannelData(channel);
    const dst = out.getChannelData(channel);
    let w = 0;
    for (let i = 0; i < kept.length; i++) {
      const [a, b] = kept[i];
      const f = fades[i];
      for (let k = 0; k < f; k++) {
        // Equal-power: outgoing cos, incoming sin.
        const t = ((k + 1) / (f + 1)) * halfPi;
        const p = w - f + k;
        dst[p] = dst[p] * Math.cos(t) + src[a + k] * Math.sin(t);
      }
      dst.set(src.subarray(a + f, b), w);
      w += b - a - f;
    }
  }
  return out;
}

function scheduleProgressTicks(ctx, duration, onFrac) {
  if (!onFrac || typeof ctx.suspend !== 'function' || !(duration > 0)) return;
  const ticks = Math.min(24, Math.floor(duration));
  for (let i = 1; i <= ticks; i++) {
    const t = (duration * i) / (ticks + 1);
    ctx.suspend(t).then(() => {
      onFrac(i / (ticks + 1));
      ctx.resume();
    }).catch(() => {});
  }
}

async function renderNodesStage(buffer, group, onFrac) {
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  );
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  let head = src;
  for (const { desc, cfg } of group) {
    const built = desc.build(ctx, cfg);
    head.connect(built.input);
    head = built.output;
  }
  head.connect(ctx.destination);
  scheduleProgressTicks(ctx, buffer.duration, onFrac);
  src.start(0);
  return ctx.startRendering();
}

// Render pipeline: splice cuts first, then walk the enabled effects in chain
// order, batching consecutive kind:'nodes' effects into a single
// OfflineAudioContext pass. Progress is spread proportionally across stages.
export async function renderChain(buffer, cuts, chain, onProgress) {
  const report = (pct) => {
    if (onProgress) onProgress(clamp(pct, 0, 100));
  };
  if (!buffer || buffer.length === 0) {
    report(100);
    return buffer;
  }

  const byId = new Map(REGISTRY.map((d) => [d.id, d]));
  const enabled = (chain || []).filter((c) => c && c.on && byId.has(c.id));
  const hasCuts = !!(cuts && cuts.length);
  if (!enabled.length && !hasCuts) {
    report(100);
    return buffer;
  }

  const stages = [];
  if (hasCuts) stages.push({ type: 'splice' });
  let i = 0;
  while (i < enabled.length) {
    if (byId.get(enabled[i].id).kind === 'nodes') {
      const group = [];
      while (i < enabled.length && byId.get(enabled[i].id).kind === 'nodes') {
        group.push({ desc: byId.get(enabled[i].id), cfg: enabled[i] });
        i++;
      }
      stages.push({ type: 'nodes', group });
    } else {
      stages.push({ type: 'buffer', desc: byId.get(enabled[i].id), cfg: enabled[i] });
      i++;
    }
  }

  const share = 100 / stages.length;
  let buf = buffer;
  for (let s = 0; s < stages.length; s++) {
    const base = s * share;
    const stage = stages[s];
    if (stage.type === 'splice') {
      buf = spliceCuts(buf, cuts);
    } else if (stage.type === 'nodes') {
      buf = await renderNodesStage(buf, stage.group, (frac) => report(base + frac * share));
    } else {
      buf = await stage.desc.process(buf, stage.cfg, (pct) =>
        report(base + (clamp(pct, 0, 100) / 100) * share)
      );
    }
    report(base + share);
  }
  report(100);
  return buf;
}
