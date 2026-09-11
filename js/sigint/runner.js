// One place that runs a SIGINT job, whether or not there is a Worker to run it
// in. In the page the work leaves the main thread; under node, and anywhere a
// worker fails to construct, the same function runs in place — so the two paths
// call identical code and cannot disagree about an answer.
//
// There is no pool here on purpose. These jobs are one at a time by nature: a
// person presses MEASURE and waits for the measurement. What the worker buys is
// a page that still scrolls and draws while they wait, not throughput.
import { runTask } from '../../workers/sigint-worker.js';

export class SigintRunner {
  constructor({ workerUrl = null } = {}) {
    this.workerUrl = workerUrl;
    this.available = typeof Worker === 'function' && !!workerUrl;
    this.worker = null;
    this.jobs = new Map();
    this.seq = 0;
    this.failures = 0;
  }

  _worker() {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerUrl, { type: 'module' });
    w.onmessage = (e) => {
      const msg = e.data || {};
      const job = this.jobs.get(msg.job);
      if (!job) return;
      this.jobs.delete(msg.job);
      if (msg.type === 'done') job.resolve(msg.result);
      else job.reject(new Error(msg.message || 'sigint worker error'));
    };
    w.onerror = (e) => {
      // A worker whose script will not load is dead. Retire it so the next call
      // spawns a fresh one, and after two deaths stop trying and run in place —
      // a panel that works slowly beats a panel that does not work.
      const error = new Error((e && e.message) || 'sigint worker error');
      for (const [, job] of this.jobs) job.reject(error);
      this.jobs.clear();
      try { w.terminate(); } catch (_) { /* already gone */ }
      this.worker = null;
      if (++this.failures >= 2) this.available = false;
    };
    this.worker = w;
    return w;
  }

  /**
   * Run one job. `x` is handed to the worker by transfer, so the caller must
   * pass a copy it does not need afterwards — `subarray` of a live AudioBuffer
   * channel would be detached out from under the page.
   */
  async run(type, x, sampleRate, opts = {}) {
    if (!this.available) return runTask(type, x, sampleRate, opts);
    const job = ++this.seq;
    const samples = x instanceof Float32Array ? x.slice() : Float32Array.from(x);
    return new Promise((resolve, reject) => {
      this.jobs.set(job, { resolve, reject });
      try {
        this._worker().postMessage({ type, job, x: samples, sampleRate, opts }, [samples.buffer]);
      } catch (error) {
        // postMessage itself can throw on an options object that will not clone
        this.jobs.delete(job);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch(() => {
      // Any worker fault falls back to running in place, not just a fault after
      // the runner has given up trying: the first failure is the one a person
      // is waiting through, and it must still produce an answer. `available`
      // going false after two deaths only stops the next call from paying the
      // worker's start-up cost first.
      return runTask(type, x, sampleRate, opts);
    });
  }

  terminate() {
    for (const [, job] of this.jobs) job.reject(new Error('sigint runner stopped'));
    this.jobs.clear();
    if (this.worker) { try { this.worker.terminate(); } catch (_) { /* already gone */ } }
    this.worker = null;
  }
}

export const sigintRunner = new SigintRunner({
  workerUrl: typeof document !== 'undefined'
    ? new URL('../../workers/sigint-worker.js', import.meta.url).href
    : null,
});
