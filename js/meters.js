// Yellowjacket — canvas level meter. IEC 60268-18 digital peak ballistics:
// instant attack, release 20 dB per 1.7 s. Peak-hold 1.5 s, RMS bar behind.

const MIN_DB = -60;                       // left edge of the scale
const TICKS = [0, -6, -12, -24, -48];     // silkscreen tick positions, dB
const HOLD_MS = 1500;
const CLIP_AT = 0.999;
const RMS_TAU = 0.3;                      // s, RMS release one-pole

export class LevelMeter {
  constructor(canvas) {
    this.canvas = canvas;
    this.onclip = null;         // called once per new clip event (|sample| >= 0.999)
    this._g = canvas.getContext('2d');
    this._analyser = null;
    this._tap = null;
    this._data = null;
    this._peak = 0;             // displayed peak, linear
    this._hold = 0;             // peak-hold, linear
    this._holdAt = 0;           // ms timestamp of last hold capture
    this._rms = 0;              // displayed RMS, linear
    this._inClip = false;
    this._raf = 0;
    this._last = 0;
  }

  connect(audioContext, node) {
    if (this._tap && this._analyser) {
      try { this._tap.disconnect(this._analyser); } catch (e) { /* already detached */ }
    }
    this._analyser = audioContext.createAnalyser();
    this._analyser.fftSize = 2048;
    this._data = new Float32Array(this._analyser.fftSize);
    node.connect(this._analyser);
    this._tap = node;
  }

  start() {
    if (this._raf) return;
    this._last = performance.now();
    const step = (now) => {
      this._raf = requestAnimationFrame(step);
      this._frame(now);
    };
    this._raf = requestAnimationFrame(step);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(now) {
    const dt = Math.max(0, (now - this._last) / 1000);
    this._last = now;

    let framePeak = 0;
    let frameRms = 0;
    let clipped = false;
    if (this._analyser && this._data) {
      this._analyser.getFloatTimeDomainData(this._data);
      const d = this._data;
      let sumSq = 0;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        const a = v < 0 ? -v : v;
        if (a > framePeak) framePeak = a;
        sumSq += v * v;
      }
      frameRms = Math.sqrt(sumSq / d.length);
      clipped = framePeak >= CLIP_AT;
    }

    // IEC 60268-18: instant attack; release gain per frame = 10^((-20/20) * dt/1.7)
    const rel = Math.pow(10, (-20 / 20) * (dt / 1.7));
    const decayed = this._peak * rel;
    this._peak = framePeak > decayed ? framePeak : decayed;

    if (framePeak >= this._hold) {
      this._hold = framePeak;
      this._holdAt = now;
    } else if (now - this._holdAt > HOLD_MS) {
      this._hold *= rel;
    }

    if (frameRms >= this._rms) this._rms = frameRms;
    else this._rms += (frameRms - this._rms) * (1 - Math.exp(-dt / RMS_TAU));

    if (clipped && !this._inClip && typeof this.onclip === 'function') this.onclip();
    this._inClip = clipped;

    this._draw();
  }

  _draw() {
    const canvas = this.canvas;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;   // hidden tab: skip drawing, ballistics keep running
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const g = this._g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const cWell = color('--yj-well', '#070604');
    const cLine = color('--yj-line', '#262418');
    const cAmber = color('--yj-amber', '#C79A00');
    const cYellow = color('--yj-yellow', '#FFD400');
    const cHot = color('--yj-hot', '#D7FF00');
    const cDim = color('--yj-ink-dim', '#94906F');

    const padX = 4;
    const labelH = 13;
    const barX = padX;
    const barW = Math.max(1, cw - padX * 2);
    const barY = 3;
    const barH = Math.max(4, ch - labelH - barY - 2);
    const dbToX = (db) => {
      const clamped = Math.min(0, Math.max(MIN_DB, db));
      return barX + ((clamped - MIN_DB) / -MIN_DB) * barW;
    };

    g.clearRect(0, 0, cw, ch);
    g.fillStyle = cWell;
    g.fillRect(0, 0, cw, ch);

    // silkscreen tick lines
    g.strokeStyle = cLine;
    g.lineWidth = 1;
    for (const db of TICKS) {
      const x = Math.round(dbToX(db)) + 0.5;
      g.beginPath();
      g.moveTo(x, barY);
      g.lineTo(x, barY + barH + 3);
      g.stroke();
    }

    const peakDb = toDb(this._peak);
    const rmsDb = toDb(this._rms);
    const holdDb = toDb(this._hold);
    const xSplit = dbToX(-6);

    // RMS bar behind, full bar height
    const xRms = dbToX(rmsDb);
    if (xRms > barX) {
      g.fillStyle = cAmber;
      g.fillRect(barX, barY, xRms - barX, barH);
    }

    // peak bar, vertically inset so the RMS bar reads behind it
    const inset = Math.max(2, Math.floor(barH / 5));
    const py = barY + inset;
    const ph = barH - inset * 2;
    const xPeak = dbToX(peakDb);
    if (xPeak > barX) {
      g.fillStyle = cYellow;
      g.fillRect(barX, py, Math.min(xPeak, xSplit) - barX, ph);
      if (xPeak > xSplit) {
        g.fillStyle = cHot;   // segment above -6 dB
        g.fillRect(xSplit, py, xPeak - xSplit, ph);
      }
    }

    // peak-hold tick
    if (holdDb > MIN_DB + 0.5) {
      const xh = Math.min(dbToX(holdDb), barX + barW - 2);
      g.fillStyle = holdDb > -6 ? cHot : cYellow;
      g.fillRect(xh - 1, barY, 2, barH);
    }

    // tick labels
    g.fillStyle = cDim;
    g.font = '9px "IBM Plex Mono", monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const ly = barY + barH + 12;
    for (const db of TICKS) {
      const text = String(db);
      const w = g.measureText(text).width;
      let x = dbToX(db) - w / 2;
      if (x < 1) x = 1;
      if (x + w > cw - 1) x = cw - 1 - w;
      g.fillText(text, x, ly);
    }
  }
}

function toDb(v) {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}
