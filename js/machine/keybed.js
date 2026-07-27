// Yellowjacket MACHINE — QWERTY keybed (PATTERN slice). Digit1..Digit8 fire
// tracks 0-7, pad-style. Matched on e.code (the physical top row) so AZERTY
// and friends keep the same keys. Keydown only; repeats and modifier chords
// are ignored, and so are keystrokes aimed at anything editable or a button
// (buttons own Space/Enter and users tab around). The event is swallowed
// (preventDefault + stopPropagation) ONLY when a trigger actually fires, so
// digits still type into wells and inputs everywhere else. No DOM created.

// Null prototype: a lookup can only hit the eight digit codes, never an
// inherited Object.prototype member.
const KEY_TRACK = Object.assign(Object.create(null), {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3,
  Digit5: 4, Digit6: 5, Digit7: 6, Digit8: 7,
});

// Targets that own their own keystrokes; a match anywhere up the tree wins,
// so a label span inside a button still counts as the button.
const TYPING_TARGETS = 'input, select, textarea, [contenteditable], button';

export class Keybed {
  constructor() {
    this._onTrig = null;
    this._onFill = null;
    this._fillHeld = false;
    this._enabled = true;   // main.js gates this per tab; attach() alone is live
    this._handler = (e) => this._onKey(e);
    this._upHandler = (e) => this._onKeyUp(e);
  }

  // Stores the callbacks and adds ONE keydown + ONE keyup window listener. The
  // handler references never change, so addEventListener dedupes double attach.
  attach(onTrig, onFill = null) {
    this._onTrig = onTrig;
    this._onFill = onFill;
    window.addEventListener('keydown', this._handler);
    window.addEventListener('keyup', this._upHandler);
  }

  detach() {
    window.removeEventListener('keydown', this._handler);
    window.removeEventListener('keyup', this._upHandler);
    this._onTrig = null;
    this._onFill = null;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(b) {
    this._enabled = !!b;
    // Disabling mid-hold (tab switch with F down) must not leave fill latched.
    if (!this._enabled && this._fillHeld) {
      this._fillHeld = false;
      if (this._onFill) this._onFill(false);
    }
  }

  _onKey(e) {
    if (!this._enabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest(TYPING_TARGETS)) return;
    // KeyF = momentary FILL while held.
    if (e.code === 'KeyF' && this._onFill) {
      if (!e.repeat && !this._fillHeld) {
        this._fillHeld = true;
        this._onFill(true);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.repeat || !this._onTrig) return;
    const track = KEY_TRACK[e.code];
    if (track === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this._onTrig(track);
  }

  _onKeyUp(e) {
    if (e.code !== 'KeyF' || !this._fillHeld) return;
    this._fillHeld = false;
    if (this._onFill) this._onFill(false);
  }
}
