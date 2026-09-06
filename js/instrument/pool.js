// A small pool of instrument workers: renders and carding leave the main
// thread, replies come back by job id, progress streams for the long ones.
// Without Worker (node, the tests) every call runs in place on the same pure
// functions, so the two paths cannot disagree.

import { renderVoice } from './render.js';
import { cardFromSource } from './from-source.js';

export const POOL_MAX = 4;

export class InstrumentPool {
  constructor({ size = null, workerUrl = null } = {}) {
    const cores = (globalThis.navigator && navigator.hardwareConcurrency) || 2;
    this.size = Math.max(1, Math.min(POOL_MAX, size ?? cores - 1));
    this.workerUrl = workerUrl;
    this.available = typeof Worker === 'function' && !!workerUrl;
    this.workers = [];
    this.jobs = new Map();
    this.seq = 0;
    this.next = 0;
  }
  get busy() { return this.jobs.size; }

  _worker(i) {
    if (!this.workers[i]) {
      const w = new Worker(this.workerUrl, { type: 'module' });
      w.onmessage = (e) => {
        const msg = e.data || {};
        const job = this.jobs.get(msg.job);
        if (!job) return;
        if (msg.type === 'progress') { if (job.onProgress) job.onProgress(msg.done, msg.total); return; }
        this.jobs.delete(msg.job);
        if (msg.type === 'done') job.resolve(msg);
        else job.reject(new Error(msg.message || 'instrument worker error'));
      };
      w.onerror = (e) => {
        const err = new Error(e.message || 'instrument worker error');
        for (const [id, job] of this.jobs) if (job.worker === i) { job.reject(err); this.jobs.delete(id); }
      };
      this.workers[i] = w;
    }
    return this.workers[i];
  }

  _post(type, payload, transfer = [], onProgress = null) {
    const i = this.next; this.next = (this.next + 1) % this.size;
    const w = this._worker(i);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress, worker: i });
      w.postMessage({ type, job: id, ...payload }, transfer);
    });
  }

  /** renderVoice's inputs → { samples, sampleRate, meta } */
  render(inputs) {
    if (!this.available) return Promise.resolve().then(() => { const v = renderVoice(inputs); return { samples: v.samples, sampleRate: v.sampleRate, meta: v.meta }; });
    return this._post('render', { inputs }).then((m) => ({ samples: m.samples, sampleRate: m.sampleRate, meta: m.meta }));
  }

  /** cardFromSource in a worker, with progress → { card, path, how } */
  card(mono, sampleRate, opts = {}, onProgress = null) {
    if (!this.available) return cardFromSource(mono, sampleRate, { ...opts, onProgress });
    const copy = mono.slice();
    return this._post('card', { mono: copy, sampleRate, opts }, [copy.buffer], onProgress).then((m) => m.result);
  }

  terminate() { for (const w of this.workers) if (w) w.terminate(); this.workers = []; this.jobs.clear(); }
}

/** The bench's shared pool; workers start on the first job. */
export const instrumentPool = new InstrumentPool({
  workerUrl: typeof Worker === 'function' ? new URL('../../workers/instrument-worker.js', import.meta.url) : null,
});
