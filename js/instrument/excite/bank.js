// A bank of second-order resonators, one per mode, driven by an excitation
// signal. Each resonator's frequency may follow its own amplitude through the
// card's nonlinearity law, which is why this exists alongside the closed form.

/**
 * y_i[n] = 2 r cos(ω) y_i[n-1] - r² y_i[n-2] + g_i x[n], r = exp(-1/(τ sr)),
 * g_i = amp_i · sin(ω) so a unit impulse rings at amp_i. With a nonlinearity
 * entry, ω follows f_i + hzPerAmp · A_i where A_i is the resonator's own
 * envelope (peak follower, 5 ms release), refreshed every 64 samples.
 */
export function runBank(modes, excitation, sampleRate, { nonlinearity = null, gain = 1 } = {}) {
  const n = excitation.length, out = new Float32Array(n);
  const law = new Map((nonlinearity || []).map((L) => [L.mode, L.hzPerAmp]));
  modes.forEach((m, index) => {
    if (!(m.freqHz > 0) || !(m.tauSec > 0) || !(m.amp > 0)) return;
    const r = Math.exp(-1 / (m.tauSec * sampleRate)), r2 = r * r;
    const k = law.get(index) || 0;
    const w0 = 2 * Math.PI * m.freqHz / sampleRate;
    let a1 = 2 * r * Math.cos(w0), g = m.amp * Math.sin(w0) * gain;
    let y1 = 0, y2 = 0, env = 0;
    const envDecay = Math.exp(-1 / (0.005 * sampleRate));
    for (let i = 0; i < n; i++) {
      if (k !== 0 && (i & 63) === 0) {
        const w = 2 * Math.PI * Math.max(1, m.freqHz + k * env) / sampleRate;
        a1 = 2 * r * Math.cos(w); g = m.amp * Math.sin(w) * gain;
      }
      const y = a1 * y1 - r2 * y2 + g * excitation[i];
      y2 = y1; y1 = y;
      const ay = Math.abs(y); env = ay > env ? ay : env * envDecay;
      out[i] += y;
    }
  });
  return out;
}
