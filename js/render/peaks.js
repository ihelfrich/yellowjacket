// Yellowjacket — shared min/max peak pyramid for waveform-style views.
// One immutable pyramid per source replaces the per-view builders that used
// to live in waveform.js and machine/slice-ui.js; every view queries the same
// structure instead of re-scanning all samples. Pure math, worker-safe, no DOM.
//
// PeakPyramid layout:
//   {
//     mono:   Float32Array,   // the source samples, referenced (never copied)
//     length: number,         // mono.length
//     levels: [               // fine -> coarse, one entry per block size
//       { block: 64,   min: Float32Array, max: Float32Array },
//       { block: 512,  min: Float32Array, max: Float32Array },
//       { block: 4096, min: Float32Array, max: Float32Array },
//     ],
//   }
// levels[k].min[i] / levels[k].max[i] hold the min/max of mono over the sample
// range [i * block, min((i + 1) * block, length)); each level therefore has
// ceil(length / block) blocks. Coarser levels are folded 8:1 from the finer
// ones, so building costs one full sample scan plus ~1.6% overhead.

const BLOCKS = [64, 512, 4096];

export function buildPeakPyramid(mono) {
  const d = mono || new Float32Array(0);
  const n = d.length;
  const levels = [];

  // level 0: direct scan of the samples
  const block0 = BLOCKS[0];
  const count0 = Math.ceil(n / block0);
  const min0 = new Float32Array(count0);
  const max0 = new Float32Array(count0);
  for (let i = 0; i < count0; i++) {
    const s = i * block0;
    const e = Math.min(s + block0, n);
    let mn = d[s], mx = d[s];
    for (let j = s + 1; j < e; j++) {
      const v = d[j];
      if (v < mn) mn = v; else if (v > mx) mx = v;
    }
    min0[i] = mn;
    max0[i] = mx;
  }
  levels.push({ block: block0, min: min0, max: max0 });

  // coarser levels fold the previous one
  for (let k = 1; k < BLOCKS.length; k++) {
    const prev = levels[k - 1];
    const f = BLOCKS[k] / BLOCKS[k - 1];
    const count = Math.ceil(prev.min.length / f);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = i * f;
      const e = Math.min(s + f, prev.min.length);
      let mn = prev.min[s], mx = prev.max[s];
      for (let j = s + 1; j < e; j++) {
        if (prev.min[j] < mn) mn = prev.min[j];
        if (prev.max[j] > mx) mx = prev.max[j];
      }
      min[i] = mn;
      max[i] = mx;
    }
    levels.push({ block: BLOCKS[k], min, max });
  }

  return { mono: d, length: n, levels };
}

// Fills outMin/outMax with one min/max pair per column for the sample span
// [startSample, endSample). Fractional sample positions are accepted (views
// pass viewSeconds * sampleRate directly). Chooses the coarsest pyramid level
// whose blocks still land at least once per column; below the level-0 block
// size it falls back to a direct sample scan. Block lookups round the column
// range outward to block boundaries, matching the previous per-view behavior.
// Allocation-free when out arrays are provided; when they are omitted, arrays
// are allocated and returned as { min, max } for convenience.
export function queryPeaks(pyramid, startSample, endSample, columns, outMin, outMax) {
  const mins = outMin || new Float32Array(columns);
  const maxs = outMax || new Float32Array(columns);
  const d = pyramid.mono;
  const n = pyramid.length;
  const spp = (endSample - startSample) / columns;

  let level = null;
  for (let k = pyramid.levels.length - 1; k >= 0; k--) {
    if (spp >= pyramid.levels[k].block) { level = pyramid.levels[k]; break; }
  }

  for (let x = 0; x < columns; x++) {
    let a = Math.floor(startSample + x * spp);
    let b = Math.floor(startSample + (x + 1) * spp);
    if (b <= a) b = a + 1;
    if (a < 0) a = 0;
    if (b > n) b = n;
    if (a >= b) { mins[x] = 0; maxs[x] = 0; continue; }
    let mn, mx;
    if (level) {
      const block = level.block;
      const i0 = Math.floor(a / block);
      const i1 = Math.min(level.min.length, Math.ceil(b / block));
      mn = Infinity;
      mx = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (level.min[i] < mn) mn = level.min[i];
        if (level.max[i] > mx) mx = level.max[i];
      }
      if (mn === Infinity) { mn = 0; mx = 0; }
    } else {
      mn = d[a];
      mx = d[a];
      for (let i = a + 1; i < b; i++) {
        const v = d[i];
        if (v < mn) mn = v; else if (v > mx) mx = v;
      }
    }
    mins[x] = mn;
    maxs[x] = mx;
  }

  return { min: mins, max: maxs };
}
