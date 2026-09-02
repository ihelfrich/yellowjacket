// Yellowjacket MACHINE — PATTERN state view. 8-track step grid (4 pages x 16
// columns over a 64-step lane), per-track mixer strip (gain/pan/mute/solo/len,
// plus LOCK-slice duck/depth/choke), the transport bar (scene row, RUN/STOP,
// momentary FILL, BPM well, swing, page buttons, FREEZE), and the step
// inspector (hold a step 260 ms to open; edits per-step locks and conditions).
// Pure view: all DOM is built once in the constructor; setMachine re-renders
// values in place and never rebuilds the tree; setPlayhead is two column class
// swaps. The view never mutates the machine object — the controller owns state,
// this module only emits intents. Because dispatchEvent is synchronous, each
// control re-reads the live machine reference right after emitting, so visuals
// track whatever the controller actually applied.

const PAGES = 4;
const COLS = 16;
const ROWS = 8;
const LENS = [4, 8, 12, 16, 24, 32, 48, 64];
const LOOPS = [1, 2, 4];
const BPM_MIN = 20;                 // same accepted range as the SLICE bpm well
const BPM_MAX = 400;
const SCENES = 8;
const HOLD_MS = 260;                // press-and-hold on a step opens the inspector
const HOLD_SLOP_PX = 6;             // pointer drift at or past this cancels the hold
const CONDS = [                     // trig-condition select: value -> silkscreen label
  ['always', 'ALWAYS'],
  ['1:2', '1:2'], ['2:2', '2:2'],
  ['1:4', '1:4'], ['2:4', '2:4'], ['3:4', '3:4'], ['4:4', '4:4'],
  ['1:8', '1:8'],
  ['fill', 'FILL'], ['notfill', 'NOT FILL'],
];

const STYLE = `
.yj-pattern { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.yj-pattern-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yj-pattern-bar .yj-param { flex: 0 1 200px; min-width: 150px; }
.yj-pattern-bar .yj-param-label { width: auto; }
.yj-pattern-run { min-width: 74px; }
.yj-pattern-bpmedit { width: 84px; }
.yj-pattern-pages { display: flex; gap: 2px; }
.yj-pattern-pages .yj-btn { padding: 7px 10px; }
.yj-pattern-loops { width: 58px; flex-shrink: 0; }
.yj-pattern-hint { flex: 1 1 150px; min-width: 130px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-pattern-hint.is-dim { color: var(--yj-ink-dim); }
.yj-pattern-grid { display: flex; flex-direction: column; gap: 4px; overflow-x: auto; padding-bottom: 2px; }
.yj-pattern-row { display: flex; align-items: center; gap: 4px; min-width: 720px; }
.yj-pattern-key { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); width: 10px; text-align: center; flex-shrink: 0; }
.yj-pattern-name { width: 96px; flex-shrink: 0; font-size: 10px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 6px; min-width: 0; }
.yj-pattern-name:hover { border-color: var(--yj-line-hi); }
.yj-pattern-name.is-empty { color: var(--yj-ink-dim); }
.yj-pattern-sq { position: relative; width: 20px; height: 20px; padding: 0; flex-shrink: 0; background: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px; font-family: var(--f-mono); font-size: 9px; line-height: 1; color: var(--yj-ink-dim); }
.yj-pattern-sq:hover:not(:disabled) { border-color: var(--yj-line-hi); color: var(--yj-yellow-hi); }
.yj-pattern-sq:active:not(:disabled) { transform: translateY(1px); }
.yj-pattern-sq:disabled { color: var(--yj-amber-dim); cursor: default; }
.yj-pattern-sq:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-pattern-sq.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); color: var(--yj-bg); }
.yj-pattern-scenes { display: flex; gap: 2px; flex-shrink: 0; }
.yj-pattern-sq.has-dot::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 3px; height: 3px; background: var(--yj-amber); }
.yj-pattern-fill { min-width: 56px; }
.yj-pattern-fill .yj-key-hint { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); margin-left: 5px; }
.yj-pattern-fill.is-active .yj-key-hint { color: var(--yj-bg); }
.yj-step { position: relative; flex: 1 1 0; aspect-ratio: 1 / 1; min-width: 16px; max-width: 30px; padding: 0; background: var(--yj-well); border: 1px solid var(--yj-line); border-radius: 2px; touch-action: manipulation; }
.yj-step.is-beatmark { border-color: var(--yj-line-hi); }
.yj-step:hover:not(:disabled) { border-color: var(--yj-amber); }
.yj-step:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 1px; }
.yj-step.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-step.is-now { background: var(--yj-select); border-color: var(--yj-amber); }
.yj-step.is-on.is-now { background: var(--yj-yellow-hi); border-color: var(--yj-yellow-hi); }
.yj-step.is-off-page { opacity: 0.25; cursor: default; }
.yj-step.has-data::after { content: ''; position: absolute; top: 1px; right: 1px; width: 3px; height: 3px; background: var(--yj-amber); }
.yj-step.is-on.is-cond { background: var(--yj-well); }
.yj-step.is-on.is-cond::before { content: ''; position: absolute; inset: 0; background: var(--yj-yellow); opacity: 0.6; }
.yj-step.is-on.is-cond.is-now { background: var(--yj-select); }
.yj-step.is-on.is-cond.is-now::before { background: var(--yj-yellow-hi); }
.yj-pattern-mix { display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: auto; }
.yj-pattern-mix input[type="range"] { flex: none; width: 60px; }
.yj-pattern-mix input[type="range"].yj-pattern-depth { width: 40px; }
.yj-pattern-val { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); font-variant-numeric: tabular-nums; text-align: right; flex-shrink: 0; }
.yj-pattern-val-gain { width: 46px; }
.yj-pattern-val-pan { width: 26px; }
.yj-pattern-val-duck { width: 30px; }
.yj-pattern-len { width: 52px; flex-shrink: 0; padding: 3px 4px; font-size: 10px; }
.yj-pattern-duck { width: 52px; flex-shrink: 0; padding: 3px 4px; font-size: 10px; }
.yj-pattern-loom { display: flex; align-items: center; gap: 4px; min-width: 980px; padding: 6px 0; border-top: 1px solid var(--yj-line); border-bottom: 1px solid var(--yj-line); background: var(--yj-panel); }
.yj-pattern-loom.is-offline { border-color: rgba(255,92,69,.36); }
.yj-pattern-loom-id { width: 158px; flex: 0 0 158px; min-width: 0; display: grid; grid-template-columns: 7px minmax(0,1fr); gap: 3px 7px; align-items: center; }
.yj-pattern-loom-led { width: 6px; height: 6px; background: var(--yj-amber-dim); grid-row: 1 / span 2; }
.yj-pattern-loom-led.is-online { background: var(--yj-nominal); }
.yj-pattern-loom-led.is-offline { background: var(--yj-fault); }
.yj-pattern-loom-title { color: var(--yj-yellow); font-size: 9px; font-weight: 700; letter-spacing: .1em; }
.yj-pattern-loom-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--yj-ink-dim); font: 8px/1.2 var(--f-mono); }
.yj-pattern-loom-events { display: flex; flex: 1 1 0; gap: 4px; min-width: 320px; }
.yj-pattern-loom-event { position: relative; flex: 1 1 0; min-width: 16px; max-width: 30px; height: 25px; padding: 0 1px; border: 1px solid var(--yj-line); background: var(--yj-well); color: var(--yj-amber-dim); font: 8px/1 var(--f-mono); overflow: hidden; text-overflow: ellipsis; }
.yj-pattern-loom-event:nth-child(4n+1) { border-color: var(--yj-line-hi); }
.yj-pattern-loom-event.is-on { color: var(--yj-yellow); border-color: var(--yj-amber-dim); background: var(--yj-select); cursor: pointer; }
.yj-pattern-loom-event.is-collision { color: var(--yj-bg); background: var(--yj-yellow); border-color: var(--yj-yellow); font-weight: 700; }
.yj-pattern-loom-event.is-selected { outline: 1px solid var(--yj-yellow-hi); outline-offset: 1px; }
.yj-pattern-loom-event.is-now { border-color: var(--yj-yellow-hi); box-shadow: inset 0 -2px 0 var(--yj-yellow-hi); }
.yj-pattern-loom-event:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-pattern-loom-controls { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-left: auto; flex-shrink: 0; white-space: nowrap; }
.yj-pattern-loom-controls .yj-btn { padding: 5px 6px; font-size: 8px; }
.yj-pattern-loom-toggle { min-width: 34px; }
.yj-pattern-loom-gain { width: 58px; }
.yj-pattern-loom-gainval { width: 39px; color: var(--yj-ink-dim); font: 8px/1 var(--f-mono); text-align: right; }
.yj-pattern-loom-state { color: var(--yj-ink-dim); font: 8px/1 var(--f-mono); }
.yj-insp { height: 122px; flex-shrink: 0; box-sizing: border-box; background: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px; padding: 8px 10px; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; }
.yj-insp.is-closed { justify-content: center; }
.yj-insp-empty { display: none; font-size: 10px; letter-spacing: 0.08em; color: var(--yj-ink-dim); text-align: center; }
.yj-insp.is-closed .yj-insp-empty { display: block; }
.yj-insp.is-closed .yj-insp-head, .yj-insp.is-closed .yj-insp-controls { display: none; }
.yj-insp-head { display: flex; align-items: center; gap: 8px; }
.yj-insp-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-insp-addr { font-family: var(--f-mono); font-size: 11px; color: var(--yj-yellow); padding: 2px 8px; font-variant-numeric: tabular-nums; }
.yj-insp-clear { padding: 4px 8px; font-size: 10px; }
.yj-insp-esc { margin-left: auto; font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); }
.yj-insp-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.yj-insp-c { display: flex; align-items: center; gap: 5px; }
.yj-insp-label { font-size: 9px; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-insp-c input[type="range"] { width: 62px; }
.yj-insp-c .yj-select { padding: 3px 4px; font-size: 10px; }
.yj-insp-val { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink); font-variant-numeric: tabular-nums; min-width: 34px; }
.yj-insp-val.is-off { color: var(--yj-ink-dim); }
`;

