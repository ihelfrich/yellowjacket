// Yellowjacket — frequency-domain view. STFT runs in a worker; the result is
// painted ONCE into a full-resolution offscreen image (cols wide, bins tall,
// rows log-frequency remapped), so setView/setPlayhead cost one drawImage.
// When WebGPU is available and #specGpu exists, the image stage moves to
// render/spectrogram-gpu.js and this canvas keeps only the overlays.

import { GpuSpectrogram, viewToColumns } from './render/spectrogram-gpu.js';

const DRAG_PX = 4;                 // click vs drag threshold, CSS px
const F_MIN = 20;                  // bottom of the log axis, Hz
const LUT_SIZE = 256;
const CHIP_PX = 9;                 // selection readout chip font size, CSS px
const HATCH_COLOR = 'rgba(255,212,0,.20)';  // repair hazard hatch, dimmer than waveform cuts
const HATCH_PITCH = 8;             // perpendicular pitch between hatch lines, CSS px
const TONE_MIN_RATIO = 1.02;       // flat TONE drags widen to this ratio so the band is real
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

function fmtFreq(f) {
  if (f >= 999.5) {
    const k = f / 1000;
    return (k >= 9.95 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
  }
  return String(Math.round(f));
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
  //         'regionselect' {t0,t1,f0,f1} | null — live during drag, null on click-clear.
  //         Seconds and Hz in ORIGINAL-timeline data coords; f clamped 20..Nyquist.
  // Gestures: drag = free rectangle; Alt-drag = TRANSIENT (full band, dragged time
  // span); Shift-drag = TONE (dragged time span, exactly the dragged frequency band).
  // Plain click seeks; a completed drag suppresses exactly that one seek.
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

    this._drag = null;        // { id, x0, y0, t0, f0, mode: 'arm'|'select' }
    this._region = null;      // selection {t0,t1,f0,f1}, data coords, survives zoom/pan
    this._repairs = [];       // Repair[] from setRepairs, drawn each composite
    this._hoverId = null;

    this._gpu = null;         // GpuSpectrogram while the GPU image path is live
    this._gpuCanvas = null;
    this._gpuLost = false;    // demoted once: never re-attempt this session
    this._gpuRaf = 0;
    this._gpuPrevTs = 0;
    this._phosOn = false;
    this._phosTimer = 0;

    const gpuCanvas = (typeof document !== 'undefined') ? document.getElementById('specGpu') : null;
    if (gpuCanvas) {
      GpuSpectrogram.create(gpuCanvas).then((gpu) => {
        if (!gpu) return;                 // no WebGPU: today's 2D path, untouched
        if (this._gpuLost) {
          gpu.destroy();
          return;
        }
        this._gpu = gpu;
        this._gpuCanvas = gpuCanvas;
        gpu.onLost(() => this._demoteGpu());
        if (!this._pushGpuData()) return; // demotes itself on upload failure
        this._imgSig = '';                // drop the 2D image; overlays go transparent
        this.render();
      });
    }

    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
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
    const prevDuration = this.duration;
    this.duration = mono && mono.length && sampleRate ? mono.length / sampleRate : 0;
    this._view = { start: 0, end: this.duration };
    this._playhead = 0;
    // Repair rebuilds recompute over the SAME timeline: selection and overlays stay
    // valid. A different duration means a new source; old data coords are meaningless.
    if (this.duration !== prevDuration) this._region = null;
    this._stopPhosphor();
    this._syncGpuVis();       // data is gone until the worker returns

    if (!this.duration) {
      this._pushGpuData();
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
        this._pushGpuData();
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
    const prev = this._playhead;
    this._playhead = t;
    if (this._gpu && this.ready) this._trackPhosphor(t - prev);
    this._composite();        // one drawImage of the visible window; no repaint
  }

  setView(startSec, endSec) {
    const v = this._clampView(startSec, endSec);
    if (v.start === this._view.start && v.end === this._view.end) return;
    this._view = v;
    this._pushGpuViewport();  // the one view object drives 2D, overlays, and GPU
    this._composite();
  }

  get view() {
    return { start: this._view.start, end: this._view.end };
  }

  setRegion(region) {
    // external set (e.g. cleared after APPLY); does not emit 'regionselect'
    this._region = this._normRegion(region);
    this._composite();
  }

  get region() {
    const r = this._region;
    return r ? { t0: r.t0, t1: r.t1, f0: r.f0, f1: r.f1 } : null;
  }

  setRepairs(repairs, hoverId = null) {
    this._repairs = Array.isArray(repairs) ? repairs : [];
    this._hoverId = hoverId;
    this._composite();        // overlays ride the blit path; never a full repaint
  }

  // ---------- coordinate mapping (CSS px <-> data coords) ----------
  // The one mapping: X is linear time across the current view window; Y is
  // log-frequency, top = Nyquist, bottom = fMin (20 Hz at sane rates), exactly
  // as the offscreen image rows and the ruler are laid out.

  timeAtX(x) {
    const rect = this.canvas.getBoundingClientRect();
    const v = this._view;
    if (!rect.width) return v.start;
    return v.start + (x / rect.width) * (v.end - v.start);
  }

  xAtTime(t) {
    const rect = this.canvas.getBoundingClientRect();
    const v = this._view;
    const span = v.end - v.start;
    if (!(span > 0)) return 0;
    return ((t - v.start) / span) * rect.width;
  }

  freqAtY(y) {
    const fs = this._freqScale();
    const rect = this.canvas.getBoundingClientRect();
    if (!fs || !rect.height) return 0;
    return fs.fMax * Math.exp(-fs.logRatio * (y / rect.height));
  }

  yAtFreq(f) {
    const fs = this._freqScale();
    const rect = this.canvas.getBoundingClientRect();
    if (!fs || !rect.height || !(f > 0)) return 0;
    return (Math.log(fs.fMax / f) / fs.logRatio) * rect.height;
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
    if (this._gpu) this._requestGpuFrame();  // GPU resyncs its canvas size in render()
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
      yellowHi: v('--yj-yellow-hi', '#FFE45C'),
      amber: v('--yj-amber', '#C79A00'),
      amberDim: v('--yj-amber-dim', '#6E5A10'),
      sel: v('--yj-select-fill', '') || v('--yj-select', 'rgba(255,212,0,0.14)'),
      cut: v('--yj-cut-fill', '') || v('--yj-cut', 'rgba(255,92,69,0.10)'),
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
    if (this._gpu) {
      if (sig === this._imgSig) return;
      this._paintImage(c);    // GPU live: shrinks the offscreen to a 1x1 transparency
      this._gpuPushColormap(c);
      this._imgSig = sig;
      return;
    }
    if (sig === this._imgSig && this._img.width === this._cols && this._img.height === this._bins) return;
    this._paintImage(c);
    this._imgSig = sig;
  }

  _paintImage(c) {
    if (this._gpu) {
      this._img.width = 1;    // resizing clears: the 2D image stage is a no-op
      this._img.height = 1;
      return;
    }
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
    const { fMax, logRatio } = this._freqScale();
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
    const gpuLive = !!(this._gpu && this.ready);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (gpuLive) {
      g.clearRect(0, 0, w, h);  // the image lives on #specGpu underneath
    } else {
      g.fillStyle = c.well;
      g.fillRect(0, 0, w, h);
    }

    const v = this._view;
    const span = v.end - v.start;
    if (!this.ready || !(this.duration > 0) || !(span > 0)) return;

    if (!gpuLive) {
      const sx0 = (v.start / this.duration) * this._cols;
      const sw = Math.max((span / this.duration) * this._cols, 1e-6);
      g.drawImage(this._img, sx0, 0, sw, this._bins, 0, 0, w, h);
    }

    this._drawRepairs(g, w, h, dpr, c);
    this._drawRuler(g, w, h, dpr, c);
    this._drawSelection(g, w, h, dpr, c);

    if (this._playhead >= v.start && this._playhead <= v.end) {
      g.fillStyle = c.playhead;
      g.fillRect(Math.round(((this._playhead - v.start) / span) * w), 0, Math.max(1, Math.round(dpr)), h);
    }
  }

  _drawRuler(g, w, h, dpr, c) {
    const fs = this._freqScale();
    if (!fs || !(fs.fMax > fs.fMin)) return;
    g.font = Math.round(9 * dpr) + 'px ' + c.mono;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    for (const f of RULER_FREQS) {
      if (f <= fs.fMin || f >= fs.fMax) continue;
      const y = Math.round(this._devY(f, h, fs));
      if (y < 10 * dpr || y > h - 2 * dpr) continue;
      g.fillStyle = c.line;
      g.fillRect(0, y, w, 1);
      g.fillStyle = c.inkDim;
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 4 * dpr, y - 2 * dpr);
    }
  }

  // ---------- repair + selection overlays (drawn every composite, data coords) ----------

  _devX(t, w) {
    const v = this._view;
    return ((t - v.start) / (v.end - v.start)) * w;
  }

  _devY(f, h, fs) {
    return (Math.log(fs.fMax / Math.max(f, 1e-6)) / fs.logRatio) * h;
  }

  _projectRect(r, w, h, fs) {
    const v = this._view;
    if (r.t1 <= v.start || r.t0 >= v.end) return null;
    const x0 = Math.max(0, this._devX(r.t0, w));
    const x1 = Math.min(w, this._devX(r.t1, w));
    const y0 = Math.max(0, this._devY(Math.min(r.f1, fs.fMax), h, fs));
    const y1 = Math.min(h, this._devY(Math.max(r.f0, fs.fMin), h, fs));
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x0, y0, rw: x1 - x0, rh: y1 - y0 };
  }

  _drawRepairs(g, w, h, dpr, c) {
    if (!this._repairs.length) return;
    const fs = this._freqScale();
    if (!fs || !(this._view.end > this._view.start)) return;
    const lw = Math.max(1, dpr);
    for (const r of this._repairs) {
      if (!r || !isFinite(r.t0) || !isFinite(r.t1) || !isFinite(r.f0) || !isFinite(r.f1)) continue;
      const p = this._projectRect(r, w, h, fs);
      if (!p) continue;
      if (r.enabled) {
        g.fillStyle = c.cut;
        g.fillRect(p.x0, p.y0, p.rw, p.rh);
        g.save();
        g.beginPath();
        g.rect(p.x0, p.y0, p.rw, p.rh);
        g.clip();
        g.strokeStyle = HATCH_COLOR;
        g.lineWidth = lw;
        g.beginPath();
        const stepX = HATCH_PITCH * dpr * Math.SQRT2;  // 8px pitch perpendicular to the lines
        for (let x = p.x0 - p.rh; x < p.x0 + p.rw; x += stepX) {
          g.moveTo(x, p.y0 + p.rh);
          g.lineTo(x + p.rh, p.y0);
        }
        g.stroke();
        g.restore();
        g.strokeStyle = c.amber;
      } else {
        g.strokeStyle = c.amberDim;   // bypassed: border only, dim
      }
      g.lineWidth = lw;
      g.strokeRect(p.x0 + lw / 2, p.y0 + lw / 2, Math.max(p.rw - lw, 1), Math.max(p.rh - lw, 1));
      if (this._hoverId != null && r.id === this._hoverId) {
        g.strokeStyle = c.yellowHi;
        g.lineWidth = lw * 2;
        g.strokeRect(p.x0 + lw, p.y0 + lw, Math.max(p.rw - lw * 2, 1), Math.max(p.rh - lw * 2, 1));
      }
    }
  }

  _drawSelection(g, w, h, dpr, c) {
    const r = this._region;
    if (!r) return;
    const fs = this._freqScale();
    if (!fs || !(this._view.end > this._view.start)) return;
    const p = this._projectRect(r, w, h, fs);
    if (!p) return;
    g.fillStyle = c.sel;
    g.fillRect(p.x0, p.y0, p.rw, p.rh);
    const lw = Math.max(1, dpr);
    g.strokeStyle = c.playhead;
    g.lineWidth = lw;
    g.strokeRect(p.x0 + lw / 2, p.y0 + lw / 2, Math.max(p.rw - lw, 1), Math.max(p.rh - lw, 1));
    this._drawChip(g, w, h, dpr, c, r, p);
  }

  _drawChip(g, w, h, dpr, c, r, p) {
    const dt = r.t1 - r.t0;
    const label = (dt < 10 ? dt.toFixed(2) : dt.toFixed(1)) + 's · '
      + fmtFreq(r.f0) + '-' + fmtFreq(r.f1) + ' Hz';
    g.font = Math.round(CHIP_PX * dpr) + 'px ' + c.mono;
    const pad = 3 * dpr;
    const cw = Math.ceil(g.measureText(label).width + pad * 2);
    const ch = Math.round((CHIP_PX + 5) * dpr);
    const cx = Math.round(Math.min(Math.max(0, p.x0), Math.max(0, w - cw)));
    let cy = Math.round(p.y0 - ch - 2 * dpr);      // above the top-left corner,
    if (cy < 0) cy = Math.round(Math.min(h - ch, p.y0 + 2 * dpr));  // or tucked inside
    g.fillStyle = c.well;
    g.fillRect(cx, cy, cw, ch);
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    g.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
    g.fillStyle = c.playhead;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(label, cx + pad, cy + ch / 2);
    g.textBaseline = 'bottom';    // restore the ruler's baseline convention
  }

  // ---------- GPU image path (render/spectrogram-gpu.js) ----------
  // The 2D pipeline stays authoritative for overlays and interaction; only the
  // image stage moves. One view object feeds both, so the GPU uniforms derive
  // from the same _view/_freqScale the overlay projection uses.

  _pushGpuData() {
    const gpu = this._gpu;
    if (!gpu) return true;
    if (!this.ready) {
      gpu.setData(null, 0, 0, 0, 0);
      this._syncGpuVis();
      this._requestGpuFrame();
      return true;
    }
    if (!gpu.setData(this._mags, this._cols, this._bins, this._minDb, this._maxDb)) {
      this._demoteGpu();
      return false;
    }
    this._syncGpuVis();
    this._pushGpuViewport();
    return true;
  }

  _pushGpuViewport() {
    const gpu = this._gpu;
    if (!gpu || !this.ready || !(this.duration > 0)) return;
    const fs = this._freqScale();
    if (!fs) return;
    const { colStart, colEnd } = viewToColumns(this._view.start, this._view.end, this.duration, this._cols);
    gpu.setViewport(colStart, colEnd, Math.log(fs.fMin), Math.log(fs.fMax), fs.fMax);
    this._requestGpuFrame();
  }

  _gpuPushColormap(c) {
    const gpu = this._gpu;
    if (!gpu) return;
    gpu.setColormap(this._gpuColormapStops(c));
    this._requestGpuFrame();
  }

  _gpuColormapStops(c) {
    // the SAME stops and CSS-resolved colors _buildLut bakes, so the paths match
    const fb = parseColor(BONE, [244, 241, 227]);
    return LUT_STOPS.map(([pos, key]) => {
      const rgb = parseColor(c[key], fb);
      return { t: pos, r: rgb[0], g: rgb[1], b: rgb[2] };
    });
  }

  _syncGpuVis() {
    const el = this._gpuCanvas;
    if (!el) return;
    const show = !!(this._gpu && this.ready);
    el.hidden = !show;
    el.style.display = show ? 'block' : 'none';
  }

  _requestGpuFrame() {
    if (!this._gpu || this._gpuRaf) return;
    this._gpuRaf = requestAnimationFrame((ts) => {
      this._gpuRaf = 0;
      const gpu = this._gpu;
      if (!gpu) return;
      const dt = this._gpuPrevTs ? Math.min(Math.max(ts - this._gpuPrevTs, 1), 100) : 16.7;
      this._gpuPrevTs = ts;
      gpu.render(dt);
      if (this._phosOn) this._requestGpuFrame();  // decay animates while playing
    });
  }

  _trackPhosphor(dT) {
    if (dT > 0 && dT <= 0.5) {        // contiguous forward motion: playback ticks
      if (!this._phosOn) {
        this._phosOn = true;
        this._gpu.setPhosphor(true);
        this._requestGpuFrame();
      }
      if (this._phosTimer) clearTimeout(this._phosTimer);
      this._phosTimer = setTimeout(() => {
        this._phosTimer = 0;
        this._stopPhosphor();         // ticks stopped: transport paused or ended
      }, 250);
    } else if (dT !== 0) {
      this._stopPhosphor();           // jump = seek: clear the trails
    }
  }

  _stopPhosphor() {
    if (this._phosTimer) {
      clearTimeout(this._phosTimer);
      this._phosTimer = 0;
    }
    if (!this._phosOn) return;
    this._phosOn = false;
    if (this._gpu) {
      this._gpu.setPhosphor(false);
      this._requestGpuFrame();
    }
  }

  _demoteGpu() {
    const gpu = this._gpu;
    this._gpuLost = true;
    if (!gpu) return;
    this._gpu = null;
    this._stopPhosphor();
    if (this._gpuRaf) {
      cancelAnimationFrame(this._gpuRaf);
      this._gpuRaf = 0;
    }
    this._syncGpuVis();
    gpu.destroy();
    this._imgSig = '';                // force the 2D image repaint
    this.render();
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

  _freqScale() {
    const fMax = this._sampleRate / 2;
    if (!(fMax > 0)) return null;
    const fMin = Math.min(F_MIN, fMax / 2);   // keep the log axis sane at absurd rates
    return { fMax, fMin, logRatio: Math.log(fMax / fMin) };
  }

  _timeAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    return this.timeAtX(x);
  }

  _freqAtClientY(clientY) {
    const fs = this._freqScale();
    if (!fs) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const y = Math.min(rect.height, Math.max(0, clientY - rect.top));
    return Math.min(fs.fMax, Math.max(fs.fMin, this.freqAtY(y)));
  }

  _normRegion(r) {
    if (!r || !isFinite(r.t0) || !isFinite(r.t1) || !isFinite(r.f0) || !isFinite(r.f1)) return null;
    const t0 = Math.min(r.t0, r.t1), t1 = Math.max(r.t0, r.t1);
    const f0 = Math.min(r.f0, r.f1), f1 = Math.max(r.f0, r.f1);
    return t1 > t0 && f1 > f0 ? { t0, t1, f0, f1 } : null;
  }

  // ---------- interaction ----------
  // Anchors are stored in DATA coords at pointerdown, so a view change mid-drag
  // (waveform-driven zoom) cannot shear the selection. Modifiers are read live
  // from each move: Alt = TRANSIENT, else Shift = TONE, else free rectangle.

  _onDown(e) {
    if (e.button !== 0 || !this.duration || !this._w) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this._drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      t0: this._timeAtClientX(e.clientX),
      f0: this._freqAtClientY(e.clientY),
      mode: 'arm',
    };
  }

  _onMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.mode === 'arm'
        && Math.abs(e.clientX - d.x0) < DRAG_PX
        && Math.abs(e.clientY - d.y0) < DRAG_PX) return;
    d.mode = 'select';
    this._region = this._dragRegion(d, e);
    this._emitRegion(this._region);
    this._composite();
  }

  _onUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d.mode === 'select') return;    // completed drag: selection stands, exactly this seek suppressed
    if (this._region) {                 // plain click clears any selection
      this._region = null;
      this._emitRegion(null);
      this._composite();
    }
    const t = Math.min(Math.max(d.t0, 0), this.duration);
    this.dispatchEvent(new CustomEvent('seek', { detail: { t } }));   // and still seeks
  }

  _onCancel(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  _dragRegion(d, e) {
    const fs = this._freqScale();
    if (!fs) return null;
    const tB = this._timeAtClientX(e.clientX);
    const t0 = Math.min(d.t0, tB), t1 = Math.max(d.t0, tB);
    if (!(t1 > t0)) return null;                   // zero time span never selects
    if (e.altKey) {
      return { t0, t1, f0: fs.fMin, f1: fs.fMax }; // TRANSIENT: full band
    }
    const fB = this._freqAtClientY(e.clientY);
    let f0 = Math.min(d.f0, fB), f1 = Math.max(d.f0, fB);
    if (e.shiftKey) {
      // TONE: exactly the dragged band. A perfectly flat drag widens ±2% in log-f
      // so the emitted region is a real rectangle, not a zero-height line.
      if (!(f1 > f0)) {
        f0 = Math.max(fs.fMin, f0 / TONE_MIN_RATIO);
        f1 = Math.min(fs.fMax, f1 * TONE_MIN_RATIO);
      }
      return { t0, t1, f0, f1 };
    }
    return f1 > f0 ? { t0, t1, f0, f1 } : null;    // free rectangle needs both extents
  }

  _emitRegion(r) {
    this.dispatchEvent(new CustomEvent('regionselect', {
      detail: r ? { t0: r.t0, t1: r.t1, f0: r.f0, f1: r.f1 } : null,
    }));
  }
}
