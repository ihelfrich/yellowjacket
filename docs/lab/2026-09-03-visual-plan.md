# 2026-09-03 · Visual plan

Synthesis of the 27 proposals scored by two judges against
`docs/lab/2026-09-03-visual-observations.md` and `docs/DESIGN.md`. Fifteen
steps survive; each is shippable on its own, ordered so nothing later is
required by anything earlier. Line numbers are the tree as of this morning
(`css/yj.css` 865 lines, `js/app/pipeline-ui.js` 171, `js/main.js` 531,
`js/app/bench-controller.js` 837). Contrast ratios below were recomputed
from the `:root` hexes, not copied from the proposals.

Verification viewports are the two the observations used: 800 × 828 and
1200 × 828, in-app Chromium, repo served the way `docs/SMOKE.md` serves it.
"Owner decision" marks the one step that changes what is always on screen.

## Order

| # | step | files | depends on |
|---|------|-------|------------|
| 1 | RACK: off module = 44 px head row; silkscreen = chain ordinal | yj.css, bench-controller.js | — |
| 2 | LEDs: blink only while working; STALE is solid amber | main.js, yj.css, bench-controller.js, machine/controller.js | — |
| 3 | Slice canvas: bar labels on a cadence | slice-ui.js | — |
| 4 | Pipeline strip: seams for glyphs, legible notes | pipeline-ui.js | — |
| 5 | Pipeline strip: YOU ARE HERE | pipeline-ui.js, main.js | — (same file as 4; land 4 first) |
| 6 | Status footer: live region, 11 px, faults wrap | index.html, yj.css, main.js | — |
| 7 | Resume panel first; say when a discard was survived | persist-controller.js, yj.css, index.html | — |
| 8 | One job registry; the owning tab's underbar crawls | main.js, yj.css, 5 call sites | — |
| 9 | Pipeline stage note carries the running job | pipeline-ui.js, main.js, 3 call sites | 8 |
| 10 | Header I/O: three seamed groups, seven buttons | index.html, yj.css | — |
| 11 | Credit row out of the bench flow (owner decision) | index.html, yj.css, main.js, bench-controller.js | — |
| 12 | One focus rule; disabled primary legible | yj.css | — |
| 13 | Transport tells the truth: `ended` fix + sounding readout | bench-controller.js, transport.js, index.html, yj.css | 10 |
| 14 | prefers-reduced-motion covers every animation | yj.css, pipeline-ui.js | 8, 9 (selectors; harmless earlier) |
| 15 | DESIGN.md amendments | docs/DESIGN.md | whichever shipped |

---

## 1 · RACK: an off module is a 44 px head row; the silkscreen prints the chain ordinal

