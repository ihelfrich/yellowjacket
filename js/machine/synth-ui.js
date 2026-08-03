// SYNTH panel: write a sound as maths and hear it. Lives in the CRATE pane
// because making an instrument belongs next to loading one, and because the
// bench already has more screens than it should.
//
// Pure view. Events: 'preview' {formula, seconds}, 'make' {formula, seconds,
// name, role}, 'formula' {formula} (on every edit, for the live plot).

const STYLE = `
.yj-synth { display: flex; flex-direction: column; gap: 8px; padding-bottom: 10px;
  border-bottom: 1px solid var(--yj-line); margin-bottom: 10px; }
.yj-synth-presets { display: flex; flex-wrap: wrap; gap: 4px; }
.yj-synth-preset {
  font-family: var(--f-mono); font-size: 9px; letter-spacing: 0.06em;
  padding: 3px 8px; cursor: pointer; color: var(--yj-ink-dim);
  background: var(--yj-well); border: 1px solid var(--yj-line);
}
.yj-synth-preset:hover { color: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-synth-preset.is-on { color: #0B0A07; background: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-synth-formula {
  width: 100%; min-height: 46px; resize: vertical;
  font-family: var(--f-mono); font-size: 11px; line-height: 1.5;
  color: var(--yj-yellow); background: var(--yj-well);
  border: 1px solid var(--yj-line); padding: 6px 8px;
}
.yj-synth-formula:focus { outline: none; border-color: var(--yj-yellow); }
.yj-synth-formula.is-bad { border-color: var(--yj-red, #e0533d); color: var(--yj-ink); }
.yj-synth-plot { width: 100%; height: 54px; display: block;
  background: var(--yj-well); border: 1px solid var(--yj-line); }
.yj-synth-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.yj-synth-msg { font-family: var(--f-mono); font-size: 9px; line-height: 1.5;
  color: var(--yj-ink-dim); min-height: 13px; }
.yj-synth-msg.is-bad { color: var(--yj-red, #e0533d); }
.yj-synth-name { font-family: var(--f-mono); font-size: 10px; width: 96px;
  color: var(--yj-ink); background: var(--yj-well); border: 1px solid var(--yj-line); padding: 3px 6px; }
.yj-synth-len { width: 74px; }
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export class SynthView extends EventTarget {
  constructor(host, presets) {
    super();
    injectStyle();
    this.host = host;
    this._presets = presets || [];
    this._seconds = 0.6;
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.className = 'yj-synth';

    const presetRow = document.createElement('div');
    presetRow.className = 'yj-synth-presets';
    this._presetBtns = this._presets.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-synth-preset';
      b.textContent = p.name;
      b.title = p.note;
      b.addEventListener('click', () => this._loadPreset(p));
      presetRow.appendChild(b);
      return b;
    });

    const area = document.createElement('textarea');
    area.className = 'yj-synth-formula';
    area.spellcheck = false;
    area.title = 'Variables: t (seconds), n (sample). Functions: sin cos exp env saw sqr tri noise clamp min max pow abs sqrt log sign floor. Constants: pi tau e.';
    area.addEventListener('input', () => this._onEdit());
    this._area = area;

    const plot = document.createElement('canvas');
    plot.className = 'yj-synth-plot';
    plot.title = 'The waveform this formula produces';
    this._plot = plot;

    const msg = document.createElement('div');
    msg.className = 'yj-synth-msg';
    this._msg = msg;

    const row = document.createElement('div');
    row.className = 'yj-synth-row';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'yj-synth-name';
    name.value = 'SYNTH';
    name.title = 'Instrument name';
    this._name = name;

    const len = document.createElement('input');
    len.type = 'range';
    len.className = 'yj-synth-len';
    len.min = '0.05';
    len.max = '4';
    len.step = '0.05';
    len.value = String(this._seconds);
    len.title = 'Length in seconds';
    const lenVal = document.createElement('span');
    lenVal.className = 'yj-synth-msg';
    len.addEventListener('input', () => {
      this._seconds = Number(len.value);
      lenVal.textContent = this._seconds.toFixed(2) + 's';
      this._onEdit();
    });
    this._lenVal = lenVal;

    const hear = document.createElement('button');
    hear.type = 'button';
    hear.className = 'yj-btn';
    hear.textContent = 'HEAR';
    hear.addEventListener('click', () => this._emitIfValid('preview'));

    const make = document.createElement('button');
    make.type = 'button';
    make.className = 'yj-btn yj-btn-primary';
    make.textContent = 'MAKE INSTRUMENT';
    make.title = 'Render this formula onto a free machine track';
    make.addEventListener('click', () => this._emitIfValid('make'));

    row.append(name, len, lenVal, hear, make);
    wrap.append(presetRow, area, plot, msg, row);
    host.appendChild(wrap);

    if (this._presets.length) this._loadPreset(this._presets[0]);
  }

  get formula() { return this._area ? this._area.value : ''; }
  get seconds() { return this._seconds; }

  // The controller reports back whether the formula compiled, and draws the
  // waveform, because rendering audio is its job and not the view's.
  setStatus(ok, message) {
    if (!this._area) return;
    this._area.classList.toggle('is-bad', !ok);
    this._msg.classList.toggle('is-bad', !ok);
    this._msg.textContent = message || '';
  }

  get plotCanvas() { return this._plot; }

  _loadPreset(p) {
    this._area.value = p.formula;
    this._name.value = p.name;
    this._role = p.role;
    this._seconds = p.seconds;
    this._lenVal.textContent = p.seconds.toFixed(2) + 's';
    for (let i = 0; i < this._presetBtns.length; i++) {
      this._presetBtns[i].classList.toggle('is-on', this._presets[i] === p);
    }
    this._msg.textContent = p.note;
    this._onEdit();
  }

  _onEdit() {
    for (const b of this._presetBtns) b.classList.remove('is-on');
    this.dispatchEvent(new CustomEvent('formula', {
      detail: { formula: this.formula, seconds: this._seconds },
    }));
  }

  _emitIfValid(type) {
    this.dispatchEvent(new CustomEvent(type, {
      detail: {
        formula: this.formula,
        seconds: this._seconds,
        name: (this._name.value || 'SYNTH').toUpperCase().slice(0, 16),
        role: this._role || 'TONE',
      },
    }));
  }
}
