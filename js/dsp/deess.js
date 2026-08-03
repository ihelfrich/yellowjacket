const defaults = {
  threshold: -30,
  reduction: 8
};

const BUTTERWORTH_Q = Math.SQRT1_2;

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

function biquadCoeffs(type, frequency, sampleRate) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const a1 = -2 * cosine / a0;
  const a2 = (1 - alpha) / a0;

  if (type === 'highpass') {
    return {
      b0: (1 + cosine) / (2 * a0),
      b1: -(1 + cosine) / a0,
      b2: (1 + cosine) / (2 * a0),
      a1,
      a2
    };
  }

  return {
    b0: (1 - cosine) / (2 * a0),
    b1: (1 - cosine) / a0,
    b2: (1 - cosine) / (2 * a0),
    a1,
    a2
  };
}

export async function processDeess(audioBuffer, cfg = {}, onProgress = null) {
  const length = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const threshold = clamp(Number(configValue(cfg, 'threshold')), -50, -10);
  const maximumReduction = clamp(Number(configValue(cfg, 'reduction')), 3, 18);
  const upperCutoff = Math.min(9000, sampleRate * 0.45);
  const lowerCutoff = Math.min(4500, upperCutoff * 0.75);
  const highpass = biquadCoeffs('highpass', lowerCutoff, sampleRate);
  const lowpass = biquadCoeffs('lowpass', upperCutoff, sampleRate);
  const inputs = [];
  const bands = [];
  const output = new AudioBuffer({
    length,
    numberOfChannels: channelCount,
    sampleRate
  });
  const outputs = [];

  for (let channel = 0; channel < channelCount; channel++) {
    inputs.push(audioBuffer.getChannelData(channel));
    bands.push(new Float32Array(length));
    outputs.push(output.getChannelData(channel));
  }

  if (onProgress) onProgress(0);
  const progressEvery = Math.max(1, Math.round(sampleRate * 0.5));
  const filterWork = Math.max(1, length * channelCount);
  let completed = 0;
  let lastYield = Date.now();

  // A Butterworth HP/LP biquad cascade forms the fourth-order split band.
  for (let channel = 0; channel < channelCount; channel++) {
    const input = inputs[channel];
    const band = bands[channel];
    let highZ1 = 0;
    let highZ2 = 0;
    let lowZ1 = 0;
    let lowZ2 = 0;

    for (let i = 0; i < length; i++) {
      const high = highpass.b0 * input[i] + highZ1;
      highZ1 = highpass.b1 * input[i] - highpass.a1 * high + highZ2;
      highZ2 = highpass.b2 * input[i] - highpass.a2 * high;

      const value = lowpass.b0 * high + lowZ1;
      lowZ1 = lowpass.b1 * high - lowpass.a1 * value + lowZ2;
      lowZ2 = lowpass.b2 * high - lowpass.a2 * value;
      band[i] = value;

      completed++;
      if (completed % progressEvery === 0) {
        if (onProgress) onProgress(50 * completed / filterWork);
        if (Date.now() - lastYield >= 32) {
          await yieldNow();
          lastYield = Date.now();
        }
      }
    }
  }

  const attackCoeff = Math.exp(-1 / (sampleRate * 0.001));
  const releaseCoeff = Math.exp(-1 / (sampleRate * 0.04));
  let envelope = 0;
  for (let i = 0; i < length; i++) {
    let detector = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      detector = Math.max(detector, Math.abs(bands[channel][i]));
    }

    const coefficient = detector > envelope ? attackCoeff : releaseCoeff;
    envelope = coefficient * envelope + (1 - coefficient) * detector;
    const envelopeDb = 20 * Math.log10(Math.max(envelope, 1e-12));
    const excess = Math.max(0, envelopeDb - threshold);
    // A 4:1 slope removes 3/4 of level above threshold.
    const reductionDb = Math.min(maximumReduction, excess * 0.75);
    const bandGain = 10 ** (-reductionDb / 20);

    for (let channel = 0; channel < channelCount; channel++) {
      outputs[channel][i] = inputs[channel][i] + (bandGain - 1) * bands[channel][i];
    }

    if ((i + 1) % progressEvery === 0) {
      if (onProgress) onProgress(50 + 50 * (i + 1) / Math.max(1, length));
      if (Date.now() - lastYield >= 32) {
        await yieldNow();
        lastYield = Date.now();
      }
    }
  }

  if (onProgress) onProgress(100);
  return output;
}

export const deess = {
  id: 'deess',
  title: 'DE-ESS',
  tagline: 'Tame the 4.5–9 kHz band.',
  kind: 'buffer',
  defaults,
  params: [
    {
      key: 'threshold',
      label: 'THRESHOLD',
      unit: 'dB',
      min: -50,
      max: -10,
      step: 1,
      def: -30
    },
    {
      key: 'reduction',
      label: 'REDUCTION',
      unit: 'dB',
      min: 3,
      max: 18,
      step: 1,
      def: 8
    }
  ],
  process: processDeess
};


export { deess as descriptor };
