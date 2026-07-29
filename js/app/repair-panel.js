// Yellowjacket BRUSH — REPAIR panel. Selection readout, STRENGTH, PREVIEW /
// APPLY, the HARMONICS helper (duplicate a tone band at 2f..Nf, offered only
// when the selection is narrower than one octave), and the non-destructive
// repair stack rendered newest on top: square bypass toggle, mono label well,
// machined × remove. Pure view: the frame is built once in the constructor;
// setSelection / setRepairs / setBusy re-render values in place. The view
// never mutates the stack — the controller owns state, this module only emits
// intents. Because dispatchEvent is synchronous, each control re-reads the
// live repairs reference right after emitting, so visuals track whatever the
// controller actually applied.

const STRENGTH_MIN = 5;             // percent on the slider …
const STRENGTH_MAX = 100;
const STRENGTH_STEP = 5;
const STRENGTH_DEF = 60;
const STRENGTH_SCALE = 100;         // … emitted as a 0.05..1 fraction
const HARMONIC_COUNTS = [2, 3, 4, 5, 6];
const HARMONIC_DEF = 4;
const OCTAVE = 2;                   // HARMONICS needs f1 / f0 below this

const STYLE = `
.yj-repair { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.yj-repair-readout { text-align: left; }
.yj-repair-readout.is-dim { color: var(--yj-ink-dim); }
.yj-repair-count { width: 64px; flex: none; }
.yj-repair-stack { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.yj-repair-empty { font-size: 11px; line-height: 1.5; letter-spacing: 0.02em; color: var(--yj-ink-dim); padding: 2px; }
.yj-repair-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 0; }
.yj-repair-sq { width: 18px; height: 18px; padding: 0; flex-shrink: 0; background: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px; font-family: var(--f-mono); font-size: 10px; line-height: 1; color: var(--yj-ink-dim); }
.yj-repair-sq:hover { border-color: var(--yj-line-hi); color: var(--yj-yellow-hi); }
.yj-repair-sq:active { transform: translateY(1px); }
.yj-repair-sq:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-repair-sq.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); color: var(--yj-bg); }
.yj-repair-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 10.5px; padding: 4px 7px; }
.yj-repair-row.is-off .yj-repair-label { color: var(--yj-ink-dim); }
.yj-repair-row:hover .yj-repair-label { border-color: var(--yj-line-hi); }
`;

export class RepairPanel extends EventTarget {
  // Contract events: 'apply' {region, strength}, 'preview' {region, strength},
  // 'toggle' {id, enabled}, 'remove' {id}, 'hover' {id|null},
  // 'harmonics' {region, count}. region is a {t0, t1, f0, f1} copy of the
  // current selection; strength is the slider percent as a 0.05..1 fraction;
  // 'toggle' carries the intended new enabled state.
  constructor(host) {
    super();
    this.host = host;
    this._selection = null;
    this._repairs = [];
    this._busy = false;
    this._hoverId = null;
    this._rows = [];

    host.classList.add('yj-repair');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    this._readout = document.createElement('div');
    this._readout.className = 'yj-well yj-count yj-repair-readout is-dim';
    this._readout.textContent = 'NO SELECTION';
    this._readout.title = 'Current spectral selection';
    host.appendChild(this._readout);

    host.appendChild(this._buildStrength());
    host.appendChild(this._buildActions());
    host.appendChild(this._buildHarmonics());

    this._empty = document.createElement('div');
    this._empty.className = 'yj-repair-empty';
    this._empty.textContent = 'Select a region on the spectrogram. Alt-drag grabs a transient, Shift-drag grabs a tone.';

    this._stack = document.createElement('div');
    this._stack.className = 'yj-repair-stack';
    host.appendChild(this._stack);
    this._renderStack();
  }

  // ---------- public API ----------

  setSelection(region) {
    this._selection = region || null;
    this._syncSelection();
  }

  setRepairs(repairs) {
    this._repairs = repairs || [];
    this._renderStack();
  }

  setBusy(b) {
    this._busy = !!b;
    this._apply.classList.toggle('is-working', this._busy);
    this._apply.disabled = this._busy || !this._selection;
  }

  // ---------- build ----------

  _buildStrength() {
    const wrap = document.createElement('div');
    wrap.className = 'yj-param';
    const label = document.createElement('span');
    label.className = 'yj-param-label';
    label.textContent = 'STRENGTH';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(STRENGTH_MIN);
    range.max = String(STRENGTH_MAX);
    range.step = String(STRENGTH_STEP);
    range.value = String(STRENGTH_DEF);
    range.title = 'Repair strength: 100% pulls the region fully to the surrounding context';
    const val = document.createElement('span');
    val.className = 'yj-param-val';
    val.textContent = STRENGTH_DEF + '%';
    range.addEventListener('input', () => {
      val.textContent = Math.round(Number(range.value)) + '%';
    });
    wrap.append(label, range, val);
    this._strength = range;
    this._strengthVal = val;
    return wrap;
  }

  _buildActions() {
    const row = document.createElement('div');
    row.className = 'yj-toolrow';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'yj-btn';
    preview.textContent = 'PREVIEW';
    preview.disabled = true;
    preview.title = 'Audition this repair once without adding it to the stack';
    preview.addEventListener('click', () => {
      if (!this._selection) return;
      this._emit('preview', this._payload());
    });
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'yj-btn yj-btn-primary';
    apply.textContent = 'APPLY';
    apply.disabled = true;
    apply.title = 'Add this repair to the stack and rebuild the audio';
    apply.addEventListener('click', () => {
      if (!this._selection || this._busy) return;
      this._emit('apply', this._payload());
    });
    row.append(preview, apply);
    this._preview = preview;
    this._apply = apply;
    return row;
  }

