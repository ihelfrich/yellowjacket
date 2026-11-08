import { spectrumPlan, spectrumCell } from './analysis/precision-spectrum.js';

export class PrecisionInspector {
  constructor(host, overview) {
    this.host = host; this.overview = overview;
    host.innerHTML = `<summary>Precision spectrogram · inspect and measure</summary>
      <p>Analyze a passage of the current SIGNAL mono mix. Repairs affect this signal; keep the original for comparison. Cursors measure spectral bins, not an identified aircraft or location.</p>
      <form class="yj-precision-controls">
        <label>Start (s)<input name="start" type="number" min="0" step="any" value="0" required></label>
        <label>End (s)<input name="end" type="number" min="0" step="any" value="30" required></label>
        <label>Window (samples)<select name="fft"><option>2048</option><option>8192</option><option selected>32768</option><option>65536</option><option>131072</option></select></label>
        <label>Low (Hz)<input name="low" type="number" min="0" step="any" value="20" required></label>
        <label>High (Hz)<input name="high" type="number" min="0" step="any" value="1000" required></label>
        <label>Floor (dBFS)<input name="floor" type="number" min="-300" max="20" value="-100" required></label>
        <label>Ceiling (dBFS)<input name="ceiling" type="number" min="-300" max="20" value="-20" required></label>
        <label>Frequency axis<select name="axis"><option value="linear">Linear</option><option value="log">Logarithmic</option></select></label>
        <button type="button" data-action="selection" class="yj-btn">Use overview selection</button>
        <button type="submit" class="yj-btn yj-btn-primary">Analyze passage</button>
        <button type="button" data-action="cancel" class="yj-btn" disabled>Cancel</button>
      </form>
      <p data-status role="status">Load audio, select a passage, then analyze.</p>
      <canvas class="yj-precision-canvas" aria-label="Precision spectrogram. Set measurement cursors with the numeric controls below."></canvas>
      <form class="yj-precision-controls" data-cursors>
        <label>Cursor<select name="cursor"><option>A</option><option>B</option></select></label>
        <label>Time (s)<input name="time" type="number" step="any" value="0" required></label>
        <label>Frequency (Hz)<input name="hz" type="number" step="any" value="100" required></label>
        <button class="yj-btn" type="submit">Set cursor</button>
        <button class="yj-btn" type="button" data-action="export" disabled>Export measurements CSV</button>
      </form>
      <p data-readout aria-live="polite">Click the plot to place A or B, or enter coordinates above.</p>`;
    this.form = host.querySelector('form'); this.cursorForm = host.querySelector('[data-cursors]');
    this.canvas = host.querySelector('canvas'); this.status = host.querySelector('[data-status]');
    this.readout = host.querySelector('[data-readout]'); this.points = {};
    this.form.onsubmit = e => { e.preventDefault(); this.analyze(); };
    this.form.oninput = e => {
      if (['floor', 'ceiling', 'axis'].includes(e.target.name)) this.draw();
      else { this.clear(); this.status.textContent = 'Settings changed. Analyze passage to apply.'; }
    };
    host.querySelector('[data-action="selection"]').onclick = () => {
      const r = overview.region;
      if (!r) { this.status.textContent = 'Drag a region in the overview first.'; return; }
      this.field('start').value = r.t0; this.field('end').value = r.t1;
      this.field('low').value = r.f0; this.field('high').value = r.f1;
      this.clear(); this.status.textContent = 'Selection copied. Analyze passage to apply.';
    };
    host.querySelector('[data-action="cancel"]').onclick = () => { this.clear(); this.status.textContent = 'Analysis cancelled.'; };
    this.cursorForm.onsubmit = e => { e.preventDefault(); this.mark(Number(this.cursorForm.elements.time.value), Number(this.cursorForm.elements.hz.value)); };
    this.canvas.onclick = e => {
      if (!this.result) return;
      const r = this.canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * this.canvas.width, y = (e.clientY - r.top) / r.height * this.canvas.height;
      const { left, top, width, height } = this.plot();
      if (x < left || x > left + width || y < top || y > top + height) return;
      const d = this.result, t = d.firstTime + (x - left) / width * (d.cols - 1) * d.stepTime;
      this.mark(t, this.hzAt((y - top) / height));
    };
    host.querySelector('[data-action="export"]').onclick = () => this.export();
    this.resize = new ResizeObserver(() => this.draw()); this.resize.observe(host);
    host.addEventListener('toggle', () => this.draw());
  }
  field(name) { return this.form.elements.namedItem(name); }
  clear() {
    this.worker?.terminate(); this.worker = null; this.result = null; this.points = {};
    this.host.querySelector('[data-action="cancel"]').disabled = true;
    this.host.querySelector('[data-action="export"]').disabled = true;
    this.readout.textContent = 'No measurements.'; this.draw();
  }
  setSource(samples, sampleRate) {
    this.clear(); this.samples = samples; this.sampleRate = sampleRate;
    this.field('start').value = 0; this.field('end').value = Math.min(30, samples?.length / sampleRate || 0);
    this.field('high').value = Math.min(1000, sampleRate / 2 || 1000);
    this.field('low').value = Math.min(20, sampleRate / 4 || 20);
    this.status.textContent = samples?.length ? 'Ready. Analyze a passage; longer windows sharpen frequency detail but blur time.' : 'Load audio to inspect.';
  }
  analyze() {
    this.clear();
    try {
      if (!this.samples?.length) throw Error('Load audio first.');
      const sr = this.sampleRate, start = Number(this.field('start').value), end = Number(this.field('end').value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > this.samples.length / sr + 1e-8) throw Error('Time range must lie inside the recording.');
      const i0 = Math.round(start * sr), i1 = Math.min(this.samples.length, Math.round(end * sr));
      if (i1 - i0 > 16_000_000) throw Error('Select a shorter passage (maximum 16 million samples).');
      const options = { fftSize: Number(this.field('fft').value), lowHz: Number(this.field('low').value), highHz: Number(this.field('high').value), offset: i0 / sr };
      spectrumPlan(i1 - i0, sr, options);
      const samples = this.samples.slice(i0, i1);
      const worker = new Worker(new URL('../workers/precision-spectrum-worker.js', import.meta.url), { type: 'module' });
      this.worker = worker; this.status.textContent = 'Analyzing every window in the selected passage…';
      this.host.querySelector('[data-action="cancel"]').disabled = false;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        worker.terminate(); this.worker = null; this.host.querySelector('[data-action="cancel"]').disabled = true;
        if (data.error) { this.status.textContent = data.error; return; }
        this.result = data.result;
        const d = this.result;
        this.status.textContent = `${d.binHz.toFixed(3)} Hz bin spacing · ${d.windowSeconds.toFixed(3)} s Hann window · ${d.stepTime.toFixed(3)} s step · ${d.cols} windows, none skipped. Display retains pixel peaks; cursors read individual bins. Bin spacing is not frequency uncertainty. Levels are coherent-tone amplitudes, not noise power density.`;
        this.draw();
      };
      worker.onerror = () => { if (this.worker === worker) { this.clear(); this.status.textContent = 'Analysis failed. Try a shorter passage.'; } };
      worker.postMessage({ samples, sampleRate: sr, options }, [samples.buffer]);
    } catch (e) { this.status.textContent = e.message; }
  }
  plot() { return { left: 68, top: 16, width: this.canvas.width - 84, height: this.canvas.height - 52 }; }
  hzAt(fraction) {
    const d = this.result, lo = d.firstBin * d.binHz, hi = (d.firstBin + d.bins - 1) * d.binHz;
    return this.field('axis').value === 'log' && lo > 0 ? hi * Math.pow(lo / hi, fraction) : hi + (lo - hi) * fraction;
  }
  mark(time, hz) {
    if (!this.result || !Number.isFinite(time) || !Number.isFinite(hz)) return;
    const d = this.result;
    if (time < d.firstTime || time > d.firstTime + (d.cols - 1) * d.stepTime || hz < d.firstBin * d.binHz || hz > (d.firstBin + d.bins - 1) * d.binHz) {
      this.readout.textContent = 'Cursor must lie within the analyzed window centres and frequency bins.'; return;
    }
    const key = this.cursorForm.elements.cursor.value;
    const p = spectrumCell(d, time, hz); this.points[key] = p;
    this.cursorForm.elements.time.value = p.time.toFixed(6); this.cursorForm.elements.hz.value = p.hz.toFixed(6);
    this.cursorForm.elements.cursor.value = key === 'A' ? 'B' : 'A';
    const { A, B } = this.points;
    this.readout.textContent = Object.entries(this.points).map(([k, v]) => `${k}: ${v.time.toFixed(4)} s, ${v.hz.toFixed(3)} Hz, ${v.db.toFixed(2)} dBFS`).join(' · ') +
      (A && B ? ` · Δt ${(B.time - A.time).toFixed(4)} s · Δf ${(B.hz - A.hz).toFixed(3)} Hz` : '');
    this.host.querySelector('[data-action="export"]').disabled = false; this.draw();
  }
  draw() {
    const canvas = this.canvas; canvas.width = Math.max(320, Math.min(1600, this.host.clientWidth || 800)); canvas.height = 360;
    const g = canvas.getContext('2d'); g.fillStyle = '#121616'; g.fillRect(0, 0, canvas.width, canvas.height);
    const d = this.result; if (!d) return;
    const floor = Number(this.field('floor').value), ceiling = Number(this.field('ceiling').value);
    if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || ceiling <= floor) { g.fillStyle = '#fff'; g.fillText('Ceiling must exceed floor.', 20, 30); return; }
    const { left, top, width, height } = this.plot(), id = g.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const b = Math.max(0, Math.min(d.bins - 1, Math.round(this.hzAt(y / (height - 1)) / d.binHz) - d.firstBin));
      const clampBin = v => Math.max(0, Math.min(d.bins - 1, v));
      const b0 = Math.min(b, clampBin(Math.ceil(this.hzAt(Math.min(1, (y + .5) / (height - 1))) / d.binHz - d.firstBin)));
      const b1 = Math.max(b, clampBin(Math.floor(this.hzAt(Math.max(0, (y - .5) / (height - 1))) / d.binHz - d.firstBin)));
      for (let x = 0; x < width; x++) {
        const c = Math.round(x / (width - 1) * (d.cols - 1));
        const c0 = Math.min(c, Math.max(0, Math.ceil((x - .5) / (width - 1) * (d.cols - 1))));
        const c1 = Math.max(c, Math.min(d.cols - 1, Math.floor((x + .5) / (width - 1) * (d.cols - 1))));
        let peak = -Infinity;
        for (let col = c0; col <= c1; col++) for (let bin = b0; bin <= b1; bin++) peak = Math.max(peak, d.db[col * d.bins + bin]);
        const v = Math.max(0, Math.min(1, (peak - floor) / (ceiling - floor))), i = (y * width + x) * 4;
        id.data[i] = 15 + 240 * v; id.data[i + 1] = 20 + 215 * v; id.data[i + 2] = 22 + 110 * v * v; id.data[i + 3] = 255;
      }
    }
    g.putImageData(id, left, top); g.font = '11px monospace'; g.fillStyle = '#f4f1e3';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      g.textAlign = 'right'; g.fillText(`${this.hzAt(f).toFixed(1)}`, left - 6, top + f * height + 4);
      g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      g.fillText(`${(d.firstTime + f * (d.cols - 1) * d.stepTime).toFixed(2)} s`, left + f * width, top + height + 18);
    }
    g.textAlign = 'left'; g.fillText('Hz', 8, 12);
    for (const [key, p] of Object.entries(this.points)) {
      const hi = this.hzAt(0), lo = this.hzAt(1), log = this.field('axis').value === 'log' && lo > 0;
      const f = hi === lo ? 0.5 : log ? Math.log(hi / p.hz) / Math.log(hi / lo) : (hi - p.hz) / (hi - lo);
      const x = left + (d.cols === 1 ? 0.5 : p.c / (d.cols - 1)) * width, y = top + f * height;
      g.strokeStyle = key === 'A' ? '#00e5ff' : '#ff83e0'; g.beginPath(); g.moveTo(x - 7, y); g.lineTo(x + 7, y); g.moveTo(x, y - 7); g.lineTo(x, y + 7); g.stroke(); g.fillText(key, x + 8, y - 8);
    }
  }
  export() {
    const d = this.result; if (!d) return;
    const rows = ['cursor,time_seconds,frequency_hz,tone_amplitude_dbfs,sample_rate,fft_size,hop_samples,bin_hz,window_seconds'];
    for (const [key, p] of Object.entries(this.points)) rows.push([key, p.time, p.hz, p.db, d.sampleRate, d.fftSize, d.hop, d.binHz, d.windowSeconds].join(','));
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'yellowjacket-spectral-measurements.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
