// Lookahead brickwall limiter, TRUTH 1 rebuild. The old design smoothed with a
// one-pole whose attack equaled the lookahead (it could not reach target in time)
// and patched the miss with a per-sample hard min, which adds corner distortion
// and pumps on peak clusters. This one derives required gain from 4x OVERSAMPLED
// peaks (js/dsp/truepeak.js), shapes attack with a forward windowed minimum plus
// a matched boxcar (the applied gain is capped by the window minimum, so the
// ceiling holds by construction), then releases through hold, fast, slow stages.

import { peakTrack } from './truepeak.js';

const defaults = {
  ceiling: -1,
};

// setTimeout(0) is clamped to ~1s in hidden tabs; MessageChannel yields are not.
function yieldNow() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key) {
  return cfg?.[key] ?? cfg?.params?.[key] ?? defaults[key];
}

export async function processLimiter(audioBuffer, cfg = {}, onProgress = null) {
  const length = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const ceilingDb = clamp(Number(configValue(cfg, 'ceiling')), -3, 0);
  const ceiling = 10 ** (ceilingDb / 20);
  const output = new AudioBuffer({ length, numberOfChannels: channelCount, sampleRate });
  if (length === 0 || channelCount === 0) {
    if (onProgress) onProgress(100);
    return output;
  }

  const inputs = [];
  const outputs = [];
  for (let c = 0; c < channelCount; c++) {
    inputs.push(audioBuffer.getChannelData(c));
    outputs.push(output.getChannelData(c));
  }

  const look = Math.max(1, Math.round(sampleRate * 0.005));
  const holdSamples = Math.round(sampleRate * 0.05);
  // Release: fast stage to within 1 dB of target (40 ms tc), then slow settle (400 ms).
  const aFast = 1 - Math.exp(-1 / (0.04 * sampleRate));
  const aSlow = 1 - Math.exp(-1 / (0.4 * sampleRate));
  const NEAR = 10 ** (-1 / 20);

  if (onProgress) onProgress(2);

  // 1. Linked oversampled peak per sample -> required gain (in place).
  const peaks = new Float32Array(length);
  peakTrack(inputs, peaks);
  const gReq = peaks;
  for (let i = 0; i < length; i++) {
    const p = peaks[i];
    gReq[i] = p > ceiling ? ceiling / p : 1;
  }
  if (onProgress) onProgress(40);
  await yieldNow();

  // 2. Forward windowed minimum over [i, i+look] via a monotonic deque.
  const gMin = new Float32Array(length);
  {
    const capacity = look + 2;
    const idx = new Int32Array(capacity);
    const val = new Float32Array(capacity);
    let head = 0;
    let size = 0;
    const push = (i) => {
      const v = gReq[i];
      while (size > 0) {
        const tail = (head + size - 1) % capacity;
        if (val[tail] < v) break;
        size--;
      }
      const tail = (head + size) % capacity;
      idx[tail] = i;
      val[tail] = v;
      size++;
    };
    for (let i = 0; i < Math.min(length, look + 1); i++) push(i);
    for (let i = 0; i < length; i++) {
      while (size > 0 && idx[head] < i) { head = (head + 1) % capacity; size--; }
      gMin[i] = size > 0 ? val[head] : 1;
      const next = i + look + 1;
      if (next < length) push(next);
    }
  }
  if (onProgress) onProgress(60);
  await yieldNow();

  // 3. Envelope: attack follows min(gMin, boxcar(gMin)) so gain ramps down across
  //    the lookahead and lands when the peak arrives; release holds 50 ms, then
  //    recovers fast to within 1 dB of target, then settles slow. Applied gain
  //    never exceeds gMin[i] <= gReq[i]: the brickwall guarantee.
  let boxSum = 0;
  let boxCount = Math.min(length, look + 1);
  for (let i = 0; i < boxCount; i++) boxSum += gMin[i];
  let cur = 1;
  let holdCtr = 0;
  const yieldEvery = Math.max(1, sampleRate * 4);
  for (let i = 0; i < length; i++) {
    const smooth = boxSum / boxCount;
    const target = smooth < gMin[i] ? smooth : gMin[i];
    if (target < cur) {
      cur = target;
      holdCtr = holdSamples;
    } else if (holdCtr > 0) {
      holdCtr--;
    } else {
      const a = cur < target * NEAR ? aFast : aSlow;
      cur += (target - cur) * a;
      if (cur > target) cur = target;
    }
    for (let c = 0; c < channelCount; c++) outputs[c][i] = inputs[c][i] * cur;
    const drop = i;
    const add = i + look + 1;
    if (drop < length) { boxSum -= gMin[drop]; boxCount--; }
    if (add < length) { boxSum += gMin[add]; boxCount++; }
    if (boxCount <= 0) { boxCount = 1; boxSum = gMin[Math.min(i + 1, length - 1)]; }
    if ((i + 1) % yieldEvery === 0) {
      if (onProgress) onProgress(60 + 40 * (i + 1) / length);
      await yieldNow();
    }
  }
  if (onProgress) onProgress(100);
  return output;
}

export const limiter = {
  id: 'limiter',
  title: 'LIMITER',
  tagline: 'Brickwall at the ceiling. 5 ms of foresight.',
  kind: 'buffer',
  defaults,
  params: [
    {
      key: 'ceiling',
      label: 'CEILING',
      unit: 'dBFS',
      min: -3,
      max: 0,
      step: 0.1,
      def: -1,
    },
  ],
  process: processLimiter,
};


export { limiter as descriptor };
