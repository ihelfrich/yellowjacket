export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
}
// E12 method on an output signal: Hann 65536 FFT; worst component outside +-6 bins of the tone.
// Tones are snapped to bin centres so scalloping and leakage do not pollute the reading.
export function measure(out, rateOut, toneHz, skip = 512) {
  const N = 65536, binHz = rateOut / N, toneBin = Math.round(toneHz / binHz);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = out[skip + i] * w; }
  fft(re, im);
  const mag = new Float64Array(N / 2); for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  let peak = 0; for (let i = toneBin - 6; i <= toneBin + 6; i++) peak = Math.max(peak, mag[i]);
  let worst = 0, where = 0;
  for (let i = 1; i < N / 2; i++) { if (Math.abs(i - toneBin) <= 6) continue; if (mag[i] > worst) { worst = mag[i]; where = i; } }
  return { levelDb: 20 * Math.log10(peak / (N / 4)), imageDb: 20 * Math.log10(worst / peak), imageHz: where * binHz, toneHz: toneBin * binHz };
}
export function snap(toneHz, rateOut) { const binHz = rateOut / 65536; return Math.round(toneHz / binHz) * binHz; }
export function tone(hz, rate, seconds) { const n = Math.round(rate * seconds), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * hz * i / rate); return x; }
