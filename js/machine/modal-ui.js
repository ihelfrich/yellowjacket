// MODAL panel: a struck sound written as the short table of numbers it really
// is. js/analysis/modal.js fits a hit to a sum of exponentially damped
// sinusoids; this view shows that fit as rows you can edit and hear, and as the
// same sum written out as an equation, so the table and the formula are one
// object rather than two views that can disagree.
//
// Pure view. No store, no Web Audio, no analysis: the caller resynthesizes on
// every 'edit' so the user hears the number move while they move it.
// Events: 'edit' {modes}, 'hear' {what}, 'make' {modes, name}.

const STYLE = `
.yj-modal { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.yj-modal-bar { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.yj-modal-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-modal-fit {
  flex: 1 1 260px; min-width: 200px; text-align: left; font-size: 10px; line-height: 1.55;
  color: var(--yj-ink-dim); white-space: normal;
}
.yj-modal-fit.is-poor { color: var(--yj-amber); border-color: var(--yj-amber-dim); }
.yj-modal-head, .yj-modal-row {
  display: grid; grid-template-columns: 18px 72px 72px 60px 1fr 38px 20px 20px;
  gap: 5px; align-items: center; min-width: 0;
}
.yj-modal-head {
  font-family: var(--f-mono); font-size: 9px; letter-spacing: 0.06em;
  color: var(--yj-ink-dim); padding: 0 0 2px 0; border-bottom: 1px solid var(--yj-line);
}
.yj-modal-head span:first-child { text-align: right; }
/* an author display rule beats the UA sheet's [hidden], so restate it here */
.yj-modal-head[hidden] { display: none; }
.yj-modal-list { display: flex; flex-direction: column; gap: 3px; max-height: 250px; overflow-y: auto; overflow-x: hidden; }
.yj-modal-row.is-off { opacity: 0.4; }
.yj-modal-idx { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); text-align: right; }
.yj-modal-num {
  width: 100%; min-width: 0; font-family: var(--f-mono); font-size: 10px;
  color: var(--yj-yellow); background: var(--yj-well); border: 1px solid var(--yj-line);
  padding: 3px 4px; font-variant-numeric: tabular-nums;
}
.yj-modal-num:focus { outline: none; border-color: var(--yj-yellow); }
.yj-modal-track { height: 8px; background: var(--yj-well); border: 1px solid var(--yj-line); overflow: hidden; }
.yj-modal-fill { height: 100%; width: 0%; background: var(--yj-yellow); }
.yj-modal-pct { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); text-align: right; font-variant-numeric: tabular-nums; }
.yj-modal-sq {
  width: 20px; height: 20px; padding: 0; background: var(--yj-panel); border: 1px solid var(--yj-line);
  border-radius: 2px; font-family: var(--f-mono); font-size: 9px; line-height: 1; color: var(--yj-ink-dim); cursor: pointer;
}
.yj-modal-sq:hover:not(:disabled) { border-color: var(--yj-amber); color: var(--yj-yellow); }
.yj-modal-sq.is-on { background: var(--yj-yellow); border-color: var(--yj-yellow); color: #0B0A07; }
.yj-modal-sq:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-modal-formula {
  text-align: left; font-size: 10px; line-height: 1.65; color: var(--yj-yellow);
  word-break: break-word; user-select: text; cursor: text;
}
.yj-modal-empty { font-family: var(--f-mono); font-size: 10px; line-height: 1.5; color: var(--yj-ink-dim); padding: 6px 2px; }
.yj-modal-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.yj-modal-name {
  font-family: var(--f-mono); font-size: 10px; width: 96px; color: var(--yj-ink);
  background: var(--yj-well); border: 1px solid var(--yj-line); padding: 3px 6px;
}
`;

// fitDb is 10*log10(residualEnergy / signalEnergy), so -12 dB is a leftover a
// quarter as loud as the hit by amplitude. Above that the residual carries the
// character of the sound and the modal model is the wrong description.
const POOR_FIT_DB = -12;
const PART_FIT_DB = -20;

const FREQ_MIN_HZ = 0.1;
const TAU_MIN_MS = 1;
const TAU_MAX_MS = 60000;
const AMP_MAX = 8;
const PHASE_EPS = 0.005;        // below this the phase prints as 0.00: leave it out
const DEFAULT_SAMPLE_RATE = 44100;
const NAME_MAX = 16;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

