# 2026-09-03 · Playback rate: the decision

Follows E12 in `2026-09-03-memory-scout.md` (native-rate decode is right for
memory and analysis; `AudioBufferSourceNode` resamples by linear interpolation,
so a 19 kHz tone in a 48 kHz buffer on the 96 kHz context throws a 29 kHz image
only 5.8 dB down) and `ledger/platform-chrome.md` §7 / "What this settles" 6.
Four plans were drafted and judged (A: open the one context at the file's rate;
B: a second transport context at the file's rate; C: an AudioWorklet transport
with the repo's Kaiser sinc; D: a context-rate playback copy made at load).
Owner constraints: fidelity is not negotiable, memory stays native for
analysis, no dumbing down, minimum irreversible friction.

## Decision

**B, with grafts.** The bench transport, LOOM and clip audition move to a
second `AudioContext` opened at the loaded buffer's rate — the same context
object as today's device-rate context whenever the rates already match — so
every source node that plays the recording runs at unity ratio, which in
Chromium is a copy, not an interpolation (`audio_buffer_source_handler.cc`
474-486: `computed_playback_rate == 1` takes `ProcessFastPath`). The device-
rate context keeps MACHINE, STUDIO, the MIDI clock, the kit readout and the
CRATE, untouched; MACHINE buffers cut from a source at another rate are
rate-matched once, at cache build, with the repo's own Kaiser sinc at a raised
playback cutoff. The only resampler left in the monitoring path is Chromium's
`media::SincResampler` between the transport and the device — the same stage
every 48 kHz web page on a 96 kHz Mac already passes through — and it vanishes
entirely when the interface is set to the file's rate.

Grafted from the runners-up, at no cost: the same-rate no-op and the
close-before-create race with a timeout (A); the device-rate record so the
decode planner is never fed a stale context rate (A); the raised Kaiser cutoff
`0.4922` and the bit-exact null test as the in-graph proof (C); the negative
control in the harness and the fault-tone status when the browser refuses a
rate and playback falls back to the linear path (D); and, as a later step, the
observation that SLOW folds images into the audible band — answered here by
retuning the transport instead of a worklet, at zero memory.

## What was verified before deciding (executed on this machine, 2026-09-03)

Scripts in the session scratchpad (`chromium-sinc-model2.mjs`,
`webkit-sinc-model.mjs`, `kaiser-measure.mjs`, `kaiser-cutoff.mjs`,
`e12-lib.mjs`); E12's method (Hann 65 536-point FFT, tones snapped to bin
centres, worst component outside ±6 bins). Step 0 below moves them into the repo.

| path | source | measured |
|---|---|---|
| Chromium unity ratio | `absh.cc:474-486` (main, fetched today) | `computed_playback_rate == 1` and integral read/end frames → `ProcessFastPath`; anything else → `ProcessInterpolatedPath` (linear) |
| Chromium context→device | `sinc_resampler.h:28-33,54-55`, `.cc:109-126` | 64 taps when the request is ≥ 96 frames (cutoff 0.92 × input Nyquist), else 32 taps (0.90); 32 sub-phase kernels with linear interpolation between phases |
| Model of that kernel, 48 k → 96 k | `chromium-sinc-model2.mjs` | 1 kHz image −130.9 dB; 19 kHz **−94.9 dB** (E12 today −5.8); 20 kHz −90.2; level −0.51 dB @ 21 kHz, −5.3 @ 22, −20.7 @ 23, −36 @ 23.5 |
| 44.1 k → 96 k | same | 15 kHz **−78.7 dB** (E12 today −12.4); −0.16 dB @ 19 kHz, −3.5 @ 20, −17.5 @ 21 |
| 96 k → 48 k (2:1 down) | same | aliases < −150 dB; −0.08 dB @ 19 kHz, −2.2 @ 21, −5.6 @ 22 (scale ×2 for 192 k → 96 k) |
| 32-tap / 0.90 kernel (Chromium's small kernel = WebKit's) | `webkit-sinc-model.mjs` | 19 kHz image −78.9 dB; −0.23 dB @ 19 kHz, −1.2 @ 20, −3.6 @ 21 |
| Repo Kaiser, cutoff scale 0.45 (today) | `kaiser-measure.mjs` → `js/dsp/resample.js` | 48 k → 96 k: 19 kHz image −104.5 dB, flat to 21 kHz, **−80 dB @ 22 kHz** (the 0.9-Nyquist design kills the last 2 kHz); 66 ms per 2 s mono |
| Repo Kaiser, cutoff scale **0.4922** | `kaiser-cutoff.mjs` | 48 k → 96 k: 19 kHz −101.4 dB; **0.00 dB through 23 kHz**, −1.7 dB @ 23.5, images ≤ −88.8 dB; 44.1 k → 96 k flat to 21 kHz, −0.36 @ 21.5; 96 k → 48 k −0.04 dB @ 23 kHz, aliases < −150 dB |
| Test suite today | `node test/run.mjs` | 50 groups / 329 cases, green; `sw.js` VERSION `yj-v63` |

