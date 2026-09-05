# 2026-09-04 — TWO STATIONS: a song from two radio signals, played by the OP-Z

**What it is.** A 3:01 song in seven sections, composed by fixed rules from
measurements of two public-domain recordings — UVB-76 (the Buzzer, 4625 kHz,
2010) and WWV (NIST time station, 1991) — performed by the OP-Z in one pass
over USB MIDI, recorded over USB audio, and mastered headlessly with the
bench's own loudness and limiter stages. Score: `scripts/compose-two-stations.mjs`.
Artefacts: `docs/lab/two-stations/two-stations.mid`, `…-sheet.txt`.

**Authorship, plainly.** The rules are mechanical and every one is traced to a
measurement below. The form, the chord progressions, the voicings and the
casting of OP-Z tracks are choices, listed as such. The OP-Z contributed its
own timbres, its arpeggiator on its own clock, and its master effects.

## 1. Where every rule comes from

| element | rule | measurement |
|---|---|---|
| tempo | 105.7 bpm | UVB-76 buzzer cycle 0.881 Hz; its 2nd harmonic 1.762 Hz is the beat, so one buzz = two beats (`cyclic-transcription.md` §2) |
| key | B minor | WWV minute tones 500 Hz ≈ B4 (−21 ¢), 600 Hz ≈ D5 (+37 ¢): a minor third (§3b) |
| chorus lift | B major | UVB-76's 156 Hz component ≈ D#3, the major third (§2) |
| the clock | a perc hit at exactly 1.000 Hz for the whole song | WWV's tick (§3b); at 60 against 105.7 bpm it phases through the beat and realigns every ~80 s |
| bass | one note per buzzer cycle (2 beats), held 0.70 of it | the buzz's own duty, 0.8 s of 1.135 s |
| texture | UVB-76's pulse layers at their true rates and measured onsets | 2.53 / 3.41 / 4.29 / 2.29 Hz from the buzzer section's transcription |
| melody rate | one note per 0.587 s, phrases gated at 0.646 Hz | the voice message's syllable and phrase rates (§2) |
| melody contour | pitch steps up when the voice's loudness rises, down when it falls; velocity is its level | 60 ms RMS of the voice section (80–120 s of the recording), snapped to the pentatonic |
| final note | D5 held over the last bar | WWV's 600 Hz tone — the minor third has the last word |

Choices: form intro 8 · verse 16 · bridge 8 · chorus 16 · verse 8 · chorus 16 ·
outro 8 (80 bars, 181.6 s); verse i–VI–III–VII (Bm G D A), bridge VI–VII–i,
chorus I–IV–V–I (B E F# B); pad voicings around B3–A4; casting from the
instrument atlas measured the same evening (below).

## 2. Casting, from the atlas

Measured with the device audible again (peak / onset / centroid per note):
the "snare" track's sample is a low thud at note 48 (f0 22 Hz region, centroid
180 Hz) and a bright crack at 60 (3.2 kHz) — so it is both kick and snare;
perc at 60 is a 2.6 kHz hat and at 36 a click; the sample track is a quiet
second perc; bass, lead and chord sustain (RMS held at 1.0 s: 0.028 / 0.040 /
0.017), chord is a warm pad (centroid 53–459 Hz); the arp track answers with
~205 ms latency on some notes (its clock). MIDI channel 1 is never used — a
factory OP-Z routes it to whichever track is selected.

| role | OP-Z track | ch | notes |
|---|---|---|---|
| kick / snare | snare (pitched sample) | 2 | 48 / 60 |
| hats, tick, texture | perc | 3 | 60 / 36 / 72 |
| texture 2 | sample | 4 | 48 |
| bass | bass | 5 | roots 43–54 (patch sounds an octave down) |
| melody, final D5 | lead | 6 | pentatonic 71–88 |
| chorus arpeggio | arp | 7 | chord + 12, held per bar; the device arpeggiates |
| pad | chord | 8 | triads 55–69; level swell/fade by relative CC 47, net zero |

## 3. The take

`scripts/opz-perform.py`: 4,790 events over 181.6 s, lead 1.5 s, tail 4 s.
Timing median 1.3 ms late, p95 3.5 ms, max 7.7 ms. Relative level moves on
the pad returned to origin (`8:47: 0`).

Raw take: peak 1.00, RMS 0.153. Full-scale samples: 55 of 8.2 M (L 39, R 16),
longest run 5 frames (0.11 ms), all on chorus kicks — transient touches, not
flat-tops; the take stands. Section dynamics, raw:

```
intro     -24.2 dBFS rms   peak  -5.5
verse     -17.3            peak  -0.9
bridge    -22.6            peak  -4.7
chorus    -13.9            peak  -0.0
verse 2   -17.3            peak  -0.5
chorus 2  -13.5            peak  -0.0
outro     -22.5            peak  -3.2
```

Ten dB between bridge and chorus: the arc is in the performance, not
the master.

## 4. The master

`scripts/master-take.mjs` — the RACK's `processLoudnorm` (measure → gain →
true-peak limit → remeasure) run in node with a minimal `AudioBuffer`:

```
in : 187.1 s · integrated -16.2 LUFS · short-term max -13.7 · true peak  0.1 dBTP
out:           integrated -14.5 LUFS · short-term max -12.6 · true peak -1.0 dBTP
```

Target −14 LUFS, ceiling −1 dBTP; the limiter's cost is the 0.5 LU shortfall.
24-bit WAV, then MP3 320 kbps for listening.

## 5. What to listen for

- The tick. It is on every second, and it is never on the beat for long: at
  bar 1 it sits near beat one; by the bridge it has walked through the bar.
- The bass is the buzzer. Same cycle, same duty, a fifth of the tempo.
- The bridge and verse-2 melodies are the voice message's loudness contour;
  nothing in them was chosen note by note.
- The chorus arpeggio drifts against the song: the OP-Z's clock is 105.0,
  the song is 105.7.
- The last note is D natural over the fading pad: WWV's minute tone, and the
  minor third back after the chorus's major.

## 6. Next

- Swells on the pad via the OP-Z's LFO (CC 9/10) rather than relative level.
- A second take with the kit velocities 10 % lower removes the 55 touches.
- Kick on the real kick track needs channel 1, which needs the device's
  active track set to it — a one-key action on the device, not a config write.
- The same rules on other pairs of signals: the score is a function of the
  measurements, so a different pair is a different song.