// A blank or half-typed field is not an edit: hold the last good value rather
// than dropping the partial to zero and firing a resynthesis at silence.
function readNumber(el) {
  const text = el && el.value != null ? String(el.value).trim() : '';
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export class ModalView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this._modes = [];
    this._rows = [];
    this._sampleRate = DEFAULT_SAMPLE_RATE;
    this._fitDb = 0;
    this._hasFit = false;
    this._edited = false;
    this._busy = false;
    if (!host) return;

    host.classList.add('yj-modal');

    const bar = document.createElement('div');
    bar.className = 'yj-modal-bar';
    const tag = document.createElement('span');
    tag.className = 'yj-modal-tag';
    tag.textContent = 'MODAL';
    const fit = document.createElement('div');
    fit.className = 'yj-well yj-modal-fit';
    fit.textContent = 'NO FIT YET · ANALYSE A STRUCK SLICE TO SEE ITS MODES';
    this._fit = fit;
    bar.append(tag, fit);

    const head = document.createElement('div');
    head.className = 'yj-modal-head';
    for (const label of ['#', 'FREQ Hz', 'DECAY ms', 'AMP', 'ENERGY', '', 'M', 'S']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      head.appendChild(cell);
    }
    this._head = head;

    const list = document.createElement('div');
    list.className = 'yj-modal-list';
    this._list = list;

    const formula = document.createElement('div');
    formula.className = 'yj-well yj-modal-formula';
    formula.title = 'The same modes as an equation. Select it and paste it into SYNTH: env(t,x) is the decay, tau is 2*pi.';
    formula.textContent = '0';
    this._formula = formula;

    const foot = document.createElement('div');
    foot.className = 'yj-modal-foot';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'yj-modal-name';
    name.value = 'MODAL';
    name.title = 'Instrument name';
    this._name = name;

    const mk = (text, title, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = primary ? 'yj-btn yj-btn-primary' : 'yj-btn';
      b.textContent = text;
      b.title = title;
      b.disabled = true;
      return b;
    };
    this._btnOriginal = mk('HEAR ORIGINAL', 'Play the recorded hit as it came in', false);
    this._btnOriginal.addEventListener('click', () => this._emit('hear', { what: 'original' }));
    this._btnModel = mk('HEAR MODEL', 'Play these numbers, resynthesized', false);
    this._btnModel.addEventListener('click', () => this._emit('hear', { what: 'model' }));
    this._btnResidual = mk('HEAR RESIDUAL', 'Play what the model does not account for. A good fit leaves a whisper.', false);
    this._btnResidual.addEventListener('click', () => this._emit('hear', { what: 'residual' }));
    this._btnMake = mk('MAKE INSTRUMENT', 'Render these modes onto a free machine track', true);
    this._btnMake.addEventListener('click', () => this._emit('make', {
      modes: this._payload(),
      name: this._readName(),
    }));

    foot.append(name, this._btnOriginal, this._btnModel, this._btnResidual, this._btnMake);
    host.append(bar, head, list, formula, foot);
    this._render();
  }

  // ---------- public API ----------

  // fit is what fitModal returned. Mute and solo reset with it: they describe
  // the rows on screen, and these are new rows.
  setFit(fit, sampleRate) {
    this._sampleRate = Number.isFinite(sampleRate) && sampleRate > 0
      ? sampleRate
      : DEFAULT_SAMPLE_RATE;
    const modes = fit && Array.isArray(fit.modes) ? fit.modes : [];
    this._modes = modes.map((mode) => ({
      freqHz: Number.isFinite(mode.freqHz) ? mode.freqHz : 0,
      tauSec: Number.isFinite(mode.tauSec) && mode.tauSec > 0 ? mode.tauSec : TAU_MIN_MS / 1000,
      amp: Number.isFinite(mode.amp) ? mode.amp : 0,
      phase: Number.isFinite(mode.phase) ? mode.phase : 0,
      energyFrac: Number.isFinite(mode.energyFrac) ? mode.energyFrac : 0,
      muted: false,
      soloed: false,
    }));
    this._fitDb = fit && Number.isFinite(fit.fitDb) ? fit.fitDb : 0;
    this._hasFit = !!fit;
    this._edited = false;
    this._render();
  }

  setBusy(busy) {
    this._busy = !!busy;
    if (!this.host) return;
    this._btnMake.classList.toggle('is-working', this._busy);
    this._syncButtons();
  }

  // ---------- rendering ----------

  // Rows are rebuilt only when the fit changes. An edit updates the derived
  // parts in place, because rebuilding on every keystroke would tear the field
  // out from under the caret.
  _render() {
    if (!this.host) return;
    this._rows = this._modes.map((mode, index) => this._buildRow(mode, index));
    const nodes = this._rows.map((row) => row.el);
    if (!this._modes.length) {
      const empty = document.createElement('div');
      empty.className = 'yj-modal-empty';
      empty.textContent = this._hasFit
        ? 'NO MODES FOUND · nothing in this slice rings long enough to be described as a decaying sinusoid.'
        : 'NO FIT YET · pick a struck slice and analyse it.';
      nodes.push(empty);
    }
    this._list.replaceChildren(...nodes);
    this._head.hidden = this._modes.length === 0;
    this._rescore();
    this._syncDerived();
  }

  _buildRow(mode, index) {
    const el = document.createElement('div');
    el.className = 'yj-modal-row';

    const idx = document.createElement('span');
    idx.className = 'yj-modal-idx';
    idx.textContent = String(index + 1);

    const freq = this._numField(
      mode.freqHz.toFixed(1),
      '0.1',
      'Pitch of partial ' + (index + 1) + ' in hertz. Type or hold the arrows: the sound follows as you move it.',
    );
    freq.addEventListener('input', () => this._editFreq(index, freq));

    const tau = this._numField(
      (mode.tauSec * 1000).toFixed(1),
      '1',
      'How long partial ' + (index + 1) + ' takes to fall to 37 percent of its start, in milliseconds. Longer is a bell, shorter is a thud.',
    );
    tau.addEventListener('input', () => this._editTau(index, tau));

    const amp = this._numField(
      mode.amp.toFixed(3),
      '0.01',
      'How loud partial ' + (index + 1) + ' starts, in the units of the recording.',
    );
    amp.addEventListener('input', () => this._editAmp(index, amp));

    const track = document.createElement('div');
    track.className = 'yj-modal-track';
    track.title = 'Share of the modelled energy this partial carries';
    const fill = document.createElement('div');
    fill.className = 'yj-modal-fill';
    track.appendChild(fill);

    const pct = document.createElement('span');
    pct.className = 'yj-modal-pct';

    const mute = this._sqButton('M', 'Drop partial ' + (index + 1) + ' from the sound');
    mute.addEventListener('click', () => this._toggle(index, 'muted'));

    const solo = this._sqButton('S', 'Hear partial ' + (index + 1) + ' alone');
    solo.addEventListener('click', () => this._toggle(index, 'soloed'));

    el.append(idx, freq, tau, amp, track, pct, mute, solo);
    return { el, freq, tau, amp, fill, pct, mute, solo };
  }

  _numField(value, step, title) {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'yj-modal-num';
    el.step = step;
    el.value = value;
    el.title = title;
    return el;
  }

  _sqButton(text, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'yj-modal-sq';
    b.textContent = text;
    b.title = title;
    return b;
  }

  // ---------- edits ----------

  _editFreq(index, el) {
    const parsed = readNumber(el);
    if (parsed === null) return;
    // Above Nyquist a mode does not exist at the frequency it claims, it folds.
    const value = clamp(parsed, FREQ_MIN_HZ, this._sampleRate / 2);
    if (value !== parsed) el.value = String(value);
    this._modes[index].freqHz = value;
    this._commit();
  }

  _editTau(index, el) {
    const parsed = readNumber(el);
    if (parsed === null) return;
    const value = clamp(parsed, TAU_MIN_MS, TAU_MAX_MS);
    if (value !== parsed) el.value = String(value);
    this._modes[index].tauSec = value / 1000;
    this._commit();
  }

  _editAmp(index, el) {
    const parsed = readNumber(el);
    if (parsed === null) return;
    const value = clamp(parsed, 0, AMP_MAX);
    if (value !== parsed) el.value = String(value);
    this._modes[index].amp = value;
    this._commit();
  }

  _toggle(index, key) {
    this._modes[index][key] = !this._modes[index][key];
    this._commit();
  }

  _commit() {
    this._edited = true;
    this._rescore();
    this._syncDerived();
    this._emit('edit', { modes: this._payload() });
  }

  // ---------- derived state ----------

  _audible() {
    let soloing = false;
    for (const mode of this._modes) if (mode.soloed) soloing = true;
    return this._modes.filter((mode) => !mode.muted && (!soloing || mode.soloed));
  }

  // The energy an isolated damped sinusoid carries goes as amp^2 * tau, the
  // same proxy the fitter ranks by, so the bars keep tracking the numbers once
  // the user starts editing them.
  _rescore() {
    const audible = this._audible();
    let total = 0;
    for (const mode of audible) total += mode.amp * mode.amp * mode.tauSec;
    for (const mode of this._modes) mode.energyFrac = 0;
    if (!(total > 0)) return;
    for (const mode of audible) mode.energyFrac = mode.amp * mode.amp * mode.tauSec / total;
  }

  // Cloned records in the shape synthModal reads, so the caller can pass the
  // payload straight through and mutating it cannot reach back into the table.
  _payload() {
    return this._audible().map((mode) => ({
      freqHz: mode.freqHz,
      tauSec: mode.tauSec,
      amp: mode.amp,
      phase: mode.phase,
      energyFrac: mode.energyFrac,
    }));
  }

  _formulaText() {
    const parts = this._audible().map((mode) => {
      const phase = Math.abs(mode.phase) >= PHASE_EPS ? ' + ' + mode.phase.toFixed(2) : '';
      return mode.amp.toFixed(2) + '*sin(tau*' + mode.freqHz.toFixed(1) + '*t' + phase + ')'
        + '*env(t,' + mode.tauSec.toFixed(3) + ')';
    });
    return parts.length ? parts.join(' + ') : '0';
  }

  _fitText() {
    if (!this._hasFit) return 'NO FIT YET · ANALYSE A STRUCK SLICE TO SEE ITS MODES';
    const level = 'RESIDUAL ' + this._fitDb.toFixed(1) + ' dB · ';
    // Stale once the numbers move: the residual was measured against the fit
    // that came in, not against whatever the user has dialled since.
    const stale = this._edited ? ' Measured on the original fit, not on your edits.' : '';
    if (!this._modes.length) {
      return level + 'no modes came out of this slice, so there is no model to hear.' + stale;
    }
    if (this._fitDb > POOR_FIT_DB) {
      return level + 'most of this sound is not modal. What is left over is more than a quarter'
        + ' as loud as the hit, so the model will sound thin and hollow beside it. Cymbals, snares'
        + ' and noisy attacks land here.' + stale;
    }
    if (this._fitDb > PART_FIT_DB) {
      return level + 'the ring fits, the attack does not. Expect the model to keep the tone and'
        + ' lose the click at the front.' + stale;
    }
    return level + 'the model accounts for nearly all of this sound. Editing these numbers is'
      + ' editing the hit.' + stale;
  }

  _syncDerived() {
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i];
      const mode = this._modes[i];
      const pct = mode.energyFrac * 100;
      row.fill.style.width = clamp(pct, 0, 100).toFixed(1) + '%';
      row.pct.textContent = pct >= 0.05 ? pct.toFixed(1) + '%' : '--';
      row.mute.classList.toggle('is-on', mode.muted);
      row.solo.classList.toggle('is-on', mode.soloed);
      row.el.classList.toggle('is-off', mode.muted || this._shadowed(mode));
    }
    this._formula.textContent = this._formulaText();
    this._fit.textContent = this._fitText();
    this._fit.classList.toggle('is-poor', this._hasFit && this._fitDb > POOR_FIT_DB);
    this._syncButtons();
  }

  // Not soloed while some other row is: silent, but for a different reason
  // than mute, so the row dims without the M key lighting up.
  _shadowed(mode) {
    if (mode.soloed) return false;
    for (const other of this._modes) if (other.soloed) return true;
    return false;
  }

  _syncButtons() {
    const heard = this._hasFit && !this._busy;
    const modelled = heard && this._modes.length > 0;
    this._btnOriginal.disabled = !heard;
    this._btnResidual.disabled = !heard;
    this._btnModel.disabled = !modelled;
    this._btnMake.disabled = !modelled;
    this._name.disabled = this._busy;
  }

  _readName() {
    const raw = this._name && this._name.value ? String(this._name.value).trim() : '';
    return (raw || 'MODAL').toUpperCase().slice(0, NAME_MAX);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
