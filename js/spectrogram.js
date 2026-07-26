// Yellowjacket — frequency-domain view. STFT runs in a worker; the result is
// painted ONCE into a full-resolution offscreen image (cols wide, bins tall,
// rows log-frequency remapped), so setView/setPlayhead cost one drawImage.

const DRAG_PX = 4;                 // click vs drag threshold, CSS px
const F_MIN = 20;                  // bottom of the log axis, Hz
const LUT_SIZE = 256;
const BONE = '#F4F1E3';            // hottest stop past --yj-hot; no CSS var exists for it
const RULER_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
// colormap stops as fractions of the dB range, colors resolved from CSS at paint time
const LUT_STOPS = [
  [0.0, 'lutBg'],
  [0.55, 'lutAmber'],
  [0.8, 'lutYellow'],
  [0.93, 'lutHot'],
  [1.0, 'lutBone'],
];

const LITTLE_ENDIAN = (() => {
  const b = new ArrayBuffer(4);
  new Uint32Array(b)[0] = 0xff;
  return new Uint8Array(b)[0] === 0xff;
})();

function packRgb(r, g, b) {
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

function parseColor(str, fallback) {
  const s = (str || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(([^)]+)\)/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length >= 3 && p.slice(0, 3).every((x) => isFinite(x))) {
      return [
        Math.min(255, Math.max(0, Math.round(p[0]))),
        Math.min(255, Math.max(0, Math.round(p[1]))),
        Math.min(255, Math.max(0, Math.round(p[2]))),
      ];
    }
  }
  return fallback;
}

export class SpectrogramView extends EventTarget {
  // events: 'seek' {t}
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this._img = document.createElement('canvas');   // full-res data image: cols x bins
    this._imgCtx = this._img.getContext('2d');
    this._imgSig = '';        // palette+data signature the image was painted with

    this._mags = null;        // column-major dB, cols*bins
    this._cols = 0;
    this._bins = 0;
    this._minDb = -90;
    this._maxDb = 0;
    this._sampleRate = 0;
    this.duration = 0;

    this._view = { start: 0, end: 0 };
    this._playhead = 0;

    this._w = 0;              // backing store size, device px
    this._h = 0;
    this._dpr = 0;
    this._c = null;           // colors cached at last render()

    this._worker = null;
    this._gen = 0;            // compute generation; stale worker messages are dropped
    this._settle = null;      // resolver of the in-flight compute promise

