// Compressor: DynamicsCompressorNode plus auto-makeup gain stage.

const defaults = {
  threshold: -24,
  ratio: 3,
  attack: 0.01,
  release: 0.25,
  knee: 24,
  autoMakeup: 1
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configValue(cfg, key) {
  const raw = cfg?.params?.[key] ?? cfg?.[key] ?? defaults[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaults[key];
}

export function buildCompressor(ctx, cfg = {}) {
  const threshold = clamp(configValue(cfg, 'threshold'), -60, 0);
  const ratio = clamp(configValue(cfg, 'ratio'), 1, 20);
  const attack = clamp(configValue(cfg, 'attack'), 0.001, 0.3);
  const release = clamp(configValue(cfg, 'release'), 0.05, 1);
  const knee = clamp(configValue(cfg, 'knee'), 0, 40);
  const autoMakeup = configValue(cfg, 'autoMakeup') >= 0.5;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.ratio.value = ratio;
  comp.attack.value = attack;
  comp.release.value = release;
  comp.knee.value = knee;

  // Auto-makeup: -threshold * (1 - 1/ratio) * 0.6 dB (contract formula).
  const makeupDb = autoMakeup ? -threshold * (1 - 1 / ratio) * 0.6 : 0;
  const makeup = ctx.createGain();
  makeup.gain.value = 10 ** (makeupDb / 20);

  comp.connect(makeup);
  return { input: comp, output: makeup };
}

export const compressor = {
  id: 'comp',
  title: 'COMPRESSOR',
  tagline: 'Levels the dynamics. Makeup included.',
  kind: 'nodes',
  defaults,
  params: [
    { key: 'threshold', label: 'THRESHOLD', unit: 'dB', min: -60, max: 0, step: 1, def: -24 },
    { key: 'ratio', label: 'RATIO', unit: ':1', min: 1, max: 20, step: 0.5, def: 3 },
    { key: 'attack', label: 'ATTACK', unit: 's', min: 0.001, max: 0.3, step: 0.001, def: 0.01 },
    { key: 'release', label: 'RELEASE', unit: 's', min: 0.05, max: 1, step: 0.01, def: 0.25 },
    { key: 'knee', label: 'KNEE', unit: 'dB', min: 0, max: 40, step: 1, def: 24 },
    { key: 'autoMakeup', label: 'AUTO MAKEUP', unit: '', min: 0, max: 1, step: 1, def: 1 }
  ],
  build: buildCompressor
};

export default compressor;

export { compressor as descriptor };