**Observation.** §Benches / RACK: "Off modules dim their sliders but keep full
height, so the stack is ~9 × 100 px and scrolls under the sticky pipeline
bar." §Friction: "off modules cost the same space as on ones." Nine panels
each carry the silkscreen `MODULE` (bench-controller.js:392) — nine copies
of a label that distinguishes nothing, while the one fact only the rack
knows, the position in the signal path, is unprinted (chain.js:158: "rack
order is part of the sound").

**Rule.** §Layout RACK — "each with power toggle (yellow square LED),
silkscreen title"; the toggle and title are the required marks, sliders on a
bypassed module are not. §Signature 2 — a printed label says what the panel
is. §Signature 9 — the LED carries the state.

**Change.**

- `css/yj.css:600` — replace
  `.yj-mod.is-off .yj-mod-params { opacity: 0.35; pointer-events: none; }`
  with
  `.yj-mod.is-off .yj-mod-params { display: none; }`
  `.yj-mod.is-off { padding-bottom: 8px; }`
  (`.yj-mod.is-off` outranks `.yj-panel`'s `22px 12px 12px`). No transition:
  the panel snaps like a hardware bypass. Collapsed height = 22 top pad + 14
  head + 8 bottom = 44 px. All-off stack = 9 × 44 + 8 × 10 gap = 476 px.
- `js/app/bench-controller.js:388` — `for (const desc of REGISTRY)` becomes
  `REGISTRY.forEach((desc, i) => { … })`; `:392` becomes
  `mod.dataset.label = String(i + 1).padStart(2, '0');`. No CSS: the
  silkscreen utility already sets 10 px / 600 / ink-dim at the seam.
- `:396-398` — after `power.title = 'Power';` add
  `power.setAttribute('aria-pressed', String(cfg.on));`
  `:436-439` (click handler) — add
  `power.setAttribute('aria-pressed', String(cfg.on));` after the toggle.

Side effect worth keeping: sliders in off modules were still Tab-focusable
behind `pointer-events: none`; `display: none` removes them from the tab
order.

**Verify.** 1200: RACK with everything off shows nine 44 px rows reading
`01 ▪ HIGH-PASS  Rumble and desk thumps…` — order, LED, name, purpose in one
line — and `#rackHost` does not scroll. Switch EQ on: its seven rows appear
under its head, modules below shift down, the LED you clicked stays under
the cursor. Bypass a module mid-A/B: the LED you clicked does not move (only
rows below it do). 800: stacked layout; the rack block is ~476 px all-off,
the pane scrolls as a whole. Tab from LIVE PREVIEW: focus lands on power
squares for off modules and on sliders only for on modules; VoiceOver reads
"Power, toggle button, pressed / not pressed".

**Cost.** You can no longer set a parameter before powering a module on;
`cfg.params` persist, so power → set → power off is the same edit and you
hear it while setting.

---

## 2 · LEDs: blink only while working; STALE is solid amber; the model LED stops standing in for the job

**Observation.** DESIGN.md §9 lists "render fresh/stale" as an LED job, but
`setRenderState(COPY.renderStale, 'busy')` (bench-controller.js:261, :448)
blinks the LED when idle-and-stale, while an actual render (:596-601)
stripes the button and leaves the LED alone — the LED blinks when nothing
is happening and holds still while working. Transcribe blinks `#ledModel`
(:196) whose label is the model state, so a running job and a loaded model
share one dot. `#ledBeatmap` uses `busy` for a 30–60 % confidence tempo
(machine/controller.js:366), which is a confidence, not activity.

**Rule.** §Signature 9 — "yellow busy (blinking 1Hz step-end)": blinking is
reserved for activity. §Palette — `--yj-amber: secondary intensity` is the
natural non-blinking fourth value. Doctrine: every mark carries one state.

**Change.**

- `js/main.js:113-116` `setLed` — add the mode:
  `mode === 'stale' ? ' is-stale'` alongside on/busy/fault.
- `css/yj.css` after `:298` — `.yj-led.is-stale { background: var(--yj-amber); }`
  (amber on panel 7.24:1; solid, so it reads as a state).
- `js/app/bench-controller.js:261` and `:448` —
  `setRenderState(COPY.renderStale, 'stale')`.
- `:601` — after `status(COPY.rendering, true);` add
  `setRenderState(COPY.rendering, 'busy');` (the `finally` path already
  writes the terminal state via `:589`).
- `:196` — move `setLed('ledModel', 'busy')` inside the
  `if (currentModel !== modelId || !transcriber.modelLoaded)` block at
  `:200`, directly before `await transcriber.loadModel(modelId)`; `:207`
  `setLed('ledModel', 'on')` stays. The transcribe job itself is shown by
  the button stripes, `#progTrans`, and (step 8) the tab underbar.
- `js/machine/controller.js:366` —
  `setBeatmapLed('stale', analysis.tempo.toFixed(1) + ' BPM · ROUGH')`.

**Verify.** 1200 RACK: hit RENDER → LED blinks, text RENDERING; done → green
`RENDER OK`; move any slider → solid amber, text STALE, no blink. MACHINE
rail with the demo (CONF 30 %): BEATMAP LED solid amber
`109.2 BPM · ROUGH`. TRANSCRIPT with a cached model: TRANSCRIBE stripes the
button, the model LED stays green throughout. 800: identical; LEDs are 7 px
squares at both widths.

---

## 3 · Slice canvas: bar labels on a chosen cadence

**Observation.** §Benches / MACHINE: "bar labels B1…B78 crowding the top
edge at 2:40 of audio"; §Friction: "Bar labels on the slice canvas collide at
song length." `slice-ui.js:471-478` labels every bar unless it is within
30·dpr px of the previous label — a greedy skip that yields B1 B3 B6 B8 …
with no readable rhythm. `_drawRuler` in the same file (`:548-553`) already
picks a step from `RULER_STEPS` against `minSpacing` and is the model to
copy. Both judges: bounded canvas risk because it mirrors `_drawRuler`; the
guard on `beats[down + bpb]` is a shipping condition.

**Rule.** §Signature 7 — "labels at the divisions in 9px mono. Time ruler
ticks are 1/5/10/30/60s adaptive" — the bar ruler is held to the same
adaptive discipline.

**Change** (`js/machine/slice-ui.js`, the bar branch at `:455-478`):

Before the loop, with `toX` already in scope:
```js
const barPx = (down + bpb < beats.length && beats[down + bpb] > beats[down])
  ? toX(beats[down + bpb]) - toX(beats[down]) : Infinity;
const MIN_LABEL_PX = 48 * dpr;
let labelStep = 1;
while (barPx * labelStep < MIN_LABEL_PX) labelStep *= 2;   // 1,2,4,8,16…; Infinity → 1
```
Inside the bar branch, replacing `:470-477` and dropping `lastLabel`:
```js
const n = (i - down) / bpb + 1;
const anchored = i === down && this._anchors.barOneTime != null;
const labelled = n >= 1 && ((n - 1) % labelStep === 0 || anchored);
g.fillStyle = c.barLine;
g.fillRect(x, 0, labelled ? barW : 1, h);      // heavy line = labelled bar
if (labelled) {
  g.fillStyle = anchored ? c.yellow : c.inkDim;
  g.fillText('B' + n, x + 3 * dpr, 17 * dpr);
}
```
Heavy lines and labels are now the same grid, so the cadence stays visible
where a label is clipped. Font stays 9·dpr px mono. Same ladder rule for any
other canvas that ever labels divisions: a step from 1/2/5 (s, Hz) or
1/2/4/8 (bars) such that adjacent label origins are ≥ 48 px apart at dpr 1;
never skip individual labels by measuring the previous one.

**Verify.** 1200 MACHINE/SLICE with the demo (78 bars, ~14 px per bar in a
~1100 px canvas): step 4 → labels B1 B5 B9 …, heavy lines under those bars
only, thin lines elsewhere. Zoom in until bars exceed 48 px: every bar
labelled, identical to today. Double-click a beat line off-cadence to pin
bar one: a yellow B1 appears at the anchor regardless of step. 800
(~700 px canvas, ~9 px per bar): step 8 → B1 B9 B17 …. Fewer than `bpb + 1`
beats in the map: every bar labelled, as today.

---

## 4 · Pipeline strip: seams for glyphs, legible notes

**Observation.** §Header: the strip is "small caps with a dim second line";
§Friction: "The pipeline bar is the best map of the tool and looks like a
caption." In `pipeline-ui.js` STYLE: stages are `border: none; background:
none` with a 6 px rotated-chevron `::after` (`:22-28`) — breadcrumb
typography; `.yj-pipe-note` is `--yj-line-hi` on panel = **1.57:1**
(`:33-36`), so `DROP A FILE` / `CARVE OR HARVEST` are below legibility on the
one row that tells a new user what to do next. Judges: seams and the note
floor are right; the proposed `border-top` doubles the hairline the tabs
already draw, and `flex: 1` makes the strip louder than the tabs above it —
both dropped here.

**Rule.** §Signature 8 — machined means "1px --yj-line border, flat fill";
§Palette — `--yj-line` is "hairline rules, panel seams", `--yj-ink-dim` is
"secondary text, silkscreen labels" (the note is a silkscreen label; it is
set in seam colour today). §Copy — "The machine states facts": a fact set
below legibility is not stated.

**Change** (all in the STYLE string of `js/app/pipeline-ui.js`):

- Delete `.yj-pipe-stage::after { … }` (`:22-27`) and
  `.yj-pipe-stage:last-child::after` (`:28`).
- `.yj-pipe-stage` (`:16-21`): add `border-right: 1px solid var(--yj-line);`
  keep `min-width: 96px`, no `flex`.
- Add `.yj-pipe-stage:last-child { border-right: none; }`.
- `.yj-pipe-note` (`:33-36`): `color: var(--yj-ink-dim);` (5.83:1).
- `.yj-pipe-stage.is-next .yj-pipe-note` (`:40`): `color: var(--yj-ink);`
  (14.8:1). `.is-done .yj-pipe-note` stays `--yj-amber` (7.24:1).
- Add `.yj-pipe-stage:hover { border-right-color: var(--yj-line-hi); }`
  next to the existing name-colour hover — the same seam-raise `.yj-btn:hover`
  uses.

Note colours become a three-step readout: dim = not yet, ink = next, amber =
what you have.

**Verify.** 1200: six cells separated by hairlines, no chevrons; `CARVE OR
HARVEST` reads at arm's length; strip height unchanged (padding untouched);
exactly one hairline between the tab row and the strip. Hover a cell: its
right seam brightens with the name. 800: the strip still scrolls sideways
inside `overflow-x: auto` if it must; seams survive the scroll.

---

## 5 · Pipeline strip: YOU ARE HERE

**Observation.** §Header: "the active stage marked with a yellow bar on the
left. It is clickable, but nothing signals that." The observer read the
yellow bar as "active" — in code (`pipeline-ui.js:43-46`) that bar means
`is-done`, `is-next` gets the dim hazard bar, and nothing marks the stage
the user is standing on. The map's one required mark is missing and its
done-mark is being read as it.

**Rule.** §Palette — `--yj-select` is "selection fill": the stage you occupy
is the selected cell. §Signature 1 — no new hazard site. Doctrine: a state
added with zero elements added.

**Change.**

- `js/app/pipeline-ui.js` `deriveStages`: give every stage an explicit
  `here` list (no "last match wins" — KIT and PATTERN both target `pattern`,
  and OUT targets `song` when a chain exists, which would otherwise light
  OUT while you stand on SONG):
  - SOURCE `here: [{tab:'transcript'},{tab:'signal'},{tab:'rack'}]`
  - SLICE `here: [{tab:'machine', mstate:'slice'}]`
  - KIT `here: []`
  - PATTERN `here: [{tab:'machine', mstate:'pattern'}]`
  - SONG `here: [{tab:'machine', mstate:'song'}]`
  - OUT `here: []` (an action, not a place)
- `PipelineView`: `this._here = null` in the constructor;
  `setHere(loc) { this._here = loc || null; this._render(); }`.
  In `_render`, per stage:
  `const here = this._here && (stage.here || []).some(h => h.tab === this._here.tab && (!h.mstate || h.mstate === this._here.mstate));`
  → class `is-here`, `btn.setAttribute('aria-current', 'location')`, and
  `btn.title = (stage.hint || stage.label) + ' · you are here'`. Because
  `_here` is stored, the class survives the full rebuild `setStages` does on
  every store change.
- STYLE: `.yj-pipe-stage.is-here { background: var(--yj-select); }` — done
  and next keep their left bars.
- `js/main.js`: `let currentMstate = 'slice';` near `showTab` (`:224`). At
  the end of `showTab(name)` call
  `if (views.pipeline) views.pipeline.setHere({ tab: name, mstate: currentMstate });`.
  Add one delegated listener:
  `document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.yj-substate-btn'); if (!b) return; currentMstate = b.dataset.mstate; if (views.pipeline) views.pipeline.setHere({ tab: 'machine', mstate: currentMstate }); });`
  Both `jump()` (`:290`) and the pipeline's own jump handler (`:274-280`)
  end in `.click()` on the substate button, so both paths are covered
  without touching `machine/controller.js:816`.

**Verify.** 1200: after loading the demo on TRANSCRIPT, SOURCE has the
selection fill and its yellow done-bar; click SLICE → SLICE filled, SOURCE
keeps only its bar; PATTERN chip → PATTERN filled, KIT not; SONG chip with
a chain → SONG filled, OUT not. Cut a word (store change) → the fill stays.
STUDIO / LOOM: strip hidden, nothing lit. 800: the fill spans the cell
between its seams.

---

## 6 · Status footer: live region at label size; faults readable in full

**Observation.** §Header: "Status line: one 10.5 px mono row at the very
bottom, dim by default … Long messages ellipsize." §Friction: "the only
feedback channel and the smallest text on the page." `<footer
class="yj-status">` (index.html:485) has no `role` or `aria-live`; the only
live region in the page is `#updateBar`. `RENDER IS STALE · the edit moved
after the last render. HIT RENDER, THEN EXPORT.` (bench-controller.js:678)
is cut by `text-overflow: ellipsis` (yj.css:751) at 800 px. Ink-dim on panel
is 5.83:1, so size, not colour, is the limit.

**Rule.** §Layout — "Footer status line: single row, mono" (kept for every
nominal message). §Type — "sizes 10–11px for silkscreen labels"; 11 is
inside the rule. §Copy — "Errors name the actual thing" is the one case that
outranks the row count.

**Change.**

- `index.html:485` — `<footer class="yj-status" role="status" aria-live="polite">`.
- `css/yj.css:746` — `font-size: 11px;` (padding stays `6px 16px`).
  Add `.yj-status > :first-child.is-fault { white-space: normal; }`.
- `js/main.js:99-111` — in `statusFault`: `el.title = msg;` and
  `el.parentElement.setAttribute('aria-live', 'assertive');`
  in `status`: `el.removeAttribute('title');`
  `el.parentElement.setAttribute('aria-live', 'polite');`.
  No second element, no nested roles.
- Chatter guard, optional: progress ticks (bench-controller.js:188,
  source-controller.js:356) call `status()` per percent; a polite region
  coalesces them. If VoiceOver still stutters, announce only when the text
  before ` · ` changes.

**Verify.** 1200 RACK: render, cut a word, hit WAV 16 → the red stale message
reads in full on one line, hover shows it as a tooltip too. 800: the same
message wraps to two lines; every other message stays one row. The status
text now matches the 11 px button face and sits above the 10 px silkscreens.
VoiceOver: `RENDER OK · 00:03.1` is spoken on completion without focus
leaving the bench.

---

## 7 · Resume panel first; say when a tab discard was survived

**Observation.** §Benches / overlay: "It is long: at 800 × 828 the grid needs
scrolling inside the overlay." The `LAST SESSION · …` panel
(persist-controller.js:140-149) sits *below* the headline, the demo button,
and the shelf grid (index.html:456), i.e. off-screen at 800 × 828 on the one
arrival where it is the only thing you want. persist flushes on
`visibilitychange → hidden` and `pagehide` (`:296-300`), so a browser tab
discard is survived, and nothing says so; after RESUME the status says only
`RESTORED · NAME` (`:475`). Chromium exposes `document.wasDiscarded` for
exactly this.

**Rule.** §Signature 1 — chevrons mean "something was removed": the tab's
working set was. §Signature 10 — "Nothing floats": no toast; the fact goes
in the panel that already exists. §Copy — states the fact, no exclamation.

**Change.**

- `index.html:456-462` — move `#resumePanel` to sit immediately after
  `.yj-drop-word` (before the `<p>`). Add `role="status"` to `#resumeInfo`
  (`:457`).
- `css/yj.css:379-387` `.yj-resume` — `border-top` → `border-bottom`,
  `padding-top: 14px` → `padding-bottom: 14px`, add `position: relative;`
  (the hazard underbar of DROP A FILE is already the rule above it).
  Add `.yj-resume.is-discarded::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--yj-hazard); }`
  and `.yj-resume.is-discarded { padding-left: 12px; }` — a pseudo, not
  `border-image`, so the bottom hairline stays plain.
- `js/app/persist-controller.js:140` — `const discarded = document.wasDiscarded === true;`
  if `discarded`, `bits[0] = 'THE BROWSER DISCARDED THIS TAB · SAVED ' + timeAgo(json.savedAt || Date.now()).toUpperCase();`
  and `$('resumePanel').classList.toggle('is-discarded', discarded)`.
  After `$('resumePanel').hidden = false;` (`:149`): `$('btnResume').focus();`.
- `:475` — when `discarded`, `parts[0] += ' · AFTER A TAB DISCARD'`.
- Non-Chromium: `wasDiscarded` is `undefined`, panel renders as today.

**Verify.** 800 × 828, Chromium: with a saved session, reload → the RESUME
panel is directly under DROP A FILE, in view without scrolling, RESUME
focused (Enter resumes). Discard the tab (chrome://discards → Urgent
discard), return → the panel carries a 4 px hazard rule on its left and
reads `THE BROWSER DISCARDED THIS TAB · SAVED 2 MIN AGO · 12 WORDS …`;
status after resume: `RESTORED · NAME · AFTER A TAB DISCARD`. Plain reload:
no hazard rule, text as today. 1200: same, centred in the overlay.
`wasDiscarded` is true only on that one reload, so the rule cannot become a
banner.

---

## 8 · One job registry; the tab that owns a running job crawls its underbar

**Observation.** §Friction: "Long jobs (transcribe, render, harvest, beat
map) report only [in the status line]." `#progTrans` (index.html:169) lives
in the TRANSCRIPT rail, `#progRender` (`:277`) in the RACK rail; HARVEST
(machine/controller.js:964-966), decode/fetch (source-controller.js:65,
:323), RESTORE (persist-controller.js:407) each stripe their own button —
all invisible from any other tab. Eight `classList.add('is-working')`
sites, no shared registry.

**Rule.** §Signature 1 — the active-tab underbar is an enumerated hazard
site and "stripes crawl left … while working. Stripes = machine is doing
something." §Signature 9 — "yellow busy". Zero elements added. The
non-active-tab crawl is a new site → recorded in step 15.

**Change.**

- `js/main.js`, next to `status()` (`:99`):
  ```js
  const jobs = new Map();                       // tab → Set(name)
  for (const b of document.querySelectorAll('.yj-tab-btn')) b.dataset.title = b.title;
  function paintJobs(tab) {
    const btn = $('tabBtn-' + tab); if (!btn) return;
    const names = [...(jobs.get(tab) || [])];
    btn.classList.toggle('is-working', names.length > 0);
    btn.title = btn.dataset.title + (names.length ? ' · WORKING: ' + names.join(', ') : '');
  }
  function beginJob(name, tab) {
    if (!tab) return { end() {} };
    const set = jobs.get(tab) || new Set(); set.add(name); jobs.set(tab, set);
    paintJobs(tab);
    let done = false;
    return { end() { if (done) return; done = true; set.delete(name); paintJobs(tab); } };
  }
  ctx.api.beginJob = beginJob;
  ```
- `css/yj.css` after `:183`:
  `.yj-tab-btn { position: relative; }`
  `.yj-tab-btn.is-working::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 5px; background: var(--yj-hazard-dim); animation: yj-crawl 0.7s linear infinite; }`
  `.yj-tab-btn.is-active.is-working::after { background: var(--yj-hazard); }`
  (`bottom: -5px; height: 5px` covers exactly the 5 px border the tab already
  reserves; `border-image` cannot animate, hence the pseudo; `yj-crawl`
  exists at `:144`.)
- Call sites — `const job = ctx.api.beginJob('TRANSCRIBE', 'transcript')`
  at bench-controller.js:194, `job.end()` in the `finally` at `:231-236`;
  `'RENDER', 'rack'` at `:597` / `:631`; `'SPECTROGRAM', 'signal'` around
  source-controller.js:158-167 (`end()` in the `.finally`); `'BEATMAP',
  'machine'` at the top of `runAnalysis` (source-controller.js:225) with
  `end()` where its result lands — the `setBeatmapLed` terminal writes
  (machine/controller.js:360-370) and the `ctx.api.analysisFault` path; `'HARVEST', 'machine'` at
  `:964`, `end()` in both `onmessage` (`:974`) and `onerror` (`:1019`) — the
  harvest worker has no `finally`, only these two exits, so both must end.
  Decode/fetch and RESTORE register nothing (the overlay is up).

**Verify.** 1200: start TRANSCRIBE, switch to RACK → TRANSCRIPT's underbar
shows a dim crawling stripe; switch back → the active underbar itself
crawls in full yellow; finish → static hazard bar as before. Hover the tab
while working: title ends `· WORKING: TRANSCRIBE`. HARVEST from SLICE, go to
SIGNAL → MACHINE crawls; terminate the worker in devtools → `onerror` ends
it. Load the demo and stay on TRANSCRIPT → SIGNAL then MACHINE crawl in turn
(spectrogram, then beatmap). 800: same; tab row height unchanged.

---

## 9 · Pipeline stage note carries the running job and its percent

**Observation.** Spectrogram and beatmap run after every load and report
only in `#specNote` (source-controller.js:158-161) and `#sliceNote` /
`#ledBeatmap` (machine/controller.js:370, :842) — invisible from
TRANSCRIPT, SIGNAL, RACK. HARVEST refuses with "analyze the track first"
(`:961`), sending the user to find a job they cannot see. The strip's own
header (pipeline-ui.js:1-4) says it "is a status readout as much as a
navigation bar", but its notes only know done/next. Judges: belt and braces
with step 8, and the percent earns the second belt; job state must survive
`_render` and ticks must not rebuild the DOM.

**Rule.** §Signature 1 — the stage already uses a 2 px left rule (yellow =
done, dim hazard = next); crawling hazard is the natural third value.
§Layout — the footer stays one row because the percent moves to the stage.
§Copy — terse caps.

**Change.**

- `js/main.js` registry from step 8 — `beginJob(name, tab, stageKey)`;
  the returned handle gains `note(pct)`. Keep `working = new Map()`
  (stageKey → `{name, pct}`); `beginJob` sets it and calls
  `views.pipeline.setWorking(stageKey, {name, pct: null})`; `note(pct)`
  updates pct and calls it again; `end()` deletes and calls
  `setWorking(stageKey, null)`.
- `js/app/pipeline-ui.js` `PipelineView`: `this._working = new Map()`;
  `setWorking(key, w)` stores `w` (or deletes) and patches in place:
  `const btn = this.host.querySelector('[data-key="' + key + '"]')`; toggle
  `is-working`; set its `.yj-pipe-note` text to
  `w ? w.name + (w.pct != null ? ' · ' + Math.round(w.pct) + '%' : '') : (stage.note || '—')`.
  `_render` consults `_working` when it builds, so a store change mid-job
  keeps the readout.
- STYLE, placed **after** the `.is-done::before` / `.is-next::before` rules
  so it wins at equal specificity:
  `.yj-pipe-stage.is-working::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; background: var(--yj-hazard); animation: yj-crawl 0.7s linear infinite; }`
  `.yj-pipe-stage.is-working .yj-pipe-note { color: var(--yj-yellow); }`
- Stage keys: spectrogram → `slice` (`'SPECTROGRAM'` — SLICE is what waits
  on it), beatmap → `slice` (`'MAPPING BEATS'`), harvest → `slice`
  (`'HARVESTING'`), song render / freeze → `out` (`'RENDERING'` with pct
  where the job reports one). RACK render is not on this map; step 8 covers
  it. Transcribe is not a stage; step 8 covers it.
- Then stop flipping the canvas notes between hint and job text
  (source-controller.js:158, :161; machine/controller.js:842, :370): the
  canvas note keeps the hint, the stage keeps the job — one place per fact.
  Keep the fault text in `#specNote` (`'Spectrogram fault — see console.'`):
  a fault is named where it happened.

**Verify.** 1200: load the demo, stay on TRANSCRIPT → the SLICE cell's note
reads `SPECTROGRAM`, then `MAPPING BEATS`, in yellow with a crawling 2 px
rule, then `CARVE OR HARVEST` in ink (next). Hit HARVEST during `MAPPING
BEATS` → the fault "analyze the track first" now points at something you
can see. HARVEST from SLICE, go to RACK → SLICE reads `HARVESTING`. 800:
`MAPPING BEATS · 62%` in 9 px mono is ~95 px, inside the 96 px cell; no
overflow.

---

## 10 · Header I/O: three seamed groups, seven buttons, COMMAND anchored right

**Observation.** §Header: "a second row of nine buttons … All equal weight
… the row wraps or clips below ~820 px (a horizontal scrollbar appears under
it at 800 px)." §Friction: "the eye has no order to follow." All nine have
command-deck entries (main.js:315-330); URL IN and PROJECT IN already exist
as controls inside the overlay (`#urlInput` + `#btnLoadUrl`,
`#btnProjectOpen2`), so the header is the third copy of those two.

**Rule.** §Layout — "I/O (open file / export) right": the slot was specified
for in and out, not for every route in. §Palette — `--yj-line` is the
grouping mark `.yj-history` already uses. §Signature 10 — grouping by seam,
not by box.

**Change.**

- `index.html:117-129`: keep `.yj-history` (UNDO REDO) first; wrap
  `#btnOpen` + `#btnField` in
  `<div class="yj-io-group" role="group" aria-label="Source in">`; wrap
  `#btnKeep` + `#btnProjectSave` in
  `<div class="yj-io-group" role="group" aria-label="Keep and save">`; add the
  `hidden` attribute to `#btnOpenUrl` and `#btnProjectOpen` (keep them —
  the deck actions `open-url` / `project-open` and the first-run route
  `project` (main.js:448) call `.click()` on those ids, and
  `HTMLElement.click()` fires on a hidden element, so no JS changes);
  `#btnCommand` last.
- `#btnField` title: append ` — plus a URL box and .YJKT project open` so
  SHELF is understood as the door to every source.
- `css/yj.css` after `:104`:
  `.yj-io-group { display: flex; gap: 6px; padding-right: 8px; margin-right: 2px; border-right: 1px solid var(--yj-line); }`
  `.yj-btn-command { margin-left: auto; }`
  `.yj-io { flex-wrap: wrap; }`
- `:771` — replace `.yj-io { width: 100%; overflow-x: auto; padding-bottom: 2px; }`
  with `.yj-io { width: 100%; }` so the row wraps instead of clipping.

**Verify.** 1200: the row reads `UNDO REDO | AUDIO IN SHELF | KEEP PROJECT
OUT … COMMAND ⌘K` with two hairline seams and COMMAND alone at the far
right. 800: seven buttons on one or two lines, no horizontal scrollbar under
the header. ⌘K, type `url` → OPEN A URL still works; first-run path OPEN A
YELLOWJACKET PROJECT still opens the picker; SHELF opens the overlay where
the URL box and the .YJKT button are. KEEP stays beside SHELF, so the SMOKE rows that name it still hold.

**Cost.** URL IN and PROJECT IN lose their one-click header route; they are
one step through SHELF or the deck.

---

## 11 · Credit row out of the bench flow — owner decision

**Observation.** §Header: "Footer legal line sits between the tab pane and
the status line on every screen." `.yj-credit` (yj.css:535-538; index.html:
474-478) is a 10 px mono row with `padding: 10px 16px 14px` — about 34 px
above the one row the eye checks for feedback. The judges split between
moving it (hierarchy-08) and folding it into the status row
(density-credit-into-status); this merges them so the licence link stays on
every bench, the sentence stays verbatim at the door, and the footer is one
row.