    this._down = null;        // { id, x, t }

    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointerup', (e) => this._onUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onCancel(e));

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas.parentElement || canvas);
    this._watchDpr();
  }

  // ---------- public API ----------

  async compute(mono, sampleRate) {
    this._gen++;
    const gen = this._gen;
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    if (this._settle) {       // release a superseded caller quietly
      this._settle();
      this._settle = null;
    }

    this._mags = null;
    this._cols = 0;
    this._bins = 0;
    this._imgSig = '';
    this._sampleRate = sampleRate || 0;
    this.duration = mono && mono.length && sampleRate ? mono.length / sampleRate : 0;
    this._view = { start: 0, end: this.duration };
    this._playhead = 0;

    if (!this.duration) {
      this.render();
      return;
    }

    const copy = mono.slice();  // caller keeps its array; the copy is transferred
    const worker = new Worker(new URL('../workers/spectrogram-worker.js', import.meta.url), { type: 'module' });
    this._worker = worker;

    await new Promise((resolve, reject) => {
      this._settle = resolve;
      const finish = () => {
        if (this._settle === resolve) this._settle = null;
        if (this._worker === worker) this._worker = null;
        worker.terminate();
      };
      worker.onmessage = (e) => {
        const msg = e.data;
        if (gen !== this._gen || !msg || msg.type !== 'done') return;  // progress is consumed silently
        this._mags = msg.mags;
        this._cols = msg.cols;
        this._bins = msg.bins;
        this._minDb = msg.minDb;
        this._maxDb = msg.maxDb;
        finish();
        this.render();
        resolve();
      };
      worker.onerror = (err) => {
        if (gen !== this._gen) return;
        finish();
        reject(new Error(err && err.message ? err.message : 'Spectrogram worker fault'));
      };
      worker.onmessageerror = () => {
        if (gen !== this._gen) return;
        finish();
        reject(new Error('Spectrogram worker message fault'));
      };
      worker.postMessage(
        { type: 'compute', mono: copy, sampleRate, fftSize: 2048, hop: 512, maxCols: 8000 },
        [copy.buffer]
      );
    });
  }

  setPlayhead(t) {
    if (!isFinite(t)) return;
    this._playhead = t;
    this._composite();        // one drawImage of the visible window; no repaint
  }

  setView(startSec, endSec) {
    const v = this._clampView(startSec, endSec);
    if (v.start === this._view.start && v.end === this._view.end) return;
    this._view = v;
    this._composite();
  }

  get view() {
    return { start: this._view.start, end: this._view.end };
  }

  get ready() {
    return !!(this._mags && this._cols > 0 && this._bins > 1);
  }

  render() {
    this._syncSize();
    if (!this._w || !this._h) return;   // hidden tab: try again on next render()
    this._c = this._colors();
    this._ensureImage(this._c);
    this._composite();
  }

  // ---------- sizing / DPR ----------

  _syncSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    if (!w || !h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  _watchDpr() {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(`(resolution: ${(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)}dppx)`);
    mq.addEventListener('change', () => {
      this.render();
      this._watchDpr();       // re-arm at the new ratio
    }, { once: true });
  }

  // ---------- colors / colormap ----------

  _colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => {
      const x = cs.getPropertyValue(name).trim();
      return x || fb;
    };
    return {
      well: v('--yj-well', '#070604'),
      line: v('--yj-line', '#262418'),
      playhead: v('--yj-yellow', '#FFD400'),
      inkDim: v('--yj-ink-dim', '#94906F'),
      mono: v('--f-mono', '"IBM Plex Mono", ui-monospace, monospace'),
      lutBg: v('--yj-bg', '#0B0A07'),
      lutAmber: v('--yj-amber', '#C79A00'),
      lutYellow: v('--yj-yellow', '#FFD400'),
      lutHot: v('--yj-hot', '#D7FF00'),
      lutBone: BONE,
    };
  }

  _buildLut(c) {
    const stops = LUT_STOPS.map(([pos, key]) => ({ pos, rgb: parseColor(c[key], parseColor(BONE, [244, 241, 227])) }));
    const lut = new Uint32Array(LUT_SIZE);
    let s = 0;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t = i / (LUT_SIZE - 1);
      while (s < stops.length - 2 && t > stops[s + 1].pos) s++;
      const a = stops[s], b = stops[s + 1];
      const f = b.pos > a.pos ? Math.min(1, Math.max(0, (t - a.pos) / (b.pos - a.pos))) : 0;
      lut[i] = packRgb(
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f)
      );
    }
    return lut;
  }

  // ---------- full-res image ----------

  _ensureImage(c) {
    if (!this.ready) return;
    const sig = [c.lutBg, c.lutAmber, c.lutYellow, c.lutHot, this._cols, this._bins, this._sampleRate].join('|');
    if (sig === this._imgSig && this._img.width === this._cols && this._img.height === this._bins) return;
    this._paintImage(c);
    this._imgSig = sig;
  }

  _paintImage(c) {
    const cols = this._cols, bins = this._bins;
    this._img.width = cols;
    this._img.height = bins;
    const lut = this._buildLut(c);
    const id = this._imgCtx.createImageData(cols, bins);
    const px = new Uint32Array(id.data.buffer);
    const mags = this._mags;
    const minDb = this._minDb;
    const span = (this._maxDb - this._minDb) || 1;
    const scale = (LUT_SIZE - 1) / span;
    const fMax = this._sampleRate / 2;
    const fMin = Math.min(F_MIN, fMax / 2);   // keep the log axis sane at absurd rates
    const logRatio = Math.log(fMax / fMin);
    const binHz = this._sampleRate / (bins * 2);

    for (let r = 0; r < bins; r++) {
      // row r (top = Nyquist, bottom = fMin) samples the linear bins on a log scale
      const f = fMax * Math.exp(-logRatio * (r / (bins - 1)));
      let bf = f / binHz;
      if (bf > bins - 1) bf = bins - 1;
      if (bf < 0) bf = 0;
      const b0 = Math.floor(bf);
      const b1 = Math.min(b0 + 1, bins - 1);
      const frac = bf - b0;
      const o = r * cols;
      for (let col = 0; col < cols; col++) {
        const base = col * bins;
        const d0 = mags[base + b0];
        const db = d0 + (mags[base + b1] - d0) * frac;
        let idx = ((db - minDb) * scale) | 0;
        if (idx < 0) idx = 0;
        else if (idx > LUT_SIZE - 1) idx = LUT_SIZE - 1;
        px[o + col] = lut[idx];
      }
    }
    this._imgCtx.putImageData(id, 0, 0);
  }

  // ---------- compositing ----------

  _composite() {
    const g = this.ctx;
    if (!g || !this._w || !this._h) return;
    const w = this._w, h = this._h, dpr = this._dpr;
    const c = this._c || this._colors();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.well;
    g.fillRect(0, 0, w, h);

    const v = this._view;
    const span = v.end - v.start;
    if (!this.ready || !(this.duration > 0) || !(span > 0)) return;

    const sx0 = (v.start / this.duration) * this._cols;
    const sw = Math.max((span / this.duration) * this._cols, 1e-6);
    g.drawImage(this._img, sx0, 0, sw, this._bins, 0, 0, w, h);

    this._drawRuler(g, w, h, dpr, c);

    if (this._playhead >= v.start && this._playhead <= v.end) {
      g.fillStyle = c.playhead;
      g.fillRect(Math.round(((this._playhead - v.start) / span) * w), 0, Math.max(1, Math.round(dpr)), h);
    }
  }

  _drawRuler(g, w, h, dpr, c) {
    const fMax = this._sampleRate / 2;
    const fMin = Math.min(F_MIN, fMax / 2);
    if (!(fMax > fMin)) return;
    const logRatio = Math.log(fMax / fMin);
    g.font = Math.round(9 * dpr) + 'px ' + c.mono;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    for (const f of RULER_FREQS) {
      if (f <= fMin || f >= fMax) continue;
      const y = Math.round((Math.log(fMax / f) / logRatio) * h);
      if (y < 10 * dpr || y > h - 2 * dpr) continue;
      g.fillStyle = c.line;
      g.fillRect(0, y, w, 1);
      g.fillStyle = c.inkDim;
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 4 * dpr, y - 2 * dpr);
    }
  }

  // ---------- view math ----------

  _minSpan() {
    return this._sampleRate ? Math.max(0.001, 16 / this._sampleRate) : 0.001;
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

  _timeAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const f = rect.width ? (clientX - rect.left) / rect.width : 0;
    const v = this._view;
    return v.start + Math.min(1, Math.max(0, f)) * (v.end - v.start);
  }

  // ---------- interaction ----------

  _onDown(e) {
    if (e.button !== 0 || !this.duration || !this._w) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this._down = { id: e.pointerId, x: e.clientX, t: this._timeAtClientX(e.clientX) };
  }

  _onUp(e) {
    const d = this._down;
    if (!d || e.pointerId !== d.id) return;
    this._down = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (Math.abs(e.clientX - d.x) >= DRAG_PX) return;   // a drag, not a seek click
    const t = Math.min(Math.max(d.t, 0), this.duration);
    this.dispatchEvent(new CustomEvent('seek', { detail: { t } }));
  }

  _onCancel(e) {
    const d = this._down;
    if (!d || e.pointerId !== d.id) return;
    this._down = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }
}
