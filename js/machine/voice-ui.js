// Yellowjacket MACHINE — VOICE drawer for the PATTERN state. Per
// CONTRACT-SONG.md section 3: sample name, a mini min/max waveform of the
// track's PCM with draggable START/END trim handles (fractions of the
// sample), PITCH / ATTACK / RELEASE / REVERSE controls and a TRIG audition
// button. Pure view: no store access, 'voiceedit' carries exactly ONE changed
// voice field per emit; dispatch is synchronous, so every control re-reads
// the live track right after emitting and shows what the controller applied.
// Peak drawing follows the slice-ui idiom: per-column min/max iterated over
// the Float32Array, no drawImage.

const PITCH_MIN = -24;
const PITCH_MAX = 24;
const ATT_MIN = 1;                  // ms, CONTRACT-SONG.md section 1
const ATT_MAX = 500;
const REL_MIN = 2;
const REL_MAX = 2000;
const MIN_SPAN = 0.005;             // end - start never shrinks below this
const GRAB_PX = 8;                  // CSS px, handle grab zone
const WAVE_H = 72;                  // CSS px, canvas height

const STYLE = `
.yj-voice { display: flex; flex-direction: column; gap: 8px; background: var(--yj-panel); border: 1px solid var(--yj-line); border-radius: 2px; padding: 8px 10px; }
.yj-voice-head { display: flex; align-items: center; gap: 8px; }
.yj-voice-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-voice-name { font-family: var(--f-mono); font-size: 11px; color: var(--yj-yellow); padding: 2px 8px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-voice-name.is-empty { color: var(--yj-ink-dim); }
.yj-voice-actions { display: flex; gap: 6px; margin-left: auto; }
.yj-voice-wave { width: 100%; height: 72px; display: block; background: var(--yj-well); border: 1px solid var(--yj-line); border-radius: 2px; cursor: ew-resize; touch-action: none; }
.yj-voice-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.yj-voice-c { display: flex; align-items: center; gap: 5px; }
.yj-voice-label { font-size: 9px; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-voice-val { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink); font-variant-numeric: tabular-nums; min-width: 44px; }
.yj-voice-c input[type="range"] { width: 70px; }
`;

