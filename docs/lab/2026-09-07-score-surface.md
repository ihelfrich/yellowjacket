# 2026-09-07 — The score surface: what an audit of the whole app found, and what was built from it

Ian asked whether the application could be improved meaningfully. Rather than
guess, seven auditors were sent at seven dimensions of the repository — cold
start, the physics the card engine can represent, the composition surface,
defects, performance, keeping and sharing work, and access — and every claim
each returned was handed to a separate agent whose job was to refute it. This
note records what survived, what was built, and what was measured on the way.

## 1. The finding the audit converged on

Everything downstream of "measure a real object" was write-only or out of
reach in the browser.

- The 13-minute piece existed only as four hand-written JavaScript modules
  rendered by a Node script. Browser and CLI could exchange nothing but a
  semitone-rounded MIDI file, which destroys the non-12-TET pitches that are
  the point of the card work.
- The in-page render path allocated three full-length 96 kHz buffers:
  measured at about 1.1 GB for the 784 s of *Thirteen Cards*, in a tab
  observed resetting past ~780 MB. That is why the piece was rendered by
  Node, one movement at a time.
- Every pitch the browser could produce was 12-TET. The instrument panel
  showed an object's measured scale in cents and then played a different one.
- The measured instruments that ship in the repository — the only thing
  in the bench that sounds with no file, no download and no network — were
  named on exactly one surface: positions 9 to 18 of a native select, marked
  with an undefined `◇`.
- A card was write-only: KEEP downloaded a `.json` that nothing could open.
- `sw.js` precached ten of the thirteen cards the symphony needs, so an
  offline render would have failed on the three Iowa bells.

## 2. What was built

**A score file** (`yj-score-1`, `js/score/model.js`). `scoreToJson` /
`scoreFromJson`, hertz and seconds, cards embedded whole or referenced by id
where the id is a fingerprint of the source samples. `scripts/render-score.mjs`
reads the same file, so a score written in the browser renders on a terminal
and back. Serialized movement III is 89,231 bytes: eight of its ten parts are
refs, two embed because only the C#5 Iowa bell is on the found list.

**A block renderer** (`renderScoreBlocks`). Peak resident audio is one block
rather than the whole piece; a note that straddles a boundary is carried in an
overlap window. Pinned to `<= 1e-9` sample-for-sample against the whole-buffer
path — including for a part written out of chronological order, which is not
hypothetical: movement 4 has three such notes (brass 231, thud 88 and 210),
and before the fix the block path diverged from the whole path by 2.98e-1.

**A SCORE panel** (`js/app/score-panel.js`), under the STUDIO roll. Open a
score file, take the four movements of *Thirteen Cards*, or turn what is on
the roll right now into a score; render it here with progress and cancel;
hand the render to the bench or save the WAV. Note renders go to the worker
pool. Measured in the page: movement III, 10 parts, 677 notes, rendered in
**61 s** to a 43.1 MB WAV, which the bench then decoded as 02:36.929,
"MATCHED · NO CONVERSION". The same render on the main thread without the
pool had not finished at 157 s.

The file the panel writes is byte-identical to the file the whole-buffer
encoder writes (pinned in `test/cases-score-panel.mjs`). That holds because
24-bit never dithers, so a block encoded alone is the same bytes as that span
inside a whole-file encode; a 16-bit stream would have to carry the dither
generator across blocks and is deliberately not offered.

**Cents on a step.** A STUDIO step carries an optional `cents`; the sounding
pitch is note + cents/100 semitones, through both the synth and the card
voices, through `compileStudioScore`, and into a score file. With cents zero
or absent every frequency is bit-identical to before.

**Honest classification.** The bar/tunedBar hypothesis was scored in-sample —
its free parameter was fitted on the same two overtones it was then judged
against — so shells passed as confident bars and "no known family" never
fired. Every family is now scored over all measured ratios with a stated
charge for a free parameter. See `2026-09-07-classifier-honesty.md`.

**The front door.** Eleven named buttons on the intake overlay, each of which
strikes a real measured object and reports what it is: `CARILLON ·
Eulenspiegel noon chime · PD · G5 787.1 Hz · 4 MODES · 2.49 s TO −60 dB`.
Then one button puts it on a STUDIO part. The overlay gained a way past
itself, and a ⌘K jump no longer switches tabs behind it.

## 3. What is settled

- A score is a file, not a module. Anything that wants to compose for these
  instruments writes `yj-score-1`.
- Long renders go through blocks. The whole-buffer path stays because it is
  the reference the block path is pinned against, not because it is the way
  to render a piece.
- 24-bit is the streaming format. Not a preference — the dither state is what
  makes 16-bit unstreamable block by block, and it is not worth carrying.
- Escape belongs to whatever is on top. The surfaces above the intake mark
  the key consumed; the intake declines an Escape another surface took.

## 4. What would overturn it

- If a score ever needs per-note articulation beyond excitation and velocity,
  `yj-score-1` gains a field and the version goes to 2. The reader already
  refuses an unknown `format` by name.
- The 61 s figure is one machine, one movement, with a warm worker pool. A
  slower machine renders the four movements in something closer to ten
  minutes, and at that point the panel should stream to a file handle rather
  than build a Blob.
- The panel renders a movement at a time on purpose. The whole piece is about
  220 MB, past the point where handing it to the bench is kind.

## 5. Still true, and still the only thing that matters

Nobody has listened. The measurements say the piece is balanced, in range,
unbroken, and now reachable from the page. Whether it is music is the one
thing none of this measures.
