// Constellation: project harvested slices into two dimensions by timbre, so a
// kit can be SEEN. Similar sounds land near each other, so redundancy in a kit
// is visible rather than something you discover by auditioning 24 slices.
//
// Pure, node-testable. PCA by power iteration with deflation: eight features
// and a couple of dozen points, so the covariance matrix is 8x8 and the whole
// thing costs microseconds. No dependency, no approximation worth naming.

const DIMS = 8;
const POWER_ITERS = 200;
const CONVERGE = 1e-10;

// Features live on wildly different scales (dB in the tens, ratios in [0,1],
// centroid in thousands of Hz). Without standardising, the centroid alone would
// dictate both axes.
export function standardize(rows) {
  const n = rows.length;
  const d = rows[0] ? rows[0].length : 0;
  const mean = new Float64Array(d);
  const sd = new Float64Array(d);
  for (const row of rows) {
    for (let j = 0; j < d; j++) mean[j] += row[j];
  }
  for (let j = 0; j < d; j++) mean[j] /= n || 1;
  for (const row of rows) {
    for (let j = 0; j < d; j++) {
      const dev = row[j] - mean[j];
      sd[j] += dev * dev;
    }
  }
  for (let j = 0; j < d; j++) {
    sd[j] = Math.sqrt(sd[j] / Math.max(1, n - 1));
    if (!(sd[j] > 1e-12)) sd[j] = 1;   // a constant feature contributes nothing
  }
  return rows.map((row) => {
    const out = new Float64Array(d);
    for (let j = 0; j < d; j++) out[j] = (row[j] - mean[j]) / sd[j];
    return out;
  });
}

function covariance(rows) {
  const n = rows.length;
  const d = rows[0] ? rows[0].length : 0;
  const cov = [];
  for (let i = 0; i < d; i++) cov.push(new Float64Array(d));
  for (const row of rows) {
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) cov[i][j] += row[i] * row[j];
    }
  }
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      cov[i][j] /= denom;
      cov[j][i] = cov[i][j];
    }
  }
  return cov;
}

function topEigenvector(cov, d, seed) {
  let v = new Float64Array(d);
  // Deterministic start: a fixed pattern, not random, so two runs agree.
  for (let i = 0; i < d; i++) v[i] = Math.sin(seed * (i + 1)) + 0.5;
  let norm = Math.hypot(...v) || 1;
  for (let i = 0; i < d; i++) v[i] /= norm;
  let value = 0;
  for (let iter = 0; iter < POWER_ITERS; iter++) {
    const next = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      for (let j = 0; j < d; j++) acc += cov[i][j] * v[j];
      next[i] = acc;
    }
    norm = Math.hypot(...next);
    if (!(norm > 1e-300)) return { vector: v, value: 0 };
    for (let i = 0; i < d; i++) next[i] /= norm;
    let delta = 0;
    for (let i = 0; i < d; i++) delta += Math.abs(next[i] - v[i]);
    v = next;
    value = norm;
    if (delta < CONVERGE) break;
  }
  return { vector: v, value };
}

function deflate(cov, d, vec, value) {
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) cov[i][j] -= value * vec[i] * vec[j];
  }
}

// vectors: array of equal-length numeric arrays (the eight harvest features).
// Returns { points: [{x, y}] } with x and y each scaled into [-1, 1], plus the
// share of variance the two axes actually explain, so the UI can be honest
// when a projection is not telling you much.
export function project2d(vectors) {
  const rows = (vectors || []).filter((v) => v && v.length);
  if (rows.length < 2) {
    return { points: rows.map(() => ({ x: 0, y: 0 })), explained: 0, axes: null };
  }
  const d = rows[0].length;
  const z = standardize(rows);
  const cov = covariance(z);
  let trace = 0;
  for (let i = 0; i < d; i++) trace += cov[i][i];

  const first = topEigenvector(cov, d, 1);
  deflate(cov, d, first.vector, first.value);
  const second = topEigenvector(cov, d, 2);

  const xs = [];
  const ys = [];
  for (const row of z) {
    let x = 0;
    let y = 0;
    for (let j = 0; j < d; j++) {
      x += row[j] * first.vector[j];
      y += row[j] * second.vector[j];
    }
    xs.push(x);
    ys.push(y);
  }
  const span = (arr) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of arr) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const half = Math.max(1e-9, (hi - lo) / 2);
    const mid = (hi + lo) / 2;
    return (v) => (v - mid) / half;
  };
  const sx = span(xs);
  const sy = span(ys);
  return {
    points: xs.map((x, i) => ({ x: sx(x), y: sy(ys[i]) })),
    explained: trace > 0 ? (first.value + second.value) / trace : 0,
    axes: { first: Array.from(first.vector), second: Array.from(second.vector) },
  };
}

// Which feature dominates each axis, so the plot can be labelled with
// something meaningful instead of "PC1".
export const FEATURE_NAMES = Object.freeze([
  'ATTACK', 'SUSTAIN', 'LOW', 'MID', 'HIGH', 'BRIGHT', 'NOISY', 'PITCHED',
]);

export function axisLabel(vector) {
  if (!vector || !vector.length) return '?';
  let best = 0;
  for (let i = 1; i < vector.length; i++) {
    if (Math.abs(vector[i]) > Math.abs(vector[best])) best = i;
  }
  const name = FEATURE_NAMES[best] || ('F' + best);
  return (vector[best] < 0 ? '-' : '+') + name;
}

export { DIMS };
