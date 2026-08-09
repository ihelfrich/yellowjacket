# CONTRACT-SEMANTIC-TAKE — transcript becomes a scene instrument

Binding for the first Semantic Take vertical slice. This is one complete
workflow, not a claim that Yellowjacket is already a DAW, Descript replacement,
or autonomous composer.

## 1. The product promise

A source phrase can become a repeatable musical performance without destroying
the transcript edit or consuming one of Machine's eight drum voices.

The user workflow is:

1. Load a recording. Yellowjacket hashes its encoded bytes locally.
2. Select transcript words or a time span in Loom.
3. Choose a Studio gesture, capture one bar from WIRE MIDI, or use the
   deterministic starter gesture, and `WEAVE`.
4. Audition the resulting immutable plan and `ARM TO SCENE`.
5. Press Machine `RUN`. The take plays as a ninth, scene-local lane beside all
   eight Machine tracks. Bypass it, trim its gain, or trace any event.
6. Press `PRINT 24-BIT`. Yellowjacket downloads the audio and its provenance as
   one ZIP.

This eliminates the intervening export, hand-slicing, DAW re-import, manual
tempo alignment, sacrificed drum pad, and separately maintained cue sheet. A
source change does not erase an armed plan: the plan remains inspectable but is
offline until the matching source is restored.

## 2. State: immutable plan, mutable scene reference

The persisted relationship is deliberately small:

```js
project.loom = {
  weaveCount,
  activePlanId,
  plans: { [planId]: LoomPlan },
  plan, // compatibility alias only
};

scene.loomLane = {
  planId,
  enabled,
  gainDb,
  pan,
  repeatSteps,
  startStep,
};
```

A `LoomPlan` is JSON-only, addressed by SHA-256 over its canonical musical and
provenance content, and immutable after publication.
It owns the material snapshot, gesture snapshot, stable event identities,
source ranges, and transforms. Changing material or gesture creates another
plan; it never rewrites a plan already referenced by a scene. `activePlanId` is
the Loom editor cursor. `scene.loomLane.planId` is the performance authority.

The lane owns arrangement choices only. It never copies source PCM and never
owns a second event list. Source audio remains a runtime asset (and in the
normal `.yjkt` source payload); the plan stores provenance, not audio. A missing
plan reference or disabled lane compiles to silence without changing Machine's
event or duck streams.

## 3. One performance compiler, one clock

`js/performance/compile.js` is the pure join between the existing Machine
compiler and the active scene's Loom lane. It has no DOM, Web Audio, MIDI, or
mutable scheduler state.

- `compilePerformanceWindow()` preserves `compileWindow()` output and adds the
  semantic stream. Machine timing remains canonical.
- A plan event's `gridStep` (falling back to `stepIndex`) is resolved against
  the destination scene's BPM and swing. Saved Loom seconds do not become a
  second transport. The authored source range and playback-rate transform stay
  intact.
- `repeatSteps` and `startStep` are step-domain arrangement controls. Occurrence
  IDs and ordering are stable, including across repeated cycles.
- Windows are half-open: `[fromSec, toSec)`. Adjacent scheduler passes may
  neither omit nor double-trigger an onset at their seam.
- Machine live playback compiles both streams from the same transport anchor.
  Loom's audition engine is not started in parallel with Machine.
- `compilePerformanceRender()` uses the same event rules offline. It preserves
  `machineTotalSec`, while `totalSec` extends through any semantic source tail.
  No extra repeat may begin at or beyond the requested Machine boundary merely
  to fill that tail.

Both live and offline semantic voices pass through
`js/loom/schedule.js`: the same source offset/span, playback rate, gain, pan,
and edge fade are scheduled from the same compiled event.

## 4. SHA-256 is the source boundary

The identity of a source is `sha256:<64 lowercase hex characters>` over the
encoded bytes loaded by the user. It is computed locally with Web Crypto before
a source becomes eligible for semantic lineage. A filename, byte count,
transcript text, decoded PCM checksum, object identity, or runtime generation
counter is not a substitute.

Every newly armable Semantic Take must carry that identity in `plan.source`.
Playback and print require the current source to match it exactly. Name and size
remain useful labels and diagnostics, but never prove identity. If SHA-256 is
unavailable, source loading must report an identity fault rather than publish an
untraceable plan. If the hash differs, the plan and trace remain available while
audio scheduling and print remain unavailable.

The canonical SHA-256 `plan.id` provides collision-resistant plan/event
addressing; it is still not the source proof. The plan digest identifies the
recipe, while `plan.source.sha256` identifies the encoded recording. These two
identities must not be conflated. Restored stale IDs are recomputed, and a
hashless legacy source remains inspectable but offline until it is rebound.

## 5. Live/offline parity and the print artifact

Parity means the compiled musical decisions match: event IDs and order, onset
times, source regions, rates, gains, pans, repetition, and lineage. It also means
both paths use the same semantic voice scheduler. This boundary ends before the
master/output environment.

It does **not** promise bit-identical live capture and offline render. Live audio
uses the browser's real-time context and output device; print uses an
`OfflineAudioContext`, a render rate at least as high as the canonical Machine
rate and loaded source rate, then Yellowjacket's offline master limiter. Browser
decoder/resampler implementations may differ.

