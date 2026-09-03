// One transport rule for five sound sources. The header button and Space
// mean "stop whatever is sounding"; only when nothing is do they start the
// bench. Before this, they knew about the bench alone: with the MACHINE
// running after QUICK TAKE the header still read PLAY, and pressing it
// started the song on top of stopping the machine — "I can't stop it".

export const SOURCE_ORDER = Object.freeze(['bench', 'machine', 'loom', 'studio', 'audition']);
const NAMES = Object.freeze({
  bench: 'THE BENCH', machine: 'THE MACHINE', loom: 'THE LOOM AUDITION', studio: 'THE STUDIO', audition: 'THE CLIP',
});

// state: {bench, machine, loom, studio, audition} booleans → sounding names, in order.
export function soundingSources(state) {
  const s = state && typeof state === 'object' ? state : {};
  return SOURCE_ORDER.filter((k) => !!s[k]);
}

// On-screen names for the sounding readout beside PLAY.
export const SHORT = Object.freeze({ bench: 'BENCH', machine: 'MACHINE', loom: 'LOOM', studio: 'STUDIO', audition: 'CLIP' });

export function transportLabel(sources) {
  return sources && sources.length ? 'STOP' : 'PLAY';
}

export function transportTitle(sources, hasSource = true) {
  if (sources && sources.length) {
    return 'Stop ' + sources.map((k) => NAMES[k] || k).join(' and ').toLowerCase() + ' (Space)';
  }
  return hasSource ? 'Play the bench (Space)' : 'Load audio to play';
}
