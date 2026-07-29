# Yellowjacket — build contract, PERSIST slice

Extends docs/CONTRACT.md conventions (binding). This slice makes the bench remember:
everything the user has built — transcript edits, clips, rack settings, the machine's
scenes and samples, the repair stack — survives a reload, an update, a crash. One
project slot ("the bench remembers its last session"); a project browser can come
later. Storage is OPFS (supported in every current engine); autosave rides the
store's change events, which is why every mutation was routed through store.update.

Honesty rules: never auto-load on boot (surprise state is hostile) — offer RESUME /
START FRESH in the drop zone. Never let autosave block or jank the UI. If OPFS is
unavailable (private windows in some engines), the bench works exactly as today and
says nothing until the user would lose something; then one status-line note.

## Storage layout (OPFS, under directory 'yellowjacket-v1')
```
project.json          — the serializable document + parametric runtime state
source.bin            — the ORIGINAL encoded source bytes as loaded (mp3/wav/...)
samples/<assetId>.f32 — machine track samples: header-less concatenated per-channel
                        Float32 (channel count/frames/rate live in project.json)
```

## project.json shape (formatVersion 2)
```js
{
  formatVersion: 2, savedAt: epochMs, fileName,
  sourceBytes: { size },            // sanity check against source.bin
  words,                            // plain array incl. deleted/filler flags (cuts derive)
  clips,
  chain,                            // [{id, on, params}]
  machine: { activeScene, scenes: [{ id, name, bpm, swing, seed,
    tracks: [{ sampleId, steps: [64 numbers], stepData, len, gainDb, pan,
               mute, solo, duckSource, duckDb, choke }] }] },   // no PCM here
  assets: { id: { kind, label, sampleRate, frames, channelCount } },
  repairs,                          // parametric stack, tiny
  anchors,                          // beatmap anchors only; analysis re-runs on restore
}
```

## js/app/persist.js (fleet agent; the core is PURE and testable)
```js
export function serializeProject(project, runtime): { json: object, sampleFiles: [{ id, bytes: ArrayBuffer }] }
// json per the shape above; sampleFiles only for assets whose PCM is present on a
// track (dedupe by sampleId — scenes share refs). Uint8Array steps -> plain arrays.
export function applySnapshot(json, { project, runtime }): RestorePlan
// Mutates IN PLACE (the project object is never replaced — controllers hold refs):
// words/clips/chain contents, machine scenes (steps.set, stepData, mix fields,
// activeScene), runtime.repairs, and returns what the orchestrator must do:
// { fileName, needsAnalysis: bool, anchors, sampleAttachments: [{ sceneIndex,
//   trackIndex, assetId }] }  // PCM attaching happens after sample files load
export class OpfsStore {
  static async open(): OpfsStore|null        // null when OPFS is unavailable
  async writeJson(name, obj) / readJson(name)
  async writeBytes(name, arrayBuffer) / readBytes(name)   // name may contain one '/'
  async remove(name) / async wipe()
  async has(name): bool
}
```
Version guard: applySnapshot throws on unknown formatVersion (the orchestrator shows
'SAVED SESSION IS FROM A NEWER BENCH' and offers only START FRESH). Steps arrays are
clamped to 64; unknown stepData keys pass through untouched (forward tolerance).

## js/app/persist-controller.js (mine)
Autosave: on store 'change', debounce 800 ms, serialize and write project.json
(small, every time); write source.bin once per generation when runtime.sourceBytes
appears; write missing samples/<id>.f32 after machine changes. All writes awaited in
a single-flight queue (never two writers, never blocking UI). navigator.storage
.persist() requested once, result ignored. Restore: read project.json -> decode
source.bin through the normal loadArrayBuffer path -> applySnapshot -> attach sample
PCM -> refresh every surface (transcript, slice, pattern, rack, repair stack rebuild
via the repair controller) -> re-run analysis with saved anchors. RESUME/DISCARD UI
in the drop zone; DISCARD wipes the OPFS directory. Status: 'RESTORED · <name> ·
N REPAIRS · M SCENES' on success.

## source-controller (mine, one addition)
Retain the encoded bytes: loadArrayBuffer stores a copy of its input in
runtime.sourceBytes before decode (the decoder detaches its argument in some
engines, so copy first).

## Acceptance
- Harness (pure core): serialize -> applySnapshot roundtrip on a synthetic project
  with 2 scenes, stepData, repairs, clips, words: deep-equal on every serialized
  field; steps survive as Uint8Array after apply; unknown future stepData keys
  survive; formatVersion mismatch throws.
- Browser: load dirty fixture, transcribe-less flow (carve clips, assign a sample,
  program steps, add a hum repair), reload the page, RESUME: clips/pattern/sample/
  repair stack all back, repair audibly reapplied, analysis re-ran; DISCARD then
  reload shows a clean drop zone.
