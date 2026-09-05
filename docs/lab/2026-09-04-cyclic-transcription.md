# 2026-09-04 — Cyclostationary transcription: a signal's periodicities, played

**Claim.** A recording can be transcribed not by its notes but by its
*modulation spectrum* — the set of rates at which its bands rise and fall —
and that transcription can be played by an instrument at the exact rates
(not a grid), with the source's own phase relations, and then measured back
with the same detector to say how much of the structure the instrument
carried. The loop is source → `analyseCyclic` → score → performance →
`analyseCyclic` → fidelity. Every stage exists and is tested; the last real
stage (the OP-Z playing it) is built and waiting on the device's audio,
which went silent mid-session (§5).

What shipped: `js/compose/cyclic-score.js` (`composeCyclic`, `scoreEvents`,
`scoreToSmf`, `describeScore`, `scoreFidelity`, `carrierCentroid`),
`scripts/opz-perform.py` (plays events over USB MIDI while recording USB
audio; relative CCs return to origin; nothing written to the device),
`scripts/cyclic-virtual.mjs` (a stand-in instrument for the loop),
5 tests under `cyclic transcription`, and `buildSmf` gained CC events.

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
