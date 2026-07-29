# CONTRACT-HARVEST — slice mining, voice color, and the instrument crate

Binding for the HARVEST slice. Three parts: HARVEST (mine a whole song for
its best material, classified by role), COLOR (per-voice filter and drive so
reworks stop sounding like their source), CRATE (a persistent instrument
library independent of any session, so instruments from different songs pull
together). Everything composes with SONG/LOCK/WIRE as shipped.

## 1. HARVEST — automatic kit curation

New pure core js/analysis/harvest.js (node-testable, no DOM):

```
harvest(mono, sampleRate, onsets) -> { picks, candidates }
  // onsets: seconds array from the existing analysis (spectral flux peaks).
  // picks: up to 24 of {t0, t1, role, label, score}, timeline-ordered.
```

Candidates: each onset opens a window to min(next onset, 1.2 s), skipped if
under 40 ms or RMS under -48 dBFS. Features per candidate (all from plain
FFT/RMS math, no new deps): attack sharpness (rms 0-12 ms vs 40-120 ms),
band ratios (low <150 Hz, mid 150-2k, high >4 kHz), spectral centroid,
spectral flatness, harmonicity (normalized autocorrelation peak in the
40-1000 Hz lag band), sustain (rms 200-400 ms vs 0-50 ms), and peak dBFS.

Roles and heuristics (tune on the synthetic fixtures, document thresholds):
KICK low+sharp+short · SNARE mid+flat+sharp · HAT high+flat+short ·
BASS harmonic+low+sustained · TONE harmonic+mid+short · VOX harmonic+mid+
sustained · FX noisy+sustained · CRASH high+sustained.

Selection: quotas KICK 3, SNARE 3, HAT 3, BASS 3, TONE 4, VOX 4, FX 2,
CRASH 2; rank inside a role by score = loudness x sharpness fit; greedy
diversity: a pick within 2 s of an already-picked candidate loses half its
score (spread across the song is the point); unfilled quotas hand their
slots to the best remaining candidates of any role. Labels: 'KICK 1',
'VOX 2', etc.

workers/harvest-worker.js wraps the core (message {type:'harvest', mono,
sampleRate, onsets} -> {type:'done', picks} / {type:'error', message}),
transferable in, guarded self.onmessage like repair-worker.

Node fixtures: synthesize a 20 s scene at 44.1 kHz with known plants: sine-
burst kicks at 60 Hz, noise-burst snares band-passed 400-3k, hp-noise ticks,
a sustained 80 Hz saw bass, a 440 Hz vocal-ish sustained harmonic tone, a
white-noise riser. Assert every plant is found with the right role and t0
within 20 ms, quotas respected, diversity rule kicks in when two identical
kicks sit 0.5 s apart.

## 2. COLOR — voice filter and drive

voice gains (project-store defaults, persist clamps, VOICE drawer controls):

```
lpf: 20000,   // Hz; >= 18000 means OFF (no node)
res: 0.7,     // 0.5..8, lowpass resonance only
hpf: 20,      // Hz; <= 25 means OFF
drive: 0,     // dB 0..24; 0 means OFF
```

Compiler (normalizeVoice + event emission): fields ride the event ONLY when
non-neutral (lpfHz/resQ/hpfHz/driveDb), preserving the golden-fixture
guarantee: neutral voices compile bit-identical, neutral schedule graphs are
node-for-node what they are today.

scheduleEvent voice chain when color present: src -> WaveShaper (tanh curve
k = 10^(driveDb/20), 2048-point, with 1/tanh(k) output normalization so
unity-peak input stays unity) -> highpass BiquadFilterNode -> lowpass
BiquadFilterNode -> gain -> pan. THE Q TRAP (TRUTH 1 lesson, non-negotiable):
BiquadFilterNode lowpass/highpass Q is IN dB. Butterworth hpf: Q = -3.0103
(20*log10(0.7071)). Lowpass res maps Q_dB = 20*log10(res). Skip every OFF
node entirely.

## 3. CRATE — persistent instrument library

js/app/crate.js: CrateStore over OPFS dir 'yellowjacket-crate-v1' (its OWN
directory: session DISCARD must never touch the crate). Reuse the OpfsStore
patterns from js/app/persist.js but self-contained (no persist.js edits).

```
CrateStore.open() -> store | null      // same Safari/null semantics
put({name, role, source, voice, sampleRate, pcm: Float32Array}) -> id
list() -> [{id, name, role, source, seconds, sampleRate, savedAt}]
get(id) -> {meta, pcm}
remove(id)
```

Layout: index.json (array of metas, rewritten on every mutation) +
<id>.f32. ids 'i' + timestamp-ish counter persisted in index.json (maxId),
collision-proof by construction.

js/machine/crate-ui.js — pure view, EventTarget, pattern-ui idioms,
self-injected styles (list every class in notes): setInstruments(list),
setBusy(bool); rows show NAME · ROLE · SOURCE · SECONDS with LOAD and
Alt+click-to-delete (title explains); events 'load' {id}, 'delete' {id},
'refresh'. Empty state: one honest line about saving instruments from the
VOICE drawer.

js/machine/voice-ui.js gains one button in its actions row: 'CRATE +'
emitting 'crate' {track} (only when the track has a sample). Smallest diff.

Wiring (integrator): VOICE 'crate' -> CrateStore.put with the track's pcm,
voice, label, and P.fileName as source -> status 'CRATED · <name>'.
CRATE substate (new MACHINE tab strip entry) hosts crate-ui; 'load' assigns
to the first empty track of the ACTIVE scene (or track 8 if none free),
copying pcm + voice, registering an asset, bumpTrack, status says where it
landed. Persisted instruments survive DISCARD and new sessions by design.

## 4. Acceptance

Node: harvest fixture plants found + roles right + quotas + diversity;
color neutrality (no event fields when defaults; rate/gain unchanged);
drive curve unity-peak property; persist roundtrip with color fields.
Browser: HARVEST on the demo track yields 24 labeled clips spread across
the full duration (assert min/max t0 span > 60% of duration); role labels
visible in SLICE; save two instruments from two DIFFERENT source songs into
the crate, reload, both list and load into tracks; a rendered song using
crated + colored voices completes and downloads. Existing 56 harness cases
stay green.
