// The SIGINT runner: one place that runs a job, in a worker when there is one
// and in place when there is not. The two paths call the same function, so what
// is pinned here is that the fallback is real, that a dead worker degrades to it
// rather than to nothing, and that every task the panel names exists.
import assert from 'node:assert/strict';

import { SigintRunner } from '../js/sigint/runner.js';
import { TASKS, runTask } from '../workers/sigint-worker.js';
import { WWV_WWVH } from '../js/sigint/tdoa.js';
import { white } from './noise-colours.mjs';

const RATE = 8000;

function keyed(seconds = 2, { hz = 1000, ditSec = 0.08, amp = 0.5 } = {}) {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  const w = white(n, { sigma: 0.01, seed: 3 });
  for (let i = 0; i < n; i++) {
    const on = Math.floor(i / (RATE * ditSec)) % 2 === 0;
    x[i] = (on ? amp : 0) * Math.cos(2 * Math.PI * hz * i / RATE) + w[i];
  }
  return x;
}

export const NAME = 'sigint runner';

export const cases = [
  async function everyTaskThePanelNamesExists() {
    // The panel's buttons post these five strings. A typo in one would be a
    // button that throws only when pressed.
    for (const task of ['measure', 'segment', 'classify', 'decode', 'tdoa', 'marker']) {
      assert.equal(typeof TASKS[task], 'function', task + ' is not a task');
    }
    assert.throws(() => runTask('nonsense', keyed(0.6), RATE), /unknown job: nonsense/);
  },

  async function withoutAWorkerEverythingStillRuns() {
    // This is the node path, and it is also what the page falls back to.
    const r = new SigintRunner({ workerUrl: null });
    assert.equal(r.available, false);
    const x = keyed(2);
    const m = await r.run('measure', x, RATE);
    assert.ok(m.centre && Math.abs(m.centre.value - 1000) < 2, `centre ${m.centre && m.centre.value}`);
    const d = await r.run('decode', x, RATE);
    assert.ok(Array.isArray(d) && d.length >= 8, 'decode returns one entry per decoder');
    assert.deepEqual(d.map((e) => e.name), ['MORSE', 'RTTY', 'SELCALL', 'SAME / EAS', 'TIME CODE (WWV/WWVH)', 'SSTV', 'POCSAG', 'ALE (MIL-STD-188-141)']);
    for (const e of d) assert.ok(e.ok === true || typeof e.reason === 'string', e.name + ' neither decoded nor said why');
  },

  async function aDeadWorkerDegradesToRunningInPlace() {
    // Two construction failures and the runner stops trying. A panel that works
    // slowly beats a panel that does not work.
    const calls = [];
    class Dead {
      constructor(url) { calls.push(url); setTimeout(() => this.onerror && this.onerror({ message: 'no script' }), 0); }
      postMessage() { /* never answers */ }
      terminate() {}
    }
    const prior = globalThis.Worker;
    globalThis.Worker = Dead;
    try {
      const r = new SigintRunner({ workerUrl: 'about:blank' });
      assert.equal(r.available, true, 'it should try the worker first');
      const x = keyed(1.2);
      const first = await r.run('measure', x, RATE);
      assert.ok(first && first.centre, 'the first failure still returns an answer');
      assert.equal(r.failures >= 1, true);
      await r.run('measure', x, RATE);
      assert.equal(r.available, false, 'after two deaths it stops trying');
      const third = await r.run('measure', x, RATE);
      assert.ok(third && third.centre, 'and keeps answering in place');
      assert.equal(calls.length, 2, 'it did not keep spawning workers after giving up');
    } finally {
      if (prior === undefined) delete globalThis.Worker; else globalThis.Worker = prior;
    }
  },

  async function theJobIsSentByTransferSoTheCallerMustHandOverACopy() {
    const sent = [];
    class Recorder {
      postMessage(msg, transfer) {
        sent.push({ msg, transfer });
        setTimeout(() => this.onmessage({ data: { type: 'done', job: msg.job, result: { ok: true } } }), 0);
      }
      terminate() {}
    }
    const prior = globalThis.Worker;
    globalThis.Worker = Recorder;
    try {
      const r = new SigintRunner({ workerUrl: 'about:blank' });
      const x = keyed(0.5);
      const before = x[100];
      const out = await r.run('measure', x, RATE);
      assert.deepEqual(out, { ok: true });
      assert.equal(sent.length, 1);
      assert.ok(sent[0].transfer && sent[0].transfer.length === 1, 'the buffer is transferred, not copied twice');
      // The caller's array is untouched: the runner copies before transferring,
      // which is what stops a detached view taking the page's audio with it.
      assert.equal(x[100], before);
      assert.equal(x.byteLength > 0, true);
      r.terminate();
    } finally {
      if (prior === undefined) delete globalThis.Worker; else globalThis.Worker = prior;
    }
  },

  async function theWorkerAndTheInPlacePathGiveTheSameAnswer() {
    // Not a trivial assertion: they share runTask precisely so that they
    // cannot drift, and this is what would fail if someone forked them.
    const x = keyed(2);
    const direct = runTask('measure', x.slice(), RATE, {});
    const viaRunner = await new SigintRunner({ workerUrl: null }).run('measure', x.slice(), RATE);
    assert.equal(direct.centre.value, viaRunner.centre.value);
    assert.equal(direct.snr.value, viaRunner.snr.value);
  },

  async function theTwoStationTaskCarriesItsStation() {
    const r = new SigintRunner({ workerUrl: null });
    // Two minutes of hiss is not two time stations, and the refusal must name
    // what was missing rather than return a number.
    const out = await r.run('tdoa', white(RATE * 130, { sigma: 0.05, seed: 9 }), RATE, { station: WWV_WWVH });
    assert.equal(out.ok, false);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 10, out.reason);
  },
];
