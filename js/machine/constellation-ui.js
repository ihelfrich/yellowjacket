// Constellation view: your kit as a map. Each harvested slice is a point placed
// by timbre, coloured by role, sized by loudness. Clusters are redundancy you
// can see. Click a star to select and hear it.
//
// Pure view: takes clips with features, emits 'pick' {id}. No store access.

import { project2d, axisLabel } from '../analysis/constellation.js';

const ROLE_HUE = {
  KICK: 8, SNARE: 32, HAT: 54, BASS: 20,
  TONE: 70, VOX: 96, FX: 140, CRASH: 44,
};
const PAD = 22;
const DOT_MIN = 3.5;
const DOT_MAX = 9;

export class ConstellationView {
  constructor(canvas) {
    this.canvas = canvas;
    this._clips = [];
    this._points = [];
    this._selectedId = null;
    this._explained = 0;
    this._axes = null;
    this._hoverId = null;
    this._handlers = {};
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => this._onDown(e));
      canvas.addEventListener('pointermove', (e) => this._onMove(e));
      canvas.addEventListener('pointerleave', () => { this._hoverId = null; this.render(); });
    }
  }

  addEventListener(type, fn) {
    (this._handlers[type] = this._handlers[type] || []).push(fn);
  }

  _emit(type, detail) {
    for (const fn of this._handlers[type] || []) fn({ detail });
  }

  setClips(clips, selectedId) {
    this._clips = (clips || []).filter((c) => Array.isArray(c.features) && c.features.length);
    this._selectedId = selectedId == null ? null : selectedId;
    if (this._clips.length >= 2) {
      const out = project2d(this._clips.map((c) => c.features));
      this._points = out.points;
      this._explained = out.explained;
      this._axes = out.axes;
    } else {
      this._points = this._clips.map(() => ({ x: 0, y: 0 }));
      this._explained = 0;
      this._axes = null;
    }
    this.render();
  }

  setSelected(id) {
    this._selectedId = id == null ? null : id;
    this.render();
  }

  _css(name, fallback) {
    if (typeof getComputedStyle === 'undefined') return fallback;
    const v = getComputedStyle(this.canvas).getPropertyValue(name);
    return v ? v.trim() : fallback;
  }

  _layout() {
    const c = this.canvas;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    // A rect measured while the pane is hidden reads 0, and clamping that to a
    // minimum leaves a tiny bitmap stretched across the real width later, which
    // magnifies everything drawn in it. Prefer the layout box, and re-render on
    // reveal (controller.js calls render() when SLICE becomes visible).
    const rect = c.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width || c.clientWidth || c.offsetWidth || 0));
    const h = Math.max(80, Math.round(rect.height || c.clientHeight || c.offsetHeight || w));
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  _toPixel(pt, w, h) {
    return {
      px: PAD + ((pt.x + 1) / 2) * (w - PAD * 2),
      py: h - PAD - ((pt.y + 1) / 2) * (h - PAD * 2),
    };
  }

  _hit(x, y) {
    const { w, h } = this._layout();
    let best = null;
    let bestD = 14 * 14;
    for (let i = 0; i < this._points.length; i++) {
      const { px, py } = this._toPixel(this._points[i], w, h);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestD) { bestD = d; best = this._clips[i]; }
    }
    return best;
  }

  _onDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clip = this._hit(e.clientX - rect.left, e.clientY - rect.top);
    if (clip) {
      this._selectedId = clip.id;
      this.render();
      this._emit('pick', { id: clip.id });
    }
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clip = this._hit(e.clientX - rect.left, e.clientY - rect.top);
    const id = clip ? clip.id : null;
    if (id !== this._hoverId) {
      this._hoverId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'default';
      this.render();
    }
  }

  render() {
    const c = this.canvas;
    if (!c || !c.getContext) return;
    const { w, h, dpr } = this._layout();
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const well = this._css('--yj-well', '#0B0A07');
    const line = this._css('--yj-line', '#2A2618');
    const dim = this._css('--yj-ink-dim', '#8A8262');
    const yellow = this._css('--yj-yellow', '#FFD400');
    g.fillStyle = well;
    g.fillRect(0, 0, w, h);

    if (!this._clips.length) {
      g.fillStyle = dim;
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText('HARVEST to map the kit', w / 2, h / 2);
      return;
    }

    // Crosshair through the middle: the projection is centred by construction.
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD, h / 2); g.lineTo(w - PAD, h / 2);
    g.moveTo(w / 2, PAD); g.lineTo(w / 2, h - PAD);
    g.stroke();

    let maxScore = 0;
    for (const clip of this._clips) maxScore = Math.max(maxScore, clip.score || 0);

    for (let i = 0; i < this._clips.length; i++) {
      const clip = this._clips[i];
      const { px, py } = this._toPixel(this._points[i], w, h);
      const hue = ROLE_HUE[(clip.tag || '').toUpperCase()] ?? 50;
      const loud = maxScore > 0 ? (clip.score || 0) / maxScore : 0.5;
      const r = DOT_MIN + loud * (DOT_MAX - DOT_MIN);
      const sel = clip.id === this._selectedId;
      const hov = clip.id === this._hoverId;

      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fillStyle = 'hsl(' + hue + ' 90% ' + (sel ? 72 : 52) + '%)';
      g.fill();
      if (sel || hov) {
        g.beginPath();
        g.arc(px, py, r + 4, 0, Math.PI * 2);
        g.strokeStyle = sel ? yellow : dim;
        g.stroke();
      }
      if (sel || hov) {
        g.fillStyle = sel ? yellow : dim;
        g.font = '9px ui-monospace, monospace';
        g.textAlign = 'center';
        g.fillText(clip.label || clip.tag || '', px, py - r - 7);
      }
    }

    // Axis names come from the dominant feature in each component, so the plot
    // says what it is showing rather than "PC1".
    g.fillStyle = dim;
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'left';
    if (this._axes) {
      g.fillText(axisLabel(this._axes.first), PAD, h - 6);
      g.save();
      g.translate(10, h - PAD);
      g.rotate(-Math.PI / 2);
      g.fillText(axisLabel(this._axes.second), 0, 0);
      g.restore();
    }
    g.textAlign = 'right';
    g.fillText(Math.round(this._explained * 100) + '% OF VARIATION', w - PAD, h - 6);
  }
}
