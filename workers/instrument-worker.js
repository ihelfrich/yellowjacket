// Instrument worker: renders of cards and the carding of recordings, off the
// main thread. Pure modules only; the page never waits on a render it did not
// ask to hear. Protocol: { type: 'render', job, inputs } → { type: 'done', job,
// samples, sampleRate, meta }; { type: 'card', job, mono, sampleRate, opts } →
// progress messages then { type: 'done', job, result }; failures → { type:
// 'error', job, message }.
import { renderVoice, clearCache } from '../js/instrument/render.js';
import { cardFromSource } from '../js/instrument/from-source.js';

let rendered = 0;

self.onmessage = async (e) => {
  const msg = e.data || {};
  const { type, job } = msg;
  try {
    if (type === 'render') {
      const v = renderVoice(msg.inputs);
      // The render module keeps its own cache; a copy leaves so the cache stays whole.
      const samples = v.samples.slice();
      if (++rendered % 256 === 0) clearCache();
      self.postMessage({ type: 'done', job, samples, sampleRate: v.sampleRate, meta: v.meta }, [samples.buffer]);
    } else if (type === 'card') {
      const result = await cardFromSource(msg.mono, msg.sampleRate, {
        ...(msg.opts || {}),
        onProgress: (done, total) => self.postMessage({ type: 'progress', job, done, total }),
      });
      self.postMessage({ type: 'done', job, result });
    } else {
      throw new Error('unknown job: ' + type);
    }
  } catch (err) {
    self.postMessage({ type: 'error', job, message: String(err && err.message ? err.message : err) });
  }
};
