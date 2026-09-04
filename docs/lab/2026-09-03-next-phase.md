# 2026-09-03 · The next phase

Written after the memory program, the fifteen-step visual pass, and the eight-step
playback-rate decision all shipped (working tree clean at `cfabe16`; `sw.js` VERSION is
`yj-v66`, not v65 — the brief for this pass was one deploy stale). This is the ordered
plan for what comes after.

## How this list was made, and what it is worth

Every candidate below survived an adversarial verification pass: a second reader tried to
refute it against the working tree, and the corrections are folded in rather than
appended. Six candidates were refuted outright and are recorded at the end so they are not
raised again. Where a claim here is **READ** it names a file and line I opened; where it is
**INFERRED** it says so. Nothing in this document was tested by running the suite.

Three biases to know about before trusting the order:

- **Fidelity outranks capability**, because that is the stated non-negotiable. Two of the
  six ship-next steps buy no new feature at all.
- **A false claim in a public document outranks a private defect.** The README and the
  in-app shelf copy carry your name during a job cycle; two of the sentences in them are
  not true today, and both fixes are minutes.
- **Cheap-and-certain is front-loaded** only where it is genuinely near-free. Step 3 is
  the largest item in the document and it sits third because it is worth it, not because
  it is easy.

Not repeated here, because it shipped today: native-rate decode, the enforced budget,
the OPFS source spill, per-job transcriber release, bounded caches, the four-channel-unit
denoise worker, the byte-quantised spectrogram, streamed WAV export, discard auto-restore,
windowed loads for the three shelf cards, the whole visual pass, and all eight playback-rate
steps.

---

# Ship next

Steps 1 and 2 together are under a day. Steps 3–6 are one focused session each, except
step 3, which is one to two.

---

## 1 · Two public claims that are not true

**What it is.** Two sentences the tool states about itself are false, and one of them is
enforced nowhere.

