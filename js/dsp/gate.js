const defaults = {
  threshold: -55,
  release: 120,
  floor: -30
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

export async function processGate(audioBuffer, cfg = {}, onProgress = null) {
  const length = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const threshold = clamp(Number(configValue(cfg, 'threshold')), -80, -20);
  const releaseMs = clamp(Number(configValue(cfg, 'release')), 30, 500);
  const floorDb = clamp(Number(configValue(cfg, 'floor')), -60, -6);
  const attackCoeff = Math.exp(-1 / (sampleRate * 0.002));
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const input = [];
  const output = new AudioBuffer({
    length,
    numberOfChannels: channelCount,
    sampleRate
  });
  const outputChannels = [];

  for (let channel = 0; channel < channelCount; channel++) {
    input.push(audioBuffer.getChannelData(channel));
    outputChannels.push(output.getChannelData(channel));
  }

  if (onProgress) onProgress(0);
  const progressEvery = Math.max(1, Math.round(sampleRate * 0.5));
  let lastYield = Date.now();
  let envelope = 0;

  for (let i = 0; i < length; i++) {
    let detector = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      detector = Math.max(detector, Math.abs(input[channel][i]));
    }

    const coefficient = detector > envelope ? attackCoeff : releaseCoeff;
    envelope = coefficient * envelope + (1 - coefficient) * detector;
    const envelopeDb = 20 * Math.log10(Math.max(envelope, 1e-12));
    const position = clamp((envelopeDb - (threshold - 6)) / 6, 0, 1);
    const smooth = position * position * (3 - 2 * position);
    const gain = 10 ** (floorDb * (1 - smooth) / 20);

    for (let channel = 0; channel < channelCount; channel++) {
      outputChannels[channel][i] = input[channel][i] * gain;
    }

    if ((i + 1) % progressEvery === 0) {
      if (onProgress) onProgress(100 * (i + 1) / Math.max(1, length));
      if (Date.now() - lastYield >= 32) {
        await yieldNow();
        lastYield = Date.now();
      }
    }
  }

  if (onProgress) onProgress(100);
  return output;
}

export const gate = {
  id: 'gate',
  title: 'GATE',
  tagline: 'Close below threshold. Soft at the edge.',
  kind: 'buffer',
  defaults,
  params: [
    {
      key: 'threshold',
      label: 'THRESHOLD',
      unit: 'dB',
      min: -80,
      max: -20,
      step: 1,
      def: -55
    },
    {
      key: 'release',
      label: 'RELEASE',
      unit: 'ms',
      min: 30,
      max: 500,
      step: 10,
      def: 120
    },
    {
      key: 'floor',
      label: 'FLOOR',
      unit: 'dB',
      min: -60,
      max: -6,
      step: 1,
      def: -30
    }
  ],
  process: processGate
};

export default gate;

export { gate as descriptor };
