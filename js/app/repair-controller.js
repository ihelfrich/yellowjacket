// Spectral repair controller: owns the repair stack and the rebuild. Repairs are
// parametric and non-destructive — every rebuild starts from the captured original
// PCM and applies enabled entries in order through the worker. Edits are
// length-preserving, so words, clips, cuts, and the beatmap stay valid throughout.

import { buildPeakPyramid } from '../render/peaks.js';
import { mixdownMono } from '../audio-engine.js';

const PAD_SEC = 0.6;          // context frames + window each side of a region
const PREVIEW_PAD_SEC = 0.15; // audition a little around the region

let repairSeq = 0;

export function initRepairController(ctx) {
  const { store, engine, views, $, COPY, status, statusFault } = ctx;
  const { waveMini, waveMain, spec, sliceView, repairPanel } = views;
  const R = store.runtime;

  let worker = null;
  let building = false;
  let pendingRebuild = false;
  let selection = null;

  function ensureWorker() {
    if (!worker) {
      worker = new Worker(new URL('../../workers/repair-worker.js', import.meta.url), { type: 'module' });
    }
    return worker;
  }

  // One handler for the life of the worker, dispatching by job id. Replacing
  // onmessage per call meant the two callers of this worker (PREVIEW and the
  // rebuild that follows APPLY) could not both be in flight: whichever asked
  // last owned the next reply, so a preview during a rebuild resolved with the
  // rebuild's audio and left `building` true forever, wedging the panel busy.
  let repairJobSeq = 0;
  const repairJobs = new Map();

  function runWorker(channels, sampleRate, regions) {
    const w = ensureWorker();
    if (!w.onmessage) {
      w.onmessage = (e) => {
        const msg = e.data || {};
        const job = repairJobs.get(msg.job);
        if (!job) return;
        repairJobs.delete(msg.job);
        if (msg.type === 'done') job.resolve(msg.channels);
        else if (msg.type === 'error') job.reject(new Error(msg.message));
      };
      // An error event carries no job id, so it fails everything outstanding
      // rather than leaving whichever job it belonged to hanging.
      w.onerror = (e) => {
        const err = new Error(e.message || 'repair worker error');
        for (const [, job] of repairJobs) job.reject(err);
        repairJobs.clear();
      };
    }
    const id = ++repairJobSeq;
    return new Promise((resolve, reject) => {
      repairJobs.set(id, { resolve, reject });
      w.postMessage({ type: 'repair', job: id, channels, sampleRate, regions },
        channels.map((c) => c.buffer));
    });
  }

  function captureOriginal() {
    if (R.original || !R.buffer) return;
    R.original = { buffer: R.buffer, mono: R.mono };
  }

  function spanFor(repair, sampleRate, length) {
    const s = Math.max(0, Math.floor((Math.min(repair.t0, repair.t1) - PAD_SEC) * sampleRate));
    const e = Math.min(length, Math.ceil((Math.max(repair.t0, repair.t1) + PAD_SEC) * sampleRate));
    return { s, e };
  }

  async function rebuild() {
    if (building) { pendingRebuild = true; return; }
    building = true;
    if (repairPanel) repairPanel.setBusy(true);
    try {
      captureOriginal();
      if (!R.original) return;
      const src = R.original.buffer;
      const sampleRate = src.sampleRate;
      const enabled = R.repairs.filter((r) => r.enabled);

      if (!enabled.length) {
        // Identity restore: the literal original objects come back.
        R.buffer = R.original.buffer;
        R.mono = R.original.mono;
      } else {
        // Point the runtime at the original before allocating, so the previous
        // repaired pair is collectable during the rebuild instead of adding a
        // third full buffer to the peak.
        R.buffer = R.original.buffer;
        R.mono = R.original.mono;
        const out = new AudioBuffer({
          length: src.length,
          numberOfChannels: src.numberOfChannels,
          sampleRate,
        });
        for (let c = 0; c < src.numberOfChannels; c++) {
          out.getChannelData(c).set(src.getChannelData(c));
        }
        // Apply each enabled repair to its padded span; later repairs read the
        // output of earlier ones, matching the stack's visual order.
        for (const repair of enabled) {
          const { s, e } = spanFor(repair, sampleRate, src.length);
          if (e - s < 8192) continue;
          const spans = [];
          for (let c = 0; c < out.numberOfChannels; c++) {
            spans.push(out.getChannelData(c).slice(s, e));
          }
          const done = await runWorker(spans, sampleRate, [{
            t0: Math.min(repair.t0, repair.t1) - s / sampleRate,
            t1: Math.max(repair.t0, repair.t1) - s / sampleRate,
            f0: repair.f0,
            f1: repair.f1,
            strength: repair.strength,
          }]);
          for (let c = 0; c < out.numberOfChannels; c++) {
            out.getChannelData(c).set(done[c], s);
          }
        }
        R.buffer = out;
        R.mono = mixdownMono(out);
      }

      // Swap everything downstream; length is identical so state stays valid.
      engine.adoptBuffer(R.buffer, R.mono);
      R.peaks = buildPeakPyramid(R.mono);
      waveMini.setBuffer(R.mono, sampleRate, R.peaks);
      waveMain.setBuffer(R.mono, sampleRate, R.peaks);
      sliceView.setSource(R.mono, sampleRate, R.peaks);
      sliceView.setClips(store.project.clips);
      if (store.project.words) sliceView.setWords(store.project.words);
      if (R.analysis) sliceView.setAnalysis(R.analysis);
      spec.compute(R.mono, sampleRate).then(() => spec.render()).catch(() => {});
      const active = enabled.length;
      status(active ? 'REPAIR APPLIED · ' + active + ' ACTIVE' : 'REPAIRS CLEARED · ORIGINAL RESTORED');
      store.update('repairs', () => {});
    } catch (err) {
      statusFault('REPAIR FAULT · ' + (err.message || err));
    } finally {
      building = false;
      if (repairPanel) repairPanel.setBusy(false);
      if (repairPanel) repairPanel.setRepairs(R.repairs);
      if (spec.setRepairs) spec.setRepairs(R.repairs, null);
      if (pendingRebuild) { pendingRebuild = false; rebuild(); }
    }
  }

  function labelFor(region) {
    const span = Math.abs(region.t1 - region.t0);
    const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v));
    return 'R' + (++repairSeq) + ' · ' + span.toFixed(2) + 's · ' + fmtHz(Math.min(region.f0, region.f1)) + '-' + fmtHz(Math.max(region.f0, region.f1));
  }

  function addRepair(region, strength) {
    if (!R.buffer || !region) return;
    R.repairs.push({
      id: 'rp' + repairSeq,
      t0: Math.min(region.t0, region.t1),
      t1: Math.max(region.t0, region.t1),
      f0: Math.min(region.f0, region.f1),
      f1: Math.max(region.f0, region.f1),
      strength,
      enabled: true,
      label: labelFor(region),
    });
    selection = null;
    if (spec.setRegion) spec.setRegion(null);
    if (repairPanel) repairPanel.setSelection(null);
    rebuild();
  }

  async function previewRepair(region, strength) {
    if (!R.buffer || !region || (!engine.ctx && !engine.transport)) {
      if (!engine.ctx) statusFault('Play something once first — the audio engine wakes on a gesture.');
      return;
    }
    try {
      captureOriginal();
      const sampleRate = R.buffer.sampleRate;
      const t0 = Math.min(region.t0, region.t1);
      const t1 = Math.max(region.t0, region.t1);
      const s = Math.max(0, Math.floor((t0 - PAD_SEC) * sampleRate));
      const e = Math.min(R.buffer.length, Math.ceil((t1 + PAD_SEC) * sampleRate));
      const spans = [];
      for (let c = 0; c < R.buffer.numberOfChannels; c++) {
        spans.push(R.buffer.getChannelData(c).slice(s, e));
      }
      const done = await runWorker(spans, sampleRate, [{
        t0: t0 - s / sampleRate, t1: t1 - s / sampleRate,
        f0: region.f0, f1: region.f1, strength,
      }]);
      // Audition just around the region.
      const a = Math.max(0, Math.floor((t0 - PREVIEW_PAD_SEC) * sampleRate) - s);
      const b = Math.min(done[0].length, Math.ceil((t1 + PREVIEW_PAD_SEC) * sampleRate) - s);
      engine.audition(done.map((ch) => ch.subarray(a, b)), { sampleRate });
      status('PREVIEW · ' + (b - a > 0 ? ((b - a) / sampleRate).toFixed(2) : '0') + 's REPAIRED');
    } catch (err) {
      statusFault('PREVIEW FAULT · ' + (err.message || err));
    }
  }

  // ---------- panel wiring ----------
  if (repairPanel) {
    repairPanel.addEventListener('apply', (e) => addRepair(e.detail.region, e.detail.strength));
    repairPanel.addEventListener('preview', (e) => previewRepair(e.detail.region, e.detail.strength));
    repairPanel.addEventListener('toggle', (e) => {
      const r = R.repairs.find((x) => x.id === e.detail.id);
      if (r) { r.enabled = e.detail.enabled; rebuild(); }
    });
    repairPanel.addEventListener('remove', (e) => {
      R.repairs = R.repairs.filter((x) => x.id !== e.detail.id);
      rebuild();
    });
    repairPanel.addEventListener('hover', (e) => {
      if (spec.setRepairs) spec.setRepairs(R.repairs, e.detail.id);
    });
    repairPanel.addEventListener('harmonics', (e) => {
      const { region, count } = e.detail;
      const f0 = Math.min(region.f0, region.f1);
      const f1 = Math.max(region.f0, region.f1);
      const nyquist = (R.buffer ? R.buffer.sampleRate : 48000) / 2;
      for (let k = 2; k <= count; k++) {
        if (k * f0 >= nyquist) break;
        R.repairs.push({
          id: 'rp' + (++repairSeq),
          t0: Math.min(region.t0, region.t1),
          t1: Math.max(region.t0, region.t1),
          f0: k * f0,
          f1: Math.min(nyquist, k * f1),
          strength: e.detail.strength ?? 0.6,
          enabled: true,
          label: 'R' + repairSeq + ' · x' + k + ' harmonic',
        });
      }
      rebuild();
    });
  }

  if (spec.addEventListener) {
    spec.addEventListener('regionselect', (e) => {
      selection = e.detail;
      if (repairPanel) repairPanel.setSelection(selection);
    });
  }

  function resetForSource() {
    R.repairs = [];
    R.original = null;
    selection = null;
    if (repairPanel) {
      repairPanel.setSelection(null);
      repairPanel.setRepairs([]);
    }
    if (spec.setRepairs) spec.setRepairs([], null);
  }

  // RESUME hands back repairs with saved 'rpN' ids while repairSeq restarts at
  // zero; sync the counter and relight the panel/overlays in one place. addRepair
  // mints id 'rp'+repairSeq BEFORE labelFor increments, so id N means the counter
  // must resume at N+1 or the next repair collides with a restored one.
  function repairsRestored() {
    for (const r of R.repairs) {
      const m = /^rp(\d+)$/.exec(r.id || '');
      if (m) repairSeq = Math.max(repairSeq, Number(m[1]) + 1);
    }
    if (repairPanel) repairPanel.setRepairs(R.repairs);
    if (spec.setRepairs) spec.setRepairs(R.repairs, null);
  }

  ctx.api.repairReset = resetForSource;
  ctx.api.addRepair = addRepair;
  ctx.api.repairRebuild = rebuild;
  ctx.api.repairsRestored = repairsRestored;
}


