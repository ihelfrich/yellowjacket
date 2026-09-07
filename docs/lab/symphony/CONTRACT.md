# Thirteen Cards — movement module contract

Each movement is one pure ES module, `js/score/symphony/movement-N.js`
(N = 1..4), implementing movement N of `docs/lab/symphony/design.json`
LITERALLY: every rule, every number, no invention, no randomness.

```js
import { createScore, addPart, addNote } from '../model.js';
export const TITLE = 'Two Metals';             // the movement's title
export const SECONDS = 240;                    // the movement's stated length
export function movement({ cards }) { ... return score; }   // cards: { [cardId]: cardObject } preloaded by the caller
export const FACTS = { seconds: 240, parts: 10, lastOnsetSec: 237.5, notes: { 'brass': 123, ... } };  // what your check script measured
```

Score model (`js/score/model.js`):
- `createScore({ title, sampleRate: 48000 })`
- `addPart(score, { id, card, excitation, pan, rmsDb, gainDb })` → part; `id` = the design's role words shortened to one token (e.g. 'brass', 'plastic-Cs5', 'glass', 'hiawatha', 'fdr', 'thud', 'commons', 'carillon', 'wwv', 'buzzer-breath', 'buzzer-strike', 'ory'). One part per (card, excitation) role in the design; pan and rmsDb from the design.
- `addNote(part, { t, hz, velocity, seconds })`: t and seconds in SECONDS, hz in HERTZ (fractional cents are the point), velocity 0.05..1.
- Helpers you may write in your module: `hz(k, root)` from the movement's scale exactly as its rules define it, bar/beat → seconds from the stated tempo, motif players.

Renderer facts (`js/score/render.js`): a struck/plucked note rings by physics regardless of `seconds` (pass the design's 4); a bowed/blown note sustains for `seconds` and is released at note-off; cap 16 s. Levels: every note lands at −6 dBFS × velocity, then the part is RMS-normalised to its rmsDb. So velocity is both timbre and level.

Cards: `docs/lab/cards/<id>.json`; ids exactly as in the design (`iowa-bells-brass-Cs5`, `iowa-bells-plastic-ff-Cs5`, `iowa-bells-plastic-ff-E5`, `iowa-bells-plastic-ff-A5`, `carillon-bell`, `freesound-wineglass`, `hiawatha-vowel`, `fdr-vowel`, `opz-thud`, `commons-bell-15cm`, `uvb76-buzz`, `wwv-tone`, `ory-chord`).

Rules of the road:
- Read your movement with `jq '.movements[N-1]' docs/lab/symphony/design.json` (and `.orchestration`, `.premise` once). Do not read the other movements.
- Bars are 1-based; bar b starts at (b−1)·barSeconds; beat y of a bar starts at (y−1)·beatSeconds after the bar start.
- Where the design says a velocity or length, use it; where it says "beat rule", apply the movement's stated beat rule.
- Where a rule is ambiguous, choose the reading that keeps the arithmetic the critics checked (named pitches, section boundaries, note counts) and record the choice in a comment.
- Create ONLY `js/score/symphony/movement-N.js` in the repo. Put any check script under the session scratchpad (`/private/tmp/claude-501/-Users-ian/464bd471-1cf3-457c-a68e-f79b533d997f/scratchpad/symphony/`), run it with `node`, and report its output. Do not edit any other repo file. Do not run the test suite.
- Verify yourself before returning: the last onset and the total length match the design; the named pitches appear at the stated bars; note counts per part are plausible; no NaN; no note before 0.
