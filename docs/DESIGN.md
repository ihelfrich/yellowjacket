# Yellowjacket — design language

The reference world is test equipment, not software. An oscilloscope faceplate, a caution
panel in a cockpit, the silkscreened front of a 1970s Braun signal generator, hazard chevrons
on a machine guard. Everything on screen should look like it was printed on the device, not
rendered by a framework. The user is at a bench, and sound is the specimen.

## Palette (CSS custom properties, all in :root)
```css
--yj-bg:        #0B0A07;   /* warm near-black, the bakelite chassis */
--yj-panel:     #12110C;   /* raised panel */
--yj-well:      #070604;   /* recessed wells: canvas panes, readout windows */
--yj-line:      #262418;   /* hairline rules, panel seams */
--yj-line-hi:   #3A3722;   /* hovered seams */
--yj-yellow:    #FFD400;   /* THE yellow. primary. contrast on bg ≈ 13.9:1 */
--yj-yellow-hi: #FFE45C;   /* hover/active */
--yj-amber:     #C79A00;   /* secondary intensity */
--yj-amber-dim: #6E5A10;   /* tertiary / disabled */
--yj-ink:       #E8E4D4;   /* body text, warm off-white */
--yj-ink-dim:   #94906F;   /* secondary text, silkscreen labels */
--yj-nominal:   #58D68D;   /* status green — sparse, LEDs and OK states only */
--yj-fault:     #FF5C45;   /* clipping, errors, over-threshold */
--yj-select:    rgba(255, 212, 0, 0.14);   /* selection fill */
--yj-cut:       rgba(255, 92, 69, 0.10);   /* cut-region fill, striped */
--yj-wave:      #D9B830;   /* waveform body */
```
Semantics are signal-status: yellow = attention/interactive, green = nominal (tiny LED dots,
"MODEL READY"), red = fault (clipping counts, errors). Never decorative green/red.

## Type
- Labels/UI: "Archivo" (Google Fonts), weights 500/700. ALL-CAPS, letter-spacing 0.08em,
  sizes 10–11px for silkscreen labels, 13px buttons.
- Numbers/readouts/transcript: "IBM Plex Mono", 400/600. Readouts get font-variant-numeric:
  tabular-nums.
- One display moment only: the wordmark "YELLOWJACKET" in Archivo 700, tight, with a
  chevron-striped underbar. No other display type anywhere.

## Signature moves (the things that make it look like nothing else)
1. **Hazard chevrons carry state.** A 45° yellow/black stripe pattern
   (repeating-linear-gradient, 8px pitch) appears ONLY on: the active-tab underbar, progress
   bars (stripes crawl left via background-position animation while working), cut regions in
   the waveform, and the render button while rendering. Stripes = machine is doing something
   or something was removed. Never as decoration.
2. **Silkscreen panel labels.** Every panel gets a tiny caps label pinned to its top-left
   seam like printed lettering: "SIGNAL / TIME DOMAIN", "TRANSCRIPT", "RACK". With a thin
   rule running from the label to the panel edge.
3. **Readout windows.** Numbers live in recessed dark wells (--yj-well, inset border,
   1px inner shadow) like LCD windows: timecode, LUFS, peak. Yellow mono digits.
4. **Transcript as signal.** Words are tokens whose brightness tracks nothing decorative:
   filler words get inverted black-on-yellow treatment; deleted words get struck +
   chevron-hatched; the currently-playing word gets the full --yj-yellow with a hard edge,
   no glow, like an LED segment. Dead-air gaps render as bracketed pills: [ 2.4s ].
5. **Meter ballistics.** Level meters move like VU-ish hardware (fast attack, ~300ms release,
   peak-hold tick that decays), with silkscreen dB ticks. Clip indicator is a red LED square
   that LATCHES until clicked, exactly like hardware.
6. **The spectrogram is on-brand.** Colormap runs black → deep amber → yellow → bone white.
   Heat = energy. It reads as the poster shot of the whole app.