**Rule.** §Layout — "Footer status line: single row, mono, left = state,
right = device + model + sample rate": one footer row was specified and the
app grew a second. §Copy — "No marketing anywhere in the app. The README
does the persuading."

**Change.**

- `index.html:474-478` — move the whole `.yj-credit` div to be the last
  child of `.yj-drop-inner` (after `#ripHelp`). `css/yj.css:537` — padding
  becomes `6px 0 0`; nothing else changes. It is seen on every arrival and
  every time SHELF opens.
- `index.html:487` —
  `<div id="stRight"><span id="stDevice">NO FILE</span><a class="yj-status-license" href="https://github.com/ihelfrich/yellowjacket/blob/main/LICENSE.md" target="_blank" rel="noopener" title="Personal noncommercial use · organizations require a commercial license">LICENSE</a></div>`
  `css/yj.css`: `.yj-status-license { color: var(--yj-amber-dim); text-decoration: none; margin-left: 12px; }`
  `.yj-status-license:hover { color: var(--yj-yellow); }`
  and in `@media (max-width: 560px)`: `.yj-status-license { display: none; }`.
  Seven characters of 11 px mono (~52 px), not the ~170 px the judge
  objected to; the sentence is in the title.
- `js/app/bench-controller.js:74` — write `$('stDevice')` instead of
  `$('stRight')` (the only writer; `rg -n stRight js` confirms).