`PRINT 24-BIT` emits `<stem>-semantic-take.zip` with exactly:

```text
<stem>-semantic-take.wav
<stem>-semantic-take.yjmap.json
```

The WAV is stereo, 24-bit PCM, and includes the active scene's eight Machine
tracks plus its armed semantic lane. The `.yjmap.json` sidecar is versioned and
contains render/sample facts, scene ID/index, BPM, swing, seed, loop count,
Machine and tail-extended durations, plan/compiler identity, source SHA-256,
gesture, and every compiled semantic event's complete lineage. `renderedAt`
records the print operation, so ZIP bytes themselves are not a determinism
oracle; the compiled event stream is.

## 6. Honest OP-Z and WIRE scope

OP-Z/WIRE integration in this slice means clock and touch:

- incoming USB MIDI notes and learned note/CC mappings can trigger or control
  the existing Machine surface;
- Loom can capture one bar from the selected WIRE input. The first note starts
  the bar; note, channel, velocity, note-off gate, raw timestamp, and selected
  input ID enter the immutable gesture. Note-off bounds the audible source span;
  fractional `gridStep` retains as-played timing on Machine's compiler clock.
  The input identity, BPM, and swing are latched for the bar, and a port change
  cancels the take. An OP-Z may be that standard MIDI input;
- MIDI clock can be measured and adopted, and clock/transport output can make
  connected hardware follow Machine;
- the existing OP-1/OP-Z drum-patch `.aif` export remains a separate Machine-kit
  path.

There is no Loom-to-MIDI **output** stream compiler, Standard MIDI File export,
or semantic-note transmission to an OP-Z here. Capture is MIDI input, not a
claim that the OP-Z receives or renders the ninth audio lane. Do not describe
clock sync, hardware pad control, or drum-patch export as that capability.

## 7. Fidelity: what may and may not be claimed

The semantic lane plays the decoded source buffer directly; it does not bake
another intermediate clip. Source boundaries are sample-addressed by Web Audio,
an edge fade prevents clicks, and playback rates are bounded to `0.5..2.0`.
Deterministic overlap analysis applies conservative lane headroom, with a
default lane trim of -9 dB and a semantic peak budget of 0.9 before the master.
Offline print applies the shared limiter with a declared -0.3 dBTP ceiling and
reports peak/clipping statistics in the map only after that limiter succeeds.
Limiter failure aborts the print; it must never silently emit an unlimited WAV
with a false ceiling claim. The rendered duration includes complete Machine
voice/Space tails and semantic events already started inside the requested
cycles, plus their scheduler stop pads. It compiles no new occurrence after the
Machine grid ends; `machineDurationSec`, `renderDurationSec`, and
`tailDurationSec` make that boundary explicit in the map.

These are preservation and accountability claims, not source enhancement.
Twenty-four-bit output does not recover detail absent from the input. Changing
`AudioBufferSourceNode.playbackRate` couples pitch and duration; this slice has
no formant-preserving semantic time-stretch. The semantic lane is dry apart from
its event gain, pan, edge fade, and offline master stage; it does not inherit a
Machine track's insert chain or Space sends. Live monitor fidelity remains
bounded by the browser, audio interface, device sample rate, and loaded source.
The limiter ceiling is not a substitute for a certified mastering or loudness
delivery pass.

## 8. Regression invariants

The following are release blockers:

1. With no valid enabled lane, performance compilation is deeply neutral to
   the existing Machine event and duck streams.
2. Object and `Map` plan registries compile the same stable events.
3. Adjacent half-open windows equal the same whole window with no seam duplicate.
4. Destination BPM/swing retarget grid onsets; repetition stays step-locked and
   deterministic across runs.
5. Every semantic occurrence has a stable ID and complete plan, scene, source,
   gesture, transform, and source-range trace.
6. Overlapping and long-tailed material always produces finite gain and obeys
   the semantic peak budget.
7. Window and render compilers produce the same in-bound semantic onset stream;
   render extends through tails without starting an out-of-bound cycle.
8. Live and offline scheduling consume the same compiled semantic fields and
   direct source buffer.
9. A source-hash mismatch cannot sound or print, while its immutable plan and
   trace survive save/restore.
10. A print is 24-bit stereo WAV plus a versioned `.yjmap.json` in one ZIP, and
    the map's event lineage agrees with the rendered compiler output.
11. The same raw one-bar MIDI capture produces the same content-addressed
    gesture; raw onset, fractional grid position, velocity, channel, and
    note-off duration survive, while onsets at or beyond the bar are rejected.

Canonical owners: state and lane defaults live in `js/app/project-store.js`;
round-trip behavior in `js/app/persist.js`; plan/provenance rules in
`js/loom/compile.js`; raw MIDI adaptation in `js/loom/capture.js`; the
performance join in `js/performance/compile.js`;
semantic voice scheduling in `js/loom/schedule.js`; live/offline orchestration
and lineage in `js/machine/sequencer.js`; packaging in
`js/machine/controller.js`; source hashing in `js/app/fingerprint.js`; and
hardware scope in `js/app/wire-controller.js` and `docs/CONTRACT-WIRE.md`.
