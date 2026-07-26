// Yellowjacket — time-domain waveform view. Oscilloscope pane: min/max peaks
// cached per column at the current zoom, static layer drawn to an offscreen
// canvas on render(), playhead updates blit that layer and draw overlays only.

const ZOOM_STEP = 1.25;                       // zoom factor per wheel notch
const DRAG_PX = 4;                            // click vs drag threshold, CSS px
const RULER_STEPS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600]; // adaptive tick steps, sec
const HATCH_COLOR = 'rgba(255,212,0,.28)';    // cut hatch, matches --yj-hazard-dim
const HATCH_PITCH = 8;                        // perpendicular pitch between hatch lines, CSS px
const CUT_DIM = 'rgba(0,0,0,.45)';            // darkening under the hatch
const L1 = 64, L2 = 512, L3 = 4096;           // peak pyramid block sizes, samples

export class WaveformView extends EventTarget {
  // events: 'seek' {t}, 'select' {start,end} (detail null when cleared),
  //         'view' {start,end} after any user zoom/pan
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._off = document.createElement('canvas');
    this._offCtx = this._off.getContext('2d');

    this.mono = null;
    this.sampleRate = 0;
    this.duration = 0;

    this._view = { start: 0, end: 0 };
    this._cuts = [];
    this._sel = null;
    this._playhead = 0;

    this._pyr = null;          // static min/max pyramid over the whole buffer
    this._peaks = null;        // per-column min/max at current zoom + width
    this._peaksDirty = true;
    this._staticReady = false;
    this._w = 0;               // backing store size, device px
    this._h = 0;
    this._dpr = 0;
    this._c = null;            // colors cached at last static draw