- `js/main.js` `commandDefs` (`:298 ff.`) — add to the existing `PROJECT`
  group:
  `{ id: 'about', group: 'PROJECT', label: 'ABOUT · LICENSE', note: 'Built by Ian Helfrich · personal noncommercial use · organizations require a commercial license', keywords: 'credit author who made this terms license', run: () => window.open('https://github.com/ihelfrich/yellowjacket/blob/main/LICENSE.md', '_blank', 'noopener') }`.

**Decision for Dr. Helfrich.** The always-visible chrome drops the words
"organizations require a commercial license" to a `LICENSE` link whose
tooltip carries them. If the sentence must stay on every bench, leave this
step out; step 1 still cuts RACK by ~600 px and nothing else here depends
on it.

**Verify.** 1200: exactly one footer row; right cell `WEBGPU · WHISPER-BASE
· 48.0k · 02:40   LICENSE`, link amber-dim, yellow on hover, opens the
licence in a new tab; the overlay's foot carries the full sentence; the
bench gains 34 px. 800: the left status cell keeps most of the row; with
step 1 an all-off RACK fits without scrolling (confirm by screenshot at
1200 × 828 — the arithmetic says 476 px under the LIVE PREVIEW strip). ≤560:
link hidden.

---

## 12 · One focus rule for every control; disabled primary legible

