const defaults = {
  ceiling: -1
};

// setTimeout(0) is clamped to ~1s in hidden tabs; MessageChannel yields are not.
function yieldNow() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key) {
  return cfg?.[key] ?? cfg?.params?.[key] ?? defaults[key];
}

function makeOutput(buffer) {
  return new AudioBuffer({
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate
  });
}

export async function processLimiter(audioBuffer, cfg = {}, onProgress = null) {
  const length = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const ceilingDb = clamp(Number(configValue(cfg, 'ceiling')), -3, 0);
  const ceiling = 10 ** (ceilingDb / 20);
  const lookahead = Math.max(1, Math.round(sampleRate * 0.005));
  const attackCoeff = Math.exp(-1 / (sampleRate * 0.005));
  const releaseCoeff = Math.exp(-1 / (sampleRate * 0.06));
  const inputs = [];
  const output = makeOutput(audioBuffer);
  const outputs = [];

  for (let channel = 0; channel < channelCount; channel++) {
    inputs.push(audioBuffer.getChannelData(channel));
    outputs.push(output.getChannelData(channel));
  }

  if (onProgress) onProgress(0);
  if (length === 0 || channelCount === 0) {
    if (onProgress) onProgress(100);
    return output;
  }

  const capacity = lookahead + 2;
  const dequeIndices = new Int32Array(capacity);
  const dequeValues = new Float64Array(capacity);
  let head = 0;
  let size = 0;

  const linkedPeak = (index) => {
    let peak = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      peak = Math.max(peak, Math.abs(inputs[channel][index]));
    }
    return peak;
  };

  const pushPeak = (index) => {
    const peak = linkedPeak(index);
    while (size > 0) {
      const tail = (head + size - 1) % capacity;
      if (dequeValues[tail] > peak) break;
      size--;
    }
    const tail = (head + size) % capacity;
    dequeIndices[tail] = index;
    dequeValues[tail] = peak;
    size++;
  };

  for (let index = 0; index < Math.min(length, lookahead + 1); index++) pushPeak(index);

  const progressEvery = Math.max(1, Math.round(sampleRate * 0.5));
  let lastYield = Date.now();
  let gain = 1;
  for (let i = 0; i < length; i++) {
    while (size > 0 && dequeIndices[head] < i) {
      head = (head + 1) % capacity;
      size--;
    }

    const peakAhead = size > 0 ? dequeValues[head] : 0;
    const target = peakAhead > ceiling ? ceiling / peakAhead : 1;
    const smoothing = target < gain ? attackCoeff : releaseCoeff;
    gain = smoothing * gain + (1 - smoothing) * target;

    const peakNow = linkedPeak(i);
    // Lookahead shapes the envelope; this final bound preserves the brickwall invariant.
    const appliedGain = peakNow > 0 ? Math.min(gain, ceiling / peakNow) : gain;
    for (let channel = 0; channel < channelCount; channel++) {
      outputs[channel][i] = inputs[channel][i] * appliedGain;
    }

    const next = i + lookahead + 1;
    if (next < length) pushPeak(next);

    if ((i + 1) % progressEvery === 0) {
      if (onProgress) onProgress(100 * (i + 1) / length);
      if (Date.now() - lastYield >= 32) {
        await yieldNow();
        lastYield = Date.now();
      }
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
      def: -1
    }
  ],
  process: processLimiter
};

export default limiter;

export { limiter as descriptor };
