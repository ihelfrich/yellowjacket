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
    this._enabled = true;   // main.js gates this per tab; attach() alone is live
    this._handler = (e) => this._onKey(e);
  }

  // Stores the callback and adds ONE window keydown listener. The handler
  // reference never changes, so addEventListener dedupes a double attach.
  attach(onTrig) {
    this._onTrig = onTrig;
    window.addEventListener('keydown', this._handler);
  }

  detach() {
    window.removeEventListener('keydown', this._handler);
    this._onTrig = null;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(b) {
    this._enabled = !!b;
  }

  _onKey(e) {
    if (!this._enabled || !this._onTrig) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const track = KEY_TRACK[e.code];
    if (track === undefined) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest(TYPING_TARGETS)) return;
    e.preventDefault();
    e.stopPropagation();
    this._onTrig(track);
  }
}