export class PatternView extends EventTarget {
  // Contract events: 'togglestep' {track, step}, 'assign' {track},
  // 'cleartrack' {track}, 'mix' {track, key, value}
  // (key gainDb|pan|mute|solo|len|duckSource|duckDb|choke),
  // 'bpm' {bpm}, 'swing' {swing}, 'run' {}, 'stopreq' {}, 'freeze' {loops},
  // 'trig' {track}. LOCK slice adds: 'stepedit' {track, step, patch} with
  // exactly one changed key per emit (null value = clear that lock),
  // 'clearstep' {track, step}, 'scene' {index}, 'scenecopy' {from, to},
  // 'fill' {on}. The contract names no control for assign/cleartrack, so:
  // click on a track's sample-name well = assign, Alt+click = cleartrack
  // (stated in the well's title text). SONG slice adds: 'voiceopen' {track}
  // from the per-row [V] button (the integrator opens the VOICE drawer).
  // A Semantic Take adds one compact, non-editing lane above the eight tracks:
  // 'loomtoggle', 'loomgain', 'loomtrace', 'loomopen', and 'loomprint'.
  constructor(host) {
    super();
    this.host = host;
    this._machine = null;
    this._page = 0;
    this._playStep = null;
    this._litCol = null;
    this._running = false;
    this._rows = [];
    this._cols = Array.from({ length: COLS }, () => []);
    this._loom = { lane: null, plan: null, online: false, sceneLabel: '' };
    this._loomPrintBusy = false;
    this._loomSelectedEventId = null;
    this._hold = null;              // pending hold-to-inspect gesture
    this._holdConsumed = false;     // swallows the click after a fired hold
    this._docKey = null;            // document listeners live only while the
    this._docPtr = null;            // inspector is open

    host.classList.add('yj-pattern');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    this._bar = this._buildBar();
    const grid = document.createElement('div');
    grid.className = 'yj-pattern-grid';
    this._loomRow = this._buildLoomLane();
    grid.appendChild(this._loomRow.root);
    for (let i = 0; i < ROWS; i++) grid.appendChild(this._buildRow(i));
    host.appendChild(grid);
    this._grid = grid;

    // The inspector's space is reserved from construction (fixed height, own
    // scroll), so opening and closing it never shifts the grid.
    this._insp = this._buildInspector();
    host.appendChild(this._insp.root);
  }

  // ---------- public API ----------

  setMachine(machine) {
    this._machine = machine || null;
    this._syncBar();
    this._syncScenes();
    for (let i = 0; i < ROWS; i++) this._syncRow(i);
    if (this._insp.open) this._syncInspector();   // closes itself if the step is gone
  }

