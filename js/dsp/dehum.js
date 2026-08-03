// De-hum: series notch biquads at the mains fundamental and its harmonics.

const defaults = {
  base: 60,
  harmonics: 4
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key) {
  const raw = cfg?.params?.[key] ?? cfg?.[key] ?? defaults[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaults[key];
}

export function buildDehum(ctx, cfg = {}) {
  const base = clamp(configValue(cfg, 'base'), 50, 60);
  const harmonics = Math.round(clamp(configValue(cfg, 'harmonics'), 1, 8));
  const nyquist = ctx.sampleRate / 2;

  const notches = [];
  for (let k = 1; k <= harmonics; k++) {
    const freq = base * k;
    if (freq >= nyquist * 0.95) break;
    const n = ctx.createBiquadFilter();
    n.type = 'notch';
    n.frequency.value = freq;
    n.Q.value = 30;
    if (notches.length) notches[notches.length - 1].connect(n);
    notches.push(n);
  }

  if (!notches.length) {
    // Degenerate sample rate: nothing to notch, pass through.
    const g = ctx.createGain();
    return { input: g, output: g };
  }

  return { input: notches[0], output: notches[notches.length - 1] };
}

export const dehum = {
  id: 'dehum',
  title: 'DE-HUM',
  tagline: 'Mains buzz and its overtones.',
  kind: 'nodes',
  defaults,
  params: [
    { key: 'base', label: 'MAINS', unit: 'Hz', min: 50, max: 60, step: 10, def: 60 },
    { key: 'harmonics', label: 'HARMONICS', unit: '', min: 1, max: 8, step: 1, def: 4 }
  ],
  build: buildDehum
};


export { dehum as descriptor };
