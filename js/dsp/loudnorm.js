import { measureLoudness } from './loudness.js';
import { processLimiter } from './limiter.js';

const defaults = {
  target: -16
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

// `inPlace` writes back into the input: safe only for a buffer this stage
// owns (the limiter's fresh output), never for the caller's source.
async function applyGain(audioBuffer, gain, onProgress, progressStart, progressSpan, inPlace = false) {
  const gained = inPlace ? audioBuffer : new AudioBuffer({
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
        if (onProgress) onProgress(progressStart + progressSpan * completed / total);
        if (Date.now() - lastYield >= 32) {
          await yieldNow();
          lastYield = Date.now();
        }
      }
    }
  }
  return gained;
}

export async function processLoudnorm(audioBuffer, cfg = {}, onProgress = null) {
  const target = clamp(Number(configValue(cfg, 'target')), -24, -9);
  const measurement = measureLoudness(
    audioBuffer,
    onProgress ? (pct) => onProgress(pct * 0.3) : null
  );

  if (measurement.integrated === -Infinity) {
    if (onProgress) onProgress(100);
    return audioBuffer;
  }

  // measure -> gain -> true-peak limit. Limiting can eat level, so remeasure and
  // apply one corrective pass; without it the delivered LUFS silently misses the
  // promise whenever the limiter works hard (TRUTH 1, audit item 4).
  const gain = 10 ** ((target - measurement.integrated) / 20);
  let gained = await applyGain(audioBuffer, gain, onProgress, 30, 15);
  let limited = await processLimiter(
    gained,
    { ceiling: -1 },
    onProgress ? (pct) => onProgress(45 + pct * 0.25) : null
  );
  gained = null;   // the limiter has its own output; this copy is dead now

  const after = measureLoudness(limited, null);
  const missLu = target - after.integrated;
  if (Math.abs(missLu) > 0.05 && after.integrated !== -Infinity) {
    // The corrective gain is applied in place on the limiter's output (this
    // stage owns it) instead of allocating a fourth full buffer; the second
    // limiter pass then replaces it. Peak above the input drops from four
    // full copies to two (ledger: rack-render-export-loom §7.3).
    const corrected = await applyGain(limited, 10 ** (missLu / 20), onProgress, 70, 10, true);
    limited = null;
    limited = await processLimiter(
      corrected,
      { ceiling: -1 },
      onProgress ? (pct) => onProgress(80 + pct * 0.2) : null
    );
  }
  if (onProgress) onProgress(100);
  return limited;
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


export { loudnorm as descriptor };