  setLoomLane({ lane = null, plan = null, online = false, sceneLabel = '' } = {}) {
    this._loom = { lane, plan, online: !!online, sceneLabel: String(sceneLabel || '') };
    const events = plan && Array.isArray(plan.events) ? plan.events : [];
    if (!events.some((event) => event && event.id === this._loomSelectedEventId)) {
      this._loomSelectedEventId = null;
    }
    this._syncLoomLane();
  }

  setLoomPrintBusy(busy) {
    this._loomPrintBusy = !!busy;
    this._syncLoomLane();
  }

  setPlayhead(step) {
    this._playStep = (typeof step === 'number' && isFinite(step) && step >= 0)
      ? Math.floor(step)
      : null;
    this._lightCol(this._playCol());
  }

  setPage(p) {
    p = Math.min(PAGES - 1, Math.max(0, p | 0));
    this._page = p;
    this._pageBtns.forEach((b, k) => b.classList.toggle('is-active', k === p));
    for (let i = 0; i < ROWS; i++) this._syncRowSteps(i);
    this._lightCol(this._playCol());
  }

  get page() {
    return this._page;
  }

  // FILL is momentary and can be held from the QWERTY keybed or a mapped MIDI
  // control, not only from this button. Without this the sequencer filled
  // while the button stayed dark, so the surface lied about what was playing.
  setFill(on) {
    if (this._fillBtn) this._fillBtn.classList.toggle('is-active', !!on);
  }

  setClipHint(label) {
    const h = this._bar.hint;
    h.textContent = label || 'NO CLIP SELECTED';
    h.classList.toggle('is-dim', !label);
  }

  setRunning(b) {
    this._running = !!b;
    this._bar.run.textContent = this._running ? 'STOP' : 'RUN';
    this._bar.run.classList.toggle('is-working', this._running);
  }

  // ---------- transport bar ----------

  _buildBar() {
    const bar = document.createElement('div');
    bar.className = 'yj-pattern-bar';

    const scenes = document.createElement('div');
    scenes.className = 'yj-pattern-scenes';
    this._sceneBtns = [];
    for (let k = 0; k < SCENES; k++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-pattern-sq';
      b.textContent = String(k + 1);
      b.title = 'Scene ' + (k + 1) + '. Click switches; Alt+click copies the current scene here, then switches.';
      b.addEventListener('click', (e) => {
        if (!this._machine) return;
        if (e.altKey) {
          const from = this._activeScene();
          if (from === k) return;             // copying a scene onto itself is a no-op
          this._emit('scenecopy', { from, to: k });
        } else {
          this._emit('scene', { index: k });
        }
        this.setMachine(this._machine);       // scene switch swaps tracks/bpm/swing
      });
      scenes.appendChild(b);
      this._sceneBtns.push(b);
    }

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'yj-btn yj-btn-primary yj-pattern-run';
    run.textContent = 'RUN';
    run.title = 'Start / stop the pattern';
    run.addEventListener('click', () => this._emit(this._running ? 'stopreq' : 'run', {}));

    const fill = this._buildFill();

    const bpmWell = document.createElement('div');
    bpmWell.className = 'yj-well yj-count';
    bpmWell.textContent = '— BPM';
    bpmWell.title = 'Pattern tempo. Click to type a BPM; Enter commits, Escape cancels.';
    bpmWell.addEventListener('click', () => this._editBpm());

    const swingWrap = document.createElement('div');
    swingWrap.className = 'yj-param';
    const swingLabel = document.createElement('span');
    swingLabel.className = 'yj-param-label';
    swingLabel.textContent = 'SWING';
    const swing = document.createElement('input');
    swing.type = 'range';
    swing.min = '50';
    swing.max = '70';
    swing.step = '1';
    swing.value = '50';
    swing.title = 'Swing: position of every off-16th inside its 8th, percent';
    const swingVal = document.createElement('span');
    swingVal.className = 'yj-param-val';
    swingVal.textContent = '50%';
    swing.addEventListener('input', () => {
      const v = Number(swing.value);
      swingVal.textContent = v + '%';
      this._emit('swing', { swing: v });
    });
    swingWrap.append(swingLabel, swing, swingVal);

    const pages = document.createElement('div');
    pages.className = 'yj-pattern-pages';
    this._pageBtns = [];
    ['A', 'B', 'C', 'D'].forEach((ch, p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-btn' + (p === 0 ? ' is-active' : '');
      b.textContent = ch;
      b.title = 'Steps ' + (p * COLS + 1) + '–' + (p * COLS + COLS);
      b.addEventListener('click', () => this.setPage(p));
      pages.appendChild(b);
      this._pageBtns.push(b);
    });

    const freeze = document.createElement('button');
    freeze.type = 'button';
    freeze.className = 'yj-btn';
    freeze.textContent = 'FREEZE';
    freeze.title = 'Render the pattern offline and load the result on the bench as the new source';

    const loops = document.createElement('select');
    loops.className = 'yj-select yj-pattern-loops';
    loops.title = 'Pattern cycles to render on FREEZE';
    for (const n of LOOPS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = '×' + n;
      loops.appendChild(o);
    }
    freeze.addEventListener('click', () => this._emit('freeze', { loops: Number(loops.value) }));

    const hint = document.createElement('div');
    hint.className = 'yj-well yj-count yj-pattern-hint is-dim';
    hint.textContent = 'NO CLIP SELECTED';
    hint.title = 'Clip that lands on a track when you click its name well';

    bar.append(scenes, run, fill, bpmWell, swingWrap, pages, freeze, loops, hint);
    this.host.appendChild(bar);
    return { run, fill, bpmWell, swing, swingVal, loops, hint };
  }

