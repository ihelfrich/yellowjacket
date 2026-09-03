# 2026-09-03 · Visual observations from screenshots (in-app Chromium, 800 px and 1200 px wide)

What was actually seen this session, as evidence for the visual pass. Each
line is an observation, not a verdict.

## Header and chrome
- Header at 800 px: wordmark, transport (RTZ, PLAY, two timecode wells, speed
  1×), then a second row of nine buttons: UNDO, REDO, AUDIO IN, SHELF, KEEP,
  URL IN, PROJECT IN, PROJECT OUT, COMMAND. All equal weight, all the same
  machined style; the row wraps or clips below ~820 px (a horizontal scrollbar
  appears under it at 800 px).
- Tab bar: six caps labels in one row with the chevron underbar on the active
  one; no other affordance. Tooltips were added today.
- Pipeline bar under the tabs (SOURCE › SLICE › KIT › PATTERN › SONG › OUT):
  small caps with a dim second line each ("CARVE OR HARVEST", "ASSIGN SLICES"),
  the active stage marked with a yellow bar on the left. It is clickable, but
  nothing signals that.
- Status line: one 10.5 px mono row at the very bottom, dim by default; the
  new yellow pulse rule on change. Long messages ellipsize.
- Footer legal line sits between the tab pane and the status line on every
  screen ("YELLOWJACKET is built by Ian Helfrich · personal noncommercial use ·
  organizations require a commercial license · license").

## Benches
- TRANSCRIPT (landing after a load): a hint paragraph, the new wayfinding
  row, then MODEL picker + LED + a full-width yellow TRANSCRIBE, CLEANUP with
  two disabled block buttons and dash wells, GAP THRESHOLD slider, RESTORE ALL,
  NO CUTS well, TRANSCRIPT OUT (TXT SRT VTT JSON), WEAVE WORDS. Waveform strip
  (waveMini) is inside this tab. Everything is a full-width stacked panel.
- SIGNAL: waveform over spectrogram (the spectrogram is the best-looking
  surface in the app: black → amber → yellow → bone).
- RACK: nine module panels stacked, each identical: MODULE silkscreen, a
  yellow square power LED, title, tagline right-aligned, sliders with mono
  value readouts. Off modules dim their sliders but keep full height, so the
  stack is ~9 × 100 px and scrolls under the sticky pipeline bar. The right
  rail: RENDER, LED row, A/B, LOUDNESS Δ well, AUDIO OUT (WAV 16/24/32F). The
  new LIVE PREVIEW strip sits above the columns.
- MACHINE / SLICE: substate chips (SLICE PATTERN PLAY SONG CRATE WIRE) as
  small toggles; the slice canvas with bar labels B1…B78 crowding the top
  edge at 2:40 of audio; a hint line "Drag to carve. Click a clip to hear it.
  Double-click a beat line to pin bar one." Right rail: HARVEST (now first),
  BEATMAP wells (109.2 BPM, CONF 30%), ANALYZE / TAP TEMPO / CLEAR ANCHORS /
  CUT AT BEATS.
- Drop zone overlay: a dashed hazard frame, "DROP A FILE" in large caps,
  three lines of prose, LOAD THE DEMO SONG, the shelf (seven chips, a note
  paragraph of ~5 lines with four links, LIGHT/LOSSLESS switch, a 3-column
  card grid), then OR PICK YOUR OWN, OPEN A .YJKT PROJECT, START WITH 808S,
  MAKE A SOUND WITHOUT AUDIO, and a URL input with LOAD URL. It is long: at
  800 × 828 the grid needs scrolling inside the overlay.
- FIRST RUN modal: a hazard rule, "FIRST RUN" tag, wordmark, a lede, two
  dense paragraphs (~6 lines each at 800 px), six path cards each with a caps
  name and a two-line note, DISMISS and a hint line. It fills the viewport.
- MINE drawer: a bar (count · MB · quota · NEVER UPLOADED) with a compact
  yellow KEEP button right-aligned; cards match the shelf cards, plus a tiny
  REMOVE chip under each.

## Type and density (from css/yj.css)
- Sizes in use: 8.5, 9, 9.5, 10, 10.5, 11, 12.5, 13, 14 px. Mono for labels,
  wells, status; a UI face for prose. Letter-spacing 0.03–0.16 em on caps.
- Panels: 1 px --yj-line border, 2 px radius, silkscreen label at the seam.
  Gap 10 px everywhere; panel padding ~12–16 px.
- Colour: black/yellow with amber and dim ink; blue reserved for "the thing
  you are not hearing"; green nominal, red fault, orange caution, chartreuse
  hot.

## Things that read as friction on screen
- Nine equal header buttons; the eye has no order to follow.
- Uniform full-height module panels on RACK; off modules cost the same space
  as on ones.
- Overlay and first-run screens are paragraphs where a glance was wanted.
- The pipeline bar is the best map of the tool and looks like a caption.
- Bar labels on the slice canvas collide at song length.
- The status line is the only feedback channel and the smallest text on the
  page.