**Observation.** `:focus-visible` rules exist for eight classes (yj.css:125,
:183, :247, :360, :556, :724; pipeline-ui.js:42) but not for `.yj-select`,
`.yj-mod-power` (a `<button>`, bench-controller.js:396), `.yj-clip-led`,
`.yj-shelf-chip`, `.yj-field-btn`, `.yj-mine-remove`, `.yj-loom-token`,
`.yj-loom-map-cell`, or the ~16 `createElement('button')` sites in
pads / pattern / synth / studio / repair — those get Chromium's blue-white
double ring, off-palette. `.yj-btn-primary:disabled` text `#2A2716` on
amber-dim is **2.24:1** (`:133`). (The proposal's parts (b) and (d) are not
taken: (b) is step 4; (d) would paint the licence link the colour of its own
sentence.)

**Rule.** §Signature 8 — "Focus = 1px yellow outline offset 2px, no glow."
§Palette header states a contrast ratio as a design value.

**Change.**

- `css/yj.css` after `:56` —
  `:where(button, select, a, input, [tabindex]):focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }`
  `:where()` has zero specificity, so every existing per-class rule
  (tabs −3, slice canvas −1, url input −1, pipe stage −2) still wins; the
  global rule only fills gaps.
- `:133` — `.yj-btn-primary:disabled { … color: #0B0A07; }` → **2.95:1** on
  amber-dim (measured; the proposal's 3.5 was wrong). Disabled is
  WCAG-exempt; the point is that TRANSCRIBE / RENDER / HARVEST / MEASURE
  read while waiting for audio.
- Pads: check `js/machine/pads-ui.js:163` once; if a 2 px outer offset
  collides in the pad grid, give the pad class `outline-offset: -2px` like
  the tabs.

**Verify.** 1200 and 800: Tab through the header, the MODEL select, the
power squares (after step 1), the shelf chips and cards in the overlay, the
MACHINE/PLAY pads, the LOOM map cells — every stop shows one 1 px yellow
outline, never the browser ring. RACK before a load: `RENDER` is readable on
the amber-dim face.

---

## 13 · Transport tells the truth: the `ended` fix, and what is sounding

**Observation.** §Friction: "nothing on screen says what is sounding." The
transport rule (transport.js:1-27) knows five sources and names them only
in the hover title; on screen `#btnPlay` flips to STOP with a yellow border
(yj.css:354). From TRANSCRIPT you cannot tell that THE MACHINE is what you
hear. Bug: bench-controller.js:133-135 sets the button text to `PLAY` on the
bench's `ended` without `refreshTransport()`, so with the machine still
running the button reads PLAY while sound continues — the fault transport.js
was written to close. Judges: fix the lie; reserve the readout's width so
the most-scanned strip never reflows; land after step 10.

**Rule.** yj.css:22-24 and the A/B key (index.html:291): "Yellow is always
what you are hearing." §Signature 9 — LED squares for status; solid yellow
= heard, never blinking (blink = busy). §Layout — the transport is the one
strip on every tab.

**Change.**

- `js/app/bench-controller.js:133-135` — the `ended` handler body becomes
  `refreshTransport();`. Ship this line regardless of the rest.
- Register the clip auditioner (the source `sounding()` reads as
  `audition`) with `addEventListener('state', refreshTransport)` alongside
  the four at `:127-130`, or the readout lags for CLIP.
- `js/app/transport.js` — `export const SHORT = Object.freeze({ bench: 'BENCH', machine: 'MACHINE', loom: 'LOOM', studio: 'STUDIO', audition: 'CLIP' });`
- `index.html:112-113`, between `#btnPlay` and `#roTime`:
  `<span class="yj-led-row yj-sounding" id="roSounding"><span class="yj-led"></span><span class="yj-led-text" id="soundingText"></span></span>`
  Always in the DOM; LED off and text empty when silent, so nothing shifts.
- `refreshTransport` (`:120`): add
  `$('roSounding').firstElementChild.classList.toggle('is-sounding', now.length > 0);`
  `$('soundingText').textContent = now.map((k) => SHORT[k]).join(' + ');`
- `css/yj.css` after `:354`:
  `.yj-sounding { min-width: 96px; }`
  `.yj-sounding .yj-led.is-sounding { background: var(--yj-yellow); }`
  `.yj-sounding .yj-led-text { color: var(--yj-yellow); }`
  and in `@media (max-width: 560px)`: `.yj-sounding { min-width: 0; } .yj-sounding .yj-led-text { display: none; }`.

**Verify.** 1200: PLAY → LED yellow, `BENCH`; QUICK TAKE from TRANSCRIPT →
`MACHINE`; play the bench over the machine → `BENCH + MACHINE`; let the
bench reach its end while the machine runs → the button still reads STOP.
Silent: LED amber-dim, no text, the transport's width identical to sounding
(measure the `#roTime` x-position in both states). 800: header height
unchanged from step 10's result; LED and text present. ≤560: 7 px square
only.

---

## 14 · prefers-reduced-motion covers every animation and keeps each state legible

**Observation.** `css/yj.css:794-797` removes animation from
`.yj-btn.is-working, .yj-progress-fill, .yj-led.is-busy` only. Uncovered:
the status pulse `.is-new` (`:755`), the `.yj-wire-chip.is-armed` blink
(`:413`), and the crawls added in steps 8 and 9. With animation removed,
`.yj-led.is-busy` is a solid yellow square — indistinguishable from
`.yj-mod-power.is-on` (`:595`) and from step 13's sounding LED — and
`.is-new` leaves an 8 px padding and no rule, so the change cue vanishes for
the users who asked for less motion, not less information.

**Rule.** §Signature 9 defines the blink as the busy cue; a hollow square
keeps the state without motion. §Signature 10 — "No shadows except the 1px
insets on wells": the hollow LED uses `border`, the status rule is the inset
the pulse already uses.

**Change.** Replace `css/yj.css:794-797` with:
```css
@media (prefers-reduced-motion: reduce) {
  .yj-btn.is-working, .yj-progress-fill, .yj-led.is-busy, .yj-wire-chip.is-armed,
  .yj-tab-btn.is-working::after { animation: none; }
  .yj-led.is-busy { background: transparent; border: 2px solid var(--yj-yellow); }
  .yj-status .is-new { animation: none; box-shadow: inset 3px 0 0 var(--yj-yellow); }
  * { scroll-behavior: auto !important; }
}
```
and in the STYLE string of `js/app/pipeline-ui.js` its own block:
`@media (prefers-reduced-motion: reduce) { .yj-pipe-stage.is-working::before { animation: none; } }`.
Stripes stay (static stripes still mean "doing"); busy = hollow yellow,
on = filled; the status rule stays lit until the next message instead of
fading.

**Verify.** macOS System Settings → Accessibility → Display → Reduce motion,
reload. 1200 and 800: RENDER while rendering shows static stripes; the RACK
LED is a hollow yellow square while rendering, solid amber when STALE, green
when fresh; a tab with a job shows a static dim stripe; after any status
change a yellow inset rule stays on the status line until the next message.
Reduce motion off: everything animates as before.

---

## 15 · DESIGN.md amendments

The doc is binding, so every place the plan changes an enumerated fact gets
written down. One line each, in `docs/DESIGN.md`:

- §Type — "13px buttons" → "11px buttons" (`yj.css:115` has been 11 px; the
  doc drifted, not the app).
- §Signature 1 — add to the enumerated sites: "the underbar of any tab whose
  bench has a job running (dim when it is not the active tab)" (step 8) and
  "the 2px left rule of a pipeline stage whose job is running" (step 9).
- §Signature 9 — add "solid amber = stale / rough: a state, not activity;
  never blinks" (step 2), and "reduced motion: busy = hollow yellow square"
  (step 14).
- §Layout — after the tabs line: "Pipeline strip under the tabs: SOURCE ·
  SLICE · KIT · PATTERN · SONG · OUT as seamed cells; done = yellow left
  rule + amber note; next = dim hazard rule + ink note; here = selection
  fill; working = crawling hazard rule + yellow note." (steps 4, 5, 9)
- §Layout RACK — "off modules collapse to their head row; the silkscreen
  carries the chain ordinal 01–09" (step 1).
- §Layout footer — right = "device + model + sample rate + LICENSE link"
  (step 11, if taken).
- §Layout header — "I/O right: SOURCE IN (AUDIO IN, SHELF) | KEEP AND SAVE
  (KEEP, PROJECT OUT) | COMMAND; URL and .YJKT open live in the overlay and
  the deck" (step 10).

**Verify.** `rg -n '13px|render fresh/stale|I/O \(open file' docs/DESIGN.md`
returns the amended lines.

---

## Rejected and why

- **hierarchy-04 · tab-bar LEDs (9).** Six always-present lamps, two of
  which (STUDIO, LOOM) never light — decoration by the doctrine's own test,
  and a permanently dark lamp reads as broken. The busy case is step 8 with
  no element at all.
- **density-rack-params-two-up (9).** Halves slider travel on exactly the
  modules being worked; density bought with operating precision is the wrong
  trade on a bench, and step 1 already removes the height.
- **feedback-memory-readout (9).** A lower-bound figure that needs a title
  to be honest, removes no decision, and crowds the status row; the 250 MB
  refusal and `DECODE_BUDGET_BYTES` already guard the failure it warns of.
- **feedback-cancel-on-working-button (10.5).** Right instinct (the striped
  surface exists and refuses clicks), wrong mechanism: bumping
  `R.generation` also re-stamps persist's saved generation and suppresses
  `runAnalysis` at source-controller.js:162 if the spectrogram is in flight;
  transcribe.js exposes no abort, so the worker keeps burning CPU after
  "cancel". Revisit with a per-job token and a real abort path.
- **density-weight-is-affordance (9.5).** A rule the doc permits but never
  states; bolding ~60 buttons is a register shift the 800 px header may not
  absorb. If wanted, ship after step 10 and screenshot the row first.
- **density-tracking-ladder (9.5).** DESIGN.md says 0.08 em and the ladder
  picks 0.09; optical, not operational; 0.14 em on `.yj-pipe-note` widens
  18-char file names inside a nowrap 96 px cell.
- **density-spacing-two-values (10.5).** On-doctrine and harmless, but the
  observation was "uniform", not "confusing", and it removes no click or
  search. Keep the seam fallback in reserve if a screenshot ever demands it.
- **hierarchy-05 · land on SIGNAL after a load (10.5).** Right reading of
  the specimen doctrine, but source-controller.js:124 hides the overlay on
  every load, so as written it yanks the user off SLICE on every mid-session
  record swap; it also reverses today's TRANSCRIPT wayfinding decision. If
  revisited: exempt loads made from a non-empty bench.
- **hierarchy-06 · overlay as three labelled panels (10.5).** A rebuild on a
  1fr 2fr 1fr grid, not a removal; demotes 808S from primary with no
  observation against it; the demo-as-card must live inside
  field-library's drawer render or it vanishes on the first chip click.
  The off-screen RESUME it also fixed is step 7.
- **hierarchy-07 · first-run rewrite (11.5).** One-shot surface — a working
  user never sees it again; the caps-route notes contradict the code's own
  "one sentence, what happens" intent. The paragraph deletion alone is safe
  if someone is in that file anyway.
- **density-type-scale (11.5).** Twenty value edits for a change that is
  mostly invisible in use. The two parts with a visible effect are taken:
  status 10.5 → 11 (step 6) and the DESIGN.md "13px buttons" correction
  (step 15). The 30 px `.yj-drop-word` and 19 px `.yj-loom-operator` are
  noted as display moments the doc forbids; left for an onboarding pass.
- **feedback-contrast (b), (d).** (b) is step 4; (d) `.yj-credit a` in
  ink-dim would paint the link the colour of its own sentence.
- **hierarchy-03 `border-top` and `flex: 1`.** Doubled hairline under the
  tabs; full-width cells make the strip louder than the tab row above it.
- **feedback-pipeline-stage RACK render → OUT.** RACK render is not on the
  recording-to-sample map; step 8 shows it on the RACK tab instead.