**(a) The shelf is not public-domain-only.** READ: `js/app/field-library.js:132` —
`{ id: 'hm01-hour', … license: 'CC BY-NC-SA', … long: { seconds: 3805, bytes: 38058848 } }`.
It is the only non-PD entry of thirty-four. Four separate statements contradict it:
`js/app/field-library.js:9-11` ("Nothing here owes attribution downstream"), `README.md:46`,
`README.md:78`, and the in-app copy at `index.html:460-464`, which says "all public domain
(CC0, PD, or old enough to be nobody's)" and links only the CC0 and PD deeds. The suite
does check licences — `test/run.mjs:1204` asserts `fieldLicenseUrl(rec.license)` resolves —
but `LICENSE_URLS` supplies a deed for BY-NC-SA, so the assertion passes. The invariant
tested is "the tag resolves", not "the shelf is public domain".

All three clauses bite. NC collides with the BSL commercial licensee, who is the only user
who ever pays. BY falsifies the manifest's own sentence for anyone who HARVESTs it. SA is
viral onto any track built from it. And the harm is silent: the app told the user it was
nobody's.

**(b) The network list omits the one host that serves executable code.** READ:
`workers/whisper-worker.js:6` — `import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';`.
READ: `README.md:20-23` enumerates the network fetches as exhaustive — the page, the
Whisper weights from Hugging Face, and archive.org — and never names jsdelivr. `rg -n
jsdelivr README.md` returns nothing. `docs/CONTRACT.md:6` does name it, so the repo knows;
the public document does not say it.

**Why for this owner.** These are the two places where the tool's central negative claim —
nothing here owes anything, nothing leaves the machine — is stated to a stranger. Both are
wrong by a word. The shelf entry was introduced *today* in `a871cbf` (the windowed-loads
commit), so this is not surviving debt; the deed URL at `field-library.js:186` shows the
tag was added deliberately, which means the manifest and the prose were written apart.

**Files.** `js/app/field-library.js`, `test/run.mjs`, `README.md`, `index.html`.

**Do this.** Drop `hm01-hour` and re-point the long-capture demonstration at
`marine-electric-sos` (CC0, 91:38) or `voyager-launch` (PD, 87:37) — READ: both already
carry `long:` (`field-library.js:138`, `:142`), and `rg -n "hm01-hour"` returns exactly one
hit in the whole repo, its own definition, so nothing references it. Then add the assertion
the suite is missing, beside `test/run.mjs:1204`:
`assert.ok(rec.license === 'CC0' || rec.license === 'PD', rec.id + ' is public domain')`.
Separately, add jsdelivr to the `README.md:20-23` clause and one sentence saying
transcription needs one online session per browser.

If you would rather keep the HM01 hour, the alternative is larger and must be complete:
surface the licence per card, and rewrite `field-library.js:9-11`, `README.md:46`,
`README.md:78`, and `index.html:460-464`. The assertion becomes "any non-PD tag also
renders an attribution string". The delete is smaller and preserves the doctrine.

**Proof.** The new assertion fails on the current manifest and passes after the edit —
that is the whole point of it. `rg -n jsdelivr README.md` returns a hit.

**Cost.** XS — one deleted object, one assertion, two prose edits. Half an hour.
**Risk.** None. Verify the archive.org item page still reads BY-NC-SA before you write the
commit message; if it was relicensed since, the tag is stale and the fix is one word, but
the internal contradiction is real either way and the assertion is worth having regardless.

---

## 2 · One Cmd-Z, one undo stack

**What it is.** Two undo stacks are bound to the same keystroke, and the transcript's wins
first and is then immediately undone by the project's.

READ: `js/transcript-ui.js:47` registers a `window` keydown listener inside the
`TranscriptView` constructor; `js/transcript-ui.js:499-505` pops the view's own snapshot
stack on Cmd/Ctrl-Z and calls only `preventDefault()`, never `stopImmediatePropagation()`.
READ: `js/main.js:478-484` registers a second `window` keydown listener that calls
`ctx.api.undo()` with no guard for the transcript and no check of `defaultPrevented`. READ:
the view is constructed at `js/main.js:196`, ~280 lines before the global handler is
attached, so the transcript listener runs first. READ: words are `<button>` elements
(`js/transcript-ui.js:230`), so `main.js`'s contenteditable/textarea target guard does not
exclude them.

INFERRED (not executed): `_undoPop` dispatches `beforeedit`, which
`js/app/bench-controller.js:305-309` turns into `store.update('transcript-edit', …)`, which
pushes a snapshot and clears `_future` (`js/app/project-store.js:225-229`). So one Cmd-Z
restores the words, pushes the pre-restore document, and pops it straight back. The symptom
is not permanent — `store.undo` → `relightAll` → `wordsRestored` → `setWords` clears
`this._undo` (`js/transcript-ui.js:62`), so the *second* press works. The user-visible
behaviour is "undo takes two presses, the first does nothing", plus a phantom redo entry.

The worse case: `_onKey` has no active-bench guard. Cmd-Z pressed on MACHINE after an
earlier transcript delete pops the transcript's stack invisibly, pushes a snapshot of the
current document, and the global undo pops that same snapshot — the MACHINE edit is not
undone and the transcript silently mutates. That is a wrong-undo, not a dead one.

**Why for this owner.** Deleting words is the interaction the README leads with
(`README.md:130-136`, "the Descript part"). The codebase already knows this guard exists:
`js/machine/keybed.js:61` bails on any modifier, and `js/main.js:461` comments that a
focused button owns Space "otherwise TAP TEMPO would double-fire" — the same class of bug,
guarded there and not here.

**Files.** `js/transcript-ui.js`, `js/main.js`, `test/run.mjs`.

**Do this.** Delete the view's private undo stack and its Cmd-Z branch. All five
`_pushUndo` sites (`js/transcript-ui.js:129, 144, 157, 333, 344`) already emit `beforeedit`,
so the store's granularity is 1:1 and the global Cmd-Z covers gap-cut pills too. State the
one cost in the commit: `UNDO_CAP` is 100 (`js/transcript-ui.js:10`) while `historyLimit`
is 60 (`js/app/project-store.js:182`) and is shared across benches, so deep transcript undo
shortens from 100 transcript steps to 60 project steps.

**Proof.** A test that fires one synthetic Cmd-Z after a deletion and asserts the words end
up restored and `store.canRedo === true`.

**Cost.** XS — delete a branch and a field, add one test. **Risk.** Low.

---

## 3 · Serialise the transport lifecycle

**What it is.** Two fast SPEED clicks can leave the transport at the wrong rate and orphan
an AudioContext, hours after the transport work shipped.

READ: `js/audio-engine.js:186-220` — `_ensureTransport` is unserialised. READ:
`js/audio-engine.js:229` — `_closeTransport` sets `this._transport = null` *before* awaiting
`close()` behind the 2 s race at `:236-241`. So a call entering during that suspension reads
`cur = null` at `:189`, skips both close guards, opens `new Ctx({ sampleRate: want })` at
`:202` and assigns at `:215`; the first call then resumes, opens its own context and
overwrites. The **first** (stale) click wins the final transport and the second click's
context is orphaned. READ: `setRate` writes `this._rate = f` synchronously at `:390` before
awaiting at `:393`, so `_rate` and `transport.rate` end up from different clicks. READ: the
call site is fire-and-forget with no re-entry guard (`js/app/bench-controller.js:862`,
handler `:908-912`).

Three things make it worse than it looks. Reaching ¼× *requires* two clicks —
`SPEED_FACTORS = [1, 2, 4]` (`js/dsp/varispeed.js:14`) and the handler cycles — so the racing
gesture is the only way to use the feature. The orphaned context is rooted, not merely
uncollected: `js/meters.js:18` keys `_taps` by context and `:90` prunes only when
`ctx.state === 'closed'`, which never happens for a context nobody closes. And it breaks a
documented invariant: `docs/lab/2026-09-03-playback-rate-decision.md:385` promises "at most
two live contexts"; two racing clicks give three, against Safari's cap of four.

A second door, same class: READ `js/audio-engine.js:250` — `clear()` calls
`this._closeTransport('clear')` **without awaiting it**, then redundantly re-nulls
`_transport` at `:251`. `js/app/source-controller.js:190` calls `engine.clear()`, so a
`clear()` followed by a `load()` (which awaits `_ensureTransport`) can open a new context
while the previous close is in flight.

**Why for this owner.** SLOW is the marquee found-sound feature, its correctness claim is
"computed playback rate is exactly 1", and the whole of this morning's work exists to
establish it. The 4→1 ordering leaves `_rate = 1` on a 24 kHz transport with a 96 kHz
buffer — four times fast, two octaves up. The readout meanwhile prints an arithmetically
inconsistent pair (`SLOW ¼× · TRANSPORT 24 kHz` on a 48 kHz file) without flagging a fault.

**Files.** `js/audio-engine.js`, `js/app/bench-controller.js`, `test/run.mjs`.

**Do this.** Three changes, all small:
1. Keep a `this._transportOp` promise in the engine and chain every `_ensureTransport` onto
   it, so a close always completes before the next open.
2. Add a generation guard inside `setRate`: capture `f`, and after the await
   `if (this._rate !== f) return;` before `if (wasPlaying) this.play(...)` at `:395`.
   Chaining alone does not cover this — the losing call still reaches `play()` reading the
   newer `_rate` against its own older transport.
3. `await this._closeTransport('clear')` in `clear()` (make it async or return the promise),
   and drop the redundant re-null at `:251`.
Belt and braces at the call site: disable `btnSpeed` until `engine.setRate` settles. That
one line covers case 2 more completely than the promise chain does.

**Proof.** The suite's SLOW test awaits every `setRate` in sequence
(`test/run.mjs:1111-1124`) and so cannot see this. Add a case that fires two `setRate` calls
*without* awaiting and asserts (a) the final `transportReport.got` equals the last requested
rate and (b) the FakeAudioContext's open count minus close count is 1. Note
`docs/lab/2026-09-03-playback-rate-decision.md:379` already lists that fake as extended for
step 3, so the harness exists.

**Cost.** Half a day with the test. **Risk.** Medium — it touches the transport lifecycle
steps 3–7 shipped this morning. The one thing not settleable by reading is how wide the
window is in practice: it equals `AudioContext.close()` latency, capped at 2 s, and the
synchronous `bandLevelDb` tail in `setSpeed` may usually close it on Chromium. That is a
measurement (a two-click burst with a timestamped `transportReport` log), not a code read.

---

## 4 · One bake path for pitched voices — the last interpolator, and pitch without time

**This is the largest step in the document. One to two focused sessions, and the only one
with a genuine cache redesign in it.**

**What it is.** Two things that look separate and are the same job.

**(a) The fidelity half, already queued by your own log.** READ: `js/machine/sequencer.js:999`
— `src.playbackRate.value = event.rate || 1;` — and READ: `js/machine/compile.js:203` —
`const rate = Math.pow(2, (pitch + p.voicePitch) / 12);`. Track buffers are built at the
context rate (READ: `createTrackBuffer`, `js/machine/sequencer.js:1197-1229`), so every
MACHINE pitch lock is Chromium's linear interpolator. Measured this morning:
`docs/lab/2026-09-03-memory-scout.md:505-512` — a synthetic snare pitched up a fifth carries
**−28.1 dB** of error energy against the correctly-resampled signal (max abs 0.029), a
sustained 9 kHz tone −29.5 dB. The log's own words at `:513-517`: "the fix is the same trick,
but it needs a bounded per-pitch buffer cache … Deliberately not started on a hunch — queued
for the ranked plan." This is the ranked plan.

**(b) The capability half.** Every *sample* voice's pitch is playbackRate, so there is no
transposition that preserves length. `docs/CONTRACT-CONFORM.md:59-63` documents it
explicitly ("a fitted slice pitched +7 plays faster than its fit"). That is true of a
hardware sampler, and it is also the reason the found-sound workflow breaks at step three:
harvest a phrase, conform it to the bar (CONFORM ships), then move it into the key of what
you are building — and the third step undoes the second. (Narrow the claim carefully: STUDIO's
six melodic parts pitch by oscillator frequency, `js/studio/engine.js:107-108`, and the
factory drum synth by frequency envelope, `js/machine/kits.js:35,47,51`. It is the sample
voices — MACHINE voice, step lock, LOOM semantic take — that are varispeed-only.)

**Why they are one job.** The mechanism for (a) is already in the repo and was proved this
morning. READ: `js/loom/excerpt.js:42` — `excerptRateFor(outRate, pitchRatio)`. A source
node's real ratio is `playbackRate × (bufferRate / contextRate)`; tag the buffer at
`contextRate / pitchRatio` and the two cancel, so the Kaiser that built the buffer does the
shift. E12f measured a +4-semitone note going from −42.2 dB to **−66.6 dB**, which is what a
directly generated tone measures. Applying the same trick per pitch to MACHINE track buffers
requires a per-pitch cache — and once a per-pitch bake exists, `pitchMode: 'key'` is a target
length on the bake that already runs: bake the trimmed span to `sliceSec × 2^(n/12)` (or, when
FIT is on, to `fitSec × 2^(n/12)`) with `stretchSamples`, then let the varispeed shortening
cancel it. Both halves need the same cache and the same hot path. Opening that path twice is
the waste.

**Why for this owner.** (a) is the last measured interpolation defect in the monitoring path,
on the bench whose README now states its fidelity path by path. (b) is the single largest
musical gap: every OP-XY-class box the VISION benchmarks against transposes without retiming,
and the sample-flipping demand signal VISION cites (Serato Sample, Koala) is built on it.

**Files.** `js/machine/sequencer.js`, `js/machine/compile.js`, `js/loom/excerpt.js` (reuse),
`js/dsp/stretch.js` (reuse), `js/machine/voice-ui.js`, `docs/CONTRACT-CONFORM.md`, `test/run.mjs`.

**Do this, in this order — (a) alone is shippable and should be committed first.**

1. **Per-pitch buffer, playbackRate 1.** In `trackBuffer`/`songBuffer`, key the cache on
   `(sample, reversed, pitchRatio)` and build the buffer at
   `excerptRateFor(ctx.sampleRate, rate)` via the existing Kaiser (`PLAYBACK_CUTOFF_SCALE`).
   `scheduleEvent` keeps `src.playbackRate.value = rate` and the two cancel to within a few
   ppm, exactly as the semantic lane does. Reuse `MIN_BUFFER_RATE`/`MAX_BUFFER_RATE`
   (`js/loom/excerpt.js:29-30`, 3000/384000) and fall back to today's path outside them.
2. **Bound the cache.** READ: `js/machine/sequencer.js:171` — `cached.fitted.clear()`, one
   fitted buffer per track, a bound deliberately shipped today (ledger 4B rank 31). A per-pitch
   map thrashes it to a zero hit rate. Replace with an LRU of N distinct pitches per track
   (N = 4 is a defensible start) plus the unpitched buffer, and assert the bound in a test.
3. **Prebake.** READ: `js/machine/sequencer.js:190-215` — `prebake` already warms mismatched
   tracks before transport starts. Extend it to walk each track's distinct step-lock pitches.
   This is not optional: the bake is ~37–61 ms for stretch (`sequencer.js:1139-1141`) plus
   ~66 ms per 2 s mono for the resampler (`playback-rate-decision.md:53`), so a 2 s stereo
   slice is roughly 200–260 ms per distinct pitch.
4. **Then, and only then, `pitchMode`.** Add one voice field, `'speed' | 'key'`, defaulting to
   `'speed'` so every existing project and the golden pattern fixture stay byte-identical.
   When `'key'`, the compiler emits `event.pitchSemis` alongside the rate and the bake targets
   the compensated length. Offline print shares the bake, as CONFORM already requires.
   Amend `docs/CONTRACT-CONFORM.md:59-63` — the current sentence becomes the description of
   the default mode, not of the tool.

**Three costs to write down before starting, all verified.**

- **Kernel cache growth.** READ: `js/dsp/resample.js:23-42` — `kernelCache` holds a
  `HALF_WIDTH * PHASES + 1 = 81,921`-entry Float64Array (655 KB) per distinct cutoff, with no
  eviction. Cutoff is `cutoffScale × min(inRate, outRate) / inRate`, so it is constant whenever
  the target rate exceeds the sample rate (all downward pitch, and upward pitch until the
  cancelling rate falls below the sample's) and distinct per semitone below that. Worst case
  is several MB, directly against today's bounded-cache doctrine. Cap the cache or quantise
  the cutoff.
- **Rate ceiling.** Voice pitch is ±24 (`js/machine/compile.js:36`) and lock pitch ±12
  (`:200`), so the combined ratio spans 0.125 to 8. On a 96 kHz device the cancelling rate
  spans 12 kHz to 768 kHz — and 768 kHz is **double** `MAX_BUFFER_RATE`. The clamp is not
  cosmetic; below it, the note must fall back to today's interpolated path and the readout
  should say so rather than pitching wrong.
- **Stretch clamp.** READ: `js/dsp/stretch.js:31-32` — `MIN_RATIO 0.25`, `MAX_RATIO 4`, which
  is exactly ±24 semitones with zero headroom. `pitchMode: 'key'` composed with FIT needs a
  stated precedence and clamp policy in the contract before code.

**Proof.** (a) is a number you already have: rebuild the scout's fixture — a synthetic snare
(noise burst + 180 Hz body, 50 ms decay) pitched up a fifth — and assert the error energy
against the correctly-resampled reference drops from −28.1 dB to the analysis floor. (b) is
neutrality plus length: the golden pattern fixture is byte-identical with `pitchMode` at its
default, and a fitted slice at `pitchMode: 'key'` pitched +7 renders to the same frame count
as the same slice at +0. Plus a cache-bound assertion after cycling six pitches.

**Risk.** Medium. It touches the step scheduler's hot path and redesigns a cache that was
deliberately bounded this morning. The neutrality half is enforceable by the golden fixture,
which is why `'speed'` must stay the default: `README.md:274-285` sells varispeed pitch as
the aesthetic ("a pitched-down vocal tail becomes a bass"), so `'key'` ships opt-in.

---

## 5 · Channel-linked tonal stretch

**What it is.** CONFORM stretches stereo by running each channel through the phase vocoder
independently, which decorrelates diffuse stereo material.

READ: `js/dsp/stretch.js:62` — `stretchSamples(samples, ratio, sampleRate, opts)` takes one
Float32Array; nothing in the module is channel-aware. READ: the only caller,
`js/machine/sequencer.js:1177-1180`, loops `for (const channel of channels) { … out.push(stretchSamples(src, …)) }`.
Inside, the tonal path integrates phase per channel from its own peak set
(`js/dsp/stretch.js:376-401`).

**Measured** (the verifier ran the module directly in node — pure ES module, no suite):

| material | metric | before | after (ratio 1.7) |
|---|---|---|---|
| identical L=R (negative control) | coherence | 1.0000 | **1.0000**, side/mid −338 dB |
| amplitude-panned harmonic (Goldbergs) | coherence | 0.9340 | 0.9322 |
| **diffuse (common source + per-channel room)** | coherence | 0.8373 | **0.0333** |
| **diffuse** | side/mid | −12.49 dB | **−0.05 dB** |
| stereo snare + room tail, tonal path | max xcorr | 0.943 | 0.244 (r1.5) |

Side energy equal to mid means the field is not shifted, it is gone.

**Two things this corrects in the original report.** The percussive/WSOLA half is
**empirically refuted** — measured inter-channel lag stayed within ±0.21 ms at ratios
1.3/1.5/2.0/3.0 even on heavily decorrelated percussion, because `bestOffset` seeds offset 0
as the incumbent and ties keep it (`js/dsp/stretch.js:139-142` and its own comment at
`:136-138`). `SEARCH_SEC` is a bound, not a behaviour. Leave WSOLA alone. And "randomises the
stereo image" is too broad: gain-panned harmonic material is essentially untouched. The
mechanism that breaks is narrower — for owned bins the code applies a pure rotation
`R(p) = synPhase[p] − anaPhase[p]`, which preserves inter-channel phase exactly whenever both
channels agree on the peak set and on `advance[]`. They agree for identical, panned and
steady-harmonic content; they diverge for diffuse content, where per-channel
instantaneous-frequency estimates differ and `R(p)` random-walks apart.

**Why for this owner.** `stretchMode` routes CRASH, FX, VOX, BASS and TONE — five of the eight
harvest roles — to the tonal path (`js/dsp/stretch.js:35, 57-61`), and diffuse stereo is
exactly what the FIELD drawer is: wave crashes, songbirds, room tone, 78 surface noise. It is
a silent fidelity loss in the one DSP stage that touches musical material, on a bench that
measures true peak to BS.1770-5 and models Chromium's resampler to −94.9 dB.

**Scope honestly.** `stretchSamples` has exactly one caller, reached only through
`createFittedBuffer`, reached only when `voice.fitSteps > 0` — default 0, OFF. Several sample
paths are already mono before they arrive (CRATE persists `channels[0]` only; factory kits,
modal and tone samples are mono). Stereo reaches the stretcher only from a fresh HARVEST or
assign cut off the loaded source. So this bites the "cut a wave crash off THE SHELF and set
FIT" workflow — real, and not universal.

**Files.** `js/dsp/stretch.js`, `js/machine/sequencer.js`, `docs/CONTRACT-CONFORM.md`,
`test/run.mjs`.

**Do this.** Add `stretchChannels(channels, ratio, sampleRate, opts)` and change only the
tonal engine. By linearity `FFT(mid) = (FFT(L) + FFT(R)) / 2`, so peaks and `advance[]` can be
computed on the summed spectrum with **no extra transform**: hoist peak-picking and the
advance computation above the channel loop and apply the one rotation to every channel. Keep
`stretchSamples` as the mono entry point so the existing tests stand. `docs/CONTRACT-CONFORM.md:18`
fixes the API as mono and is silent on channels, so it needs an amendment either way.

**Proof — and this is the part the obvious test gets wrong.** "Stretch a correlated stereo
pair and assert coherence survives" **passes on today's code** (1.0000 identical, 0.932
panned). The regression fixture must be a *diffuse* pair — common source plus per-channel
decorrelated room — asserting coherence and side/mid survive. Mono output must stay
bit-identical to protect the existing fixtures.

**Cost.** Medium, ~120 lines touched, no new algorithm. **Risk.** Medium — it changes the
output of every fitted stereo slice, so the CONFORM fixtures need rebaselining. Verify by
measurement, not by ear.

**One thing it settles for free.** Ledger 4A row 16 ("mono slices for harvest-seated drum
tracks", 3.7 MB, gated on "audible check on stereo material") proposes the opposite
direction. The measurements above settle that gate: WSOLA is channel-safe, so row 16 buys
3.7 MB by discarding a stereo field the stretcher was not damaging. Decide the two together.

**Two adjacent things noticed and not fixed here**, worth their own look rather than
scope creep: `detectOnsets` (`js/dsp/stretch.js:163-208`) also runs per channel, so L and R
can restart the WSOLA grid at different anchors (untested, not refuted — every fixture had a
strong common transient); and the tonal path's edge reflection (`:321-324`) reflects each
channel independently, the most likely seed of the steady-tone phase collapse measured at
1.0 rad → 0.5 rad.

---

## 6 · The controller-seam pass, and the three tests that would have caught it

**What it is.** Four async seams in the app controllers where a long job outlives the state
it was started against, plus the test-shape reason none of them is visible to a green suite.
Each sub-item is independently committable; ship them in this order.

**(a) A repair rebuild in flight when a new file loads writes the OLD recording's audio over
the new one — and cements it.** READ: `rebuild()` (`js/app/repair-controller.js:77`) captures
`const src = R.original.buffer` at `:84`, then awaits the worker once per enabled repair at
`:115`. `grep -n generation js/app/repair-controller.js` returns nothing. Meanwhile a new load
calls `ctx.api.repairReset()` (`js/app/source-controller.js:142`), which sets `R.repairs = []`
and `R.original = null` (`:252-254`), while `store.update('source', …)` bumps `r.generation`
and installs the new buffer. When the awaited reply lands, the continuation unconditionally
writes `R.buffer = out` (`:126`), `engine.adoptBuffer` (`:131`), rebuilds peaks, pushes the
stale PCM into three views, kicks a fresh `spec.compute`, and `store.update('repairs', …)`
schedules an autosave of the mismatch.

Worse than "one bad frame": `resetForSource` set `R.original = null` and the stale
continuation never restores it, so the **next** repair on file B runs `captureOriginal()`
against the now-stale `R.buffer` and cements file A's audio as file B's non-destructive
baseline for the rest of the session. `adoptBuffer` is documented as "only for length-identical
replacements" (`js/audio-engine.js:264-265`); across a source swap the lengths differ, so the
engine's cuts, `_position` and segment map go invalid too.

The race needs at least one *enabled* repair — the identity-restore branch (`:88-91`) is
synchronous. The widest window is the `harmonics` handler, which pushes up to `count` repairs
and makes rebuild issue one sequential worker round-trip per repair: seconds, not
milliseconds. Reachability is confirmed, not hypothetical: `repairPanel.setBusy` disables only
the APPLY button, while `openFile` stays wired to a live file input and a window-level drop
handler.

*Fix.* Take `const gen = R.generation` at the top of `rebuild()`, re-check immediately after
the awaited `runWorker` and again before the downstream swap at `:126`, bailing out of the
continuation on mismatch; do the same in `previewRepair` before `engine.audition` (`:201`).
The `finally` at `:146-151` must **not** fire the queued `rebuild()` across a generation
change, or the queued rebuild does the poisoned capture itself. Every other long job in the
app already has this guard (`bench-controller.js:268` and `:702`,
`machine/controller.js:1016`, `source-controller.js:254`) — this one call site lacks it.
Note this only *reads* `R.generation`; the visual plan's rejection of
`feedback-cancel-on-working-button` (`docs/lab/2026-09-03-visual-plan.md:758-763`) was about
*bumping* it, which re-stamps persist's saved generation. Different hazard.

**(b) The render's Δ LU is measured against a cached source loudness whose key cannot see a
repair being bypassed.** READ: `js/app/bench-controller.js:692-697` —
`const beforeKey = gen + ':' + ((R.repairs && R.repairs.length) || 0);` with the comment at
`:692` asserting "(repairs re-key it)". READ: the repair panel's `toggle` handler flips
`r.enabled` and rebuilds without changing the array length
(`js/app/repair-controller.js:212-215`), and that rebuild swaps `R.buffer` between the literal
original and a freshly repaired copy. `R.generation` is not bumped by a rebuild. So: add a
repair, render, bypass it, render again — the second render's `before` is the repaired
buffer's loudness while `R.buffer` is now the original, and `$('roDelta')` is wrong by the
difference. `beforeCache` occurs at only four lines in the whole tree
(`bench-controller.js:23, 694, 695, 697`); nothing else invalidates it.

Honest about magnitude: `roDelta` prints `toFixed(1)`, and a spot repair moves gated
integrated LUFS by hundredths of a dB, so this is a latent wrong measurement rather than one
that routinely shows a bad figure. It matters because the code comment states an invariant
the key does not implement, on the readout that says what the render did to the level.

*Fix.* The identity-restore branch returns the literal original objects
(`js/app/repair-controller.js:88-91`), so a buffer-identity check works with no new counter:
`beforeKey = gen + ':' + (R.buffer === (R.original && R.original.buffer) ? 'orig' : repairRevision)`.
If holding that reference is a memory concern after today, increment an `R.repairRevision`
counter in `rebuild()`'s success path instead.

**(c) DISCARD stays clickable during a restore, and a wipe landing mid-restore orphans the
saved session silently.** READ: `restore()` disables only `btnResume`
(`js/app/persist-controller.js:430-431`); `btnDiscard` is never disabled and the RESUME panel
stays visible until `:496`. READ: `discard()` (`:521-537`) checks neither `restoring` nor
`saving` before `await opfs.wipe()`, which removes the directory recursively **and re-points
`this._dir` to a fresh one** (`js/app/persist.js:611`) — which is why every write after the
wipe succeeds and the failure is silent rather than a loud fault. If the wipe lands around the
sample reads, tracks are silently emptied; then `if (hasSource) bytesGeneration = R.generation;`
(`:494`) marks the current generation as already written when `source.bin` no longer exists,
so `saveNow` skips the source write from then on while `project.json` still claims
`sourceBytes.size > 0`. On the next boot the panel never appears again.

Two things the original report missed. `discard()` **is** behind a `window.confirm`
(`:522-526`), so this is a missing *state* interlock, not a missing user interlock. And the
user who asked to throw the session away is then told `RESTORED · …` (`:507`, after
discard's `:533`) — the durable harm is that everything they do from that point silently
fails to persist.

*Fix.* Refuse `discard()` while `restoring || saving` and disable `btnDiscard` alongside
`btnResume` for the life of `restore()`. Independently — and this is the half to ship if only
one ships — make `bytesGeneration = R.generation` at `:494` conditional on
`await opfs.has('source.bin')`, so a vanished source is rewritten by the next autosave
instead of skipped forever. The `saving` path self-heals (discard sets
`bytesGeneration = -1`); only the restore path is durable.

**(d) `boot()` swallows every fault while reading the saved session, then arms the autosave
that overwrites it.** READ: the entire read-and-offer block
(`js/app/persist-controller.js:133-169`) sits inside `} catch (e) { /* unreadable save: leave
the panel hidden */ }` at `:170`; immediately afterwards, outside the try,
`store.addEventListener('change', scheduleSave)` and `scheduleSave()` arm the autosave. It is
the only swallowed fault in a file that surfaces six others (AUTOSAVE FAULT `:217`, PROJECT
SAVE `:242`, PROJECT OPEN `:251, :263, :302`, RESTORE `:510`, DISCARD `:535`).

Scoped honestly: the app cannot truncate its own `project.json` — `writeBytes` uses
`createWritable()` with default swap-file semantics, so a killed tab leaves the previous file
whole. The realistic triggers are a transient OPFS read fault (both `has()` and `readBytes`
rethrow anything that is not NotFoundError/TypeMismatchError), an externally corrupted file,
or a TypeError inside the panel builder on a structurally odd save (`scenes.filter` at `:138`
is unguarded).

*Fix.* Split the catch: `readJson` returning null / `has()` false stays silent; anything else
becomes `statusFault('SAVED SESSION UNREADABLE · …')`. Add the cheap reversible half —
rename `project.json` to `project.broken.json` before the first overwrite. **Do not** ship the
autosave-suppression half here: `scheduleSave` at `:178` never consults `restoreFailed`, so
suppression is a change to the single-slot project model and a larger edit than it looks.

**(e) The transcript undo, if step 2 has not already shipped.**

**Why the suite is green through all of this.** The regex-on-source assertions cover exactly
these controller paths and cannot see behaviour. `repairRebuildReleasesThePreviousPairFirst`
(`test/run.mjs:5086-5090`) is a single `assert.match` on the literal `R.buffer = R.original.buffer;`
and is the *only* coverage the rebuild lifecycle has — the behavioural repair group
(`:668-713`) exercises the pure `repairChannel` alone. `reRenderDropsTheOldTakeAndReusesTheSourceLoudness`
(`:4986-4989`) asserts `/beforeCache\.key !== beforeKey/`, which holds for any key including
the wrong one. No `init*Controller` function is invoked anywhere in `test/run.mjs`. That is a
defensible design for the *collectability* facts the ledger routes to DevTools (E2, E3, E5,
E16) — those are not observable from node. It is not defensible for correctness invariants.

**Files.** `js/app/repair-controller.js`, `js/app/bench-controller.js`,
`js/app/persist-controller.js`, `js/app/source-controller.js`, `js/transcript-ui.js`,
`test/run.mjs`.

**Proof.** Three behavioural tests, each of which would have caught one of the above:
1. Drive `rebuild()` against a runtime whose `generation` is bumped while a fake worker reply
   is pending; assert `R.buffer` and `R.original` are untouched.
2. Ask the render path for `beforeCache` across a repair bypass; assert the key changed.
3. Call `discard()` against a spilled `SourceHandle`; assert `bytes()` either re-materialises
   or refuses loudly. (This is ledger 4B row 29's own outstanding proof, still unwritten.)

**Cost.** Medium, one session — and be honest that most of it is scaffold, not test. The suite
has never instantiated a controller, so these need a stub `ctx` (store/engine/views, ~15 stub
methods across waveMini, waveMain, spec, sliceView, repairPanel) plus a `globalThis.Worker`
stub, since `js/app/repair-controller.js:26` constructs one and node has no global Worker.
`persistFixture` (`test/run.mjs:724-737`) is a serialization fixture whose runtime has no
buffer, mono or generation — it cannot drive `rebuild()`. Keep the existing regexes as cheap
anti-regression pins alongside; this replaces nothing.

**Risk.** Low. Every fix is a guard, and three of the five have a precedent call site in the
same tree.

---

# The backlog, ranked

Ordered by value for this owner, not by cost. Anything here is a defensible next session
once the six above are done.

**7 · Key detection, chroma, and a per-slice note readout.** `VISION.md:79-80` promises
"key detection with diatonic transpose" and puts it in slice 4, CONFORM; CONFORM shipped its
stretch half and not its key half (`docs/CONTRACT-CONFORM.md` has sections for stretch, voice
fit, baking, space rack, acceptance — "key" appears once and means a cache key).
`rg -ni "chroma|krumhansl|key detect|pitch class"` over `js/` returns zero matches across 93
files. Harmony is the one musical dimension the bench is blind to: it measures loudness to
BS.1770-5, tracks beats with Ellis's algorithm, classifies timbre into eight roles, and cannot
say what key the Goldberg excerpt is in — while `js/studio/view.js:120` already renders a
key/scale readout for the synth side of the same screen. Build `js/analysis/key.js`
(log-frequency chroma over the existing FFT, Krumhansl-Schmuckler against the 24 profiles,
returning `{key, mode, confidence, chroma}` in the same confidence-with-a-number shape
`trackBeats` already returns). Two corrections to the obvious plan: `harmonicity()`
(`js/analysis/harvest.js:334-339`) keeps only `re[l]/r0` and **discards the lag**, so the
per-slice f0 is a one-line `bestLag` plus parabolic interpolation, not free; and its band is
40–1000 Hz, so it answers "what note is this bass slice", not "what note is the cicada". The
real work is stating confidence honestly for material that has no key — report UNCERTAIN
rather than guessing a key for a thunderstorm. *Medium. Low risk, no audio path touched.*
Better after step 4, but the dependency is soft: MACHINE already ships ±24 semitone PITCH, so
a key readout is actionable today.

**8 · CRATE: real provenance, and arm-then-confirm before deleting.** Two defects in one
module. READ: `js/machine/controller.js:1100` writes `source: P.fileName || 'unknown source'`
and `js/app/crate.js:166-186` persists only that string — free-text filename as the entire
provenance of an instrument designed to outlive the session, in direct contradiction of
`README.md:206` ("The encoded recording's local SHA-256—not its filename—is the source
identity"). Worse than absent: `js/machine/voice-ui.js:323` enables CRATE for **any** track
holding a sample, so crating a synth, modal or factory voice while a file is loaded stamps
that file's name onto a voice that never came from it. And READ:
`js/machine/crate-ui.js:132-134` — the LOAD button's handler is
`this._emit(e && e.altKey ? 'delete' : 'load', {id})`, with no confirm, no undo, no backup,
and the only disclosure inside `load.title`. The app trains Alt-holding elsewhere
(`slice-ui.js:792`, `pattern-ui.js:651` `e.altKey ? 'cleartrack' : 'assign'`) where it is
always undoable. *Do:* write `origin: {sha256: R.sourceHash, name, startSec, endSec}` for
`kind: 'sample'` and `origin: null` for the rest — a voice that claims a false origin is worse
than one that claims none. `normalizeMeta` (`crate.js:34-46`) already spreads unknown keys
through, so no index migration is needed; `startSec/endSec` need a prior step, since
`registerAsset` discards the clip bounds. Then make the first Alt+click *arm* the button with
the 3 s disarm pattern already written for MINE (`field-library.js:491-501`). Note
`docs/CONTRACT-HARVEST.md:93-94` specifies the current gesture, so this is a contract edit.
*S for the arm step, M with provenance. Low risk.* Drop the crate-export-zip idea: `persist()`
already mitigates eviction and a second archive format is a tool museum.

**9 · Per-step tone locks (LPF, RES, HPF, DRIVE).** `VISION.md:69` promises "hold a step and
drag any knob for a parameter lock"; the shipped lockable set
(`docs/CONTRACT-LOCK.md:65-74`) is VEL, PITCH, GAIN, PAN, RATCHET, NUDGE, GATE, PROB, COND
plus reverse — nine voice fields including all four timbre knobs are unlockable. The argument
is not "more knobs": MACHINE is hard-capped at eight tracks, and getting one darker hit inside
a pattern today costs an entire track. A tone lock removes that action outright, which is the
"what existing action does it eliminate?" test, and it is deterministic so FREEZE prints it.
No new DSP — the BiquadFilterNodes already exist per event and the `sd`-undefined-means-no-lock
convention is in place for gainDb/pan. Correct one thing in passing: the filters are *not*
static — `prepared` is rebuilt inside every `compileWindow` call
(`js/machine/compile.js:118-140`), so a live slider sweep already moves the filter across
successive hits; what is missing is movement *within* a hit and *printable* per-step movement.
*Medium (UI rows, persistence, fixtures). Low risk, strictly additive.* Do this in the same
pass through `scheduleEvent` as step 4 if both are wanted — opening that hot path twice is the
waste.

**10 · Sample loop points.** `rg -n "src.loop|loopStart|loopEnd" js/` returns nothing;
`AudioBufferSourceNode.loop` is never set. The headline "nothing can sustain a sample" is
false — CONFORM is a shipped pitch-preserving sustain mechanism, and HARVEST has a dedicated
sustained-material sweep to feed it. What CONFORM cannot do is (i) sustain past 4× the slice
(`MAX_RATIO`, silently clamped), (ii) hold length independent of pitch, (iii) avoid a 37–61 ms
bake per distinct length. A looping source beats it on all three: bake once, and loop points
in buffer seconds ride playbackRate free. Add `loopStart`, `loopEnd`, `loopXfadeMs` to the
voice, bake a crossfaded loop-ready buffer through the existing `fitted` cache pattern, and
offer a loop-point finder as an explicit SUGGEST button using `correlate()`
(`js/dsp/stretch.js:120-133`) and the equal-power curve already in `js/machine/cliprefs.js:13-25`.
Two things the "60 lines" estimate misses: `planEnvelope` derives its wall from
`sliceSec / rate` (`js/machine/sequencer.js:949-963`), the exact quantity looping removes; and
"play it chromatically" needs a keybed that does not exist — the shipped one is Digit1..Digit8,
pad-style, keydown-only. *Medium-large. Do it after step 4:* a held, looping, chromatically
played pad is the worst case for the interpolator step 4 removes.

**11 · Vendor `@huggingface/transformers@3.7.1` and the ORT wasm.** Step 1 makes the README
true; this makes the code match it. READ: `sw.js:172` declines every cross-origin request and
`sw.js:3-4` states the policy, while `sw.js:116` precaches `./workers/whisper-worker.js` — the
service worker guarantees the worker file offline and stops one line short of the module on
its line 6. An ES-module `import` cannot carry an SRI hash, import maps are not supported in
workers at all, and `index.html` has no CSP (`rg -n http-equiv index.html` returns nothing), so
this is hash-unpinned third-party executable code with same-origin reach over decoded audio,
OPFS and the crate. It also punctures the permanence argument at `VISION.md:53-54`: a static
page cannot die, except this one stops transcribing if jsdelivr does. *Two cautions.* Do **not**
add the ORT wasm to `PRECACHE` — it is tens of MB and would force every visitor to download it
at service-worker install, contradicting `README.md:357-358`; once the import is same-origin
the existing runtime cache-on-fetch path persists it after first use. And capture the exact
asset set from a live network trace first: transformers.js v3 pulls ORT assets dynamically, and
`workers/whisper-worker.js` sets no `wasmPaths` (INFERRED, not observed: ORT therefore fetches
its `.wasm` from a CDN too). `docs/CONTRACT.md:141-145` pins 3.7.1 for a verified
session-creation regression, so the fixtures gate it. *M-to-L, not the M the first pass
claimed.* Schedule alongside ledger row 20's isolation work, which vendoring simplifies
(`require-corp` needs CORS/CORP on every cross-origin subresource).

**12 · Impulse-noise repair (DECLICK).** The rack is nine stages
(`js/dsp/chain.js:13-23`) and none addresses a tick; `rg -ni "declick|decrackle|impulse noise"`
finds only voice end-fades. Denoise is spectral gating for stationary broadband noise and by
construction cannot remove a click; REPAIR is a hand-drawn rectangle, one drag at a time. The
MUSIC drawer ships two 96 kHz/24-bit 78 transfers, and `docs/research/FRONTIER.md:115` already
names "vinyl rip" as a planned RACK preset the current rack cannot honour. Add a `declick`
buffer-kind stage between highpass and dehum: LPC-residual (or high-passed derivative vs
running median) flagging samples above k·MAD of a local window, short-gap interpolation with a
run-length cap, feathered like REPAIR, with sensitivity, max-gap and an **event count readout**.
*Three honest caveats.* This is a declicker, not a decrackler — dense 78 surface crackle is a
different statistical problem, and under the bench's own honesty rule
(`docs/CONTRACT-BRUSH.md:13-15`) the copy must say so, which narrows the payoff. The
false-positive hazard for *this* shelf is not a rimshot, it is the Voyager plasma-wave tape,
whistlers and insect stridulation — on a 96 kHz field recording the residual is dominated by
the ultrasonic band, so the detector's most confident hits can be the real data; the fixture
needs a field/ultrasonic negative control. And the count readout needs a new channel out of a
buffer-kind stage, which `renderChain` does not have. *Medium, one to two sessions. Off by
default, conservative defaults.* Doctrine check: no live project asks for this today.

**13 · The sidechain envelope, per track and tempo-synced.** The narrow, high-return half of
the groove item. READ: `js/machine/sequencer.js:45-47` — `DUCK_DIP_TC = 0.0017`,
`DUCK_HOLD_SEC = 0.065`, `DUCK_RELEASE_TC = 0.06` — three module constants, identical for every
track and every tempo. Duck routing is already real and per-track
(`js/machine/compile.js:141-150`). Promote hold and release to per-track params defaulting to
today's values, and offer a tempo-synced release: `js/dsp/space.js:88-101` already exports
`delayTimeFor` and a `DIVISION_BEATS` table for the delay bus, so this is a lookup, and
per-target values ride the existing `DuckSeg` into all four scheduling paths for free. Correct
one claim: depth is tempo-independent (`applyDuck` sets `10^(-depthDb/20)`); what does not
scale is the recovery's share of the beat. Note the fixed shape is contract-specified
(`docs/CONTRACT-LOCK.md:51-52`), so this is an amendment. *Small. Lowest coupling of anything
in the groove family.*

**14 · Transient handling in the tonal phase vocoder — as an experiment, not a patch.**
`phaseVocoder` (`js/dsp/stretch.js:295-447`) contains no onset logic; `detectOnsets` has
exactly one caller, `wsola` at `:233`. Five of eight harvest roles take the tonal path. The
defect is real and *worse* than the module's own 40 ms argument: the WSOLA figure is a frame,
but the PV's spread is the FFT window — `N·(ratio−1)` = ~46 ms at ratio 2 and ~139 ms at
ratio 4. But the proposed fix is wrong twice. Solving for the frame that places a transient at
the correct output time gives `pa = u` exactly — the one frame where it sits at window index 0,
where `hann(N)[0] = 0`; the loud copy lands `(N/2)(ratio−1)` ≈ 23 ms **early** at ratio 2. So a
bare phase reset restores intra-frame coherence and does *not* remove pre-echo or relocate the
attack, and the "±5 ms click-placement test" would fail even on a correct implementation. (That
test also does not exist in the assumed form: `test/run.mjs:1874-1892` counts peaks, it never
checks positions.) And resetting `synPhase[b] = anaPhase[b]` for **all** bins destroys the
identity phase locking at `:372-401` that the file was built to protect. *Do this as an
experiment:* write the failing fixture first — a sustained 440 Hz tone with a click at a known
offset, stretched 2×, measuring both the click's coherent-peak position and the tone's phase
continuity — and be willing to conclude the naive reset is not worth shipping. The cheaper
honest alternative, since HARVEST already knows the role: a hybrid running WSOLA on the attack
region and the PV on the decay, reusing both existing engines and both existing test groups.

**15 · SPEED beyond three values — but only the honest half.** `SPEED_FACTORS = [1, 2, 4]`
(`js/dsp/varispeed.js:14`) is a whitelist, and `slowedBuffer` is bit-exact at any factor since
it changes one header field and shares the channel arrays. But the inference that *any* factor
is free is **wrong**: `js/audio-engine.js:206` gates on
`Math.round(tctx.sampleRate) !== want`, and at a non-integer factor `want` is non-integer, so
every fine-trim value takes the refusal branch and lands on Chromium's linear interpolator —
the exact path step 7 shipped this morning to escape. The exactness the repo relies on is
binary (`playback-rate-decision.md:317-320`). *So split it.* (a) Extend `SPEED_FACTORS` to
integer factors with integer quotients — on 96 kHz material ⅛× = 12 kHz, ⅙× = 16 kHz, ⅕× =
19.2 kHz, ⅓× = 32 kHz are all exact and keep the copy path; that answers the whistler and
bat-call listening case completely, and is a two-line change plus label work. (b) Ship a
cents/percent tuning trim on the **print path only**, where `slowedBuffer` is honest at any
factor and no transport is involved — that is what brings a 78 to concert pitch. (c) A
monitored fine trim needs `:206` reworked to round `want` **and** an empirical check that
Chromium's unity fast path survives a near-1 ratio; without that the readout must say CHROMIUM
LINEAR at nearly every trim value. Also worth a look while in the file: `MIN_CLOCK_HZ = 8000`
is justified at `varispeed.js:16-17` on a claim the platform ledger contradicts
(`docs/lab/ledger/platform-chrome.md:151`: contexts must accept 3000–768000 Hz).

**16 · Make SLOW findable, and stop the status line over-claiming.** `btnSpeed` is the only
transport control with no command-deck entry and no key binding — `js/main.js:359-402` holds 44
`commandDefs` and none is speed, while `btnRtz` and `btnPlay` both have one; global keys are
exactly Space, Home, Escape, Cmd-K, Cmd-Z. Add a deck entry (keywords `slow speed varispeed
ultrasonic octave pitch down bat`) that jumps to SIGNAL and then cycles the factor, so the
`#slowOut` readout is on screen when it fires, plus a global key surfaced in the deck row.
Then the part that is not cosmetic: `js/app/bench-controller.js:872-873` prints "ABOVE n kHz IN
THE SOURCE IS NOW AUDIBLE" **unconditionally**, on the same click where `showSlowView`
(`:900-905`) has already computed the flag and painted "NOTHING TO REVEAL — THIS FILE IS
ORDINARY BANDWIDTH IN A TALL CONTAINER". Gate the status sentence on that flag. *Do not* ship
the third idea from the original proposal — measuring the band on every load — because
`bandLevelDb` runs `welchPsd` over the entire mono with no cap on the main thread (~675,000
FFTs for an hour of 96 kHz), which is a perf regression against today's windowed-load work.

**17 · Verify the hash the spill already holds, and persist it.** No cross-tab coordination
exists (`rg -n "navigator.locks|BroadcastChannel" js` returns nothing) and every tab writes the
same `source.bin`/`project.json`. Since this morning's spill, a live session's only copy of the
encoded bytes is a file another tab may overwrite, and the guard is a **byte count**:
`SourceHandle.bytes()` (`js/app/source-handle.js:39-41`) validates only length, though
`this.hash` sits unused on the object. Two different files of equal length means tab A silently
keeps, exports or restores tab B's audio — a lineage failure on a bench whose identity model is
"hash, name, size" and whose README promises a keep re-opens byte-identical. *Do:* re-hash on
read-back in `bytes()`, and persist `hash` in `project.json` (`js/app/persist.js:165` records
only `sourceBytes.size`) so the RESUME guard at `persist-controller.js:451-455` — which
step 8's auto-restore now runs **without a click** — can check it. Two test fixtures build
handles with a hash that does not match their bytes (`test/run.mjs:4928`, `:4946`) and need
editing. *Skip the Web Locks half:* it adds a second boot mode and a status string for a
scenario a single-user bench has to construct on purpose.

**18 · Finish visual step 9's missed bullet, and give the repair recompute a job.** The visual
plan ordered: "stop flipping the canvas notes between hint and job text
(`source-controller.js:158, :161`; `machine/controller.js:842, :370`): the canvas note keeps
the hint, the stage keeps the job" (`docs/lab/2026-09-03-visual-plan.md:475-479`). Steps 8–15
shipped in `ead4716`; this bullet did not — the code still flips at
`source-controller.js:170/:174` and MACHINE at `machine/controller.js:866`. Deleting those two
assignments also removes a race where a superseded `compute()` resolves its predecessor's
promise (`js/spectrogram.js:160-162`) after nulling the data, so the load path's `.then()`
paints the hint over a blank canvas while the new STFT runs. Deterministic path, no user speed
needed: `persist-controller.js:281` awaits `loadArrayBuffer`, which does not await its own
`spec.compute`; `:290` then awaits `repairRebuild`, which supersedes it — so restoring any
project carrying repairs fires it every time. **Do not** patch this with a bare
`gen === R.generation` guard: `clearSource` never writes `specNote`, so the note would stick on
"Computing spectrogram…" forever after a discard. Bundle the larger half: the repair recompute
(`repair-controller.js:139`) registers no job, writes no note, swallows faults with `.catch(() => {})`,
and `setBusy(false)` runs in the `finally` *before* the un-awaited compute resolves — so after
every repair the panel reads done and the strip is idle while the microscope is blank.

**19 · The remaining ledger memory rows.** Not re-proposing the shipped program — noting that
your own §4A rank 1 is still open and is the largest single remaining win:
loudnorm holding up to five full buffers (335 MB guaranteed, 502 lexical at 96 kHz), risk low,
score 335, proof already written. Ranks 5/8 (fp16 encoder, q4f16 decoder) are gated on E10.
Ranks 9, 10, 12, 14, 15, 16 remain. The three structural rows (20–22) are correctly parked.

**20 · Smaller readout and refusal defects.** (a) The RENDER Δ LU prints `NaN LU` /
`-Infinity LU` / **`+Infinity LU`** on a short, silent or fully-cut source —
`js/app/bench-controller.js:710` does the subtraction raw while `fmtDb` (which returns `-∞`
for non-finite) is already destructured into scope at `:17` and simply unused. The tool builds
its own poison input: `js/dsp/chain.js:66-69` returns a **1-sample buffer** when everything is
cut ("AudioBuffer cannot be zero-length"), and nothing downstream rejects it. Guard on
`Number.isFinite(delta)` and fall back to the `—` the cell already ships — do not pipe the
delta through `fmtDb`, because a delta of −∞ is not "minus infinity loudness", it is undefined.
*Minutes.* (b) SPEED is enabled and silently does nothing on any source below 16 kHz
(`speedFactorsFor` filters to clocks ≥ `MIN_CLOCK_HZ`, so 8000, 11025 and 12000 all return
`[1]`), and the click prints `READY`, replacing whatever the status said. Disable the button
and put the reason in its title — but say the *defensible* reason (8000 Hz is the lowest rate
the Web Audio spec guarantees a context and buffer at), not the WAV floor the code comment
claims, since the repo's own test asserts Chromium accepts 3000. *XS.*

**21 · Per-track swing, swing grid, and live humanise — scoped as a contract change, not a
parameter add.** Swing is one value per scene, applied at the sixteenth pair
(`js/machine/compile.js:50-57`, clamped 50–70 at `:307-309`), so a straight kick under a swung
hat is not expressible. But swing is not MACHINE-local: `js/performance/compile.js:35-36, :60-63`
retargets semantic-lane onsets through `stepTime`, `js/loom/compile.js:290, :307` and
`js/studio/midi.js:43` carry it into gestures and MIDI export, and
`docs/CONTRACT-SEMANTIC-TAKE.md:73, :196` make destination BPM and swing part of the retarget
contract. Per-track swing forces a decision about what the semantic lane and MIDI OUT do with
eight values. Also: humanise is not absent — `js/machine/kits.js:300-316` already applies seeded
velocity and nudge to NEW TAKE variations; what is missing is a *live* per-track control. Two
traps for whoever builds it: drawing jitter from the same `rand01(seed, cycle, p.track, localStep)`
call at `compile.js:189` makes it perfectly correlated with the probability roll, so it needs a
distinct salt; and humanise stacks with nudge against the fixed scan margin at `:161-163`, so
the combined offset must stay inside one pair or the window-stitch property
(`test/run.mjs:418-423`) breaks at seams. STUDIO already spans swing 50–75 with a different
formula, so the two sequencers already disagree — worth reconciling in the same pass.

**22 · STRETCH on a bench selection.** `stretchSamples` is reachable only through a voice's
`fitSteps`; there is no way to stretch a recording or a selection on the bench. Two of the three
motivating requests already have a path (SLICE → `fitSteps` → FREEZE round-trips the machine
back to the bench as the new source, `js/machine/controller.js:799-810`); what genuinely has no
path is material longer than 64 sixteenths at the scene tempo (~16–24 s), any ratio outside
0.25–4, and getting the result without the machine's mix and master path. **The DSP is not
free at bench scale**: the tonal path allocates `acc` and `norm` as `Float64Array(rawLen)`
(`js/dsp/stretch.js:336-337`) plus a padded copy plus the output — ~20 bytes per output sample
per channel, so ten minutes of 96 kHz stereo at ratio 1.5 is roughly 2 GB per channel. That is
the unbounded allocation today's whole program removed. *Ship it on a selection only*, with a
hard duration ceiling checked against the same budget as decode, `mode: 'resample'` offered as
the honest pitch-moving alternative, and adoption via the existing `loadArrayBuffer` route so
words and cuts clear exactly as FREEZE clears them.

**23 · Per-card licence chip and provenance into the lineage map.** The durable half of step 1.
`rec.license` and `rec.source` have **zero** uses outside the manifest literal; `fieldLicenseUrl`
(`js/app/field-library.js:190`) has exactly two callers, both in `test/run.mjs`. The card
renderer (`:349-374`) paints kind, badge, title, place, duration and MB and nothing else, so the
chain of title dies at the click — nothing in the `.yjkt` or the printed WAV can say which
archive item a sound came from. `assets/demo/README.md` shows the standard the project already
holds itself to for its one bundled asset. *Do the narrow version:* a non-interactive licence
`<span>` in the existing `.yj-field-head-row` flex row (an `<a href>` inside the card's `<button>`
is invalid HTML and fights its click handler — put the item link in `btn.title` or the window
row), plus `license` and `sourceItem` added to `semanticTake.source`
(`js/machine/sequencer.js:508-513`), which already ships `{sha256, name, size}` into the
`.yjmap.json`. Leave `persist.js` alone until something downstream reads it.

---

# Deliberately not doing, and why

**The six refuted candidates.** Each was checked against the tree and does not survive; do not
raise them again.

- **"Persistence is Chromium-only."** The premise is a year stale.
  `FileSystemFileHandle.createWritable()` is Baseline newly-available since September 2025
  (Safari 26.0, Firefox 111), so on every browser `docs/CONTRACT.md:7` targets, autosave, spill,
  RESUME, MINE and CRATE all work. The three code comments it leaned on are correctly scoped to
  an older Safari and were read as descriptions of the present. *The interesting residue:*
  `document.wasDiscarded` really is Chrome-only and WebKit's kill is silent, but the consequence
  is one click, not lost work — with OPFS present the RESUME panel shows unconditionally.
- **"The spectrogram misses transients on long files."** Refuted by arithmetic: a column
  analyses 2048 samples, so energy can only be *missed* once the stride exceeds the window,
  i.e. past ~5.7 minutes at 48 kHz. All four motivating shelf items are 45–174 s, and the
  hour-long entries cannot be loaded whole (`field-library.js:372-377` `continue`s past the
  normal loader). On the deepest window the shelf can produce, the blind gap is 11–32 ms —
  shorter than any Morse dit in the drawer. *The interesting residue:* zoom never re-analyses
  past 85.4 s, so deep zoom is an upscaled blur; peak-hold across strided frames would fix it at
  7–42× the STFT cost.
- **"The decode budget should subtract the resident model."** The model is now released in the
  TRANSCRIBE handler's `finally` and on every source change, so at the moment `planDecodeRate`
  runs, `modelLoaded` is false in every ordinary sequence and the subtraction is zero. The real
  pressure point is a *pre-TRANSCRIBE fit check*, which is not what ledger rank 19 says. Also,
  `navigator.deviceMemory` reports 16 here, so `min(768 MiB, 16 × 96 MiB)` is identical
  behaviour.
- **"The conversion readout should name a remedy."** It attached E12's −5.8 dB (the *linear*
  interpolator, the refusal fallback) to the CHROMIUM SINC stage, which measures −94.9 dB — about
  89 dB better — and which the decision record names as the mitigation, deliberately. The
  proposed remedy string is also technically wrong: `_deviceRate` is latched at context creation,
  so changing the OS output rate mid-session changes nothing without a reload. *The residue:* the
  refused-transport fault has no remedy clause, but that branch was never once observed in live
  testing.
- **"The lineage map covers one lane of nine."** The scenario cannot occur: `renderPerformance`
  has one caller, inside the `loomprint` handler, which returns early unless a LOOM plan is armed,
  and PRINT 24-BIT is a control on the LOOM lane row, disabled without one. `semanticTake: null`
  can never reach a shipped ZIP. *The residue is real and folded into backlog item 8:* the clip's
  `start`/`end` are discarded at `registerAsset`, so per-sample provenance does not exist to write
  even if the schema were extended.
- **"`.yjkt` needs a migration chain."** `FORMAT_VERSION` was **born at 2** —
  `git show c1a7f0d:js/app/persist.js` has it, and `git log -S"FORMAT_VERSION = 1"` returns
  nothing. There has never been a bump, so the strict gate has never refused a real file. The
  observed pattern is the opposite and better: five additive extensions with the version
  deliberately pinned and forward tolerance in `clone()`. The v3 migration is already specified
  at `docs/superpowers/plans/2026-08-30-multisource-foundation.md:762-766`, more strictly than
  the proposal. Shipping `upgradeSnapshot()` today means a chain with zero migrations and
  fixtures for a v1 that never existed.

**An "erase everything" button.** The DISCARD dialog's "CRATE instruments are kept" is *true*;
MINE is also kept and unmentioned, which errs toward caution. The browser's own site-data clear
is the only erasure a user can *verify* on a serverless app, and an in-app button's two outcomes
for a sole user are "never pressed" and "destroyed the crate and the keeps". The gap is
documentation, not a control. (The CRATE half of that finding survives, as backlog item 8.)

**Web Locks cross-tab coordination.** Backlog item 17 takes the cheap half. The lock adds a
second boot mode, a degraded-autosave path and a new status string to defend against a scenario
that requires deliberately opening a second tab — the exact "what existing action does it
eliminate?" failure.

**A bench-wide STRETCH over the whole source** (as opposed to a selection). ~2 GB per channel of
scratch on ten minutes of 96 kHz stereo, undoing today's program. Ledger rank 21's chunked path
is its prerequisite, not a follow-up.

**Measuring the ultrasonic band on every load** to advertise SLOW. `welchPsd` over the entire
mono, uncapped, on the main thread.

**A whole-spectrum phase reset in the PV, shipped as a patch.** See backlog item 14 — the
arithmetic says it does not put the attack where the proposal claims, and it puts a phase
discontinuity into every sustained partial. It is an experiment with a failing fixture, or it is
nothing.

**Adding the ORT wasm to `PRECACHE`.** See backlog item 11 — it would force a multi-megabyte
download on every visitor at service-worker install, including everyone who never transcribes.

---

# What would change this order

- **A live project.** Trigger-based adoption is the doctrine, and three backlog items (12
  declick, 10 loop points, 21 swing) have no live project asking for them today. If a track
  starts, they move.
- **A measurement.** Step 3's window width and item 15's near-unity fast-path question are both
  empirical. If the transport race turns out to be microseconds wide on Chromium, step 3 drops
  below step 4.
- **R7.** The hardware loopback that would measure Chromium's converter is still unrun
  (`docs/lab/2026-09-03-playback-rate-decision.md`, proof ladder 3). It is the only outstanding
  proof for a claim the README now makes in public, and it needs a physical loopback or a
  BlackHole install — your call, not a code change.
