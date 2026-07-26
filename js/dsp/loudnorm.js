import { measureLoudness } from './loudness.js';
import { processLimiter } from './limiter.js';

const defaults = {
  target: -16
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

export async function processLoudnorm(audioBuffer, cfg = {}, onProgress = null) {
  const target = clamp(Number(configValue(cfg, 'target')), -24, -9);
  const measurement = measureLoudness(
    audioBuffer,
    onProgress ? (pct) => onProgress(pct * 0.4) : null
  );

  if (measurement.integrated === -Infinity) {
    if (onProgress) onProgress(100);
    return audioBuffer;
  }

  const gain = 10 ** ((target - measurement.integrated) / 20);
  const gained = new AudioBuffer({
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate
  });
  const progressEvery = Math.max(1, Math.round(audioBuffer.sampleRate * 0.5));
  let completed = 0;
  const total = Math.max(1, audioBuffer.length * audioBuffer.numberOfChannels);
  let lastYield = Date.now();

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const input = audioBuffer.getChannelData(channel);
    const output = gained.getChannelData(channel);
    for (let i = 0; i < audioBuffer.length; i++) {
      output[i] = input[i] * gain;
      completed++;

      if (completed % progressEvery === 0) {
        if (onProgress) onProgress(40 + 20 * completed / total);
        if (Date.now() - lastYield >= 32) {
          await yieldNow();
          lastYield = Date.now();
        }
      }
    }
  }

  return processLimiter(
    gained,
    { ceiling: -1 },
    onProgress ? (pct) => onProgress(60 + pct * 0.4) : null
  );
}

export const loudnorm = {
  id: 'loudnorm',
  title: 'LOUDNESS',
  tagline: 'Set integrated level. Catch the overs.',
  kind: 'buffer',
  defaults,
  params: [
    {
      key: 'target',
      label: 'TARGET',
      unit: 'LUFS',
      min: -24,
      max: -9,
      step: 1,
      def: -16
    }
  ],
  process: processLoudnorm
};

export default loudnorm;

export { loudnorm as descriptor };
