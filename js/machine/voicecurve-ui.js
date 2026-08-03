// Voice curves: the shape of a voice, drawn. Eleven sliders give you numbers
// without a model of what they do; two small plots give you the model. The
// left plot is the amplitude envelope over the trimmed slice (attack ramp,
// body, release fall) with the trim window shown as the span it actually
// occupies. The right plot is the filter's magnitude response, log frequency,
// so a resonant lowpass looks like the bump it is.
//
// Read-only by design: the sliders remain the way values change, and these
// react. Adding drag targets here would mean two sources of truth for the
// same number.

const W = 2;   // device-pixel scale ceiling; canvases are small and cheap

function css(el, name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(el).getPropertyValue(name);
  return v && v.trim() ? v.trim() : fallback;
}

// Biquad magnitude response at one frequency, evaluated on the unit circle.
// RBJ cookbook coefficients; this mirrors what BiquadFilterNode computes so
// the drawing is the filter, not an impression of it.
function biquadMag(type, f0, q, fHz, sampleRate) {
  const w0 = 2 * Math.PI * Math.max(1, f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.max(0.0001, q));
  const cw = Math.cos(w0);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
  } else {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  const w = 2 * Math.PI * fHz / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = a0 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm) || 1e-9;
  return num / den;
}

export class VoiceCurveView {
  constructor(envCanvas, filtCanvas) {
    this.env = envCanvas;
    this.filt = filtCanvas;
    this._voice = null;
    this._sliceSec = 1;
    this._sampleRate = 44100;
  }

  // sliceSec is the trimmed span in seconds AFTER pitch, i.e. what the ear
  // gets, so the envelope plot matches the note you hear rather than the
  // buffer on disk.
  setVoice(voice, sliceSec, sampleRate) {
    this._voice = voice || null;
    this._sliceSec = sliceSec > 0 ? sliceSec : 1;
    this._sampleRate = sampleRate > 0 ? sampleRate : 44100;
    this.render();
  }

  render() {
    this._drawEnvelope();
    this._drawFilter();
  }