    this._drag = null;         // { id, mode:'arm'|'select'|'pan', x0, t0, view0 }

    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    canvas.addEventListener('pointerup', (e) => this._onUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onCancel(e));
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this.duration) this._applyUserView(0, this.duration);
    });

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas.parentElement || canvas);
    this._watchDpr();
  }

  // ---------- public API ----------

  setBuffer(mono, sampleRate) {
    this.mono = mono && mono.length ? mono : null;
    this.sampleRate = sampleRate || 0;
    this.duration = this.mono && this.sampleRate ? this.mono.length / this.sampleRate : 0;
    this._buildPyramid();
    this._view = { start: 0, end: this.duration };
    this._cuts = [];
    this._sel = null;
    this._playhead = 0;
    this._peaksDirty = true;
    this.render();
  }

  setCuts(cuts) {
    this._cuts = (cuts || [])
      .filter((c) => c && isFinite(c.start) && isFinite(c.end) && c.end > c.start)
      .map((c) => ({ start: c.start, end: c.end }))
      .sort((a, b) => a.start - b.start);
    this._composite();
  }

  setPlayhead(t) {
    if (!isFinite(t)) return;
    this._playhead = t;
    this._composite();          // blit static layer + overlays; no peak recompute
  }

  setSelection(sel) {
    if (sel && isFinite(sel.start) && isFinite(sel.end) && sel.end !== sel.start) {
      const a = Math.min(sel.start, sel.end);
      const b = Math.max(sel.start, sel.end);
      this._sel = { start: a, end: b };
    } else {
      this._sel = null;
    }
    this._composite();
  }

  setView(startSec, endSec) {
    const v = this._clampView(startSec, endSec);
    if (v.start === this._view.start && v.end === this._view.end) return;
    this._view = v;
    this._peaksDirty = true;
    this.render();              // external sync: no 'view' event, no feedback loop
  }

  get view() {
    return { start: this._view.start, end: this._view.end };
  }

  render() {
    this._syncSize();
    if (!this._w || !this._h) return;   // hidden tab: try again on next render()
    if (this._peaksDirty) this._computePeaks();
    this._drawStatic();
    this._composite();
  }

  // ---------- sizing / DPR ----------

  _syncSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    if (w !== this._w || dpr !== this._dpr) this._peaksDirty = true;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this._staticReady = false;
    if (!w || !h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this._off.width = w;
    this._off.height = h;
  }

  _watchDpr() {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(resolution: ${(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)}dppx)`);
    mq.addEventListener('change', () => {
      this.render();
      this._watchDpr();         // re-arm at the new ratio
    }, { once: true });
  }

  // ---------- peaks ----------

  _buildPyramid() {
    const d = this.mono;
    if (!d || d.length < L1 * 2) { this._pyr = null; return; }
    const n1 = Math.ceil(d.length / L1);
    const min1 = new Float32Array(n1);
    const max1 = new Float32Array(n1);
    for (let i = 0; i < n1; i++) {
      const s = i * L1;
      const e = Math.min(s + L1, d.length);
      let mn = d[s], mx = d[s];
      for (let j = s + 1; j < e; j++) {
        const v = d[j];
        if (v < mn) mn = v; else if (v > mx) mx = v;
      }
      min1[i] = mn;
      max1[i] = mx;
    }
    const fold = (minSrc, maxSrc, f) => {
      const n = Math.ceil(minSrc.length / f);
      const mn = new Float32Array(n);
      const mx = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = i * f;
        const e = Math.min(s + f, minSrc.length);
        let a = minSrc[s], b = maxSrc[s];
        for (let j = s + 1; j < e; j++) {
          if (minSrc[j] < a) a = minSrc[j];
          if (maxSrc[j] > b) b = maxSrc[j];
        }
        mn[i] = a;
        mx[i] = b;
      }
      return [mn, mx];
    };
    const [min2, max2] = fold(min1, max1, L2 / L1);
    const [min3, max3] = fold(min2, max2, L3 / L2);
    this._pyr = { min1, max1, min2, max2, min3, max3 };
  }

  _blockMinMax(minA, maxA, a, b, block) {
    const i0 = Math.max(0, Math.floor(a / block));
    const i1 = Math.min(minA.length, Math.ceil(b / block));
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i < i1; i++) {
      if (minA[i] < mn) mn = minA[i];
      if (maxA[i] > mx) mx = maxA[i];
    }
    return mn === Infinity ? [0, 0] : [mn, mx];
  }

  _rangeMinMax(a, b) {
    const len = b - a;
    const p = this._pyr;
    if (p && len >= L3 * 2) return this._blockMinMax(p.min3, p.max3, a, b, L3);
    if (p && len >= L2 * 2) return this._blockMinMax(p.min2, p.max2, a, b, L2);
    if (p && len >= L1 * 2) return this._blockMinMax(p.min1, p.max1, a, b, L1);
    const d = this.mono;
    let mn = d[a], mx = d[a];
    for (let i = a + 1; i < b; i++) {
      const v = d[i];
      if (v < mn) mn = v; else if (v > mx) mx = v;
    }
    return [mn, mx];
  }

  _computePeaks() {
    this._peaksDirty = false;
    const w = this._w;
    if (!w || !this.mono || !this.duration) { this._peaks = null; return; }
    const v = this._view;
    const sr = this.sampleRate;
    const s0 = v.start * sr;
    const spp = (v.end - v.start) * sr / w;
    const mins = new Float32Array(w);
    const maxs = new Float32Array(w);
    const n = this.mono.length;
    for (let x = 0; x < w; x++) {
      let a = Math.floor(s0 + x * spp);
      let b = Math.floor(s0 + (x + 1) * spp);
      if (b <= a) b = a + 1;
      if (a < 0) a = 0;
      if (b > n) b = n;
      if (a >= b) { mins[x] = 0; maxs[x] = 0; continue; }
      const mm = this._rangeMinMax(a, b);
      mins[x] = mm[0];
      maxs[x] = mm[1];
    }
    this._peaks = { mins, maxs };
  }

  // ---------- drawing ----------

  _colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => {
      const x = cs.getPropertyValue(name).trim();
      return x || fb;
    };
    return {
      bg: v('--yj-well', '#070604'),
      line: v('--yj-line', '#262418'),
      wave: v('--yj-wave', '#D9B830'),
      playhead: v('--yj-yellow', '#FFD400'),
      sel: v('--yj-select-fill', '') || v('--yj-select', 'rgba(255,212,0,0.14)'),
      cut: v('--yj-cut-fill', '') || v('--yj-cut', 'rgba(255,92,69,0.10)'),
      inkDim: v('--yj-ink-dim', '#94906F'),
      mono: v('--f-mono', '"IBM Plex Mono", ui-monospace, monospace'),
    };
  }

  _drawStatic() {
    const g = this._offCtx;
    if (!g) return;
    const w = this._w, h = this._h, dpr = this._dpr;
    const c = this._c = this._colors();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);

    // graticule: 10 major horizontal divisions + center zero-line
    g.fillStyle = c.line;
    for (let k = 1; k < 10; k++) {
      g.fillRect(Math.round((w * k) / 10), 0, 1, h);
    }
    const mid = Math.round(h / 2);
    g.fillRect(0, mid, w, 1);

    // waveform body: one min/max column per device pixel
    if (this._peaks) {
      const { mins, maxs } = this._peaks;
      const amp = h / 2 - 1;
      g.fillStyle = c.wave;
      for (let x = 0; x < w; x++) {
        let lo = mins[x], hi = maxs[x];
        if (lo < -1) lo = -1;
        if (hi > 1) hi = 1;
        const y0 = h / 2 - hi * amp;
        const y1 = h / 2 - lo * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }

    this._drawRuler(g, w, h, dpr, c);
    this._staticReady = true;
  }

  _drawRuler(g, w, h, dpr, c) {
    const v = this._view;
    const span = v.end - v.start;
    if (!(span > 0)) return;
    const minSpacing = 64 * dpr;
    let step = RULER_STEPS[RULER_STEPS.length - 1];
    for (const s of RULER_STEPS) {
      if ((s / span) * w >= minSpacing) { step = s; break; }
    }
    while ((step / span) * w < minSpacing) step *= 2;

    g.font = Math.round(9 * dpr) + 'px ' + c.mono;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = c.inkDim;
    const yText = h - 3 * dpr;
    const tickH = 6 * dpr;
    for (let t = Math.ceil(v.start / step) * step; t <= v.end; t += step) {
      const x = Math.round(((t - v.start) / span) * w);
      if (x < 0 || x > w) continue;
      g.fillRect(x, h - tickH, 1, tickH);
      const label = this._fmtTick(t);
      const tw = g.measureText(label).width;
      if (x + 4 * dpr + tw <= w - 2) g.fillText(label, x + 4 * dpr, yText);
    }
  }

  _fmtTick(t) {
    if (t < 60) return t + 's';
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  _composite() {
    const g = this.ctx;
    if (!g || !this._staticReady || !this._w || !this._h) return;
    const w = this._w, h = this._h, dpr = this._dpr;
    const c = this._c || this._colors();
    const v = this._view;
    const span = v.end - v.start;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this._off, 0, 0);
    if (!(span > 0)) return;
    const toX = (t) => ((t - v.start) / span) * w;

    // cut regions: dim + manual 45-degree hatch, 8px perpendicular pitch
    for (const cut of this._cuts) {
      if (cut.start >= v.end) break;
      if (cut.end <= v.start) continue;
      const x0 = Math.max(0, toX(cut.start));
      const x1 = Math.min(w, toX(cut.end));
      if (x1 - x0 < 0.5) continue;
      g.fillStyle = CUT_DIM;
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = c.cut;
      g.fillRect(x0, 0, x1 - x0, h);
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, h);
      g.clip();
      g.strokeStyle = HATCH_COLOR;
      g.lineWidth = Math.max(1, dpr);
      g.beginPath();
      const stepX = HATCH_PITCH * dpr * Math.SQRT2; // 8px pitch measured perpendicular to the lines
      for (let x = x0 - h; x < x1; x += stepX) {
        g.moveTo(x, h);
        g.lineTo(x + h, 0);
      }
      g.stroke();
      g.restore();
    }

    // selection overlay
    if (this._sel && this._sel.end > v.start && this._sel.start < v.end) {
      const x0 = Math.max(0, toX(this._sel.start));
      const x1 = Math.min(w, toX(this._sel.end));
      if (x1 > x0) {
        g.fillStyle = c.sel;
        g.fillRect(x0, 0, x1 - x0, h);
      }
    }

    // playhead
    if (this.duration && this._playhead >= v.start && this._playhead <= v.end) {
      g.fillStyle = c.playhead;
      g.fillRect(Math.round(toX(this._playhead)), 0, Math.max(1, Math.round(dpr)), h);
    }
  }

  // ---------- view math ----------

  _minSpan() {
    return this.sampleRate ? Math.max(0.001, 16 / this.sampleRate) : 0.001;
  }

  _clampView(s, e) {
    if (!this.duration) return { start: 0, end: 0 };
    let span = e - s;
    const min = Math.min(this._minSpan(), this.duration);
    if (!isFinite(span) || span < min) span = min;
    if (span > this.duration) span = this.duration;
    let start = isFinite(s) ? s : 0;
    start = Math.min(Math.max(start, 0), this.duration - span);
    return { start, end: start + span };
  }

  _applyUserView(s, e) {
    const v = this._clampView(s, e);
    if (v.start === this._view.start && v.end === this._view.end) return;
    this._view = v;
    this._peaksDirty = true;
    this.render();
    this._emit('view', { start: v.start, end: v.end });
  }

  _timeAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const f = rect.width ? (clientX - rect.left) / rect.width : 0;
    const v = this._view;
    return v.start + Math.min(1, Math.max(0, f)) * (v.end - v.start);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- interaction ----------

  _onDown(e) {
    if (e.button !== 0 || !this.duration || !this._w) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this._drag = {
      id: e.pointerId,
      mode: e.shiftKey ? 'pan' : 'arm',
      x0: e.clientX,
      t0: this._timeAtClientX(e.clientX),
      view0: { start: this._view.start, end: this._view.end },
    };
  }

  _onMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.mode === 'pan') {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return;
      const span0 = d.view0.end - d.view0.start;
      const dt = -((e.clientX - d.x0) / rect.width) * span0;
      this._applyUserView(d.view0.start + dt, d.view0.end + dt);
      return;
    }
    if (d.mode === 'arm' && Math.abs(e.clientX - d.x0) >= DRAG_PX) d.mode = 'select';
    if (d.mode !== 'select') return;
    const t = this._timeAtClientX(e.clientX);
    const a = Math.min(d.t0, t);
    const b = Math.max(d.t0, t);
    if (b > a) {
      this._sel = { start: a, end: b };
      this._emit('select', { start: a, end: b });    // live while dragging
    } else {
      this._sel = null;
      this._emit('select', null);
    }
    this._composite();
  }

  _onUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d.mode !== 'arm') return;                    // pan/select: nothing more to emit
    if (this._sel) {                                 // plain click clears any selection
      this._sel = null;
      this._emit('select', null);
      this._composite();
    }
    this._emit('seek', { t: Math.min(Math.max(d.t0, 0), this.duration) });
  }

  _onCancel(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  _onWheel(e) {
    if (!this.duration || !this._w) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const v = this._view;
    const span = v.end - v.start;
    const pxPerUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1;

    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // shift+wheel (or horizontal trackpad) = pan
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const dt = ((raw * pxPerUnit) / rect.width) * span;
      this._applyUserView(v.start + dt, v.end + dt);
      return;
    }

    // wheel = zoom around cursor x, factor 1.25 per notch
    const notchPx = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
    let notches = (e.deltaMode === 0 ? e.deltaY : e.deltaY * pxPerUnit / 16) / notchPx;
    notches = Math.min(4, Math.max(-4, notches));
    if (!notches) return;
    const factor = Math.pow(ZOOM_STEP, notches);
    const t = this._timeAtClientX(e.clientX);
    const newSpan = span * factor;
    const s = t - (t - v.start) * (newSpan / span);
    this._applyUserView(s, s + newSpan);
  }
}
