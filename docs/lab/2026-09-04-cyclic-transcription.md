# 2026-09-04 — Cyclostationary transcription: a signal's periodicities, played

**Claim.** A recording can be transcribed not by its notes but by its
*modulation spectrum* — the set of rates at which its bands rise and fall —
and that transcription can be played by an instrument at the exact rates
(not a grid), with the source's own phase relations, and then measured back
with the same detector to say how much of the structure the instrument
carried. The loop is source → `analyseCyclic` → score → performance →
`analyseCyclic` → fidelity. Every stage exists and is tested, and the last real stage — the OP-Z
playing it — has run: 34 of 39 layers across two sources came back through
the detector (§3e).

What shipped: `js/compose/cyclic-score.js` (`composeCyclic`, `scoreEvents`,
`scoreToSmf`, `describeScore`, `scoreFidelity`, `carrierCentroid`),
`scripts/opz-perform.py` (plays events over USB MIDI while recording USB
audio; relative CCs return to origin; nothing written to the device),
`scripts/cyclic-virtual.mjs` (a stand-in instrument for the loop),
6 tests under `cyclic transcription`, and `buildSmf` gained CC events.

## 1. The transcription rule

From each analysis window (20 s here) take the strongest non-harmonic
periodicities. For each:

| from the detector | becomes |
|---|---|
| alpha (Hz) | the layer's rate, exactly: `period = 1/alpha`; events at `onset + k·period` |
| carrier centroid (depth-over-floor weighted mean band, DC bin excluded) | the band → track, and the pitch (folded by octaves into the track's range) |
| depth (mean-normalised modulation) | swell excursion |
| strength (ratio over the noise floor) | velocity, `50 + 6√strength`, clamped 40–120 |
| phase at (alpha, carrier bin) | onset inside the first period: `−φ/2π mod 1 × period` |
| alpha < 1 Hz | **swell**: one held note, filter cutoff moved at the alpha rate by relative CC, net zero per section |
| 1 ≤ alpha < 8 Hz | **pulse**: notes at the period; pulses in the same band alternate the band's hit and tone tracks |
| alpha ≥ 8 Hz | **buzz**: the note retriggered at the rate, 30 ms holds |

Bands: < 250 Hz low (bass / sample), < 2500 Hz mid (lead / snare), else high
(snare-tone / perc). MIDI channel 1 is never used: a factory OP-Z routes it
to whichever track is selected.

Two decisions taken after seeing real output: the carrier is a centroid,
not the argmax bin — for speech the argmax was the DC bin and every voice
layer landed on C2; and pulses sharing a band alternate tracks — otherwise
UVB-76's three harmonic rates were one perc sample at three speeds.

## 2. Source: UVB-76, 4625 kHz, 2010-12-05 12:22 UTC (CC0, 8 kHz)

160 s: buzzer, a voice message, buzzer. What the detector reads:

```
whole 160 s   0.866 Hz (period 1.154 s)  53 bands   ← the buzzer cycle
              1.814 / 2.673 / 3.627 / 4.486 / 5.338 / 6.417 Hz  its shape
              13.892 Hz on a 156 Hz component throughout  (receiver/tape)
40–80 s       0.881 Hz across 90 bands, coherence 41.6  ← buzzer proper
80–120 s      0.646 / 1.498 / 2.350 Hz in the low band  ← the voice's syllable rates
```

The score: 8 sections × 4 layers, 32 layers; every section's slowest layer
is the buzzer cycle (0.65–0.94 Hz) as a swell on the lead; 1634 note-ons,
3271 relative-CC steps summing to zero on every channel, peak 132 messages/s.
`uvb76-cyclic.mid` is the DAW-readable form (4 tracks, 1080 notes, cutoff
motion as CC 3).

## 3. Fidelity, stand-in instrument

With the OP-Z mute, `scripts/cyclic-virtual.mjs` played the events on a
crude synth (noise bursts for perc, sine tones for the rest, swells shaped by
their own alpha) and the detector read the result:

```
26 / 32 layers detected (81%)
   0 s  0.88 ok  2.00 --  3.82 ok  6.11 ok
  20 s  1.47 ok  2.53 ok  3.41 ok  4.29 ok
  40 s  0.88 ok  2.29 ok  3.35 ok  4.23 ok
  60 s  0.76 ok  1.59 --  2.47 ok  3.23 ok
  80 s  0.65 ok  1.70 ok  3.64 --  4.46 --
 100 s  0.82 ok  1.94 --  3.99 ok  4.99 ok
 120 s  0.94 ok  2.76 --  3.70 ok  4.76 ok
 140 s  0.76 ok  1.76 ok  2.76 ok  4.17 ok
```

The buzzer cycle came back in 8 of 8 sections. The misses are mid-rate
pulses on the snare-tone track, masked by the stronger pulses' harmonics in
the detector's peak list. That is a measurement of the instrument model, not
of the score, which is the point of having the number.

The synthetic test does the same with a known source (0.7 Hz AM on 150 Hz
plus 3 Hz clicks on 3 kHz): two layers on the right tracks, pulse period
exact to the sample, relative CC net zero, SMF period within 2 ms after the
tick grid, and the 3 Hz rate back through the detector.

## 3b. WWV, the calibration source (PD, 13:10, 8 kHz)

WWV's structure is known in advance: a tick every second, 500/600 Hz tones
alternating by minute, a voice announcement at 52.5 s. The detector on
minutes two and three:

```
60–120 s   0.999 Hz  x123  125 bands  coh 54   + harmonics 2–8 all marked  (600 Hz minute)
120–180 s  0.999 Hz  x133   81 bands  coh 26   + harmonics 2–8             (500 Hz minute)
```

The first pass transcribed this as a *swell* — 0.999 < 1 Hz — which is
wrong: a tick is impulsive. That forced two rules that were missing:

- **A harmonic comb means an impulsive envelope.** A line whose 2nd–6th
  harmonics are present (the 2nd must be) is a pulse whatever its rate; a
  smooth modulation has no comb. The comb also sets the hit length: a
  five-harmonic tick holds a twelfth of its period.
- **The composer does its own harmonic bookkeeping.** The detector credits a
  comb to its strongest line, which for a narrow click is often not the
  fundamental. Harmonics sit at multiples of the *true* rate, not the
  bin-quantised one, so the search tolerance grows with the harmonic number;
  once a line has a comb, its rate is refined by least squares over the comb
  and every multiple to the 16th within one bin is folded into it. Without
  the "2nd harmonic required" clause a smooth 0.7 Hz swell claimed a 3 Hz
  pulse as its fourth harmonic on two coincidences — the test caught it.

WWV then reads as one layer per minute-section: a 0.9986 Hz pulse with
five harmonics (1.000 Hz quantised to the alpha bin; the comb is on the same
grid, so refinement cannot beat the bin here). Stand-in fidelity 8/9 (89%);
the performance's own spectrum carries the comb back: `1.00 1.99 2.99 3.99
4.99 5.98`. UVB-76 under the final rule: 30 layers, 25 back (83%).

## 3c. The OP-Z take: silent, and what was ruled out

Ian ran `scripts/opz-perform.py` on the UVB-76 events: 162.4 s recorded,
every event on time, peak **0.0000**. Ruled out since: the documented
unmutes (CC 53/54 = 0 on all 16 channels) change nothing; a 120-s listener
saw 5,080 clock ticks, no key note-ons, no audio; nothing in the incoming
CC map (§2.3–2.4 of the OP-Z README) is reachable by anything sent today
except cutoff, and the relative moves netted to zero. The device is awake
and clocking the same project at 105.7 bpm; only its USB audio output is
dead. Next check is physical: volume knob, then re-seat the USB cable (a
re-enumeration), then a power cycle.

## 3d. In the bench: PERIODICITIES on the SIGNAL rail (v71)

The loop now runs in the browser with no hardware: `js/app/cyclic-controller.js`
adds a PERIODICITIES panel under MEASUREMENT. READ PERIODICITIES analyses the
first 60 s and lists each rate with its period, carrier and band count
(harmonics dimmed), then transcribes the first 120 s in 20-s sections and
prints the section/layer/motion summary. HEAR plays the transcription on the
stand-in instrument through `engine.audition` (shared code:
`js/compose/cyclic-synth.js`); STOP, and the header stop, end it. MIDI saves
the score. Verified in the app on UVB-76 from the shelf: five periodicities
on the 3.6 kHz carrier (0.73, 1.97, 3.58, 4.52, 5.40 Hz), a 22-layer
transcription (5 swells, 17 pulses), audible, stoppable, saved, no console
errors. The palette knows it as READ PERIODICITIES. Service worker `yj-v71`;
preload graph regenerated (95 modules).

Not yet: the header's "sounding" label does not name the stand-in audition;
selection-aware reading (it always reads from 0); Web MIDI out to the OP-Z
from the browser (`js/midi/wire.js` exists; Chrome allows it, the in-app pane
does not).

## 3e. The OP-Z takes — the instrument in the loop

A USB re-plug restored the device's audio (peak 0.98 on a test note; the
fault was the USB audio stream, not the synth — headphones had worked all
along). `scripts/opz-perform.py` then played both scores into the OP-Z over
USB MIDI while recording its USB output, and `scoreFidelity` read the
takes back:

| source | events | timing (median / p95 lateness) | layers back | stand-in |
|---|---|---|---|---|
| UVB-76, 160 s | 5,844 | 1.0 ms / 3.5 ms | **26 / 30 (87 %)** | 25 / 30 (83 %) |
| WWV, 120 s | 995 | 1.1 ms / 3.5 ms | **8 / 9 (89 %)** | 8 / 9 (89 %) |

Relative cutoff moves returned to origin on every channel (`residual 0`).

```
UVB-76 on the OP-Z
   0 s  0.88 --  2.00 ok  3.82 ok  6.11 ok   heard: 1.99 3.81 6.09 7.62 11.43 12.25
  20 s  1.47 ok  2.53 ok  3.41 ok  4.29 ok   heard: 1.46 2.52 3.40 4.28 5.86 6.80
  40 s  0.88 ok  2.29 ok  3.35 ok  4.23 --   heard: 0.88 2.29 3.34 4.57 6.86 9.14
  60 s  0.76 ok  1.59 ok  2.47 ok  3.23 ok   heard: 0.76 1.58 2.46 3.22 3.98 4.92
  80 s  0.65 --  1.70 ok  3.64 ok  4.46 ok   heard: 1.70 3.63 4.45 7.27 8.50 10.90
 100 s  0.82 ok  1.94 ok  3.99 ok  4.99 ok   heard: 0.82 1.93 3.98 4.98 5.80 7.73
 120 s  0.94 ok  4.76 ok                     heard: 0.94 1.88 2.81 3.75 4.75 5.63
 140 s  0.76 ok  1.76 --  2.76 ok  4.17 ok   heard: 0.76 1.52 2.75 4.16 5.27 7.03

WWV on the OP-Z: every full-minute section reads 1.00 1.99 2.99 3.98 4.98 5.98
```

What the instrument did to the transcription:

- **The OP-Z beat the stand-in on UVB-76** (87 % vs 83 %). Its drum samples
  have sharper transients than sine bursts, so pulse layers read back more
  cleanly; the comb of the 0.94 Hz layer at 120 s (`1.88 2.81 3.75 4.75`)
  is the device's own envelope shape, not the score's.
- **The misses are swells.** Two of the four failures are sub-1-Hz swells
  (0.88 Hz at 0 s, 0.65 Hz at 80 s) carried by relative cutoff moves on the
  lead: ±24 steps of cutoff on this patch is too shallow a modulation for the
  detector at this section length. The same layers survived where the
  section's depth was higher. Swells need a deeper carrier — the OP-Z's own
  LFO (CC 9/10), or level (CC 16) rather than cutoff.
- **The tick is exact.** WWV's 1 Hz comes back at 1.00 with its comb intact
  in five of five minute-sections; the one miss is the first section's
  0.88 Hz line, which is the recording's voice announcement, not the tick.
- **Timing over USB MIDI is not the limit:** median 1 ms, p95 3.5 ms late,
  against a finest period of 160 ms.

The number that matters: with the instrument in the loop, 34 of 39 layers
of two sources' periodicity structure survived transcription, performance
on hardware, and re-measurement — and the losses have a named cause.

## 4. Why this is new, and what it is not

- It is not beat tracking, not onset transcription, not sonification of a
  spectrum. The unit is the *alpha*, and alphas need not be harmonically
  related or grid-aligned: 0.881 and 2.526 Hz play together at their true
  ratio, which a sequencer cannot do and a MIDI file can only approximate.
- The phase term is the part I have not seen elsewhere: layers keep the
  measured timing relations of the source's bands, so the transcription is a
  fingerprint, not a rhythm in the style of the source.
- The fidelity number makes the instrument part of the experiment. The OP-Z's
  envelopes, filter and compressor will change the depths; the reading of
  the performance is the finding.
- Authorship: the rule is fixed and mechanical; the source and the
  instrument are the choices. Nothing here writes notes from taste.

## 5. Blocked: the OP-Z went quiet

At 20:30 the device played on MIDI Start (peak 0.82) and answered notes on
channels 2–5. By 21:10 it clocks (105.7 bpm, same project) but produces no
USB audio on Start or on any test note (peak 0.0000, checked four times).
Nothing on this side changed between the two. A volume knob at zero or a
muted master fits; a power cycle would too. `scripts/opz-perform.py` is
ready to run the moment a test note is audible:

```
scripts/opz-perform.py uvb76-events.json --out uvb76-take1.wav --lead 1.0
node -e "…scoreFidelity(score, {mono: take, sampleRate: 44100, offsetSec: 1.0})…"
```

## 6. Next

- Run the real take; compare the OP-Z's fidelity with the stand-in's 81%.
- WWV (1 Hz ticks, 100 Hz subcarrier, minute tones) as the calibration
  source: known alphas, known phases.
- Let the score choose the OP-Z's own LFO (CC 9/10) for swells above the
  relative-CC rate limit, once the LFO-speed-to-Hz map is measured.
- Drop the source on the bench and hear the transcription in the browser via
  Web MIDI (`js/midi/wire.js` exists; the in-app pane refuses MIDI, Chrome
  does not).
