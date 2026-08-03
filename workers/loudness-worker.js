// Protocol:
//   in:  { type:'measure', job, channels: Float32Array[] (transfer), sampleRate }
//   out: { type:'progress', job, pct }
//   out: { type:'done', job, result }
//   out: { type:'error', job, message }
//
// `job` is echoed on every reply. Without it the caller could only assume the
// next message belonged to the last request it made, which is false the moment
// MEASURE and RENDER overlap: one promise resolved with the other's numbers and
// the other never settled at all, leaving RENDER disabled until reload.

import { measureLoudness } from '../js/dsp/loudness.js';

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'measure') return;
  const job = message.job;

  try {
    const result = measureLoudness(
      { channels: message.channels, sampleRate: Number(message.sampleRate) },
      (pct) => self.postMessage({ type: 'progress', job, pct }),
    );
    self.postMessage({ type: 'done', job, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      job,
      message: error && error.message ? error.message : String(error),
    });
  }
};
