// EQ (4 fixed-role bands) plus the standalone high-pass rack module.
// Both are kind:'nodes' — built as BiquadFilterNode chains inside renderChain's
// OfflineAudioContext pass.

const eqDefaults = {
  lsFreq: 200,
  lsGain: 0,
  p1Freq: 800,
  p1Gain: 0,
  p2Freq: 3000,
  p2Gain: 0,
  hsFreq: 8000,
  hsGain: 0
};

const highpassDefaults = {
  freq: 80
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key, defaults) {
  const raw = cfg?.params?.[key] ?? cfg?.[key] ?? defaults[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaults[key];
}

export function buildEq(ctx, cfg = {}) {
  const nyquist = ctx.sampleRate / 2;
  const cap = (f) => Math.min(f, nyquist * 0.95);

  const ls = ctx.createBiquadFilter();
  ls.type = 'lowshelf';
  ls.frequency.value = cap(clamp(configValue(cfg, 'lsFreq', eqDefaults), 60, 500));
  ls.gain.value = clamp(configValue(cfg, 'lsGain', eqDefaults), -12, 12);

  const p1 = ctx.createBiquadFilter();
  p1.type = 'peaking';
  p1.frequency.value = cap(clamp(configValue(cfg, 'p1Freq', eqDefaults), 200, 2000));
  p1.gain.value = clamp(configValue(cfg, 'p1Gain', eqDefaults), -12, 12);
  p1.Q.value = 1.0;

  const p2 = ctx.createBiquadFilter();
  p2.type = 'peaking';
  p2.frequency.value = cap(clamp(configValue(cfg, 'p2Freq', eqDefaults), 1000, 8000));
  p2.gain.value = clamp(configValue(cfg, 'p2Gain', eqDefaults), -12, 12);
  p2.Q.value = 1.0;

  const hs = ctx.createBiquadFilter();
  hs.type = 'highshelf';
  hs.frequency.value = cap(clamp(configValue(cfg, 'hsFreq', eqDefaults), 4000, 12000));
  hs.gain.value = clamp(configValue(cfg, 'hsGain', eqDefaults), -12, 12);

  ls.connect(p1);
  p1.connect(p2);
  p2.connect(hs);
  return { input: ls, output: hs };
}

export function buildHighpass(ctx, cfg = {}) {
  const nyquist = ctx.sampleRate / 2;
  const freq = Math.min(
    clamp(configValue(cfg, 'freq', highpassDefaults), 20, 300),
    nyquist * 0.95
  );

  // Two cascaded 2nd-order highpass sections, Butterworth Q per section.
  const a = ctx.createBiquadFilter();
  a.type = 'highpass';
  a.frequency.value = freq;
  a.Q.value = 0.7071;

  const b = ctx.createBiquadFilter();
  b.type = 'highpass';
  b.frequency.value = freq;
  b.Q.value = 0.7071;

  a.connect(b);
  return { input: a, output: b };
}

export const eq = {
  id: 'eq',
  title: 'EQ',
  tagline: 'Four bands, fixed Q. Shape the voice.',
  kind: 'nodes',
  defaults: eqDefaults,
  params: [
    { key: 'lsFreq', label: 'LOW SHELF', unit: 'Hz', min: 60, max: 500, step: 5, def: 200 },
    { key: 'lsGain', label: 'LS GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'p1Freq', label: 'PEAK 1', unit: 'Hz', min: 200, max: 2000, step: 10, def: 800 },
    { key: 'p1Gain', label: 'P1 GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'p2Freq', label: 'PEAK 2', unit: 'Hz', min: 1000, max: 8000, step: 50, def: 3000 },
    { key: 'p2Gain', label: 'P2 GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 },
    { key: 'hsFreq', label: 'HIGH SHELF', unit: 'Hz', min: 4000, max: 12000, step: 100, def: 8000 },
    { key: 'hsGain', label: 'HS GAIN', unit: 'dB', min: -12, max: 12, step: 0.5, def: 0 }
  ],
  build: buildEq
};

export const highpassDesc = {
  id: 'highpass',
  title: 'HIGH-PASS',
  tagline: 'Rumble and desk thumps. Cut at the corner.',
  kind: 'nodes',
  defaults: highpassDefaults,
  params: [
    { key: 'freq', label: 'CORNER', unit: 'Hz', min: 20, max: 300, step: 5, def: 80 }
  ],
  build: buildHighpass
};

export default eq;

export { eq as descriptor };
