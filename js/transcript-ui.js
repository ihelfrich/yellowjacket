// Yellowjacket — transcript instrument. Words are tokens on the original
// timeline; edits are flags (word.deleted plus a parallel gap-cut array) that
// compile to Cut ranges via getCuts(). All times are seconds on the ORIGINAL
// buffer. The view renders into its own child element so siblings inside the
// container (the empty-state hint) survive re-renders.

const GAP_PILL = 0.35;    // gaps longer than this get a clickable pill token
const GAP_BREATH = 0.12;  // dead-air cuts keep this much room at each end
const MERGE_TOL = 0.02;   // cuts this close together merge into one
const SCROLL_MS = 300;    // playback autoscroll throttle

export class TranscriptView extends EventTarget {
  // events: 'wordclick'   {index, t}            — seek intent
  //         'selectrange' {start, end, i0, i1}  — seconds + inclusive word indices;
  //                                                all null when selection clears
  //         'beforeedit'  {}                    — fires before shared document mutation
  //         'edited'      {}                    — deleted flags or gap cuts changed
  constructor(container) {
    super();
    this._host = container;
    this._el = document.createElement('div');
    this._el.className = 'yj-words';
    container.appendChild(this._el);

    this._words = [];
    this._duration = 0;
    this._gapCut = [];      // parallel to words: true = gap after word i is cut
    this._wordEls = [];
    this._gapEls = [];      // sparse, indexed by word; null when no pill
    this._sel = null;       // {a, b} inclusive word indices, a <= b
    this._selAnchor = null;
    this._focusIndex = -1;  // roving keyboard focus among transcript words
    this._drag = null;      // {start, moved, shift}
    this._activeIndex = -1;
    this._lastScroll = 0;

    this._el.addEventListener('mousedown', (e) => this._onDown(e));
    this._el.addEventListener('mousemove', (e) => this._onMove(e));
    this._el.addEventListener('click', (e) => {
      const pill = e.target.closest('.yj-gap');
      if (pill && pill.dataset.g != null) this._toggleGap(Number(pill.dataset.g));
    });
    this._el.addEventListener('keydown', (e) => this._onWordKey(e));
    window.addEventListener('mouseup', (e) => this._onUp(e));
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  // ---------- public API ----------

  setWords(words, duration, gapCuts = null) {
    this._words = Array.isArray(words) ? words : [];
    const n = this._words.length;
    const last = n ? this._words[n - 1] : null;
    this._duration = typeof duration === 'number' && isFinite(duration) && duration > 0
      ? duration
      : last ? last.end + (last.gapAfter || 0) : 0;
    this._gapCut = Array.isArray(gapCuts) ? gapCuts : [];
    this._gapCut.length = n;
    for (let i = 0; i < n; i++) this._gapCut[i] = !!this._gapCut[i];
    this._sel = null;
    this._selAnchor = null;
    this._focusIndex = n ? 0 : -1;
    this._drag = null;
    this._activeIndex = -1;
    this._lastScroll = 0;
    this._render();
  }

  setActiveTime(t) {
    const words = this._words;
    const n = words.length;
    if (!n || typeof t !== 'number' || !isFinite(t)) return;
    // binary search: last word with start <= t, active only if t inside it
    let lo = 0, hi = n - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const active = idx >= 0 && t < words[idx].end ? idx : -1;
    if (active === this._activeIndex) return;
    const prev = this._wordEls[this._activeIndex];
    if (prev) prev.classList.remove('is-now');
    this._activeIndex = active;
    if (active < 0) return;
    const el = this._wordEls[active];
    if (!el) return;
    el.classList.add('is-now');
    const now = performance.now();
    if (now - this._lastScroll >= SCROLL_MS) {
      this._lastScroll = now;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  // Programmatic selection for provenance tracing. By default this is visual
  // only: following a woven event back to its word must not accidentally arm a
  // new material replacement. Callers may opt into the normal select event.
  selectRange(i0, i1, { emit = false, scroll = false } = {}) {
    if (!this._words.length) return false;
    const a = Math.max(0, Math.min(this._words.length - 1, Math.min(i0 | 0, i1 | 0)));
    const b = Math.max(0, Math.min(this._words.length - 1, Math.max(i0 | 0, i1 | 0)));
    this._applySel(a, b);
    this._selAnchor = a;
    this._setWordFocus(a, false);
    if (scroll) {
      const el = this._wordEls[a];
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    if (emit) this._emitSelect();
    return true;
  }

  deleteSelection() {
    return this._flagSelection(true);
  }

  restoreSelection() {
    return this._flagSelection(false);
  }

  markFillersDeleted() {
    const words = this._words;
    let count = 0;
    for (const w of words) if (w.filler && !w.deleted) count++;
    if (!count) return 0;
    this._pushUndo();
    for (const w of words) if (w.filler) w.deleted = true;
    this._refresh();
    this._emitEdited();
    return count;
  }

  markDeadAir(threshold = 1.0) {
    const th = typeof threshold === 'number' && isFinite(threshold) ? threshold : 1.0;
    const words = this._words;
    let count = 0;
    for (let i = 0; i < words.length; i++) {
      if ((words[i].gapAfter || 0) >= th && !this._gapCut[i]) count++;
    }
    if (!count) return 0;
    this._pushUndo();
    for (let i = 0; i < words.length; i++) {
      if ((words[i].gapAfter || 0) >= th) this._gapCut[i] = true;
    }
    this._refresh();
    this._emitEdited();
    return count;
  }

  restoreAll() {
    const dirty = this._words.some((w) => w.deleted) || this._gapCut.some(Boolean);
    if (!dirty && !this._sel) return;
    const hadSelection = !!this._sel;
    if (dirty) this._pushUndo();
    for (const w of this._words) w.deleted = false;
    this._gapCut.fill(false);
    this._sel = null;
    this._refresh();
    if (hadSelection) this._emitSelect();
    if (dirty) this._emitEdited();
  }

  getCuts(padding = 0.04) {
    const pad = typeof padding === 'number' && isFinite(padding) && padding >= 0 ? padding : 0.04;
    const words = this._words;
    const n = words.length;
    const dur = this._duration;
    const cuts = [];

    // deleted-word runs: pad into surrounding silence, never into a kept neighbor
    let i = 0;
    while (i < n) {
      if (!words[i].deleted) { i++; continue; }
      let j = i;
      while (j + 1 < n && words[j + 1].deleted) j++;
      let start = words[i].start - pad;
      if (i > 0) start = Math.max(start, words[i - 1].end);
      let end = words[j].end + pad;
      if (j + 1 < n) end = Math.min(end, words[j + 1].start);
      start = Math.max(0, start);
      end = Math.min(dur, end);
      if (end > start) cuts.push({ start, end });
      i = j + 1;
    }

    // gap cuts: keep a breath of silence at each end so joins stay natural
    for (let g = 0; g < n; g++) {
      if (!this._gapCut[g]) continue;
      const gapStart = words[g].end;
      const gapEnd = g + 1 < n ? words[g + 1].start : gapStart + (words[g].gapAfter || 0);
      const start = Math.max(0, gapStart + GAP_BREATH);
      const end = Math.min(dur, gapEnd - GAP_BREATH);
      if (end > start) cuts.push({ start, end });
    }

    cuts.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const c of cuts) {
      const prev = merged[merged.length - 1];
      if (prev && c.start <= prev.end + MERGE_TOL) {
        if (c.end > prev.end) prev.end = c.end;
      } else {
        merged.push({ start: c.start, end: c.end });
      }
    }
    return merged;
  }

  getText(includeDeleted = false) {
    const parts = [];
    for (const w of this._words) {
      if (includeDeleted || !w.deleted) parts.push(w.text);
    }
    return parts.join(' ');
  }

  // ---------- rendering ----------

  _render() {
    const words = this._words;
    const n = words.length;
    this._wordEls = new Array(n);
    this._gapEls = new Array(n).fill(null);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const w = words[i];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'yj-word' + (w.filler ? ' is-filler' : '') + (w.deleted ? ' is-cut' : '');
      el.dataset.i = String(i);
      el.textContent = w.text;
      el.tabIndex = i === this._focusIndex ? 0 : -1;
      el.setAttribute('aria-pressed', 'false');
      el.setAttribute('aria-label', 'Word ' + (i + 1) + ': ' + w.text);
      el.title = 'Enter seeks · Space selects · Shift+Arrow extends selection';
      this._wordEls[i] = el;
      frag.appendChild(el);
      frag.appendChild(document.createTextNode(' '));
      const gap = w.gapAfter || 0;
      if (gap > GAP_PILL) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'yj-gap' + (this._gapCut[i] ? ' is-cut' : '');
        pill.dataset.g = String(i);
        pill.textContent = '␣ ' + gap.toFixed(1) + 's';
        pill.title = 'Dead air. Click to toggle cut.';
        pill.setAttribute('aria-label', gap.toFixed(1) + ' seconds of dead air after word ' + (i + 1));
        pill.setAttribute('aria-pressed', this._gapCut[i] ? 'true' : 'false');
        this._gapEls[i] = pill;
        frag.appendChild(pill);
        frag.appendChild(document.createTextNode(' '));
      }
    }
    this._el.textContent = '';
    this._el.appendChild(frag);
  }

  _refresh() {
    const words = this._words;
    const sel = this._sel;
    for (let i = 0; i < words.length; i++) {
      const el = this._wordEls[i];
      if (!el) continue;
      el.classList.toggle('is-cut', !!words[i].deleted);
      el.classList.toggle('is-sel', !!sel && i >= sel.a && i <= sel.b);
      el.setAttribute('aria-pressed', sel && i >= sel.a && i <= sel.b ? 'true' : 'false');
      const pill = this._gapEls[i];
      if (pill) {
        pill.classList.toggle('is-cut', !!this._gapCut[i]);
        pill.setAttribute('aria-pressed', this._gapCut[i] ? 'true' : 'false');
      }
    }
  }

  // ---------- selection ----------

  _applySel(a, b) {
    const prev = this._sel;
    const next = a == null ? null : { a, b };
    if (prev && next && prev.a === next.a && prev.b === next.b) return;
    if (prev) {
      for (let i = prev.a; i <= prev.b; i++) {
        if (!next || i < next.a || i > next.b) {
          const el = this._wordEls[i];
          if (el) {
            el.classList.remove('is-sel');
            el.setAttribute('aria-pressed', 'false');
          }
        }
      }
    }
    if (next) {
      for (let i = next.a; i <= next.b; i++) {
        if (!prev || i < prev.a || i > prev.b) {
          const el = this._wordEls[i];
          if (el) {
            el.classList.add('is-sel');
            el.setAttribute('aria-pressed', 'true');
          }
        }
      }
    }
    this._sel = next;
  }

  _emitSelect() {
    if (!this._sel) {
      this.dispatchEvent(new CustomEvent('selectrange', {
        detail: { start: null, end: null, i0: null, i1: null },
      }));
      return;
    }
    const a = this._words[this._sel.a];
    const b = this._words[this._sel.b];
    if (!a || !b) return;
    this.dispatchEvent(new CustomEvent('selectrange', {
      detail: { start: a.start, end: b.end, i0: this._sel.a, i1: this._sel.b },
    }));
  }

  _flagSelection(deleted) {
    const words = this._words;
    const sel = this._sel;
    if (!sel || !words.length) return 0;
    let count = 0;
    for (let i = sel.a; i <= sel.b; i++) {
      if (!!words[i].deleted !== deleted) count++;
    }
    if (!count) return 0;
    this._pushUndo();
    for (let i = sel.a; i <= sel.b; i++) words[i].deleted = deleted;
    this._refresh();
    this._emitEdited();
    return count;
  }

  // ---------- gap cuts ----------

  _toggleGap(g) {
    if (!Number.isInteger(g) || g < 0 || g >= this._gapCut.length) return;
    this._pushUndo();
    this._gapCut[g] = !this._gapCut[g];
    const pill = this._gapEls[g];
    if (pill) {
      pill.classList.toggle('is-cut', this._gapCut[g]);
      pill.setAttribute('aria-pressed', this._gapCut[g] ? 'true' : 'false');
    }
    this._emitEdited();
  }

  // ---------- undo ----------
  //
  // There is ONE undo stack, and it lives in ProjectStore. This view used to
  // keep a second one and pop it on its own Command-Z; because both handlers
  // were window listeners and this one never stopped propagation, a single
  // press ran both, and the view's handler had no active-bench guard — so
  // Command-Z on MACHINE could silently rewind a transcript edit the user was
  // not looking at. Every edit site below already fires 'beforeedit', which is
  // what the store snapshots on, so nothing is lost but the duplication.

  _pushUndo() {
    // ProjectStore snapshots the durable document on this event. It must fire
    // before the shared words/gap arrays change, not after an edit has already
    // made the prior state unrecoverable.
    this.dispatchEvent(new CustomEvent('beforeedit', { detail: {} }));
  }

  // ---------- input ----------

  _setWordFocus(index, moveFocus = true) {
    if (!this._words.length) return;
    const next = Math.max(0, Math.min(this._words.length - 1, index | 0));
    const prev = this._wordEls[this._focusIndex];
    if (prev) prev.tabIndex = -1;
    this._focusIndex = next;
    const el = this._wordEls[next];
    if (!el) return;
    el.tabIndex = 0;
    if (moveFocus && el.focus) el.focus();
  }

  _onWordKey(e) {
    const el = e.target && e.target.closest ? e.target.closest('.yj-word') : null;
    if (!el || el.dataset.i == null) return;
    const index = Number(el.dataset.i);
    if (!Number.isInteger(index)) return;

    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this._words.length - 1;
    if (next != null) {
      e.preventDefault();
      e.stopPropagation();
      next = Math.max(0, Math.min(this._words.length - 1, next));
      if (e.shiftKey) {
        if (this._selAnchor == null) this._selAnchor = index;
        this._applySel(Math.min(this._selAnchor, next), Math.max(this._selAnchor, next));
        this._emitSelect();
      } else {
        this._selAnchor = next;
      }
      this._setWordFocus(next);
      return;
    }

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && this._selAnchor != null) {
        this._applySel(Math.min(this._selAnchor, index), Math.max(this._selAnchor, index));
      } else {
        this._selAnchor = index;
        this._applySel(index, index);
      }
      this._emitSelect();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const word = this._words[index];
      if (word) this.dispatchEvent(new CustomEvent('wordclick', {
        detail: { index, t: word.start },
      }));
      return;
    }