  _prep(canvas) {
    if (!canvas || !canvas.getContext) return null;
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const dpr = Math.min(W, (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1);
    // A canvas measured while its pane is hidden reads 0 and would bake a
    // 1px bitmap that gets stretched on reveal; skip instead.
    if (!rect.width || !rect.height) return null;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    return { g, w, h, dpr };
  }

  _drawEnvelope() {
    const p = this._prep(this.env);
    if (!p) return;
    const { g, w, h } = p;
    const v = this._voice;
    const ink = css(this.env, '--yj-ink-dim', '#9a8f6a');
    const line = css(this.env, '--yj-line', '#2a2519');
    const hot = css(this.env, '--yj-yellow', '#FFD400');

    g.strokeStyle = line;
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (!v) {
      g.fillStyle = ink;
      g.font = '10px ui-monospace, monospace';
      g.fillText('NO VOICE', 8, h / 2);
      return;
    }

    // Wall-clock length of the slice as it will actually play.
    const rate = Math.pow(2, (v.pitch || 0) / 12);
    const wallSec = Math.max(0.001, this._sliceSec / rate);
    const attack = Math.min((v.attack || 3) / 1000, wallSec);
    const release = Math.min((v.release || 8) / 1000, wallSec);
    const sustainEnd = Math.max(attack, wallSec - release);

    const x = (t) => (t / wallSec) * (w - 2) + 1;
    const y = (a) => h - 1 - a * (h - 6);

    // Envelope: linear attack, flat body, linear release to zero.
    g.beginPath();
    g.moveTo(x(0), y(0));
    g.lineTo(x(attack), y(1));
    g.lineTo(x(sustainEnd), y(1));
    g.lineTo(x(wallSec), y(0));
    g.strokeStyle = hot;
    g.lineWidth = 1.5;
    g.stroke();

    g.globalAlpha = 0.12;
    g.fillStyle = hot;
    g.fill();
    g.globalAlpha = 1;

    // Readout: the two numbers that shape it, plus the length it lands at.
    g.fillStyle = ink;
    g.font = '9px ui-monospace, monospace';
    g.fillText('A ' + Math.round(attack * 1000) + 'ms', 4, 11);
    g.fillText('R ' + Math.round(release * 1000) + 'ms', 4, 21);
    const lenTxt = wallSec >= 1 ? wallSec.toFixed(2) + 's' : Math.round(wallSec * 1000) + 'ms';
    const tw = g.measureText(lenTxt).width;
    g.fillText(lenTxt, w - tw - 4, 11);
  }

  _drawFilter() {
    const p = this._prep(this.filt);
    if (!p) return;
    const { g, w, h } = p;
    const v = this._voice;
    const ink = css(this.filt, '--yj-ink-dim', '#9a8f6a');
    const line = css(this.filt, '--yj-line', '#2a2519');
    const hot = css(this.filt, '--yj-yellow', '#FFD400');
    const dim = css(this.filt, '--yj-amber-dim', '#C79A00');

    g.strokeStyle = line;
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (!v) return;

    const sr = this._sampleRate;
    const fMin = 20;
    const fMax = Math.min(20000, sr / 2);
    const logMin = Math.log(fMin);
    const logMax = Math.log(fMax);
    const xOf = (f) => ((Math.log(f) - logMin) / (logMax - logMin)) * (w - 2) + 1;
    // +12 dB of headroom so a resonant peak has somewhere to go.
    const dbTop = 12;
    const dbBot = -36;
    const yOf = (db) => (1 - (db - dbBot) / (dbTop - dbBot)) * (h - 2) + 1;

    // Decade gridlines, so the log axis is readable rather than implied.
    g.strokeStyle = line;
    for (const f of [100, 1000, 10000]) {
      if (f <= fMin || f >= fMax) continue;
      g.beginPath();
      g.moveTo(xOf(f), 1);
      g.lineTo(xOf(f), h - 1);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(1, yOf(0));
    g.lineTo(w - 1, yOf(0));
    g.strokeStyle = line;
    g.stroke();

    const lpfOn = (v.lpf || 20000) < 18000;
    const hpfOn = (v.hpf || 20) > 25;
    if (!lpfOn && !hpfOn) {
      g.fillStyle = ink;
      g.font = '9px ui-monospace, monospace';
      g.fillText('FILTERS OFF · FLAT', 5, 12);
      return;
    }

    g.beginPath();
    for (let px = 1; px < w - 1; px++) {
      const f = Math.exp(logMin + ((px - 1) / (w - 3)) * (logMax - logMin));
      let mag = 1;
      if (hpfOn) mag *= biquadMag('highpass', v.hpf, Math.SQRT1_2, f, sr);
      if (lpfOn) mag *= biquadMag('lowpass', v.lpf, v.res || 0.7, f, sr);
      const db = 20 * Math.log10(Math.max(1e-6, mag));
      const y = yOf(Math.max(dbBot, Math.min(dbTop, db)));
      if (px === 1) g.moveTo(px, y);
      else g.lineTo(px, y);
    }
    g.strokeStyle = hot;
    g.lineWidth = 1.5;
    g.stroke();

    // Mark the corners so the numbers and the picture agree.
    g.strokeStyle = dim;
    g.lineWidth = 1;
    for (const [on, f] of [[hpfOn, v.hpf], [lpfOn, v.lpf]]) {
      if (!on) continue;
      g.beginPath();
      g.moveTo(xOf(f), 1);
      g.lineTo(xOf(f), h - 1);
      g.stroke();
    }

    g.fillStyle = ink;
    g.font = '9px ui-monospace, monospace';
    const label = (hpfOn ? 'HP ' + Math.round(v.hpf) + ' ' : '')
      + (lpfOn ? 'LP ' + (v.lpf >= 1000 ? (v.lpf / 1000).toFixed(1) + 'k' : Math.round(v.lpf)) : '')
      + (lpfOn && (v.res || 0.7) > 1.2 ? ' Q' + (v.res || 0.7).toFixed(1) : '');
    g.fillText(label, 5, 12);
  }
}