The 0.4922 figure is C's derivation (0.5 − Δf/2 with the 320-tap Kaiser
transition width) and it holds empirically; B's proposed 0.485 leaves −0.11 dB
at 23 kHz and −27 dB at 23.5 — 0.4922 is the constant to ship.

## The shape

| context | rate | owns | why it stays there |
|---|---|---|---|
| **device** (`engine.ctx`, today's) | hardware rate, 96 kHz here | MACHINE voices, STUDIO, MIDI clock, kit readout, factory kits | sequencer clock, `getOutputTimestamp`, 96 kHz factory kits play bit-exact |
| **transport** (`engine.transport`) | `engine.buffer.sampleRate` | bench play, LOOM, clip audition, native-rate auditions | every recording source node at unity ratio → copy path |

When `buffer.sampleRate === ctx.sampleRate` the transport **is** the device
context (`shared: true`): no second context, today's graph exactly. Two
contexts cannot share a bus node; they sum in CoreAudio after the page, so the
meter takes one `AnalyserNode` per context (peak = max, RMS = root-sum-square,
clip = any). That reading is exact whenever one context sounds, which the
transport rule already enforces for bench vs MACHINE (`bench-controller.js:129`
togglePlay → stopAll; `machine/controller.js:770` run → `engine.pause()`);
clip audition or LOOM alongside a running MACHINE is the one overlap that can
sum above the meter's reading, and it is disclosed rather than prevented.

Every consumer and where it lands:

| consumer | today | after | change |
|---|---|---|---|
| `Engine.play/seek/setRate/pause/currentTime` (`audio-engine.js:160-260`) | `this._ctx/_master` | `this._transport.ctx/master` | internal |
| `LoomEngine.play/stop` (`loom/engine.js:47-48,111`) | `engine.wake()/master/ctx` | `engine.wakeTransport()`, `transport.master/ctx` | 3 lines |
| `loom/controller.js:606` hearOrigin | `engine.wake()` | `engine.wakeTransport()` | 1 line |
| `ClipAuditioner.play/stop` (`cliprefs.js:93-94,151`) | `engine.ctx/master` | `engine.transport.ctx/master` | 2 lines |
| repair preview (`repair-controller.js:179-207`), synth preview (`machine/controller.js:1198-1205`), modal `playPcm` (`:1278-1286`) | hand-rolled `createBuffer` + source on `engine.ctx` | `engine.audition(...)` | dedupe |
| `Sequencer` (`sequencer.js:230-233,267-270,543`) | `engine.wake()/ctx/master` | unchanged | buffers rate-matched at cache build |
| semantic lane (`sequencer.js:829-838` ← `controller.js:63-75 bufferFor`) | `R.buffer` at native rate on the device ctx | windowed excerpt at `ctx.sampleRate` | new resolver method |
| `StudioEngine` (`studio/engine.js:169-172,206-209`) | `engine.wake()/master` | unchanged | — |
| `ClockOut` (`wire-controller.js:331-333` → `clock.js:53-58`) | `engine.ctx` | unchanged | — |
| `kitView.setState(…, engine.ctx.sampleRate)` (`controller.js:96,244,277,290-292,797`); `kit-ui.js:408` "LIVE AUDITION USES THE DEVICE RATE" | device rate | unchanged, still true | — |
| `LevelMeter` (`meters.js:27-35`) + `hookMeter` (`bench-controller.js:166-175`) | one analyser, `meterHooked` latch | one analyser per context, idempotent connect | step 3 |
| `renderChain` (`chain.js:126-129`), export, spectrogram, transcription, harvest, loudness, KEEP | native buffer | unchanged | — |
| `persist`, `project-store` | context is runtime state | unchanged | — |

## Ordered plan — every step ships alone, tested, with its E12 row

Baseline for every step: `npm test` green (50/329 today), the source-regex
test `nativeDecodeAttemptLeavesTheFallbackSomethingToDecode` (`run.mjs:3512`)
keeps passing because the decode block of `load()` is not edited, and `sw.js`
VERSION is bumped on each deploy (`yj-v63` → `yj-v64`, …). No new module is
added to `PRECACHE`: the additions live in existing files.

### Step 0 — the harness first, with a negative control

**Files.** `test/browser/e12b-playback.html` (new; not precached, not linked
from `index.html`, opened by hand like Experiment 1) importing `js/fft.js`
(`FFT`, `hann`) and `js/dsp/resample.js`; `test/lab/e12-lib.mjs`,
`test/lab/chromium-sinc-model.mjs`, `test/lab/webkit-sinc-model.mjs`,
`test/lab/kaiser-cutoff.mjs` moved in from the scratchpad (they model Chromium,
so they are lab scripts, not suite cases).

**Rows** (1 s bin-centred tones, Hann 65 536, worst component outside ±6 bins;
a Blackman–Harris toggle for claims below −60 dB):

| row | what | pass |
|---|---|---|
| R0 | 96 k buffer → `OfflineAudioContext(96000)` via source node, 19 kHz | −59.8 dB (window floor), the control |
| R1 | raw 48 k buffer → 96 k offline, 19 kHz | reproduces **−5.8 dB @ 29 kHz** — the negative control; if it does not, the harness is wrong |
| R2 | raw 44.1 k buffer → 96 k offline, 15 kHz | −12.4 dB @ 29.1 kHz |
| R3 | `resample(x, 48000, 96000, {cutoffScale: 0.4922})` → 96 k offline, 1/19/21/23/23.5 kHz | images ≤ −80 dB (BH window), level within 0.05 dB through 23 kHz |
| R4 | 48 k slice through the MACHINE buffer builder on `OfflineAudioContext(96000)` (step 2) | as R3 |
| R5 | **null test**: 48 k buffer → `OfflineAudioContext(48000)` via source node, `playbackRate 1` | `max|out − in| === 0` (bit-exact; the in-graph proof for steps 3–5) |
| R6 | **SLOW null test**: 48 k buffer → `OfflineAudioContext(12000)`, `playbackRate 0.25` | output frames equal input frames 1:1, bit-exact (step 7) |
| R7 | platform stage (see Proof ladder) | 29 kHz image ≤ −60 dB, 21 kHz within 1 dB of 1 kHz |

**Ships:** nothing in the app changes. **Proof:** R0–R2 reproduce E12.

### Step 1 — a playback cutoff for the repo's Kaiser (pure, additive)

**Files.** `js/dsp/resample.js`: `resample(input, inRate, outRate, { cutoffScale = 0.45 } = {})`
(the four existing callers — `stretch.js`, `wire-controller.js`, `drum-dsp.js`,
`machine/controller.js:128` — pass nothing and keep 0.45, the →16 k
transcription design); `export const PLAYBACK_CUTOFF_SCALE = 0.4922`;
`export function resampleChannels(channels, inRate, outRate, opts)`. The
kernel cache already keys on the cutoff (`kernelTable`, `toFixed(8)`).

**Tests** (`test/run.mjs`, new group `playback resample`): E12 in node with
`js/fft.js` — 48 k → 96 k 19 kHz image ≤ −80 dB (measured −101.4), 23 kHz
level within 0.05 dB (0.00), 25 kHz image ≤ −80 dB; 44.1 k → 96 k 21 kHz
within 0.05 dB; 96 k → 48 k 23 kHz within 0.1 dB, aliases ≤ −100 dB; identity
when rates match (`input.slice()`); default call unchanged (byte-equal to the
pre-change output for a 22 kHz tone at 0.45 — the transcription path is not
allowed to move).

**Ships:** yes, no behaviour change. **Proof:** R3.

### Step 2 — MACHINE buffers at the context's rate (live and printed)

**Files.** `js/machine/sequencer.js`: `createTrackBuffer(ctx, sample, reversed)`
(1138) builds the `AudioBuffer` at `ctx.sampleRate`, resampling each channel
with `PLAYBACK_CUTOFF_SCALE` when `Math.round(sample.sampleRate) !== ctx.sampleRate`
(memcpy when equal, today's code); export it. `createFittedBuffer` (1115)
stretches the matched channels read back from the forward buffer's
`getChannelData` (one copy per `(ctx, sample)`, as today, just at the context
rate) and creates at `ctx.sampleRate`; reversal after resampling (linear phase,
order immaterial). `prebake()` (161) also warms forward — and reversed where a
step or voice asks — buffers for tracks whose sample rate differs from the
context's. `js/machine/controller.js`: after each `bumpTrack` site (240, 544,
576, 588, 1112, 1230, 1369) queue `sequencer.prebake()` in a `setTimeout(0)`
so the resample (≈ 33 ms per mono-second at 2×; a 2 s stereo slice ≈ 130 ms)
never lands inside `trigger()` or the scheduler (CONTRACT-CONFORM 3). The
`trackBuffer`/`songBuffer` caches already key on `ctx` (`sequencer.js:132`),
so the live context and each offline render context get their own copies —
`renderWav`/`renderSong` render at `max(track rates, source rate)`
(`:1428-1436`), which today linearly interpolates any lower-rate sample into
the printed WAV; this step fixes the print too.

**Tests.** With `renderStubCtx(…, 96000)` (`run.mjs:2277`) extended with
`createBuffer(ch, len, rate)`: a 48 k sample holding a 19 kHz tone yields a
96 k buffer of `round(n × 2)` frames whose E12 reading shows no image above
−80 dB; a 96 k sample yields byte-identical channels; reversed equals the
forward buffer reversed; fitted buffer length equals `round(fitSec × 96000)`;
`prebake` warms the reversed buffer when a step lock asks for it (existing
pattern). Existing `offline render` and `factory drums` groups unchanged.

**Ships:** yes — independent of the transport; harvested slices and the
semantic-free print stop interpolating. **Memory:** +100 % per 48 k slice on a
96 k device (2 s stereo 0.77 → 1.5 MB; cap `MAX_TRACK_SAMPLE_SEC` 30 s →
23 MB per pad worst case); factory 96 kHz kits unchanged. **Proof:** R4.

### Step 3 — the transport context, the meter over two contexts, the status line (one unit)

**Engine** (`js/audio-engine.js`).
- constructor: `this._transport = null; this._deviceRate = 0; this.transportReport = null;`
- `_ensureCtx()` (283): unchanged, plus `this._deviceRate = this._ctx.sampleRate` on creation (a hint-free context is the hardware rate; the decode planner keeps being fed `ctx.sampleRate` from this context, so a 96 k file after a 48 k file is planned against the device — A's planner risk cannot arise because the device context never changes rate).
- `async _ensureTransport(rate)`: `rate === this._ctx.sampleRate` → `{ctx: this._ctx, master: this._master, shared: true}`; same rate as the current non-shared transport → no-op; otherwise `_haltPlayback()`, dispatch **`transportchange`** `{from: oldCtx}` synchronously (consumers drop nodes while the old graph is valid), `await Promise.race([old.close().catch(() => {}), 2 s])` (Safari caps hardware contexts at 4: close before create, always), `new Ctx({ sampleRate: rate })` + `GainNode → destination`; if `ctx.sampleRate !== rate` record `transportReport = {requested: rate, got: ctx.sampleRate, refused: true}`, close it and share the device context instead (playback returns to today's linear path, said out loud in step 3's status); dispatch **`transport`** `{ctx, master, rate, shared}`.
- `load()`: after `decodeReport`, `await this._ensureTransport(buffer.sampleRate)` before `'loaded'`; the fallback `ctx.decodeAudioData` branch yields a device-rate buffer and simply shares. `adoptBuffer` and `setAltBuffer`: call `_ensureTransport(next.sampleRate)` (a no-op — repairs and renders are at the source rate, `chain.js:126-129`). `clear()`: close a non-shared transport, `this._transport = null`.
- `wakeTransport()`: ensure (falls back to `wake()` with no buffer) + `resumeContext`; `get transport()`; `get deviceRate()`.
- `play()` (167): `const T = this._transport; const ctx = T.ctx;` sources connect to `T.master`; `currentTime` (160), `_t0`, `seek`, `setRate`, `_stopSources` read the transport. `ctx`, `master`, `wake()`, `sampleRate`, `buffer`, `mono`, `duration`, events: unchanged.
- The stale comment block at 37-48 ("playback resamples on the way out, which costs nothing here") is rewritten to state the rule.

**Meter** (`js/meters.js`): `connect(ctx, node)` keeps its signature, stores
`Map<ctx, {analyser, node}>` (idempotent for the same ctx+node; replaces a
different node on the same ctx; `drop(ctx)` and automatic eviction of
`state === 'closed'`); `_frame` aggregates peak = max, rms = √Σ(mean squares),
clipped = any. `js/app/bench-controller.js`: `hookMeter()` loses the
`meterHooked` latch and hooks whichever contexts exist (`engine.ctx/master`,
`engine.transport.master` when not shared); called from `togglePlay` as today,
on `engine 'transport'`, and — a one-line improvement — on the first
`sequencer`/`studioEngine` running `'state'` so a MACHINE-only session meters
too. On `'transportchange'` `{from}`: `meter.drop(from)`, and `loomEngine.stop()`
/ `auditioner.stop()` if they are sounding on it. Add a readout beside
`#roTime` (`index.html:116`): `MATCHED · NO CONVERSION` when shared, else
`TRANSPORT 48 kHz → DEVICE 96 kHz · CHROMIUM SINC`; `DEVICE KEPT 96 kHz ·
PLAYBACK INTERPOLATES` as a fault-tone line when `transportReport.refused`.

**Status** (`js/app/source-controller.js:144-157`): the LOADED line gains
`· BENCH AT <rate>` and the same conversion phrase; refusal is a fault-tone
status, not a soft note (D's rule).

**Contracts.** `docs/CONTRACT.md:67-68`: add `get transport()` and
`wakeTransport()` with the rule "sources that play the recording run at unity
ratio on the transport". `docs/CONTRACT-MACHINE.md:73-74` in step 4.

**Tests** (`lifecycleCases`, extending the `FakeAudioContext` at `run.mjs:915`
with `constructor(opts)` → `sampleRate = opts?.sampleRate ?? 96000`, `state`,
`close()`, `createBufferSource()` recording `.buffer`/`.playbackRate`,
`decodeAudioData` → `{sampleRate: this.sampleRate}`): (a) a 48 k buffer on a
96 k device creates a transport at 48000, `engine.ctx` stays 96000, `'transport'`
fires with `shared: false`; (b) a 96 k buffer shares — no second constructor
call; (c) a second load at another rate dispatches `'transportchange'`, awaits
`close()` of the first transport, then constructs (order asserted); (d) same
rate twice → one context; (e) `clear()` closes a non-shared transport;
(f) `play()` schedules on the transport fake, not the device fake, and
`playbackRate.value === 1`; (g) a refused rate leaves `transportReport.refused`
and the transport shared; (h) `deviceRate` is 96000 across every swap;
(i) `LevelMeter` aggregation over two fake analysers (peak = max, clip = any);
(j) `engineCanReturnToASourceFreeState` and `engineCanWakeWithoutLoadingASource`
unchanged.

**Consumers during this step.** Sequencer, Studio, ClockOut, kit readout:
untouched (device context). LOOM and clip audition still play on `engine.ctx`
with today's behaviour until step 4 — visible, not silent, because the readout
names the bench's own conversion only.

**Ships:** yes. **Memory:** a non-shared context ≈ 1–2 MB, freed on close;
two analysers negligible; the source buffer unchanged (Traum 161 MB).
**Proof:** R5 (bit-exact in-graph), `chrome://media-internals` showing the
transport stream requested at 48 000 Hz, then R7 when hardware allows.

### Step 4 — LOOM and clip audition on the transport

**Files.** `js/loom/engine.js:47-48` → `this.engine.wakeTransport()`,
`this.engine.transport.master`; `:111` → `this.engine.transport && this.engine.transport.ctx`.
`js/loom/controller.js:606` → `engine.wakeTransport()`. `js/machine/cliprefs.js:93-94,151`
→ `this._engine.transport.ctx/master` (guarded null → silent no-op as today).
`docs/CONTRACT-MACHINE.md:73-74`: "reuses engine.transport". Scheduling math
in `loom/schedule.js` is in seconds; untouched.

**Tests.** A fake engine `{buffer, transport: {ctx: fakeA, master}, ctx: fakeB, wakeTransport() {return fakeA}}`:
`LoomEngine.play(plan)` creates its bus and voices on `fakeA`;
`ClipAuditioner.play(clip)` creates its source on `fakeA`; source-text
assertions in the style of `run.mjs:3512` that `loom/engine.js` and
`cliprefs.js` no longer reference `engine.ctx`/`engine.master` for playback.

**Ships:** yes. **Proof:** R5 covers the same node path (a clip of a 19 kHz
48 k file auditions on a 48 k context; the bench's readout is the same).

### Step 5 — `engine.audition()` replaces three hand-rolled graphs

**Files.** `js/audio-engine.js`: `audition(pcm, { sampleRate, when = 0, gain = 1 })`
→ returns the source node; picks the transport when `sampleRate` matches it,
else the device context when that matches, else resamples each channel with
`PLAYBACK_CUTOFF_SCALE` to the transport-or-device rate; connects to that
context's master. `js/app/repair-controller.js:179-207` (guard becomes
`!engine.ctx && !engine.transport`), `js/machine/controller.js:1198-1205`
(synth preview — its 44.1 k source-free buffer was interpolated today) and
`:1278-1286` (`playPcm`) call it.

**Tests.** `audition()` picks the matching context, resamples otherwise
(fake contexts at 48000 and 96000; a 44.1 k pcm lands on the transport at
48000 after resampling with the right length); source-text assertion that the
three call sites use `engine.audition(`.

**Ships:** yes. **Proof:** R3 for the resampled case; R5 for the matched case.

### Step 6 — the semantic lane at the device rate (windowed excerpts)

The MACHINE sequencer plays Semantic Take events from `R.buffer` on the device
context (`sequencer.js:829-838`, `controller.js:63-75`) — the E12 defect — and
it must stay there: it shares the drum clock. A full-source device-rate copy is
the memory D was rejected for, so the resolver serves excerpts.

**Files.** `js/machine/controller.js` `setPerformanceSources`: add
`excerptFor(planId, event, rate)` → `{channels, sampleRate: rate, offsetSec}`;
when `R.buffer.sampleRate === rate` return `{buffer: R.buffer, offsetSec: event.sourceOffsetSec}`
(no copy, today's path); otherwise cut `[sourceOffsetSec − 2 ms, + sourceSpanSec + 2 ms]`,
resample with `PLAYBACK_CUTOFF_SCALE`, and cache in an LRU keyed
`sourceHash|planId|eventId|rate` capped at 30 s of audio (plans are immutable
JSON, so the key cannot go stale; a new source has a new hash). `js/machine/sequencer.js`
`_semanticSource(planId, event, ctx)` (117) builds the excerpt's `AudioBuffer`
on `ctx` (WeakMap on the excerpt) and rebases `sourceOffsetSec`; the three
callers — live (`:830`), `renderWav` (`:367`), `renderSong` — pass `event` and
their context. `loom/schedule.js` unchanged.

**Tests.** The resolver returns the live buffer untouched when rates match;
returns a 96 k excerpt of the right length with `offsetSec` rebased otherwise;
a second call hits the cache; a 19 kHz-tone excerpt passes the E12 check; the
LRU evicts past 30 s. `semantic performance` and `offline render` groups stay
green.

**Ships:** yes. **Memory:** ≤ 0.77 MB per stereo second at 96 k, capped at
≈ 23 MB. **Proof:** R4's method on the excerpt path (offline render of a
Semantic Take whose source is a 48 k 19 kHz tone at a 96 k render rate).

### Step 7 — SLOW on the transport clock (varispeed without interpolation)

`setRate(2|4)` sets `playbackRate = 1/f` today (`audio-engine.js:199`), i.e.
linear interpolation even on a matched buffer; at ¼× a 19 kHz component lands
at 4.75 kHz with its image near 7.25 kHz — inside hearing. The printed SLOW
file is already "the same samples under a slower clock" (`varispeed.js:33`).
The transport can be that clock: retune it to `fileRate / f` and keep
`playbackRate = 1/f`, so `computed_playback_rate = (1/f) × (fileRate / (fileRate/f)) = 1`
exactly (48000/12000 and 44100/11025 are exact in binary) — the copy path
again, and Chromium converts 12 k → 96 k on the way out. `speedFactorsFor`
already floors the clock at `MIN_CLOCK_HZ` 8000 ≥ Chromium's 3000.

**Files.** `js/audio-engine.js` `setRate(f)`: pause if playing, `await
_ensureTransport(this._buffer.sampleRate / f)`, resume from the held position;
`play()` unchanged (`playbackRate 1/f`, `realSecondsUntil`/`bufferSecondsElapsed`
already map real time to buffer time through the factor). The readout says
`SLOW ¼ · TRANSPORT 12 kHz → DEVICE 96 kHz`.

**Tests.** After `setRate(4)` on a 48 k buffer the fake transport is constructed
with `{sampleRate: 12000}`; `playbackRate.value × (48000 / 12000) === 1`;
`setRate(1)` returns to the file's rate (shared again when it equals the
device); position is preserved across the swap; `varispeed` group unchanged.

**Ships:** yes, gated on the audible check (R6 first, then a 19 kHz 48 k tone
at ¼×: the 7.25 kHz image must be gone). **Fidelity bound:** at 12 kHz the
device callback maps to < 96 frames on most buffer sizes, so Chromium uses its
32-tap kernel (`sinc_resampler.h:54-55`): the 32-tap model gives images
≤ −79 dB and −0.23 / −1.2 / −3.6 dB at the source's 19 / 20 / 21 kHz —
against today's ≈ −7 dB in-band image. **Memory:** zero. **Proof:** R6
(offline, bit-exact) and E12d in-app.

### Step 8 — records

`docs/lab/2026-09-03-memory-scout.md`: append E12b (harness rows R0–R6 with
numbers), E12c (platform capture), E12d (SLOW). `docs/lab/ledger/platform-chrome.md`
"What this settles" 6: replace "CoreAudio converts" with "Chromium
`media::SincResampler` converts — in the audio service's `AudioOutputResampler`
on desktop (`kWebAudioRemoveAudioDestinationResampler` enabled by default),
Blink's `AudioDestination` otherwise; same kernel; 64 taps / 0.92 when the
request is ≥ 96 frames, else 32 / 0.90." `README` "Numbers worth trusting"
once R7 is measured.

## Memory

| item | cost | note |
|---|---|---|
| decoded source | **0 change** | Traum 218 s 48 k stereo stays at the 161 MB planned footprint; no playback copy, ever |
| second `AudioContext` (non-shared only) | ≈ 1–2 MB | render thread, output FIFO, audio-service converter; freed on close |
| MACHINE buffers at the device rate (step 2) | +100 % per 48 k slice on a 96 k device | 2 s stereo 0.77 → 1.5 MB; 30 s cap → 23 MB per pad worst case; factory kits already 96 k |
| semantic excerpts (step 6) | ≤ 0.77 MB per stereo second | LRU ≤ 30 s ≈ 23 MB |
| `audition()` resample (step 5) | transient, one clip span | as today's `createBuffer` copies |
| analysers, kernel tables | KB | one Float64 table per distinct cutoff |
| SLOW (step 7) | 0 | the transport is the clock |

## Fidelity outcome, path by path

| path | resampler in the path | numbers |
|---|---|---|
| bench 1×, file rate ≠ device | none in-graph (copy path); Chromium SincResampler to the device | 48 k → 96 k: 19 kHz image −94.9 dB (today −5.8), flat to 20 kHz, −0.5 dB @ 21, −5.3 @ 22, −20.7 @ 23; 44.1 k: 15 kHz −78.7 (today −12.4), −0.16 @ 19, −3.5 @ 20; 192 k → 96 k alias-free, −0.08 dB @ 38 kHz, −2.2 @ 42, −5.6 @ 44 |
| bench 1×, file rate = device (`MATCHED`) | **none** | bit-transparent; the owner's `audiofmt` sets the interface to the file's rate |
| LOOM / clip audition at rate 1 | as bench | same |
| LOOM / semantic events at rate ≠ 1 | linear (unchanged, musical pitch) | documented; a bounded worklet voice pool only if asked |
| MACHINE slices, semantic excerpts, auditions (Kaiser 0.4922) | repo sinc, ≥ 80 dB design | 48 → 96: images ≤ −88.8 dB, 0.00 dB through 23 kHz, −1.7 @ 23.5; 44.1 → 96: flat to 21 kHz; 96 → 48: −0.04 @ 23 kHz, aliases < −150 dB |
| factory 96 k kits on a 96 k device | none | bit-exact, as today (A would have lost this) |
| SLOW ½ / ¼ | none in-graph; Chromium 32-tap to the device | images ≤ −79 dB; ≤ −1.2 dB to the source's 20 kHz (today ≈ −7 dB in-band images) |
| print (`renderChain`, export, KEEP) | none | unchanged, every sample |
| MACHINE print with mixed-rate kits | Kaiser instead of linear | fixed by step 2 |

The honest limit: the last ≈ 8 % of a 48 kHz file's band (22–24 kHz; 20.3–22
kHz of a 44.1 k file) sits in the platform kernel's transition band whenever
the device rate differs. No plan avoids a transition band somewhere; C's would
have been narrower (0.75 kHz) at the price of rewriting the transport. The
matched-rate path has none.

## Risks and mitigations

1. **Platform shelf and drift.** Inherent to any rate-mismatched device; the readout names it, `MATCHED` is bit-transparent, and R7 is the regression check after Chromium updates (`chrome://media-internals` logs "resampling from X Hz to Y Hz" per destination).
2. **Two contexts sum after the meter.** Exact when one context sounds (bench vs MACHINE exclusivity already enforced at `bench-controller.js:129` and `controller.js:770`); clip/LOOM + MACHINE can sum unmetered — disclosed in the meter's title, not prevented. No live limiter exists to keep coherent.
3. **Safari's four-context cap.** Close before create, awaited, asserted by test (c); at most two live contexts.
4. **Nodes on a closing transport.** `_haltPlayback()` first; `'transportchange'` is synchronous so LOOM/clip stop and the meter drops the analyser before `close()`; the close is raced against 2 s so a hung close cannot wedge `load()`.
5. **Browser refuses or fakes the rate** (Safari's `{sampleRate}` support is uneven). `transportReport`, shared device transport, today's linear path, fault-tone status — never silent.
6. **Autoplay.** The transport is created in `load()`, where the device context is created today; a file pick is a gesture, RESTORE is not, and both resume on play as now.
7. **First-trigger latency** from the Kaiser resample. `prebake` after every `bumpTrack` site in a `setTimeout(0)`; lazy path stays correct.
8. **Excerpt cache.** Keyed on immutable ids plus the source hash; LRU by seconds.
9. **SLOW retune is a context swap mid-play** (tens of ms of silence, position held). Only on a factor change; the transport rate is shown.
10. **Latency.** The audio-service resampler adds ≥ 48 frames at the transport rate plus its FIFO; scheduling headroom (`SCHEDULE_DELAY` 30 ms, LOOM 45 ms, clip 5 ms) is at the context, so nothing is scheduled inside the added output delay.
11. **Test doubles.** The lifecycle `FakeAudioContext` ignores options and lacks `close()`; step 3 extends it first. Node cannot run Web Audio, so the fidelity numbers come from the harness and the models, and the lab entries say so.
12. **Deploy.** `sw.js` VERSION bump per deploy (`yj-v63` today); no `PRECACHE` change.

## Proof ladder

1. **Node** (`npm test`): the groups named per step — kernel numbers, buffer builders, transport lifecycle and ordering, routing of every consumer, meter aggregation, SLOW ratio identity.
2. **In-graph, offline** (`test/browser/e12b-playback.html`): R1/R2 must reproduce E12's defect before anything is trusted; R3/R4 prove the Kaiser paths; **R5 and R6 prove the transport paths bit-exact** — a stronger statement than "≥ 60 dB down", because an `AudioBufferSourceNode` at unity ratio in an `OfflineAudioContext` at the buffer's rate is the same code path the live transport takes.
3. **Platform stage** (R7, the only measurement of Chromium's converter; an `OfflineAudioContext` never touches a destination): `chrome://media-internals` shows the transport stream at the file's rate; then capture the device output at 96 kHz while the transport plays a bin-centred 19 kHz tone in a 48 k buffer and a 1 kHz reference — via a physical loopback (interface out → in, `getUserMedia` with echoCancellation / autoGainControl / noiseSuppression off) or a BlackHole install, either of which is Dr. Helfrich's call (`system_profiler` shows no loopback device today). Pass: 29 kHz image ≤ −60 dB (model −95), 21 kHz within 1 dB of 1 kHz; repeat for 44.1 k / 15 kHz (−79) and, once step 7 lands, ¼× (E12d). Confirm `MATCHED` with the interface at 48 kHz shows neither image nor shelf.

## Rejected, and why

- **A — one context at the file's rate.** The rate becomes global: with a 44.1/48 kHz file loaded the 96 kHz factory kits would be downsampled for live audition (`kit-ui.js:408` promises canonical 96 kHz), the two 8 kHz FLACs in the field library (`field-library.js:109,113`, UVB-76 and HM01) would make MACHINE and STUDIO 4 kHz-band instruments, and `clear()` would keep that rate; every rate-changing load stops every transport and restarts the MIDI clock (0xFC/0xFA); context identity stops being stable for every persistent consumer (sequencer strips/rack/caches, studio graph, `ClockOut._ctx`, the meter latch), so steps 2–5 of A could only ship as one unit. Same platform stage and same hardware-only proof as B. Kept from A: same-rate no-op, device-rate record, close-before-create race, refusal report, status wording.
- **C — AudioWorklet transport.** The best resampler in the monitoring path (0.4922 Kaiser, flat to 23.25 kHz, offline-provable) and the only plan that named varispeed — but it re-implements thirteen transport behaviours on a worklet clock with a main-thread feeder whose 1.5 s lookahead is exposed to this bench's 0.2–0.65 s main-thread decodes and harvest copies, node cannot execute it, and the source-node fallback leaves two transport implementations forever. It also left LOOM at rate 1 and the semantic lane on the linear path. Kept from C: the cutoff constant (verified), the null test, the harness rows, and varispeed — answered by step 7 for zero memory and no worklet.
- **D — a context-rate playback copy at load.** Spends Step 2's saving again (Traum 161 → 328 MB resident, ≈ 580 MB transient, ≈ 620 MB after RENDER on a machine already swapping), falls back to the linear path past ≈ 9 minutes of 48 k stereo, keeps decodeAudioData's shelf, and leaves kit samples for a follow-on. Kept from D: the negative control, the harness-first ordering, the fault-tone caveat.
- **Decode twice, band-limited to 20 kHz** (D's variant): any playback buffer whose rate differs from its context re-enters the interpolator, and 20 kHz is exactly the band this bench listens above.
- **A MediaStream bridge** (transport → `MediaStreamAudioDestinationNode` → device context) to keep one meter point: it inserts an unverified resampler in the MediaStream path; not measured, not proposed.
- **A live limiter to make the two-context sum safe:** the bench has no live limiter today (`masterLimit` is offline-only); adding one is a new sound, not a fix.
- **A full-source device-rate copy for the semantic lane:** D's memory by another name; excerpts instead.
- **Resample-at-load floor for sub-44.1 kHz files** (A's step 8): unnecessary once the device context stays at the device rate.
- **A worklet voice pool for LOOM/semantic events at rate ≠ 1:** trigger-based; only when the musical paths are asked to be band-limited.

Effort: steps 0–5 ≈ 3 days (B's estimate, judged), step 6 ≈ ½ day, step 7 ≈
½ day plus the listening check, step 8 an hour once R7 has a number.
