// Yellowjacket MACHINE — PATTERN state view. 8-track step grid (4 pages x 16
// columns over a 64-step lane), per-track mixer strip (gain/pan/mute/solo/len),
// and the transport bar (RUN/STOP, BPM well, swing, page buttons, FREEZE).
// Pure view: all DOM is built once in the constructor; setMachine re-renders
// values in place and never rebuilds the tree; setPlayhead is two column class
// swaps. The view never mutates the machine object — main.js owns state, this
// module only emits intents. Because dispatchEvent is synchronous, each control
// re-reads the live machine reference right after emitting, so visuals track
// whatever main.js actually applied.

const PAGES = 4;
const COLS = 16;
const ROWS = 8;
const LENS = [4, 8, 12, 16, 24, 32, 48, 64];
const LOOPS = [1, 2, 4];
const BPM_MIN = 20;                 // same accepted range as the SLICE bpm well
const BPM_MAX = 400;

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
.yj-pattern-sq { width: 20px; height: 20px; padding: 0; flex-shrink: 0; background: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px; font-family: var(--f-mono); font-size: 9px; line-height: 1; color: var(--yj-ink-dim); }
.yj-pattern-sq:hover:not(:disabled) { border-color: var(--yj-line-hi); color: var(--yj-yellow-hi); }
.yj-pattern-sq:active:not(:disabled) { transform: translateY(1px); }
.yj-pattern-sq:disabled { color: var(--yj-amber-dim); cursor: default; }
.yj-pattern-sq:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-pattern-sq.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); color: var(--yj-bg); }
.yj-step { flex: 1 1 0; aspect-ratio: 1 / 1; min-width: 16px; max-width: 30px; padding: 0; background: var(--yj-well); border: 1px solid var(--yj-line); border-radius: 2px; }
.yj-step.is-beatmark { border-color: var(--yj-line-hi); }
.yj-step:hover:not(:disabled) { border-color: var(--yj-amber); }
.yj-step:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 1px; }
.yj-step.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-step.is-now { background: var(--yj-select); border-color: var(--yj-amber); }
.yj-step.is-on.is-now { background: var(--yj-yellow-hi); border-color: var(--yj-yellow-hi); }
.yj-step.is-off-page { opacity: 0.25; cursor: default; }
.yj-pattern-mix { display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: auto; }
.yj-pattern-mix input[type="range"] { flex: none; width: 60px; }
.yj-pattern-val { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); font-variant-numeric: tabular-nums; text-align: right; flex-shrink: 0; }
.yj-pattern-val-gain { width: 46px; }
.yj-pattern-val-pan { width: 26px; }
.yj-pattern-len { width: 52px; flex-shrink: 0; padding: 3px 4px; font-size: 10px; }
`;

export class PatternView extends EventTarget {
  // Contract events: 'togglestep' {track, step}, 'assign' {track},
  // 'cleartrack' {track}, 'mix' {track, key, value} (key gainDb|pan|mute|solo|len),
  // 'bpm' {bpm}, 'swing' {swing}, 'run' {}, 'stopreq' {}, 'freeze' {loops},
  // 'trig' {track}. The contract names no control for assign/cleartrack, so:
  // click on a track's sample-name well = assign, Alt+click = cleartrack
  // (stated in the well's title text).
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

    host.classList.add('yj-pattern');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    this._bar = this._buildBar();
    const grid = document.createElement('div');
    grid.className = 'yj-pattern-grid';
    for (let i = 0; i < ROWS; i++) grid.appendChild(this._buildRow(i));
    host.appendChild(grid);
  }

  // ---------- public API ----------

  setMachine(machine) {
    this._machine = machine || null;
    this._syncBar();
    for (let i = 0; i < ROWS; i++) this._syncRow(i);
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

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'yj-btn yj-btn-primary yj-pattern-run';
    run.textContent = 'RUN';
    run.title = 'Start / stop the pattern';
    run.addEventListener('click', () => this._emit(this._running ? 'stopreq' : 'run', {}));

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

    bar.append(run, bpmWell, swingWrap, pages, freeze, loops, hint);
    this.host.appendChild(bar);
    return { run, bpmWell, swing, swingVal, loops, hint };
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

    row.append(key, name, trig);

    const cells = [];
    for (let col = 0; col < COLS; col++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-step' + (col % 4 === 0 ? ' is-beatmark' : '');
      b.addEventListener('click', () => {
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

    mix.append(gain, gainVal, pan, panVal, mute, solo, len);
    row.appendChild(mix);

    this._rows.push({ name, trig, cells, gain, gainVal, pan, panVal, mute, solo, len });
    return row;
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