export class VoiceView extends EventTarget {
  // Contract events: 'voiceedit' {track, patch} (patch holds only the changed
  // field), 'trig' {track}, 'crate' {track} (CONTRACT-HARVEST.md section 3),
  // 'close' {}.
  constructor(host) {
    super();
    this.host = host;
    this._track = -1;
    this._t = null;                 // live track reference from setTrack
    this._drag = null;              // { id, which: 'start'|'end' }
    this._peaks = null;             // cached column min/max; reset per track/width

    host.classList.add('yj-voice');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    const head = document.createElement('div');
    head.className = 'yj-voice-head';
    const tag = document.createElement('span');
    tag.className = 'yj-voice-tag';
    tag.textContent = 'VOICE';
    const name = document.createElement('span');
    name.className = 'yj-well yj-voice-name is-empty';
    name.textContent = 'T— · EMPTY';
    name.title = 'Track and sample this voice shapes';
    const actions = document.createElement('div');
    actions.className = 'yj-voice-actions';

    const trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'yj-btn yj-btn-primary';
    trig.textContent = 'TRIG';
    trig.title = 'Audition the voice: what you hear is what the pattern plays';
    trig.disabled = true;
    trig.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && this._track >= 0) this._emit('trig', { track: this._track });
    });
    trig.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();           // no synthesized click on keyup
        e.stopPropagation();          // keep main.js space-to-play out of it
        if (this._track >= 0) this._emit('trig', { track: this._track });
      }
    });

    const crate = document.createElement('button');
    crate.type = 'button';
    crate.className = 'yj-btn';
    crate.textContent = 'CRATE +';
    crate.title = 'Save this instrument to the crate: it outlives the session and the song it came from';
    crate.disabled = true;
    crate.addEventListener('click', () => {
      if (this._track >= 0 && this._t && this._t.sample) this._emit('crate', { track: this._track });
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'yj-btn';
    close.textContent = 'CLOSE';
    close.title = 'Close the voice drawer';
    close.addEventListener('click', () => this._emit('close', {}));

    actions.append(trig, crate, close);
    head.append(tag, name, actions);
    host.appendChild(head);

    const wave = document.createElement('canvas');
    wave.className = 'yj-voice-wave';
    wave.title = 'Trim: drag the START and END handles';
    wave.addEventListener('pointerdown', (e) => this._onDown(e));
    wave.addEventListener('pointermove', (e) => this._onMove(e));
    wave.addEventListener('pointerup', (e) => this._onUp(e));
    wave.addEventListener('pointercancel', (e) => this._onUp(e));
    host.appendChild(wave);
    this._wave = wave;

    const controls = document.createElement('div');
    controls.className = 'yj-voice-controls';
    const group = (label, ...nodes) => {
      const g = document.createElement('div');
      g.className = 'yj-voice-c';
      const l = document.createElement('span');
      l.className = 'yj-voice-label';
      l.textContent = label;
      g.append(l, ...nodes);
      controls.appendChild(g);
      return g;
    };
    const sq = (txt, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-pattern-sq';
      b.textContent = txt;
      b.title = title;
      return b;
    };
    const range = (min, max, step, val, title) => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      r.value = String(val);
      r.title = title;
      return r;
    };
    const val = () => {
      const s = document.createElement('span');
      s.className = 'yj-voice-val';
      return s;
    };

    const pdown = sq('−', 'Pitch down one semitone');
    const pitchVal = val();
    const pup = sq('+', 'Pitch up one semitone');
    pdown.addEventListener('click', () => this._stepPitch(-1));
    pup.addEventListener('click', () => this._stepPitch(1));
    group('PITCH', pdown, pitchVal, pup);

    const att = range(ATT_MIN, ATT_MAX, 1, 3, 'Attack ramp, ms');
    const attVal = val();
    att.addEventListener('input', () => this._patch('attack', Math.round(Number(att.value))));
    group('ATTACK', att, attVal);

    const rel = range(REL_MIN, REL_MAX, 1, 8, 'Release ramp, ms; every voice declicks at its end');
    const relVal = val();
    rel.addEventListener('input', () => this._patch('release', Math.round(Number(rel.value))));
    group('RELEASE', rel, relVal);

    const rev = sq('R', 'Reverse: play the trimmed span backwards');
    rev.addEventListener('click', () => this._patch('reverse', !this._voice().reverse));
    group('REV', rev);

    // COLOR (CONTRACT-HARVEST 2): the controls that stop a rework sounding
    // like its source. Each OFF value skips its node entirely.
    const lpf = range(200, 20000, 100, 20000, 'Lowpass cutoff, Hz; 20k is off');
    const lpfVal = val();
    lpf.addEventListener('input', () => this._patch('lpf', Math.round(Number(lpf.value))));
    group('LPF', lpf, lpfVal);

    const res = range(5, 80, 1, 7, 'Lowpass resonance');
    const resVal = val();
    res.addEventListener('input', () => this._patch('res', Number(res.value) / 10));
    group('RES', res, resVal);

    const hpf = range(20, 2000, 10, 20, 'Highpass cutoff, Hz; 20 is off');
    const hpfVal = val();
    hpf.addEventListener('input', () => this._patch('hpf', Math.round(Number(hpf.value))));
    group('HPF', hpf, hpfVal);

    const drive = range(0, 24, 1, 0, 'Saturation, dB; 0 is off');
    const driveVal = val();
    drive.addEventListener('input', () => this._patch('drive', Math.round(Number(drive.value))));
    group('DRIVE', drive, driveVal);

    this._lpf = lpf; this._lpfVal = lpfVal;
    this._res = res; this._resVal = resVal;
    this._hpf = hpf; this._hpfVal = hpfVal;
    this._drive = drive; this._driveVal = driveVal;

    host.appendChild(controls);
    this._name = name;
    this._trig = trig;
    this._crate = crate;
    this._close = close;
    this._pitchVal = pitchVal;
    this._att = att;
    this._attVal = attVal;
    this._rel = rel;
    this._relVal = relVal;
    this._rev = rev;
  }

  // ---------- public API ----------

  setTrack(index, track) {
    this._track = (typeof index === 'number' && index >= 0) ? index | 0 : -1;
    this._t = track || null;
    this._peaks = null;
    this._sync();
    this._draw();
  }

  // ---------- voice state ----------

  _voice() {
    // Defaults mirror project-store createVoice; the view never mutates them.
    const v = (this._t && this._t.voice) || {};
    return {
      start: Number.isFinite(v.start) ? v.start : 0,
      end: Number.isFinite(v.end) ? v.end : 1,
      pitch: Number.isFinite(v.pitch) ? v.pitch : 0,
      attack: Number.isFinite(v.attack) ? v.attack : 3,
      release: Number.isFinite(v.release) ? v.release : 8,
      reverse: !!v.reverse,
    };
  }

  _patch(field, value) {
    if (this._track < 0) return;
    this._emit('voiceedit', { track: this._track, patch: { [field]: value } });
    this._sync();
    if (field === 'start' || field === 'end') this._draw();
  }

  _stepPitch(d) {
    const cur = this._voice().pitch;
    const v = Math.min(PITCH_MAX, Math.max(PITCH_MIN, cur + d));
    if (v !== cur) this._patch('pitch', v);
  }

  _sync() {
    const t = this._t;
    const has = !!(t && t.sample);
    const label = has ? (t.sample.label || 'SAMPLE') : 'EMPTY';
    this._name.textContent = (this._track >= 0 ? 'T' + (this._track + 1) : 'T—') + ' · ' + label;
    this._name.classList.toggle('is-empty', !has);
    this._trig.disabled = !has;
    this._crate.disabled = !has;
    const v = this._voice();
    this._pitchVal.textContent = (v.pitch > 0 ? '+' : '') + v.pitch + ' ST';
    this._att.value = String(v.attack);
    this._attVal.textContent = v.attack + ' ms';
    this._rel.value = String(v.release);
    this._relVal.textContent = v.release + ' ms';
    this._rev.classList.toggle('is-on', v.reverse);
    const lpf = v.lpf == null ? 20000 : v.lpf;
    this._lpf.value = String(lpf);
    this._lpfVal.textContent = lpf >= 18000 ? 'OFF' : (lpf >= 1000 ? (lpf / 1000).toFixed(1) + 'k' : lpf + ' Hz');
    const res = v.res == null ? 0.7 : v.res;
    this._res.value = String(Math.round(res * 10));
    this._resVal.textContent = res.toFixed(1);
    const hpf = v.hpf == null ? 20 : v.hpf;
    this._hpf.value = String(hpf);
    this._hpfVal.textContent = hpf <= 25 ? 'OFF' : hpf + ' Hz';
    const drive = v.drive == null ? 0 : v.drive;
    this._drive.value = String(drive);
    this._driveVal.textContent = drive === 0 ? 'OFF' : '+' + drive + ' dB';
  }

  // ---------- trim handles ----------

  _onDown(e) {
    if (e.button !== 0 || !this._t || !this._t.sample) return;
    const rect = this._wave.getBoundingClientRect();
    if (!rect.width) return;
    const v = this._voice();
    const x = e.clientX - rect.left;
    const ds = Math.abs(x - v.start * rect.width);
    const de = Math.abs(x - v.end * rect.width);
    let which = null;
    if (ds <= GRAB_PX && ds <= de) which = 'start';
    else if (de <= GRAB_PX) which = 'end';
    if (!which) return;
    e.preventDefault();
    // Synthetic pointers have no capturable id (see slice-ui): not fatal.
    try { this._wave.setPointerCapture(e.pointerId); } catch (err) { /* drag still works */ }
    this._drag = { id: e.pointerId, which };
  }

  _onMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const rect = this._wave.getBoundingClientRect();
    if (!rect.width) return;
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this._setHandle(d.which, f);
  }

  _setHandle(which, f) {
    const v = this._voice();
    if (which === 'start') {
      const nv = Math.min(Math.max(0, f), Math.max(0, v.end - MIN_SPAN));
      if (Math.abs(nv - v.start) > 1e-6) this._patch('start', nv);
    } else {
      const nv = Math.max(Math.min(1, f), Math.min(1, v.start + MIN_SPAN));
      if (Math.abs(nv - v.end) > 1e-6) this._patch('end', nv);
    }
  }

  _onUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (this._wave.hasPointerCapture && this._wave.hasPointerCapture(e.pointerId)) {
      this._wave.releasePointerCapture(e.pointerId);
    }
  }

  // ---------- mini waveform (slice-ui min/max idiom, no drawImage) ----------

  _scanPeaks(ch, w) {
    const mins = new Float32Array(w);
    const maxs = new Float32Array(w);
    const n = ch.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      const step = b - a > 4096 ? Math.ceil((b - a) / 4096) : 1;  // 30 s tracks stay cheap
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = a; i < b; i += step) {
        const s = ch[i];
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      mins[x] = lo === Infinity ? 0 : lo;
      maxs[x] = hi === -Infinity ? 0 : hi;
    }
    return { w, mins, maxs };
  }

  _draw() {
    const cv = this._wave;
    const g = cv.getContext ? cv.getContext('2d') : null;
    if (!g) return;                                   // node stub: no 2d context
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const w = Math.max(1, Math.round((cv.clientWidth || 480) * dpr));
    const h = Math.max(1, Math.round(WAVE_H * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      this._peaks = null;
    }
    const c = this._colors();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);
    const ch = this._t && this._t.sample && this._t.sample.channels ? this._t.sample.channels[0] : null;
    if (!ch || !ch.length) {
      g.font = Math.round(9 * dpr) + 'px ' + c.mono;
      g.fillStyle = c.inkDim;
      g.fillText('NO SAMPLE', 8 * dpr, h / 2 + 3 * dpr);
      return;
    }
    if (!this._peaks || this._peaks.w !== w) this._peaks = this._scanPeaks(ch, w);
    const mid = h / 2;
    const amp = mid - 2 * dpr;
    g.fillStyle = c.line;
    g.fillRect(0, Math.round(mid), w, 1);
    g.fillStyle = c.wave;
    for (let x = 0; x < w; x++) {
      const hi = Math.min(1, this._peaks.maxs[x]);
      const lo = Math.max(-1, this._peaks.mins[x]);
      const y0 = mid - hi * amp;
      g.fillRect(x, y0, 1, Math.max(1, (mid - lo * amp) - y0));
    }
    const v = this._voice();
    const xs = Math.round(v.start * w);
    const xe = Math.round(v.end * w);
    g.globalAlpha = 0.6;                              // dim outside the trimmed span
    g.fillStyle = c.bg;
    if (xs > 0) g.fillRect(0, 0, xs, h);
    if (xe < w) g.fillRect(xe, 0, w - xe, h);
    g.globalAlpha = 1;
    const edge = Math.max(1, Math.round(dpr));
    const hs = Math.round(7 * dpr);
    g.fillStyle = c.yellow;
    g.fillRect(Math.min(xs, w - edge), 0, edge, h);
    g.fillRect(Math.max(0, Math.min(xe, w) - edge), 0, edge, h);
    g.fillRect(Math.max(0, Math.min(xs - (hs >> 1), w - hs)), Math.round(mid - hs / 2), hs, hs);
    g.fillRect(Math.max(0, Math.min(xe - (hs >> 1), w - hs)), Math.round(mid - hs / 2), hs, hs);
  }

  _colors() {
    const fb = {
      bg: '#070604', line: '#262418', wave: '#D9B830', yellow: '#FFD400',
      inkDim: '#94906F', mono: '"IBM Plex Mono", ui-monospace, monospace',
    };
    if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fb;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, f) => (cs.getPropertyValue(name) || '').trim() || f;
    return {
      bg: v('--yj-well', fb.bg),
      line: v('--yj-line', fb.line),
      wave: v('--yj-wave', fb.wave),
      yellow: v('--yj-yellow', fb.yellow),
      inkDim: v('--yj-ink-dim', fb.inkDim),
      mono: v('--f-mono', fb.mono),
    };
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