  _buildHarmonics() {
    const row = document.createElement('div');
    row.className = 'yj-toolrow';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yj-btn';
    btn.textContent = 'HARMONICS';
    btn.disabled = true;
    btn.title = 'Repeat this band at its multiples. Needs a band narrower than one octave.';
    const count = document.createElement('select');
    count.className = 'yj-select yj-repair-count';
    count.disabled = true;
    count.title = 'Top multiple: ×4 adds copies at 2, 3 and 4 times the band';
    for (const n of HARMONIC_COUNTS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = '×' + n;
      count.appendChild(o);
    }
    count.value = String(HARMONIC_DEF);
    btn.addEventListener('click', () => {
      if (!this._harmonicsOk()) return;
      this._emit('harmonics', {
        region: this._regionCopy(),
        count: Number(count.value),
      });
    });
    row.append(btn, count);
    this._harmBtn = btn;
    this._harmCount = count;
    return row;
  }

  // ---------- stack list ----------

  _renderStack() {
    const reps = this._repairs;
    this._rows = [];
    this._stack.textContent = '';
    if (!reps.length) {
      this._stack.appendChild(this._empty);
    } else {
      for (let k = reps.length - 1; k >= 0; k--) {
        const rec = this._buildRow(reps[k]);
        this._syncRow(rec, reps[k]);
        this._stack.appendChild(rec.row);
        this._rows.push(rec);
      }
    }
    // A hovered row that vanished can never fire pointerleave; clear the
    // highlight so the spectrogram outline does not stick.
    if (this._hoverId != null && !this._find(this._hoverId)) {
      this._hoverId = null;
      this._emit('hover', { id: null });
    }
  }

  _buildRow(repair) {
    const id = repair.id;
    const row = document.createElement('div');
    row.className = 'yj-repair-row';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'yj-repair-sq';
    toggle.title = 'Bypass this repair; the entry stays in the stack';
    toggle.addEventListener('click', () => {
      const r = this._find(id);
      if (!r) return;
      this._emit('toggle', { id, enabled: !r.enabled });
      this._echoStack();
    });

    const label = document.createElement('span');
    label.className = 'yj-well yj-repair-label';

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'yj-repair-sq';
    x.textContent = '×';
    x.title = 'Remove this repair';
    x.addEventListener('click', () => {
      if (!this._find(id)) return;
      this._emit('remove', { id });
      this._echoStack();
    });

    row.addEventListener('pointerenter', () => {
      if (this._hoverId === id) return;
      this._hoverId = id;
      this._emit('hover', { id });
    });
    row.addEventListener('pointerleave', () => {
      if (this._hoverId !== id) return;
      this._hoverId = null;
      this._emit('hover', { id: null });
    });

    row.append(toggle, label, x);
    return { id, row, toggle, label };
  }

  _syncRow(rec, repair) {
    rec.toggle.classList.toggle('is-on', !!repair.enabled);
    rec.row.classList.toggle('is-off', !repair.enabled);
    const label = repair.label || '';
    if (rec.label.textContent !== label) {
      rec.label.textContent = label;
      rec.label.title = label;
    }
  }

  // Re-read the live stack after an emit: sync rows in place when the ids
  // still line up, rebuild when the controller restructured the list.
  _echoStack() {
    const reps = this._repairs || [];
    const shown = this._rows;
    let match = reps.length === shown.length;
    if (match) {
      for (let k = 0; k < shown.length; k++) {
        if (reps[reps.length - 1 - k].id !== shown[k].id) { match = false; break; }
      }
    }
    if (!match) {
      this._renderStack();
      return;
    }
    for (let k = 0; k < shown.length; k++) {
      this._syncRow(shown[k], reps[reps.length - 1 - k]);
    }
  }

  _find(id) {
    const reps = this._repairs || [];
    for (let k = 0; k < reps.length; k++) {
      if (reps[k].id === id) return reps[k];
    }
    return null;
  }

  // ---------- selection ----------

  _syncSelection() {
    const sel = this._selection;
    this._readout.textContent = sel ? this._fmtRegion(sel) : 'NO SELECTION';
    this._readout.classList.toggle('is-dim', !sel);
    this._preview.disabled = !sel;
    this._apply.disabled = !sel || this._busy;
    const harm = this._harmonicsOk();
    this._harmBtn.disabled = !harm;
    this._harmCount.disabled = !harm;
  }

  _harmonicsOk() {
    const s = this._selection;
    return !!s && s.f0 > 0 && s.f1 / s.f0 < OCTAVE;
  }

  _payload() {
    return {
      region: this._regionCopy(),
      strength: Number(this._strength.value) / STRENGTH_SCALE,
    };
  }

  _regionCopy() {
    const s = this._selection;
    return { t0: s.t0, t1: s.t1, f0: s.f0, f1: s.f1 };
  }

  // ---------- formatting ----------

  _fmtRegion(s) {
    return (s.t1 - s.t0).toFixed(2) + 's · '
      + this._fmtHz(s.f0) + '-' + this._fmtHz(s.f1) + ' Hz';
  }

  _fmtHz(v) {
    if (v >= 1000) {
      const k = Math.round(v / 100) / 10;
      return (k === Math.round(k) ? String(Math.round(k)) : k.toFixed(1)) + 'k';
    }
    return String(Math.round(v));
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
