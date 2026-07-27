// Protocol:
//   in:  { type:'measure', channels: Float32Array[] (transfer), sampleRate }
//   out: { type:'progress', pct }
//   out: { type:'done', result }
//   out: { type:'error', message }

import { measureLoudness } from '../js/dsp/loudness.js';

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'measure') return;

  try {
    const result = measureLoudness(
      { channels: message.channels, sampleRate: Number(message.sampleRate) },
      (pct) => self.postMessage({ type: 'progress', pct }),
    );
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error && error.message ? error.message : String(error),
    });
  }
};