  _buildFill() {
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'yj-btn yj-pattern-fill';
    fill.title = 'Momentary fill: FILL-conditioned steps fire while held (key F)';
    const label = document.createElement('span');
    label.textContent = 'FILL';
    const key = document.createElement('span');
    key.className = 'yj-key-hint';
    key.textContent = 'F';
    fill.append(label, key);
    this._fillBtn = fill;

    let held = false;
    const set = (on) => {
      on = !!on;
      if (on === held) return;
      held = on;
      fill.classList.toggle('is-active', on);
      this._emit('fill', { on });
    };
    fill.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (fill.setPointerCapture && e.pointerId != null) {
        try { fill.setPointerCapture(e.pointerId); } catch { /* stale pointer id */ }
      }
      set(true);
    });
    fill.addEventListener('pointerup', () => set(false));
    fill.addEventListener('pointercancel', () => set(false));
    fill.addEventListener('lostpointercapture', () => set(false));
    fill.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();           // no synthesized click on keyup
        e.stopPropagation();          // keep main.js space-to-play out of it
        set(true);
      }
    });
    fill.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        set(false);
      }
    });
    fill.addEventListener('blur', () => set(false));
    return fill;
  }

  _editBpm() {
    const well = this._bar.bpmWell;
    if (well.hidden) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'yj-well yj-count yj-pattern-bpmedit';
    input.value = this._machine ? String(this._machine.bpm) : '';
    const done = () => {
      input.remove();
      well.hidden = false;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = Number(input.value);
        if (isFinite(v) && v >= BPM_MIN && v <= BPM_MAX) {
          this._emit('bpm', { bpm: v });
          this._syncBar();
        }
        done();
      } else if (e.key === 'Escape') {
        done();
      }
    });
    input.addEventListener('blur', done);
    well.hidden = true;
    well.parentElement.insertBefore(input, well);
    input.focus();
    input.select();
  }

  // ---------- semantic take lane ----------

  _buildLoomLane() {
    const root = document.createElement('section');
    root.className = 'yj-pattern-loom';
    root.setAttribute('aria-label', 'Loom lane');

    const identity = document.createElement('div');
    identity.className = 'yj-pattern-loom-id';
    const led = document.createElement('span');
    led.className = 'yj-pattern-loom-led';
    led.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'yj-pattern-loom-title';
    title.textContent = 'LOOM LANE';
    const source = document.createElement('span');
    source.className = 'yj-pattern-loom-source';
    source.textContent = 'NO SEMANTIC TAKE ARMED';
    identity.append(led, title, source);

    const events = document.createElement('div');
    events.className = 'yj-pattern-loom-events';
    events.setAttribute('role', 'group');
    events.setAttribute('aria-label', 'Loom events grouped by step');
    const cells = [];
    for (let step = 0; step < COLS; step++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'yj-pattern-loom-event';
      cell.textContent = '·';
      cell.disabled = true;
      cell.addEventListener('click', () => this._selectLoomCell(step));
      events.appendChild(cell);
      cells.push(cell);
      this._cols[step].push(cell);
    }

    const controls = document.createElement('div');
    controls.className = 'yj-pattern-loom-controls';
    const state = document.createElement('span');
    state.className = 'yj-pattern-loom-state';
    state.textContent = 'NO TAKE';
    state.setAttribute('role', 'status');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'yj-btn yj-pattern-loom-toggle';
    toggle.textContent = 'OFF';
    toggle.title = 'Enable or bypass this Loom lane';
    toggle.addEventListener('click', () => {
      const lane = this._loom.lane;
      if (lane) this._emit('loomtoggle', { enabled: lane.enabled === false });
    });

    const gain = document.createElement('input');
    gain.type = 'range';
    gain.className = 'yj-pattern-loom-gain';
    gain.min = '-48';
    gain.max = '6';
    gain.step = '0.5';
    gain.value = '0';
    gain.setAttribute('aria-label', 'Loom lane gain');
    gain.title = 'Loom lane gain, dB';
    const gainVal = document.createElement('span');
    gainVal.className = 'yj-pattern-loom-gainval';
    gainVal.textContent = '0.0 dB';
    gain.addEventListener('input', () => {
      const gainDb = Number(gain.value);
      gainVal.textContent = this._fmtDb(gainDb);
      this._emit('loomgain', { gainDb });
    });

    // Shown only while the lane is empty: the one-press way to fill it.
    const quick = document.createElement('button');
    quick.type = 'button';
    quick.className = 'yj-btn yj-btn-primary';
    quick.textContent = 'QUICK TAKE';
    quick.title = 'Weave what is selected — transcript words, a drag on the waveform, or the selected clip; else four spans from the recording — onto the starter phrase, arm this lane, and run';
    quick.addEventListener('click', () => this._emit('loomquicktake', {}));

    const trace = document.createElement('button');
    trace.type = 'button';
    trace.className = 'yj-btn';
    trace.textContent = 'TRACE';
    trace.title = 'Inspect the selected Loom event and its source provenance';
    trace.addEventListener('click', () => {
      const event = this._selectedLoomEvent();
      if (event) this._emit('loomtrace', { id: event.id });
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'yj-btn';
    edit.textContent = 'EDIT';
    edit.title = 'Open this semantic take in Loom';
    edit.addEventListener('click', () => {
      const plan = this._loom.plan;
      this._emit('loomopen', { planId: plan && plan.id || null });
    });

    const print = document.createElement('button');
    print.type = 'button';
    print.className = 'yj-btn';
    print.textContent = 'PRINT 24-BIT';
    print.title = 'Render this Loom lane as a 24-bit WAV';
    print.addEventListener('click', () => this._emit('loomprint', {}));

    controls.append(state, quick, toggle, gain, gainVal, trace, edit, print);
    root.append(identity, events, controls);
    return { root, led, source, cells, state, quick, toggle, gain, gainVal, trace, edit, print, groups: [] };
  }

  _loomStep(event) {
    const raw = event && Number.isFinite(Number(event.gridStep))
      ? Number(event.gridStep)
      : event && Number.isFinite(Number(event.stepIndex))
        ? Number(event.stepIndex)
      : Number(event && event.gesture && event.gesture.eventRef && event.gesture.eventRef.stepIndex);
    if (!Number.isFinite(raw)) return null;
    return ((Math.floor(raw) % COLS) + COLS) % COLS;
  }

  _loomEventLabel(event) {
    const source = event && event.source;
    const gesture = event && event.gesture;
    return String((source && source.label) || (gesture && gesture.note) || 'EVENT').toUpperCase();
  }

  _selectedLoomEvent() {
    const plan = this._loom.plan;
    const events = plan && Array.isArray(plan.events) ? plan.events : [];
    return events.find((event) => event && event.id === this._loomSelectedEventId)
      || events.find((event) => event && event.id) || null;
  }

  _selectLoomCell(step) {
    const group = this._loomRow.groups[step] || [];
    if (!group.length) return;
    const at = group.findIndex((event) => event && event.id === this._loomSelectedEventId);
    const event = group[(at + 1) % group.length];
    this._loomSelectedEventId = event && event.id || null;
    this._syncLoomLane();
  }

  _syncLoomLane() {
    const row = this._loomRow;
    if (!row) return;
    const { lane, plan, online, sceneLabel } = this._loom;
    const events = plan && Array.isArray(plan.events) ? plan.events.filter(Boolean) : [];
    const sourceLabel = plan && ((plan.source && plan.source.name) || plan.materialLabel);
    const gestureLabel = plan && plan.gesture && plan.gesture.label;
    const identity = [sourceLabel || 'SOURCE', gestureLabel || 'GESTURE'].join(' × ').toUpperCase();
    row.source.textContent = plan ? identity : 'NO SEMANTIC TAKE ARMED';
    // Offer the take whenever the lane has nothing PLAYABLE: empty, or holding a
    // plan whose source has been swapped out from under it. An offline take is
    // kept for its trace, not as a reason to hide the door.
    if (row.quick) row.quick.hidden = !!(plan && online);
    row.source.title = plan ? identity : '';
    row.led.classList.toggle('is-online', !!plan && online);
    row.led.classList.toggle('is-offline', !!plan && !online);
    row.root.classList.toggle('is-offline', !!plan && !online);

    const groups = Array.from({ length: COLS }, () => []);
    for (const event of events) {
      const step = this._loomStep(event);
      if (step != null) groups[step].push(event);
    }
    row.groups = groups;
    row.cells.forEach((cell, step) => {
      const group = groups[step];
      const selected = group.some((event) => event && event.id === this._loomSelectedEventId);
      cell.disabled = group.length === 0;
      cell.classList.toggle('is-on', group.length > 0);
      cell.classList.toggle('is-collision', group.length > 1);
      cell.classList.toggle('is-selected', selected);
      cell.setAttribute('aria-pressed', selected ? 'true' : 'false');
      cell.textContent = group.length > 1 ? '×' + group.length
        : (group.length ? this._loomEventLabel(group[0]).slice(0, 3) : '·');
      const labels = group.map((event) => this._loomEventLabel(event)).join(', ');
      cell.title = group.length > 1
        ? 'Step ' + (step + 1) + ': ' + group.length + ' events — ' + labels + '. Click cycles the selected event.'
        : (group.length ? 'Step ' + (step + 1) + ': ' + labels : 'Step ' + (step + 1) + ': no Loom event');
      cell.setAttribute('aria-label', cell.title);
    });

    const hasLane = !!(lane && plan && (!lane.planId || lane.planId === plan.id));
    const enabled = hasLane && lane.enabled !== false;
    const gainDb = hasLane && Number.isFinite(Number(lane.gainDb)) ? Number(lane.gainDb) : 0;
    row.toggle.disabled = !hasLane;
    row.toggle.textContent = enabled ? 'ON' : 'OFF';
    row.toggle.classList.toggle('is-active', enabled);
    row.toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    row.gain.disabled = !hasLane;
    row.gain.value = String(gainDb);
    row.gainVal.textContent = this._fmtDb(gainDb);
    row.trace.disabled = !events.some((event) => event && event.id);
    row.edit.disabled = false;
    row.print.disabled = this._loomPrintBusy || !hasLane || !online;
    row.print.textContent = this._loomPrintBusy ? 'PRINTING…' : 'PRINT 24-BIT';
    row.print.title = !online && hasLane
      ? 'Source audio is offline; reconnect it before printing'
      : (this._loomPrintBusy ? 'Rendering 24-bit audio and source lineage'
        : 'Render this Loom lane as a 24-bit WAV');
    const place = sceneLabel ? String(sceneLabel).toUpperCase() + ' · ' : '';
    row.state.textContent = plan
      ? place + events.length + (events.length === 1 ? ' EVENT · ' : ' EVENTS · ') + (online ? 'ONLINE' : 'OFFLINE')
      : 'NO TAKE';
  }

  // ---------- grid rows ----------

  _buildRow(i) {
    const row = document.createElement('div');
    row.className = 'yj-pattern-row';

    const key = document.createElement('span');
    key.className = 'yj-pattern-key';
    key.textContent = String(i + 1);

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'yj-well yj-pattern-name is-empty';
    name.textContent = 'EMPTY';
    name.title = 'Track ' + (i + 1) + ' sample. Click assigns the selected clip; Alt+click clears the track.';
    name.addEventListener('click', (e) => {
      this._emit(e.altKey ? 'cleartrack' : 'assign', { track: i });
      this._syncRow(i);
    });

    const sq = (txt, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-pattern-sq';
      b.textContent = txt;
      b.title = title;
      return b;
    };

    const vbtn = sq('V', 'Voice: trim, pitch and envelope for track ' + (i + 1));
    vbtn.classList.add('yj-pattern-vbtn');
    vbtn.addEventListener('click', () => this._emit('voiceopen', { track: i }));

    const trig = sq('T', 'Fire track ' + (i + 1) + ' once (key ' + (i + 1) + ')');
    trig.disabled = true;
    trig.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this._emit('trig', { track: i });
    });
    trig.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();           // no synthesized click on keyup
        e.stopPropagation();          // keep main.js space-to-play out of it
        this._emit('trig', { track: i });
      }
    });

    row.append(key, name, vbtn, trig);

    const cells = [];
    for (let col = 0; col < COLS; col++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-step' + (col % 4 === 0 ? ' is-beatmark' : '');
      b.title = 'Toggle; hold to inspect the step';
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this._machine) return;
        const step = this._page * COLS + col;
        if (step >= this._machine.tracks[i].len) return;
        this._armHold(i, col, e);
      });
      b.addEventListener('click', () => {
        if (this._holdConsumed) return;       // this press opened the inspector
        if (!this._machine) return;
        const step = this._page * COLS + col;
        if (step >= this._machine.tracks[i].len) return;
        this._emit('togglestep', { track: i, step });
        this._syncCell(i, col);
      });
      row.appendChild(b);
      cells.push(b);
      this._cols[col].push(b);
    }

    const mix = document.createElement('div');
    mix.className = 'yj-pattern-mix';
    const range = (min, max, step, val, title) => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      r.value = String(val);
      r.title = title;
      return r;
    };
    const val = (cls, txt) => {
      const s = document.createElement('span');
      s.className = 'yj-pattern-val ' + cls;
      s.textContent = txt;
      return s;
    };

    const gain = range(-24, 6, 0.5, 0, 'Track gain, dB');
    const gainVal = val('yj-pattern-val-gain', '0.0 dB');
    gain.addEventListener('input', () => {
      if (!this._machine) return;
      const v = Number(gain.value);
      gainVal.textContent = this._fmtDb(v);
      this._emit('mix', { track: i, key: 'gainDb', value: v });
    });

    const pan = range(-1, 1, 0.05, 0, 'Pan');
    const panVal = val('yj-pattern-val-pan', 'C');
    pan.addEventListener('input', () => {
      if (!this._machine) return;
      const v = Number(pan.value);
      panVal.textContent = this._fmtPan(v);
      this._emit('mix', { track: i, key: 'pan', value: v });
    });

    const mute = sq('M', 'Mute track ' + (i + 1));
    mute.addEventListener('click', () => {
      if (!this._machine) return;
      this._emit('mix', { track: i, key: 'mute', value: !this._machine.tracks[i].mute });
      this._syncRow(i);
    });

    const solo = sq('S', 'Solo track ' + (i + 1) + ' (any solo silences non-solo tracks)');
    solo.addEventListener('click', () => {
      if (!this._machine) return;
      this._emit('mix', { track: i, key: 'solo', value: !this._machine.tracks[i].solo });
      this._syncRow(i);
    });

    const len = document.createElement('select');
    len.className = 'yj-select yj-pattern-len';
    len.title = 'Track length in steps; unequal lengths run as polymeter';
    for (const n of LENS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = String(n);
      len.appendChild(o);
    }
    len.value = '16';
    len.addEventListener('change', () => {
      if (!this._machine) return;
      this._emit('mix', { track: i, key: 'len', value: Number(len.value) });
      this._syncRow(i);
    });

    const duck = document.createElement('select');
    duck.className = 'yj-select yj-pattern-duck';
    duck.title = 'Duck source: track ' + (i + 1) + ' dips when the source track hits';
    {
      const o = document.createElement('option');
      o.value = '-1';
      o.textContent = 'OFF';
      duck.appendChild(o);
    }
    for (let k = 0; k < ROWS; k++) {
      if (k === i) continue;                  // a track never ducks from itself
      const o = document.createElement('option');
      o.value = String(k);
      o.textContent = 'T' + (k + 1);
      duck.appendChild(o);
    }
    duck.addEventListener('change', () => {
      if (!this._machine) return;
      this._emit('mix', { track: i, key: 'duckSource', value: Number(duck.value) });
      this._syncRow(i);
    });

    const depth = range(0, 24, 1, 12, 'Duck depth, dB');
    depth.classList.add('yj-pattern-depth');
    const depthVal = val('yj-pattern-val-duck', '12dB');
    depth.addEventListener('input', () => {
      if (!this._machine) return;
      const v = Number(depth.value);
      depthVal.textContent = v + 'dB';
      this._emit('mix', { track: i, key: 'duckDb', value: v });
    });

    const choke = sq('C', 'Choke: each new hit on track ' + (i + 1) + ' cuts the previous one (mono track)');
    choke.addEventListener('click', () => {
      if (!this._machine) return;
      this._emit('mix', { track: i, key: 'choke', value: !this._machine.tracks[i].choke });
      this._syncRow(i);
    });

    mix.append(gain, gainVal, pan, panVal, mute, solo, len, duck, depth, depthVal, choke);
    row.appendChild(mix);

    this._rows.push({ name, trig, cells, gain, gainVal, pan, panVal, mute, solo, len, duck, depth, depthVal, choke });
    return row;
  }

  // ---------- hold-to-inspect gesture ----------

  _armHold(track, col, e) {
    this._cancelHold();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      if (!this._hold || this._hold.fired) return;
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) >= HOLD_SLOP_PX) this._cancelHold();
    };
    const up = () => {
      const fired = !!(this._hold && this._hold.fired);
      this._cancelHold();
      // The click the browser dispatches right after this pointerup must not
      // toggle; clicks run before timers, so a 0 ms reset cannot eat later ones.
      if (fired) setTimeout(() => { this._holdConsumed = false; }, 0);
    };
    const timer = setTimeout(() => {
      if (!this._hold) return;
      this._hold.fired = true;
      this._holdConsumed = true;
      this._openInspector(track, this._page * COLS + col);
    }, HOLD_MS);
    this._hold = { timer, fired: false, move, up };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  _cancelHold() {
    if (!this._hold) return;
    clearTimeout(this._hold.timer);
    window.removeEventListener('pointermove', this._hold.move);
    window.removeEventListener('pointerup', this._hold.up);
    window.removeEventListener('pointercancel', this._hold.up);
    this._hold = null;
  }

  // ---------- step inspector ----------

  _buildInspector() {
    const root = document.createElement('div');
    root.className = 'yj-insp is-closed';

    const empty = document.createElement('div');
    empty.className = 'yj-insp-empty';
    empty.textContent = 'STEP INSPECTOR · HOLD A STEP TO OPEN · QUICK CLICK TOGGLES';

    const head = document.createElement('div');
    head.className = 'yj-insp-head';
    const tag = document.createElement('span');
    tag.className = 'yj-insp-tag';
    tag.textContent = 'STEP INSPECTOR';
    const addr = document.createElement('span');
    addr.className = 'yj-well yj-insp-addr';
    addr.textContent = 'T1 · S01';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'yj-btn yj-insp-clear';
    clear.textContent = 'CLEAR STEP';
    clear.title = 'Drop all step data: the step becomes a plain trigger';
    clear.addEventListener('click', () => {
      if (!this._insp.open) return;
      this._emit('clearstep', { track: this._insp.track, step: this._insp.step });
      this._syncInspector();
      this._syncCellAbs(this._insp.track, this._insp.step);
    });
    const esc = document.createElement('span');
    esc.className = 'yj-insp-esc';
    esc.textContent = 'ESC CLOSES';
    head.append(tag, addr, clear, esc);

    const controls = document.createElement('div');
    controls.className = 'yj-insp-controls';
    const group = (label, ...nodes) => {
      const g = document.createElement('div');
      g.className = 'yj-insp-c';
      const l = document.createElement('span');
      l.className = 'yj-insp-label';
      l.textContent = label;
      g.append(l, ...nodes);
      controls.appendChild(g);
      return g;
    };
    const range = (min, max, step, val, title) => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      r.value = String(val);
      r.title = title;
      return r;
    };
    const val = () => {
      const s = document.createElement('span');
      s.className = 'yj-insp-val';
      return s;
    };
    const sq = (txt, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-pattern-sq';
      b.textContent = txt;
      b.title = title;
      return b;
    };
    // Every control patches exactly one key; a null value clears that lock.
    const patch = (p) => {
      if (!this._insp.open) return;
      this._emit('stepedit', { track: this._insp.track, step: this._insp.step, patch: p });
      this._syncInspector();
      if (this._insp.open) this._syncCellAbs(this._insp.track, this._insp.step);
    };

    const vel = range(5, 100, 1, 100, 'Velocity: scales this hit, percent');
    const velVal = val();
    vel.addEventListener('input', () => patch({ velocity: Number(vel.value) / 100 }));
    group('VEL', vel, velVal);

    const pitch = range(-12, 12, 1, 0, 'Pitch, semitones; playback rate doubles per +12');
    const pitchVal = val();
    pitch.addEventListener('input', () => patch({ pitch: Number(pitch.value) }));
    group('PITCH', pitch, pitchVal);

    const gainR = range(-24, 6, 0.5, 0, 'Gain lock, dB: overrides track gain for this hit');
    const gainOff = sq('×', 'Clear the gain lock. OFF means no lock; 0 dB is a lock.');
    const gainVal = val();
    gainR.addEventListener('input', () => patch({ gainDb: Number(gainR.value) }));
    gainOff.addEventListener('click', () => patch({ gainDb: null }));
    group('GAIN', gainR, gainOff, gainVal);

    const panR = range(-1, 1, 0.05, 0, 'Pan lock: overrides track pan for this hit');
    const panOff = sq('×', 'Clear the pan lock. OFF means no lock; C is a lock.');
    const panVal = val();
    panR.addEventListener('input', () => patch({ pan: Number(panR.value) }));
    panOff.addEventListener('click', () => patch({ pan: null }));
    group('PAN', panR, panOff, panVal);

    const ratchet = document.createElement('select');
    ratchet.className = 'yj-select';
    ratchet.title = 'Ratchet: sub-hits spread evenly inside the step';
    for (let n = 1; n <= 4; n++) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = '×' + n;
      ratchet.appendChild(o);
    }
    ratchet.addEventListener('change', () => patch({ ratchet: Number(ratchet.value) }));
    group('RATCHET', ratchet);

    const nudge = range(-50, 50, 1, 0, 'Nudge: shifts the hit inside its step, percent of a step');
    const nudgeVal = val();
    nudge.addEventListener('input', () => patch({ nudge: Number(nudge.value) / 100 }));
    group('NUDGE', nudge, nudgeVal);

    const gate = range(0, 400, 5, 0, 'Gate: hit length, percent of a step; OFF plays the natural length');
    const gateVal = val();
    gate.addEventListener('input', () => {
      const v = Number(gate.value);
      patch({ gate: v === 0 ? 0 : v / 100 });
    });
    group('GATE', gate, gateVal);

    const rev = sq('R', 'Reverse playback for this hit');
    rev.addEventListener('click', () => {
      const sd = this._stepData();
      patch({ reverse: sd && sd.reverse ? null : true });
    });
    group('REV', rev);

    const prob = range(1, 100, 1, 100, 'Probability the step fires each cycle (seeded: FREEZE hears the same take)');
    const probVal = val();
    prob.addEventListener('input', () => patch({ prob: Number(prob.value) }));
    group('PROB', prob, probVal);

    const cond = document.createElement('select');
    cond.className = 'yj-select';
    cond.title = 'Trig condition: A:B fires on cycle A of every B; FILL tracks the FILL button';
    for (const [v, label] of CONDS) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      cond.appendChild(o);
    }
    cond.addEventListener('change', () => {
      const v = cond.value;
      if (v === 'always') patch({ cond: null });
      else if (v === 'fill' || v === 'notfill') patch({ cond: v });
      else {
        const [a, b] = v.split(':').map(Number);
        patch({ cond: { a, b } });
      }
    });
    group('COND', cond);

    root.append(empty, head, controls);
    return {
      root, addr, open: false, track: 0, step: 0,
      vel, velVal, pitch, pitchVal, gainR, gainVal, panR, panVal,
      ratchet, nudge, nudgeVal, gate, gateVal, rev, prob, probVal, cond,
    };
  }

  _openInspector(track, step) {
    const I = this._insp;
    I.open = true;
    I.track = track;
    I.step = step;
    I.root.classList.remove('is-closed');
    if (!this._docKey) {
      this._docKey = (e) => {
        if (e.key !== 'Escape') return;
        const t = e.target;
        // The BPM well editor owns its own Escape (and stops propagation);
        // this guard covers any text input that lets the key bubble.
        if (t && t.tagName === 'INPUT' && t.type === 'text') return;
        this._closeInspector();
      };
      this._docPtr = (e) => {
        if (this._grid.contains(e.target) || I.root.contains(e.target)) return;
        this._closeInspector();
      };
      document.addEventListener('keydown', this._docKey);
      document.addEventListener('pointerdown', this._docPtr, true);
    }
    this._syncInspector();
  }

  _closeInspector() {
    const I = this._insp;
    I.open = false;
    I.root.classList.add('is-closed');
    if (this._docKey) {
      document.removeEventListener('keydown', this._docKey);
      this._docKey = null;
    }
    if (this._docPtr) {
      document.removeEventListener('pointerdown', this._docPtr, true);
      this._docPtr = null;
    }
  }

  _stepData() {
    const m = this._machine;
    if (!m || !this._insp.open) return null;
    const t = m.tracks[this._insp.track];
    return (t && t.stepData && t.stepData[this._insp.step]) || null;
  }

  _syncInspector() {
    const I = this._insp;
    if (!I.open) return;
    const m = this._machine;
    const t = m ? m.tracks[I.track] : null;
    if (!t || I.step >= t.len) {
      this._closeInspector();
      return;
    }
    const sd = (t.stepData && t.stepData[I.step]) || {};
    I.addr.textContent = 'T' + (I.track + 1) + ' · S' + String(I.step + 1).padStart(2, '0');

    const velPct = sd.velocity != null ? Math.round(sd.velocity * 100) : 100;
    I.vel.value = String(velPct);
    I.velVal.textContent = velPct + '%';

    const pitch = sd.pitch != null ? sd.pitch : 0;
    I.pitch.value = String(pitch);
    I.pitchVal.textContent = (pitch > 0 ? '+' : '') + pitch + ' ST';

    const gLock = sd.gainDb != null;
    I.gainR.value = String(gLock ? sd.gainDb : 0);
    I.gainVal.textContent = gLock ? this._fmtDb(sd.gainDb) : 'OFF';
    I.gainVal.classList.toggle('is-off', !gLock);

    const pLock = sd.pan != null;
    I.panR.value = String(pLock ? sd.pan : 0);
    I.panVal.textContent = pLock ? this._fmtPan(sd.pan) : 'OFF';
    I.panVal.classList.toggle('is-off', !pLock);

    const ratchet = Math.min(4, Math.max(1, sd.ratchet != null ? sd.ratchet : 1));
    I.ratchet.value = String(ratchet);

    const nudge = Math.round((sd.nudge || 0) * 100);
    I.nudge.value = String(nudge);
    I.nudgeVal.textContent = (nudge > 0 ? '+' : '') + nudge + '%';

    const gate = sd.gate ? Math.round(sd.gate * 100) : 0;
    I.gate.value = String(gate);
    I.gateVal.textContent = gate ? gate + '%' : 'OFF';
    I.gateVal.classList.toggle('is-off', !gate);

    I.rev.classList.toggle('is-on', !!sd.reverse);

    const prob = sd.prob != null ? sd.prob : 100;
    I.prob.value = String(prob);
    I.probVal.textContent = prob + '%';

    let cv = 'always';
    if (sd.cond === 'fill' || sd.cond === 'notfill') cv = sd.cond;
    else if (sd.cond && typeof sd.cond === 'object') cv = sd.cond.a + ':' + sd.cond.b;
    let known = false;
    for (const o of Array.from(I.cond.options)) {
      if (o.dataset.extra && o.value !== cv) { o.remove(); continue; }
      if (o.value === cv) known = true;
    }
    if (!known) {
      // An A:B outside the preset list still displays honestly.
      const o = document.createElement('option');
      o.value = cv;
      o.textContent = cv;
      o.dataset.extra = '1';
      I.cond.appendChild(o);
    }
    I.cond.value = cv;
  }

  // ---------- in-place value sync ----------

  _syncBar() {
    const m = this._machine;
    const b = this._bar;
    b.bpmWell.textContent = m ? this._fmtBpm(m.bpm) : '— BPM';
    if (m) {
      b.swing.value = String(m.swing);
      b.swingVal.textContent = m.swing + '%';
    }
  }

  _activeScene() {
    const m = this._machine;
    return m && typeof m.activeScene === 'number' ? (m.activeScene | 0) : 0;
  }

  _syncScenes() {
    const m = this._machine;
    const active = this._activeScene();
    this._sceneBtns.forEach((b, k) => {
      b.classList.toggle('is-on', !!m && k === active);
      const sc = m && m.scenes ? m.scenes[k] : null;
      const hasSteps = !!(sc && sc.tracks && sc.tracks.some(
        (t) => t && t.steps && Array.prototype.some.call(t.steps, (v) => v),
      ));
      const hasLoom = !!(sc && sc.loomLane && typeof sc.loomLane.planId === 'string'
        && sc.loomLane.planId);
      b.classList.toggle('has-dot', hasSteps || hasLoom);
    });
  }

  _syncRow(i) {
    const r = this._rows[i];
    const t = this._machine ? this._machine.tracks[i] : null;
    const has = !!(t && t.sample);
    const label = has ? (t.sample.label || 'SAMPLE') : 'EMPTY';
    if (r.name.textContent !== label) r.name.textContent = label;
    r.name.classList.toggle('is-empty', !has);
    r.trig.disabled = !has;
    const gainDb = t ? t.gainDb : 0;
    r.gain.value = String(gainDb);
    r.gainVal.textContent = this._fmtDb(gainDb);
    const pan = t ? t.pan : 0;
    r.pan.value = String(pan);
    r.panVal.textContent = this._fmtPan(pan);
    r.mute.classList.toggle('is-on', !!(t && t.mute));
    r.solo.classList.toggle('is-on', !!(t && t.solo));
    r.len.value = String(t ? t.len : 16);
    const rawSrc = t && typeof t.duckSource === 'number' ? t.duckSource : -1;
    const src = (rawSrc === i || rawSrc < -1 || rawSrc >= ROWS) ? -1 : rawSrc;
    r.duck.value = String(src);
    const ducked = src >= 0;
    r.depth.hidden = !ducked;
    r.depthVal.hidden = !ducked;
    const db = t && typeof t.duckDb === 'number' ? t.duckDb : 12;
    r.depth.value = String(db);
    r.depthVal.textContent = db + 'dB';
    r.choke.classList.toggle('is-on', !!(t && t.choke));
    this._syncRowSteps(i);
  }

  _syncRowSteps(i) {
    for (let col = 0; col < COLS; col++) this._syncCell(i, col);
  }

  _syncCell(i, col) {
    const t = this._machine ? this._machine.tracks[i] : null;
    const s = this._page * COLS + col;
    const off = !t || s >= t.len;
    const b = this._rows[i].cells[col];
    b.classList.toggle('is-on', !!(t && t.steps[s]));
    b.classList.toggle('is-off-page', off);
    b.disabled = off;
    const sd = !off && t.stepData ? t.stepData[s] : null;
    b.classList.toggle('has-data', !!(sd && Object.keys(sd).length));
    b.classList.toggle('is-cond', !!(sd && ((sd.prob != null && sd.prob < 100) || sd.cond != null)));
  }

  _syncCellAbs(track, step) {
    const col = step - this._page * COLS;
    if (col >= 0 && col < COLS) this._syncCell(track, col);
  }

  // ---------- playhead ----------

  _playCol() {
    if (this._playStep == null) return null;
    const c = this._playStep % (PAGES * COLS);     // LCM loops can exceed 64
    return (c >> 4) === this._page ? (c & 15) : null;
  }

  _lightCol(col) {
    if (col === this._litCol) return;
    if (this._litCol != null) {
      for (const b of this._cols[this._litCol]) b.classList.remove('is-now');
    }
    if (col != null) {
      for (const b of this._cols[col]) b.classList.add('is-now');
    }
    this._litCol = col;
  }

  // ---------- formatting ----------

  _fmtBpm(v) {
    return (Math.round(v * 10) / 10) + ' BPM';
  }

  _fmtDb(v) {
    return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  }

  _fmtPan(v) {
    const n = Math.round(Math.abs(v) * 100);
    return n === 0 ? 'C' : (v < 0 ? 'L' : 'R') + n;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
