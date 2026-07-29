// Harvest worker: wraps the pure core so mining a full song never blocks the UI
// thread. Protocol per docs/CONTRACT-HARVEST.md section 1.
//   in:  { type:'harvest', mono: Float32Array (transfer), sampleRate, onsets }
//   out: { type:'done', picks } / { type:'error', message }

import { harvest } from '../js/analysis/harvest.js';

// Guarded so the module also imports cleanly in node for the test harness.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type !== 'harvest') return;
    try {
      const { picks } = harvest(msg.mono, msg.sampleRate, msg.onsets);
      self.postMessage({ type: 'done', picks });
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  };
}
