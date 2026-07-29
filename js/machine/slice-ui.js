// Yellowjacket MACHINE — SLICE strip view. Source waveform with beat grid,
// onset ticks, word-boundary ticks, and carve-able ClipRef blocks. Follows the
// waveform.js pattern (shared min/max peak pyramid from render/peaks.js,
// DPR-aware backing store, static layer on an offscreen canvas, overlays
// composited over a blit) without importing WaveformView: the strip draws
// different furniture on top.
// Controls (ANALYZE / TAP TEMPO / CLEAR ANCHORS / CUT AT BEATS / EXPORT LOOP
// plus the editable BPM well and confidence readout) render into controlsHost.

import { makeClip, snapToBeat } from './cliprefs.js';
import { buildPeakPyramid, queryPeaks } from '../render/peaks.js';

const ZOOM_STEP = 1.25;         // zoom factor per wheel notch, same feel as waveform.js
const DRAG_PX = 4;              // click vs drag threshold, CSS px
const SNAP_TOL = 0.08;          // s, beat snap for carve/resize edges (contract: 80 ms)
const MIN_CLIP = 0.01;          // s, refuse zero-ish spans
const BEAT_HIT_PX = 5;          // CSS px, dblclick-a-beat-line tolerance
const EDGE_GRAB_PX = 5;         // CSS px, grab zone around a clip edge handle
const HANDLE = 7;               // CSS px, square handle side
const RULER_STEPS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600]; // adaptive tick steps, sec
const TOP_PAD = 32;             // CSS px above the wave: word ticks + B-labels + clip labels
const BOT_PAD = 20;             // CSS px below the wave: onset ticks + time ruler
const TAP_MIN = 4;              // taps before an anchor BPM is set (contract)
const TAP_KEEP = 9;             // rolling tap window (up to 8 inter-tap intervals)
const TAP_RESET_MS = 2000;      // gap that starts a fresh tap run

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class SliceView extends EventTarget {
  // Contract events: 'clipadd' {clip}, 'clipdelete' {id}, 'audition' {clip},
  //                  'anchorchange' {bpm, barOneTime}
  // Additions (documented deviations): 'exportloop' {clip} (EXPORT LOOP button;
  // main.js owns export.js), 'analyze' {} (ANALYZE button; main.js owns the
  // worker), 'clipselect' {clip|null} (selection changes, for rail state).
  constructor(canvas, controlsHost) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._off = document.createElement('canvas');
    this._offCtx = this._off.getContext('2d');

    this.mono = null;
    this.sampleRate = 0;
    this.duration = 0;

    this._view = { start: 0, end: 0 };
    this._analysis = null;
    this._anchors = { bpm: null, barOneTime: null };
    this._words = null;
    this._clips = [];
    this._selectedId = null;

    this._pyr = null;           // static min/max pyramid over the whole buffer
    this._peaks = null;         // per-column min/max at current zoom + width
    this._peaksDirty = true;
    this._staticReady = false;
    this._w = 0;                // backing store size, device px
    this._h = 0;
    this._dpr = 0;
    this._c = null;             // colors cached at last static draw

    this._drag = null;          // { id, mode, ... } see _onDown
    this._taps = [];
    this._tapTimer = 0;
    this._analyzing = false;

    canvas.tabIndex = 0;        // Backspace-to-delete needs key focus
    canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    canvas.addEventListener('pointerup', (e) => this._onUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onCancel(e));
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this._onDblClick(e));
    canvas.addEventListener('keydown', (e) => this._onKey(e));

    this.controls = this._buildControls(controlsHost);
    this._updateWells();
    this._updateControls();

    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas.parentElement || canvas);
    this._watchDpr();
  }

  // ---------- public API ----------

  setSource(mono, sampleRate, pyramid) {
    // pyramid: optional shared PeakPyramid built from this same mono array
    // (render/peaks.js). When absent the view builds its own.
    this.mono = mono && mono.length ? mono : null;
    this.sampleRate = sampleRate || 0;
    this.duration = this.mono && this.sampleRate ? this.mono.length / this.sampleRate : 0;
    this._pyr = this.mono ? (pyramid || buildPeakPyramid(this.mono)) : null;
    this._view = { start: 0, end: this.duration };
    this._analysis = null;
    this._anchors = { bpm: null, barOneTime: null };
    this._words = null;
    this._clips = [];
    this._selectedId = null;
    this._taps = [];
    this._peaksDirty = true;
    this._updateWells();
    this._updateControls();
    this.render();
  }

  setAnalysis(analysis) {
    this._analysis = analysis || null;
    if (analysis && analysis.anchors) {
      this._anchors = {
        bpm: Number.isFinite(analysis.anchors.bpm) ? analysis.anchors.bpm : null,
        barOneTime: Number.isFinite(analysis.anchors.barOneTime) ? analysis.anchors.barOneTime : null,
      };
    }
    this._updateWells();
    this._updateControls();
    this.render();
  }

  setWords(words) {
    this._words = words && words.length ? words : null;
    this.render();
  }

  setClips(clips) {
    this._clips = clips || [];
    if (this._selectedId != null && !this._clips.some((c) => c.id === this._selectedId)) {
      this._selectedId = null;
    }
    this._updateControls();
    if (this._staticReady) this._composite();
    else this.render();
  }

  // Public selection setter so the clip list can drive the canvas (and so
  // ASSIGN, which reads selectedClip, agrees with what the list highlights).
  selectClip(id) {
    this._selectedId = id != null && this._clips.some((c) => c.id === id) ? id : null;
    this._updateControls();
    this._composite();
    return this.selectedClip;
  }

  get selectedClip() {
    return this._clips.find((c) => c.id === this._selectedId) || null;
  }

  setAnalyzing(on) {
    this._analyzing = !!on;
    this.controls.analyze.classList.toggle('is-working', this._analyzing);
    this._updateControls();
  }

  render() {
    this._syncSize();
    if (!this._w || !this._h) return;   // hidden tab: try again on next render()
    if (this._peaksDirty) this._computePeaks();
    this._drawStatic();
    this._composite();
  }

  // ---------- controls host ----------

  _buildControls(host) {
    host.textContent = '';
    const row = () => {
      const d = document.createElement('div');
      d.className = 'yj-toolrow';
      host.appendChild(d);
      return d;
    };
    const btn = (parent, label, title, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-btn' + (primary ? ' yj-btn-primary' : '');
      b.textContent = label;
      if (title) b.title = title;
      parent.appendChild(b);
      return b;
    };

    const wells = row();
    const bpmWell = document.createElement('div');
    bpmWell.className = 'yj-well yj-count';
    bpmWell.title = 'Tempo. Click to type a BPM; Enter pins it as an anchor.';
    const confWell = document.createElement('div');
    confWell.className = 'yj-well yj-count';
    confWell.title = 'Beat-tracking confidence.';
    wells.append(bpmWell, confWell);

    const r1 = row();
    const analyze = btn(r1, 'ANALYZE', 'Re-run beat and onset analysis', true);
    const tap = btn(r1, 'TAP TEMPO', 'Tap (click or spacebar) 4+ times; median inter-tap sets the BPM anchor');

    const r2 = row();
    const clear = btn(r2, 'CLEAR ANCHORS', 'Drop BPM and bar-one pins; analysis returns to auto');
    const cut = btn(r2, 'CUT AT BEATS', 'Turn every bar in the current view into a beat clip');

    const r3 = row();
    const exportLoop = btn(r3, 'EXPORT LOOP', 'Export the selected clip as WAV');

    bpmWell.addEventListener('click', () => this._editBpm());
    analyze.addEventListener('click', () => this._emit('analyze', {}));
    tap.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this._tap();
    });
    tap.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();       // no synthesized click on keyup
        e.stopPropagation();      // keep main.js space-to-play out of a tap run
        this._tap();
      }
    });
    clear.addEventListener('click', () => {
      this._taps = [];
      this._syncTapLabel();
      this._anchors = { bpm: null, barOneTime: null };
      this._emit('anchorchange', { bpm: null, barOneTime: null });
      this._updateWells();
      this._updateControls();
      this.render();
    });
    cut.addEventListener('click', () => this._cutAtBeats());
    exportLoop.addEventListener('click', () => {
      const clip = this.selectedClip;
      if (clip) this._emit('exportloop', { clip });
    });

    return { bpmWell, confWell, analyze, tap, clear, cut, exportLoop };
  }

  _updateControls() {
    const c = this.controls;
    if (!c) return;
    const a = this._analysis;
    c.analyze.disabled = !this.mono || this._analyzing;
    c.tap.disabled = !this.mono;
    c.clear.disabled = this._anchors.bpm == null && this._anchors.barOneTime == null;
    c.cut.disabled = !(a && a.beats && a.beats.length > (a.beatsPerBar || 4));
    c.exportLoop.disabled = !this.selectedClip;
  }

  _updateWells() {
    const c = this.controls;
    if (!c) return;
    const a = this._analysis;
    const bpm = a && a.tempo ? a.tempo : this._anchors.bpm;
    c.bpmWell.textContent = bpm
      ? bpm.toFixed(1) + (this._anchors.bpm != null ? ' PIN' : ' BPM')
      : '—';
    const conf = a ? a.confidence : null;
    if (conf == null || !isFinite(conf)) {
      c.confWell.textContent = 'CONF —';
      c.confWell.style.color = '';
    } else {
      // Low confidence is stated, not hidden: the acceptance test checks for it.
      c.confWell.textContent = 'CONF ' + Math.round(conf * 100) + '%' + (conf < 0.3 ? ' · LOW' : '');
      c.confWell.style.color = conf < 0.3 ? 'var(--yj-fault)' : conf < 0.6 ? 'var(--yj-caution)' : '';
    }
  }

  _editBpm() {
    const well = this.controls.bpmWell;
    if (!this.mono || well.hidden) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'yj-well yj-count';
    input.style.width = '76px';
    const current = this._anchors.bpm != null
      ? this._anchors.bpm
      : (this._analysis && this._analysis.tempo ? this._analysis.tempo : null);
    input.value = current != null ? current.toFixed(1) : '';
    const done = () => {
      input.remove();
      well.hidden = false;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = Number(input.value);
        if (isFinite(v) && v >= 20 && v <= 400) {
          this._anchors = { bpm: v, barOneTime: this._anchors.barOneTime };
          this._emit('anchorchange', { ...this._anchors });
          this._updateWells();
          this._updateControls();
        }
        done();
      } else if (e.key === 'Escape') {
        done();
      }
    });
    input.addEventListener('blur', done);
    well.hidden = true;
    well.parentElement.insertBefore(input, well);
    input.focus();
    input.select();
  }

  _tap() {
    const now = performance.now();
    if (this._taps.length && now - this._taps[this._taps.length - 1] > TAP_RESET_MS) {
      this._taps = [];
    }
    this._taps.push(now);
    if (this._taps.length > TAP_KEEP) this._taps.shift();
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => {
      this._taps = [];
      this._syncTapLabel();
    }, TAP_RESET_MS);
    if (this._taps.length >= TAP_MIN) {
      const iv = [];
      for (let i = 1; i < this._taps.length; i++) iv.push(this._taps[i] - this._taps[i - 1]);
      iv.sort((a, b) => a - b);
      const mid = iv.length >> 1;
      const median = iv.length % 2 ? iv[mid] : (iv[mid - 1] + iv[mid]) / 2;
      const bpm = Math.round(600000 / median) / 10;
      if (isFinite(bpm) && bpm >= 20 && bpm <= 400) {
        this._anchors = { bpm, barOneTime: this._anchors.barOneTime };
        this._emit('anchorchange', { ...this._anchors });
        this._updateWells();
        this._updateControls();
      }
    }
    this._syncTapLabel();
  }

  _syncTapLabel() {
    const n = this._taps.length;
    this.controls.tap.textContent = n ? 'TAP ' + n : 'TAP TEMPO';
  }

  _cutAtBeats() {
    const a = this._analysis;
    if (!a || !a.beats || !a.beats.length) return;
    const beats = a.beats;
    const bpb = a.beatsPerBar || 4;
    if (beats.length <= bpb) return;
    const down = a.downbeat || 0;
    const phase = ((down % bpb) + bpb) % bpb;
    const v = this._view;
    let firstNew = null;
    for (let i = phase; i + bpb < beats.length; i += bpb) {
      const s = beats[i];
      const e = beats[i + bpb];
      if (e > v.end + 1e-6) break;
      if (s < v.start - 1e-6) continue;
      const dup = this._clips.some((c) =>
        c.tag === 'beat' && Math.abs(c.start - s) < 1e-3 && Math.abs(c.end - e) < 1e-3);
      if (dup) continue;
      const n = (i - down) / bpb + 1;
      const clip = makeClip(s, e, 'beat', 'BAR ' + n);
      if (!firstNew) firstNew = clip;
      this._emit('clipadd', { clip });
    }
    if (firstNew) {
      this._selectedId = firstNew.id;
      this._emit('clipselect', { clip: firstNew });
      this._updateControls();
    }
    if (this._staticReady) this._composite();
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
      this._watchDpr();           // re-arm at the new ratio
    }, { once: true });
  }

  // ---------- peaks ----------

  _computePeaks() {
    this._peaksDirty = false;
    const w = this._w;
    if (!w || !this.mono || !this.duration || !this._pyr) { this._peaks = null; return; }
    if (!this._peaks || this._peaks.mins.length !== w) {
      this._peaks = { mins: new Float32Array(w), maxs: new Float32Array(w) };
    }
    const sr = this.sampleRate;
    queryPeaks(this._pyr, this._view.start * sr, this._view.end * sr, w,
      this._peaks.mins, this._peaks.maxs);
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
      barLine: v('--yj-amber-dim', '#6E5A10'),
      wave: v('--yj-wave', '#D9B830'),
      yellow: v('--yj-yellow', '#FFD400'),
      amber: v('--yj-amber', '#C79A00'),
      caution: v('--yj-caution', '#FF9E00'),
      select: v('--yj-select', 'rgba(255,212,0,0.14)'),
      ink: v('--yj-ink', '#E8E4D4'),
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
    const v = this._view;
    const span = v.end - v.start;
    if (!(span > 0)) { this._staticReady = true; return; }
    const toX = (t) => ((t - v.start) / span) * w;

    // beat grid behind everything: thin per-beat lines, heavier per-bar lines
    const a = this._analysis;
    if (a && a.beats && a.beats.length) {
      const beats = a.beats;
      const bpb = a.beatsPerBar || 4;
      const down = a.downbeat || 0;
      const barW = Math.max(1, Math.round(1.5 * dpr));
      g.font = Math.round(9 * dpr) + 'px ' + c.mono;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      let lastThin = -Infinity;
      let lastLabel = -Infinity;
      for (let i = Math.max(0, lowerBound(beats, v.start) - 1); i < beats.length; i++) {
        const t = beats[i];
        if (t > v.end) break;
        if (t < v.start) continue;
        const x = Math.round(toX(t));
        if (((i - down) % bpb + bpb) % bpb === 0) {
          g.fillStyle = c.barLine;
          g.fillRect(x, 0, barW, h);
          const n = (i - down) / bpb + 1;
          if (n >= 1 && x - lastLabel >= 30 * dpr) {
            const anchored = i === down && this._anchors.barOneTime != null;
            g.fillStyle = anchored ? c.yellow : c.inkDim;
            g.fillText('B' + n, x + 3 * dpr, 17 * dpr);
            lastLabel = x;
          }
        } else {
          if (x - lastThin < 3 * dpr) continue;
          g.fillStyle = c.line;
          g.fillRect(x, 0, 1, h);
          lastThin = x;
        }
      }
    }

    // waveform body between the top and bottom silkscreen bands
    if (this._peaks) {
      const top = TOP_PAD * dpr, bot = BOT_PAD * dpr;
      const amp = Math.max(4, (h - top - bot) / 2);
      const mid = top + amp;
      g.fillStyle = c.line;
      g.fillRect(0, Math.round(mid), w, 1);
      const { mins, maxs } = this._peaks;
      g.fillStyle = c.wave;
      for (let x = 0; x < w; x++) {
        let lo = mins[x], hi = maxs[x];
        if (lo < -1) lo = -1;
        if (hi > 1) hi = 1;
        const y0 = mid - hi * amp;
        const y1 = mid - lo * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }

    // word boundary ticks along the top, dim
    if (this._words) {
      g.fillStyle = c.inkDim;
      g.globalAlpha = 0.7;
      for (const wd of this._words) {
        if (wd.start > v.end) break;
        if (wd.end < v.start) continue;
        const x = Math.round(toX(wd.start));
        if (x >= 0 && x <= w) g.fillRect(x, 0, 1, 6 * dpr);
      }
      const last = this._words[this._words.length - 1];
      if (last.end >= v.start && last.end <= v.end) {
        g.fillRect(Math.round(toX(last.end)), 0, 1, 6 * dpr);
      }
      g.globalAlpha = 1;
    }

    this._drawRuler(g, w, h, dpr, c);

    // onset ticks: 3px marks along the bottom, just above the time ruler
    if (a && a.onsets && a.onsets.length) {
      const onsets = a.onsets;
      g.fillStyle = c.caution;
      const yTop = h - 16 * dpr;
      const tw = Math.max(1, Math.round(3 * dpr));
      for (let i = lowerBound(onsets, v.start); i < onsets.length; i++) {
        const t = onsets[i];
        if (t > v.end) break;
        g.fillRect(Math.round(toX(t)) - (tw >> 1), yTop, tw, 7 * dpr);
      }
    }

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
    const d = this._drag;
    const edgeW = Math.max(1, Math.round(dpr));
    const hs = Math.round(HANDLE * dpr);
    const hy = Math.round(h / 2 - hs / 2);

    for (const clip of this._clips) {
      let s = clip.start, e = clip.end;
      if (d && d.mode === 'resize' && d.clip.id === clip.id) { s = d.a; e = d.b; }
      if (e <= v.start || s >= v.end) continue;
      const x0 = Math.max(-hs, toX(s));
      const x1 = Math.min(w + hs, toX(e));
      if (x1 - x0 < 0.5) continue;
      const sel = clip.id === this._selectedId;
      g.fillStyle = c.select;
      g.fillRect(x0, 0, x1 - x0, h);
      if (sel) g.fillRect(x0, 0, x1 - x0, h);   // second pass doubles the tint
      g.fillStyle = sel ? c.yellow : c.amber;
      g.fillRect(Math.round(x0), 0, edgeW, h);
      g.fillRect(Math.round(x1) - edgeW, 0, edgeW, h);
      g.fillRect(Math.round(x0), hy, hs, hs);          // square edge handles
      g.fillRect(Math.round(x1) - hs, hy, hs, hs);
      if (clip.label && x1 - x0 >= 26 * dpr) {
        g.font = Math.round(9 * dpr) + 'px ' + c.mono;
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillStyle = sel ? c.ink : c.inkDim;
        g.fillText(this._fitLabel(g, clip.label, x1 - x0 - 8 * dpr), x0 + 4 * dpr, 27 * dpr);
      }
    }

    // carve preview
    if (d && d.mode === 'carve' && d.b > d.a) {
      const x0 = Math.max(0, toX(d.a));
      const x1 = Math.min(w, toX(d.b));
      if (x1 > x0) {
        g.fillStyle = c.select;
        g.fillRect(x0, 0, x1 - x0, h);
        g.fillStyle = c.yellow;
        g.fillRect(Math.round(x0), 0, edgeW, h);
        g.fillRect(Math.round(x1) - edgeW, 0, edgeW, h);
      }
    }
  }

  _fitLabel(g, text, maxW) {
    if (g.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '';
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
    this._updateControls();      // CUT AT BEATS scope follows the view
    this.render();
  }

  _timeAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const f = rect.width ? (clientX - rect.left) / rect.width : 0;
    const v = this._view;
    return v.start + Math.min(1, Math.max(0, f)) * (v.end - v.start);
  }

  _snap(t) {
    const a = this._analysis;
    if (!a || !a.beats || !a.beats.length) return t;
    return snapToBeat(t, a.beats, SNAP_TOL);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- hit testing ----------

  _clipHit(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const x = clientX - rect.left;
    const v = this._view;
    const span = v.end - v.start;
    if (!(span > 0)) return null;
    const toX = (t) => ((t - v.start) / span) * rect.width;
    // handles win over bodies; later clips draw on top, so scan backward
    for (let i = this._clips.length - 1; i >= 0; i--) {
      const clip = this._clips[i];
      if (clip.end < v.start || clip.start > v.end) continue;
      if (Math.abs(toX(clip.start) - x) <= EDGE_GRAB_PX) return { clip, part: 'start' };
      if (Math.abs(toX(clip.end) - x) <= EDGE_GRAB_PX) return { clip, part: 'end' };
    }
    for (let i = this._clips.length - 1; i >= 0; i--) {
      const clip = this._clips[i];
      const x0 = toX(clip.start), x1 = toX(clip.end);
      if (x >= x0 && x <= x1) return { clip, part: 'body' };
    }
    return null;
  }

  _beatLineAt(clientX) {
    const a = this._analysis;
    if (!a || !a.beats || !a.beats.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const v = this._view;
    const span = v.end - v.start;
    if (!(span > 0)) return null;
    const x = clientX - rect.left;
    const t = v.start + (x / rect.width) * span;
    const i = lowerBound(a.beats, t);
    let best = null;
    let bestPx = BEAT_HIT_PX + 0.001;
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= a.beats.length) continue;
      const px = Math.abs(((a.beats[j] - v.start) / span) * rect.width - x);
      if (px < bestPx) { bestPx = px; best = a.beats[j]; }
    }
    return best;
  }

  // ---------- interaction ----------

  _onDown(e) {
    if (e.button !== 0 || !this.duration || !this._w) return;
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    // Capture keeps drags alive outside the canvas, but some pointer sources
    // (synthetic events, remote input) have no capturable pointer: not fatal.
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* drag still works */ }
    if (e.shiftKey) {
      this._drag = {
        id: e.pointerId, mode: 'pan', x0: e.clientX,
        view0: { start: this._view.start, end: this._view.end },
      };
      return;
    }
    const hit = this._clipHit(e.clientX);
    if (hit && hit.part !== 'body') {
      this._drag = {
        id: e.pointerId, mode: 'resize', clip: hit.clip, part: hit.part,
        a: hit.clip.start, b: hit.clip.end, moved: false, x0: e.clientX,
      };
    } else if (hit) {
      this._drag = { id: e.pointerId, mode: 'clip-arm', clip: hit.clip, x0: e.clientX };
    } else {
      this._drag = {
        id: e.pointerId, mode: 'arm', x0: e.clientX,
        t0: this._timeAtClientX(e.clientX), a: NaN, b: NaN,
      };
    }
  }

  _onMove(e) {
    const d = this._drag;
    if (!d) { this._hoverCursor(e); return; }
    if (e.pointerId !== d.id) return;
    if (d.mode === 'pan') {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return;
      const span0 = d.view0.end - d.view0.start;
      const dt = -((e.clientX - d.x0) / rect.width) * span0;
      this._applyUserView(d.view0.start + dt, d.view0.end + dt);
      return;
    }
    if (d.mode === 'clip-arm') {
      if (Math.abs(e.clientX - d.x0) >= DRAG_PX) d.mode = 'dead';
      return;
    }
    if (d.mode === 'dead') return;
    if (d.mode === 'arm' && Math.abs(e.clientX - d.x0) >= DRAG_PX) d.mode = 'carve';
    if (d.mode === 'carve') {
      const t = this._timeAtClientX(e.clientX);
      let a = Math.min(d.t0, t);
      let b = Math.max(d.t0, t);
      if (!e.altKey) {           // Alt disables beat snap (contract)
        a = this._snap(a);
        b = this._snap(b);
      }
      d.a = Math.max(0, a);
      d.b = Math.min(this.duration, b);
      this._composite();
      return;
    }
    if (d.mode === 'resize') {
      if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
      d.moved = true;
      let t = this._timeAtClientX(e.clientX);
      if (!e.altKey) t = this._snap(t);
      t = Math.min(Math.max(t, 0), this.duration);
      if (d.part === 'start') d.a = Math.min(t, d.b - MIN_CLIP);
      else d.b = Math.max(t, d.a + MIN_CLIP);
      this._composite();
    }
  }

  _onUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d.mode === 'pan' || d.mode === 'dead') return;

    if (d.mode === 'arm') {                        // click on empty: deselect
      if (this._selectedId != null) {
        this._selectedId = null;
        this._emit('clipselect', { clip: null });
        this._updateControls();
      }
      this._composite();
      return;
    }

    if (d.mode === 'clip-arm') {                   // click a clip: select + audition
      this._selectedId = d.clip.id;
      this._emit('clipselect', { clip: d.clip });
      this._emit('audition', { clip: d.clip });
      this._updateControls();
      this._composite();
      return;
    }

    if (d.mode === 'carve') {
      if (isFinite(d.a) && isFinite(d.b) && d.b - d.a >= MIN_CLIP) {
        const clip = makeClip(d.a, d.b, 'manual', this._spanLabel(d.a, d.b));
        this._selectedId = clip.id;                // before emit: setClips keeps it
        this._emit('clipadd', { clip });
        this._emit('clipselect', { clip });
        this._updateControls();
      }
      this._composite();
      return;
    }

    if (d.mode === 'resize') {
      const old = d.clip;
      const changed = d.moved &&
        (Math.abs(d.a - old.start) > 1e-6 || Math.abs(d.b - old.end) > 1e-6);
      if (changed && d.b - d.a >= MIN_CLIP) {
        // spans are immutable: a resize is delete + add of a new ClipRef
        const next = makeClip(d.a, d.b, old.tag, old.label);
        next.gain = old.gain;
        this._selectedId = next.id;
        // ADD BEFORE DELETE. The controller calls setClips after every event,
        // and setClips drops a selection whose id is not in the list. Deleting
        // first meant the new clip did not exist yet at that moment, so every
        // resize silently cleared the selection and ASSIGN then refused with
        // "select a clip in SLICE first" while the user was looking at it.
        this._emit('clipadd', { clip: next });
        this._emit('clipdelete', { id: old.id });
        this._emit('clipselect', { clip: next });
        this._updateControls();
      }
      this._composite();
    }
  }

  _onCancel(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this._composite();
  }

  _onDblClick(e) {
    e.preventDefault();
    if (!this.duration) return;
    const beat = this._beatLineAt(e.clientX);
    if (beat != null) {                            // dblclick a beat line: pin bar one
      this._anchors = { bpm: this._anchors.bpm, barOneTime: beat };
      this._emit('anchorchange', { ...this._anchors });
      this._updateWells();
      this._updateControls();
      return;
    }
    this._applyUserView(0, this.duration);
  }

  _onKey(e) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const clip = this.selectedClip;
    if (!clip) return;
    e.preventDefault();
    e.stopPropagation();
    this._selectedId = null;
    this._emit('clipdelete', { id: clip.id });
    this._emit('clipselect', { clip: null });
    this._updateControls();
    this._composite();
  }

  _hoverCursor(e) {
    if (!this.duration) { this.canvas.style.cursor = ''; return; }
    const hit = this._clipHit(e.clientX);
    this.canvas.style.cursor = hit ? (hit.part === 'body' ? 'pointer' : 'ew-resize') : 'crosshair';
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

  // ---------- labels ----------

  _fmtT(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  _spanLabel(a, b) {
    return this._fmtT(a) + '-' + this._fmtT(b);
  }
}