7. **Grid discipline.** Oscilloscope-style: canvas panes get faint division lines
   (10 divisions horizontal), labels at the divisions in 9px mono. Time ruler ticks are
   1/5/10/30/60s adaptive.
8. **No rounded-blob UI.** Corner radius 2px max. Buttons look machined: 1px --yj-line
   border, flat fill, yellow text; primary actions invert (yellow fill, black text).
   :active nudges content down 1px. Focus = 1px yellow outline offset 2px, no glow.
9. **LED dots.** 6px squares (not circles) for status: model loaded, WebGPU vs WASM,
   render fresh/stale. Green nominal, yellow busy (blinking 1Hz step-end), red fault.
10. **Nothing floats.** No shadows except the 1px insets on wells. No blur, no glass,
    no gradient except the chevron pattern and the spectrogram colormap.

## Layout
Single screen, no routing. Header strip: wordmark left, transport (RTZ/play/time readout)
center, I/O (open file / export) right. Below: three tabs — TRANSCRIPT, SIGNAL, RACK — as
machine toggles with the chevron underbar on the active one.
- TRANSCRIPT: left 2/3 transcript panel (scrolling words), right 1/3 control stack:
  model picker + device LED, transcribe button, filler/dead-air tools with counts in
  readout wells, export transcript menu. Waveform strip (compact, 96px) pinned at bottom,
  synced selection.
- SIGNAL: waveform (tall) stacked over spectrogram (taller), shared zoom/scroll and
  playhead; right rail of readout wells: LUFS-I, LUFS-S max, sample peak, true peak (est),
  RMS, crest, DC, clipped count (red when >0). "MEASURE" button runs analysis.
- RACK: modules in canonical order as vertical panel stack, each with power toggle
  (yellow square LED), silkscreen title, param sliders with tick marks + mono value
  readouts. Right rail: render button (chevron crawl while working), A/B toggle
  (ORIGINAL / BENCH), loudness delta readout, export WAV 16/24.
Footer status line: single row, mono, left = state ("IDLE", "TRANSCRIBING · 42%",
"RENDER OK · 00:03.1"), right = device + model + sample rate ("WEBGPU · WHISPER-BASE · 48.0k").

## Copy register (binding)
Instrument-panel terse. Sentence case for prose lines, caps for labels. Dry, concrete,
zero exclamation marks, zero emoji, zero "please". The machine states facts:
- Drop zone: "Drop a file. WAV, MP3, M4A, OGG — it never leaves this machine."
- Empty transcript: "No transcript yet. Load audio, pick a model, hit TRANSCRIBE.
  First run downloads the model (~40–200 MB) and caches it."
- Filler tool: "FLAG FILLERS" → count well "23 FLAGGED" → "CUT FLAGGED"
- Errors name the actual thing: "Decode failed — this file isn't audio this browser
  can read." not "Something went wrong".
No marketing anywhere in the app. The README does the persuading.

## Amendments (2026-09-03 visual pass)
- §Type: buttons are 11px (the app has been 11px; the doc drifted).
- §Signature 1, enumerated hazard sites gain: the underbar of any tab whose
  bench has a job running (dim when it is not the active tab); the 2px left
  rule of a pipeline stage whose job is running.
- §Signature 9: solid amber = stale / rough — a state, not activity; never
  blinks. Under reduced motion, busy = a hollow yellow square.
- §Layout, under the tabs: the pipeline strip SOURCE · SLICE · KIT · PATTERN
  · SONG · OUT as seamed cells; done = yellow left rule + amber note; next =
  dim hazard rule + ink note; here = selection fill; working = crawling
  hazard rule + yellow note (job name, percent where reported).
- §Layout RACK: off modules collapse to their head row; the silkscreen
  carries the chain ordinal 01–09.
- §Layout header, I/O right: SOURCE IN (AUDIO IN, SHELF) | KEEP AND SAVE
  (KEEP, PROJECT OUT) | COMMAND. URL and .YJKT open live in the overlay and
  the deck. Beside PLAY, a sounding readout names what is heard (BENCH,
  MACHINE, LOOM, STUDIO, CLIP), yellow, never blinking.
