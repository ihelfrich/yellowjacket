// Denoise: worker-backed spectral gating (workers/denoise-worker.js).
// The worker owns the math; this module owns channels, progress, lifecycle.

const defaults = {
  strength: 0.85,
  floorDb: -60
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key) {
  const raw = cfg?.params?.[key] ?? cfg?.[key] ?? defaults[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaults[key];
}

function runChannelJob(worker, samples, sampleRate, strength, floorDb, onPct) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        if (onPct) onPct(msg.pct);
      } else if (msg.type === 'done') {
        cleanup();
        resolve(msg.samples);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message || 'Denoise worker fault'));
      }
    };
    worker.onerror = (e) => {
      cleanup();
      reject(new Error(e && e.message ? e.message : 'Denoise worker fault'));
    };
    worker.postMessage(
      { type: 'process', samples, sampleRate, strength, floorDb },
      [samples.buffer]
    );
  });
}

export async function processDenoise(audioBuffer, cfg = {}, onProgress = null) {
  const length = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  if (length === 0) {
    if (onProgress) onProgress(100);
    return audioBuffer;
  }
  const strength = clamp(configValue(cfg, 'strength'), 0, 1);
  const floorDb = clamp(configValue(cfg, 'floorDb'), -80, -20);

  const output = new AudioBuffer({
    length,
    numberOfChannels: channelCount,
    sampleRate
  });

  const worker = new Worker(new URL('../../workers/denoise-worker.js', import.meta.url), {
    type: 'module'
  });
  try {
    if (onProgress) onProgress(0);
    for (let channel = 0; channel < channelCount; channel++) {
      // Copy: transferring getChannelData's array directly would detach the
      // source AudioBuffer's storage.
      const input = new Float32Array(audioBuffer.getChannelData(channel));
      const result = await runChannelJob(worker, input, sampleRate, strength, floorDb, (pct) => {
        if (onProgress) onProgress(((channel + clamp(pct, 0, 100) / 100) / channelCount) * 100);
      });
      output.getChannelData(channel).set(result.subarray(0, length));
    }
    if (onProgress) onProgress(100);
    return output;
  } finally {
    worker.terminate();
  }
}

export const denoise = {
  id: 'denoise',
  title: 'DENOISE',
  tagline: 'Learns the room from the quiet parts. Subtracts it.',
  kind: 'buffer',
  defaults,
  params: [
    { key: 'strength', label: 'STRENGTH', unit: '', min: 0, max: 1, step: 0.05, def: 0.85 },
    { key: 'floorDb', label: 'FLOOR', unit: 'dB', min: -80, max: -20, step: 1, def: -60 }
  ],
  process: processDenoise
};


export { denoise as descriptor };
