# DRUMS contract

Factory drums are ordinary Machine instruments. This contract exists to keep
their sound, timing, persistence, and hardware output from becoming four subtly
different implementations.

## 1. One canonical sound

- A factory voice is synthesized deterministically from a versioned model,
  parameters, and seed. It never depends on `Math.random`, the loaded source,
  the device sample rate, or an encoded sample file.
- Nonlinear synthesis runs at 384 kHz (4×), using Float64 state and integrated
  oscillator phase. The existing Kaiser-windowed sinc converter produces the
  final mono Float32 asset at exactly 96 kHz.
- The 96 kHz PCM is the canonical instrument. Live audition, pattern playback,
  song playback, project persistence, and offline bounce all consume those same
  bytes. There is no lower-quality preview renderer.
- Factory voices have calibrated role-specific levels and explicit headroom.
  They are not independently peak-normalized. Every result is finite, declicked,
  DC-controlled, and bounded by its declared ceiling.
- A browser may monitor through a 44.1 or 48 kHz AudioContext. The UI reports
  that real device rate. “96 kHz” describes the canonical asset and offline
  render target, not a claim that the sound card was reconfigured.

## 2. One canonical performance

- Drums use the existing Machine tracks, `compileWindow`, `compileRender`, and
  `compileSong`. Live and offline playback never walk a second drum timeline.
- Groove takes are deterministic functions of kit id, groove id, and variation.
  Structural anchors stay fixed; only authored ghost notes, velocities, pitch,
  ratchets, and probabilities may vary.
- Closed and open hats share `chokeGroup: 1`. A group fades the previous member
  with the same declick used by mono-track choke. The group survives save/load
  and applies through the shared live/offline scheduler.
- The long 808 voice is a pitched instrument: Machine voice tune and per-step
  pitch locks are the public tuning model. No hidden bass sequencer exists.

## 3. Installation and state

- `LOAD SOUNDS` replaces sample, voice, and mix state for all eight active-scene
  tracks while preserving every step and lock.
- `LOAD + GROOVE` does the same and visibly replaces the active scene's pattern.
  One user action is one `store.update`, one autosave observation, and one undo.
- Every installed voice is an ordinary asset with engine/model/seed/parameter
  provenance. PCM persists in `.yjkt` and OPFS through the existing sample path.
- Kit/groove/variation metadata is UI provenance only. Audio playback never
  regenerates from metadata during restore.
- Replaced, unreferenced factory assets are pruned. Assets still referenced by
  another scene remain intact.

## 4. Fidelity and export boundaries

- Editable Web Audio drive stages request `WaveShaperNode.oversample = '4x'` in
  the shared live/offline graph. Unsupported browsers may ignore that hint; the
  canonical factory PCM is already anti-aliased before it reaches the graph.
- Machine FREEZE and SONG choose the highest active sample rate, so a factory
  kit renders at 96 kHz. The existing 4× true-peak-aware master limiter owns the
  final -0.3 dBTP ceiling. A print extends past the musical grid only long enough
  to finish already-started voices and enabled Space tails (delay to the declared
  -80 dB amplitude floor); limiter failure aborts export rather than silently
  emitting an unlimited file.
- OP-Z and OP-1 drum patches require 44.1 kHz. Active-kit export folds each voice
  to mono, converts once through the Kaiser resampler, and hands the results to
  the existing AIFF patch writer. The UI names that conversion explicitly.
- Imported and harvested samples keep their true rate and bandwidth. Factory
  fidelity labels must never be applied to user audio merely because it shares
  a Machine scene.

## 5. Regression gates

Tests must pin manifest shape, deterministic PCM, exact frame/rate contracts,
finite output, endpoint fades, DC and peak bounds, meaningful band energy,
groove determinism and isolation, persistence of drum metadata/choke groups,
and successful compilation of every starter groove. Browser verification must
cover both load modes, a new take, all eight pads, RUN, 96 kHz offline render,
undo/redo, reload persistence, and active-kit hardware print without console
errors.
