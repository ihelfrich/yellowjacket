// Yellowjacket MACHINE — PAD GRID. Until now the groovebox had no instrument
// surface: tracks fired from QWERTY 1-8 or from external MIDI, so with a mouse
// and no hardware you could program a pattern but never play one. Eight pads,
// struck on pointerdown, because waiting for click adds the whole press-to-
// release interval to every hit and latency is the entire point of a pad.
// Velocity comes from where in the pad you land (high is hard, low is soft),
// which is what gives a mouse dynamics. Pure view: no store access, no Web
// Audio, no DOM at module top level.
//
// Events: 'trig' {track, velocity}, 'release' {track}.

const PADS = 8;
const VEL_TOP = 1;                  // velocity at the top edge of a pad
const VEL_BOTTOM = 0.4;             // ...and at the bottom edge
const FLASH_MS = 90;                // decay of an outside light-up (sequencer, MIDI)

const STYLE = `
.yj-pads { display: flex; flex-direction: column; gap: 8px; }
.yj-pads-head { display: flex; align-items: center; gap: 8px; }
.yj-pads-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-pads-hint {
  font-family: var(--f-mono); font-size: 9px; letter-spacing: 0.03em; color: var(--yj-ink-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.yj-pads-step {
  margin-left: auto; flex-shrink: 0; font-family: var(--f-mono); font-size: 10px;
  color: var(--yj-yellow); font-variant-numeric: tabular-nums; padding: 2px 8px;
}
.yj-pads-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.yj-pad {
  position: relative; display: flex; flex-direction: column; align-items: flex-start;
  aspect-ratio: 1 / 1; min-height: 62px; max-height: 124px; padding: 6px 7px; overflow: hidden;
  background-color: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px;
  cursor: pointer; touch-action: none; -webkit-user-select: none; user-select: none;
}
/* The gradient is the silkscreen for the velocity axis: the lit end is the hard end. */
.yj-pad::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 62%; pointer-events: none;
  background: linear-gradient(180deg, rgba(255, 212, 0, 0.13), rgba(255, 212, 0, 0));
}
.yj-pad:hover { border-color: var(--yj-line-hi); }
.yj-pad:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 2px; }
.yj-pad.is-lit { background-color: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-pad.is-lit::before { background: none; }
.yj-pad.is-empty { opacity: 0.5; }
.yj-pad.is-empty::before { background: none; }
.yj-pad.is-empty.is-lit { background-color: var(--yj-amber-dim); border-color: var(--yj-amber); }
.yj-pad-num { font-family: var(--f-mono); font-size: 10px; line-height: 1; color: var(--yj-amber); }
.yj-pad-vel {
  position: absolute; right: 7px; top: 6px; font-family: var(--f-mono); font-size: 9px;
  line-height: 1; color: var(--yj-ink-dim); font-variant-numeric: tabular-nums;
}
.yj-pad-name {
  margin-top: auto; width: 100%; text-align: left; font-family: var(--f-mono); font-size: 10px;
  line-height: 1.2; letter-spacing: 0.03em; color: var(--yj-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.yj-pad.is-empty .yj-pad-name { color: var(--yj-ink-dim); }
.yj-pad.is-lit .yj-pad-num,
.yj-pad.is-lit .yj-pad-vel,
.yj-pad.is-lit .yj-pad-name { color: var(--yj-bg); }
@media (max-width: 560px) {
  .yj-pads-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .yj-pads-hint { display: none; }
}
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined' || !document.head) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export class PadGridView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this._tracks = [];
    this._pads = [];
    this._held = new Map();         // pointerId -> track index
    this._keys = new Set();         // track indices held down from the keyboard
    this._flashTimers = new Array(PADS).fill(null);
    this._winUp = null;
    this._led = null;
    this._stepOut = null;
    if (!host || typeof document === 'undefined') return;

    host.classList.add('yj-pads');

    const head = document.createElement('div');
    head.className = 'yj-pads-head';
    const tag = document.createElement('span');
    tag.className = 'yj-pads-tag';
    tag.textContent = 'PADS';
    const hint = document.createElement('span');
    hint.className = 'yj-pads-hint';
    hint.textContent = 'HIT HIGH FOR HARD, LOW FOR SOFT · KEYS 1-8';
    const led = document.createElement('span');
    led.className = 'yj-led';
    led.title = 'Lights on every downbeat while the sequencer runs';
    const step = document.createElement('span');
    step.className = 'yj-well yj-pads-step';
    step.textContent = '—';
    step.title = 'Step the sequencer is on';
    head.append(tag, hint, led, step);
    host.appendChild(head);
    this._led = led;
    this._stepOut = step;

    const grid = document.createElement('div');
    grid.className = 'yj-pads-grid';
    for (let i = 0; i < PADS; i++) grid.appendChild(this._buildPad(i));
    host.appendChild(grid);
  }

  // ---------- public API ----------

  setTracks(tracks) {
    this._tracks = tracks || [];
    for (let i = 0; i < this._pads.length; i++) {
      const t = this._tracks[i];
      const has = !!(t && t.sample);
      const label = has ? (t.sample.label || 'SAMPLE') : 'EMPTY';
      const pad = this._pads[i];
      if (pad.name.textContent !== label) pad.name.textContent = label;
      pad.el.classList.toggle('is-empty', !has);
    }
  }

  // Lights a pad from outside, so the sequencer and incoming MIDI mark the same
  // squares the mouse does. Safe before setTracks: the pads exist from
  // construction, and an out-of-range index is ignored rather than thrown.
  flash(trackIndex) {
    const i = Math.trunc(Number(trackIndex));
    if (!this._pads[i]) return;
    if (this._flashTimers[i] != null) clearTimeout(this._flashTimers[i]);
    this._flashTimers[i] = setTimeout(() => {
      this._flashTimers[i] = null;
      this._syncLit(i);
    }, FLASH_MS);
    this._syncLit(i);
  }

  // Optional position readout: the pads double as a transport display, so you
  // can perform over a running pattern without looking back at the grid.
  setPlayingStep(step) {
    const s = (typeof step === 'number' && isFinite(step) && step >= 0) ? Math.floor(step) : null;
    if (this._stepOut) this._stepOut.textContent = s == null ? '—' : 'STEP ' + String(s + 1).padStart(2, '0');
    if (this._led) this._led.classList.toggle('is-on', s != null && s % 4 === 0);
  }

  // ---------- pads ----------

  _buildPad(i) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'yj-pad is-empty';
    b.dataset.track = String(i);
    b.title = 'Track ' + (i + 1) + ' · key ' + (i + 1)
      + '. Strike near the top for a hard hit, near the bottom for a soft one.';

    const num = document.createElement('span');
    num.className = 'yj-pad-num';
    num.textContent = String(i + 1);

    const vel = document.createElement('span');
    vel.className = 'yj-pad-vel';
    vel.textContent = '';

    const name = document.createElement('span');
    name.className = 'yj-pad-name';
    name.textContent = 'EMPTY';

    b.addEventListener('pointerdown', (e) => this._down(i, e));
    b.addEventListener('pointerup', (e) => this._up(e));
    b.addEventListener('pointercancel', (e) => this._up(e));
    b.addEventListener('lostpointercapture', (e) => this._up(e));
    b.addEventListener('keydown', (e) => this._keyDown(i, e));
    b.addEventListener('keyup', (e) => this._keyUp(i, e));
    b.addEventListener('blur', () => this._keyRelease(i));

    b.append(num, vel, name);
    this._pads.push({ el: b, name, vel });
    return b;
  }

  _down(i, e) {
    if (e.button !== 0) return;
    const id = e.pointerId == null ? -1 : e.pointerId;
    // Capture keeps the release on this pad when the pointer slides off it.
    // Synthetic and remote pointers have no capturable id and throw; the
    // window backstop below covers their release instead.
    try { this._pads[i].el.setPointerCapture(id); } catch { /* not capturable */ }
    this._held.set(id, i);
    this._watch(true);
    const v = this._velocityAt(i, e);
    this._pads[i].vel.textContent = v.toFixed(2);
    this._syncLit(i);
    // An empty pad still emits: the caller decides whether silence is the right
    // answer, and a pad that swallowed the hit would read as a dead surface.
    this._emit('trig', { track: i, velocity: v });
  }

  _velocityAt(i, e) {
    const el = this._pads[i].el;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const h = rect ? rect.height : 0;
    // A pad measured while hidden reports zero height. Firing every such hit at
    // the soft rail would be worse than ignoring position, so fall back to full.
    if (!h || !isFinite(h) || !isFinite(e.clientY)) return VEL_TOP;
    const f = Math.min(1, Math.max(0, (e.clientY - rect.top) / h));
    return Math.round((VEL_TOP - f * (VEL_TOP - VEL_BOTTOM)) * 1000) / 1000;
  }

  _up(e) {
    this._release(e.pointerId == null ? -1 : e.pointerId);
  }

  // Idempotent: the pad and the window backstop both route here, and in a real
  // browser both fire for the same release.
  _release(id) {
    if (!this._held.has(id)) return;
    const i = this._held.get(id);
    this._held.delete(id);
    if (!this._held.size) this._watch(false);
    this._finish(i);
  }

  // A second finger (or the QWERTY key) still down on the same track keeps the
  // note alive: release means the last hand came off, not any hand.
  _finish(i) {
    this._syncLit(i);
    if (this._keys.has(i)) return;
    for (const t of this._held.values()) if (t === i) return;
    this._emit('release', { track: i });
  }

  // ---------- keyboard ----------

  _keyDown(i, e) {
    if (e.repeat) return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();               // no synthesized click on keyup
    e.stopPropagation();              // keep main.js space-to-play out of it
    if (this._keys.has(i)) return;
    this._keys.add(i);
    // The keyboard carries no position, so it plays the pad at full strength.
    this._pads[i].vel.textContent = VEL_TOP.toFixed(2);
    this._syncLit(i);
    this._emit('trig', { track: i, velocity: VEL_TOP });
  }

  _keyUp(i, e) {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    this._keyRelease(i);
  }

  _keyRelease(i) {
    if (!this._keys.has(i)) return;   // blur with no key down must stay quiet
    this._keys.delete(i);
    this._finish(i);
  }

  // ---------- lighting ----------

  _syncLit(i) {
    const pad = this._pads[i];
    if (!pad) return;
    let lit = this._keys.has(i) || this._flashTimers[i] != null;
    if (!lit) {
      for (const t of this._held.values()) {
        if (t === i) { lit = true; break; }
      }
    }
    pad.el.classList.toggle('is-lit', lit);
  }

  // ---------- window backstop ----------

  // Listeners exist only while a pad is held, so the view leaves nothing on the
  // window between hits and needs no teardown call from the integrator.
  _watch(on) {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    if (on === !!this._winUp) return;
    if (on) {
      this._winUp = (e) => this._up(e);
      window.addEventListener('pointerup', this._winUp);
      window.addEventListener('pointercancel', this._winUp);
    } else {
      window.removeEventListener('pointerup', this._winUp);
      window.removeEventListener('pointercancel', this._winUp);
      this._winUp = null;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