    if (e.key === 'Escape' && this._sel) {
      e.preventDefault();
      e.stopPropagation();
      this._applySel(null);
      this._emitSelect();
    }
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const el = e.target.closest('.yj-word');
    if (!el || el.dataset.i == null) return;
    e.preventDefault();
    this._drag = { start: Number(el.dataset.i), moved: false, shift: e.shiftKey };
  }

  _onMove(e) {
    if (!this._drag) return;
    const el = e.target.closest('.yj-word');
    if (!el || el.dataset.i == null) return;
    const i = Number(el.dataset.i);
    if (!this._drag.moved && i === this._drag.start) return;
    this._drag.moved = true;
    this._applySel(Math.min(this._drag.start, i), Math.max(this._drag.start, i));
  }

  _onUp(e) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (d.moved) {
      this._selAnchor = d.start;
      this._setWordFocus(d.start, false);
      this._emitSelect();
      return;
    }
    const i = d.start;
    this._setWordFocus(i, false);
    if ((d.shift || e.shiftKey) && this._selAnchor != null) {
      this._applySel(Math.min(this._selAnchor, i), Math.max(this._selAnchor, i));
      this._emitSelect();
      return;
    }
    this._selAnchor = i;
    if (this._sel) {
      this._applySel(null);
      this._emitSelect();
    }
    const w = this._words[i];
    if (w) this.dispatchEvent(new CustomEvent('wordclick', { detail: { index: i, t: w.start } }));
  }

  _onKey(e) {
    const t = e.target;
    if (t && t.closest && t.closest('input, select, textarea, [contenteditable="true"]')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this._sel) {
      e.preventDefault();
      this.deleteSelection();
    }
  }

  _emitEdited() {
    this.dispatchEvent(new CustomEvent('edited', { detail: {} }));
  }
}
