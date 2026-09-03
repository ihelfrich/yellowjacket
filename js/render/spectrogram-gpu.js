// Yellowjacket — WebGPU spectrogram image. The STFT dB matrix uploads once as a
// TRANSPOSED r32float texture (width=bins, height=cols) so the column-major
// source buffer is already row-contiguous for queue.writeTexture; zoom/pan then
// costs one fullscreen-triangle draw with the log-frequency remap, manual
// bilinear, dB normalize, and 256x1 LUT lookup all in the fragment stage.
// Phosphor persistence ping-pongs two rgba16float targets with exp(-dt/500ms)
// decay. Canvas2D (js/spectrogram.js _paintImage) is the reference renderer:
// the sampling conventions here mirror it exactly so the two paths match.

const LUT_W = 256;
const U_FLOATS = 12;               // struct U below: 12 f32, 48 bytes
const DECAY_TAU_MS = 500;

const WGSL = /* wgsl */ `
struct U {
  colStart: f32, colEnd: f32, logFMin: f32, logFMax: f32,
  nyquist: f32, minDb: f32, dbSpanInv: f32, cols: f32,
  bins: f32, layerRows: f32, decay: f32, pad: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var dataTex: texture_2d_array<f32>;
@group(0) @binding(2) var lutTex: texture_2d<f32>;
@group(0) @binding(3) var pingTex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let x = f32((vi << 1u) & 2u);
  let y = f32(vi & 2u);
  o.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  o.uv = vec2<f32>(x, y);
  return o;
}

fn loadDb(col: i32, bin: i32) -> f32 {
  let rows = i32(u.layerRows);
  let layer = col / rows;
  return textureLoad(dataTex, vec2<i32>(bin, col - layer * rows), layer, 0).r;
}

fn specColor(uv: vec2<f32>) -> vec4<f32> {
  // log-frequency remap: uv.y=0 is Nyquist, uv.y=1 is fMin, as the 2D image rows
  let f = exp(mix(u.logFMax, u.logFMin, uv.y));
  let bf = clamp(f * u.bins / u.nyquist, 0.0, u.bins - 1.0);
  let b0 = i32(bf);
  let b1 = min(b0 + 1, i32(u.bins) - 1);
  let fb = fract(bf);
  // texel-center bilinear over the same source window drawImage samples
  let cf = clamp(u.colStart + uv.x * (u.colEnd - u.colStart) - 0.5, 0.0, u.cols - 1.0);
  let c0 = i32(cf);
  let c1 = min(c0 + 1, i32(u.cols) - 1);
  let fc = fract(cf);
  let db = mix(
    mix(loadDb(c0, b0), loadDb(c0, b1), fb),
    mix(loadDb(c1, b0), loadDb(c1, b1), fb),
    fc
  );
  // db is already normalised 0..1 (r8unorm of the quantised byte)
  let t = clamp(db, 0.0, 1.0);
  return textureLoad(lutTex, vec2<i32>(clamp(i32(t * 255.0 + 0.5), 0, 255), 0), 0);
}

@fragment
fn fs_present(v: VOut) -> @location(0) vec4<f32> {
  return specColor(v.uv);
}

@fragment
fn fs_phosphor(v: VOut) -> @location(0) vec4<f32> {
  let prev = textureLoad(pingTex, vec2<i32>(v.pos.xy), 0);
  return max(specColor(v.uv), prev * u.decay);
}

@fragment
fn fs_blit(v: VOut) -> @location(0) vec4<f32> {
  return textureLoad(pingTex, vec2<i32>(v.pos.xy), 0);
}
`;

// ---------- pure helpers (node-testable; see scratch/test_gpu_math.mjs) ----------

export function chunkLayout(cols, bins, maxDim, maxLayers) {
  // one texture row per STFT column; rows spill into array layers past maxDim
  if (!(cols > 0) || !(bins > 0) || bins > maxDim) return null;
  const layerRows = Math.min(cols, maxDim);
  const layers = Math.ceil(cols / layerRows);
  if (layers > maxLayers) return null;
  return { layerRows, layers };
}

export function viewToColumns(viewStart, viewEnd, duration, cols) {
  // fractional column window; identical to _composite's drawImage source rect
  if (!(duration > 0) || !(cols > 0)) return { colStart: 0, colEnd: 0 };
  return {
    colStart: (viewStart / duration) * cols,
    colEnd: (viewEnd / duration) * cols,
  };
}

export function phosphorDecay(dtMs) {
  return Math.exp(-Math.max(dtMs, 0) / DECAY_TAU_MS);
}

export function packUniforms(out, vp, meta, decay) {
  // slot order mirrors struct U in the WGSL above
  out[0] = vp.colStart;
  out[1] = vp.colEnd;
  out[2] = vp.logFMin;
  out[3] = vp.logFMax;
  out[4] = vp.nyquist;
  out[5] = meta.minDb;
  out[6] = 1 / ((meta.maxDb - meta.minDb) || 1);
  out[7] = meta.cols;
  out[8] = meta.bins;
  out[9] = meta.layerRows;
  out[10] = decay;
  out[11] = 0;
  return out;
}

export function buildLutBytes(stops) {
  // same segment walk as SpectrogramView._buildLut, so both renderers agree
  const s = stops.slice().sort((a, b) => a.t - b.t);
  const out = new Uint8Array(LUT_W * 4);
  let k = 0;
  for (let i = 0; i < LUT_W; i++) {
    const t = i / (LUT_W - 1);
    while (k < s.length - 2 && t > s[k + 1].t) k++;
    const a = s[k];
    const b = s[Math.min(k + 1, s.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const o = i * 4;
    out[o] = Math.round(a.r + (b.r - a.r) * f);
    out[o + 1] = Math.round(a.g + (b.g - a.g) * f);
    out[o + 2] = Math.round(a.b + (b.b - a.b) * f);
    out[o + 3] = 255;
  }
  return out;
}

// ---------- renderer ----------

export class GpuSpectrogram {
  static async create(canvas) {
    let device = null;
    try {
      if (!canvas || typeof navigator === 'undefined' || !navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      if (!device) return null;
      const context = canvas.getContext('webgpu');
      if (!context) {
        device.destroy();
        return null;
      }
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      const gpu = new GpuSpectrogram(canvas, device, context, format);
      await gpu._init();
      return gpu;
    } catch (e) {
      if (device) {
        try { device.destroy(); } catch (e2) { /* already lost */ }
      }
      return null;
    }
  }

  constructor(canvas, device, context, format) {
    this._canvas = canvas;
    this._device = device;
    this._context = context;
    this._format = format;
    this._maxDim = device.limits.maxTextureDimension2D;
    this._maxLayers = device.limits.maxTextureArrayLayers;
    this._dead = false;
    this._destroyed = false;
    this._lostCb = null;
    this._dirty = true;
    this._hasData = false;
    this._phosphor = false;
    this._phosIdx = 0;
    this._w = 0;
    this._h = 0;
    this._meta = { cols: 0, bins: 0, layerRows: 1, minDb: -90, maxDb: 0 };
    this._vp = { colStart: 0, colEnd: 0, logFMin: 0, logFMax: 1, nyquist: 1 };
    this._uArr = new Float32Array(U_FLOATS);
    this._uBuf = null;
    this._lutTex = null;
    this._lutView = null;
    this._dataTex = null;
    this._dataView = null;
    this._phosTex = [null, null];
    this._phosView = [null, null];
    this._bgData = null;
    this._bgPhos = [null, null];
    this._bgBlit = [null, null];
    this._pPresent = null;
    this._pPhosphor = null;
    this._pBlit = null;

    device.lost.then((info) => {
      const wasDead = this._dead;
      this._dead = true;
      if (!wasDead && info && info.reason !== 'destroyed' && this._lostCb) this._lostCb(info);
    }).catch(() => {});
  }

  async _init() {
    const device = this._device;
    const module = device.createShaderModule({ code: WGSL });
    const F = GPUShaderStage.FRAGMENT;
    const dataEntries = [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } },
      // r32float has no filterable guarantee without float32-filterable, and we
      // only textureLoad, so every texture binds as unfilterable-float
      { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 2, visibility: F, texture: { sampleType: 'unfilterable-float' } },
    ];
    const pingEntry = { binding: 3, visibility: F, texture: { sampleType: 'unfilterable-float' } };
    this._bglData = device.createBindGroupLayout({ entries: dataEntries });
    this._bglPhos = device.createBindGroupLayout({ entries: [...dataEntries, pingEntry] });
    this._bglBlit = device.createBindGroupLayout({ entries: [pingEntry] });
    const vertex = { module, entryPoint: 'vs_main' };
    const primitive = { topology: 'triangle-list' };
    const pipe = (bgl, entryPoint, format) => device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex,
      primitive,
      fragment: { module, entryPoint, targets: [{ format }] },
    });
    [this._pPresent, this._pPhosphor, this._pBlit] = await Promise.all([
      pipe(this._bglData, 'fs_present', this._format),
      pipe(this._bglPhos, 'fs_phosphor', 'rgba16float'),
      pipe(this._bglBlit, 'fs_blit', this._format),
    ]);
    this._uBuf = device.createBuffer({
      size: U_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._lutTex = device.createTexture({
      size: [LUT_W, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._lutView = this._lutTex.createView();
  }

  setData(mags, cols, bins, minDb, maxDb) {
    if (this._dead) return false;
    if (!mags || !(cols > 0) || !(bins > 0)) {
      this._hasData = false;
      this._dirty = true;
      if (this._dataTex) { this._dataTex.destroy(); this._dataTex = null; }
      return true;
    }
    const layout = chunkLayout(cols, bins, this._maxDim, this._maxLayers);
    if (!layout || mags.length < cols * bins) return false;
    try {
      // r8unorm: the matrix arrives as bytes (LUT indices); the shader reads
      // them back as 0..1 and indexes the LUT directly.
      const tex = this._device.createTexture({
        size: [bins, layout.layerRows, layout.layers],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      for (let l = 0; l < layout.layers; l++) {
        const row0 = l * layout.layerRows;
        const rows = Math.min(layout.layerRows, cols - row0);
        this._device.queue.writeTexture(
          { texture: tex, origin: { x: 0, y: 0, z: l } },
          mags,
          { offset: row0 * bins, bytesPerRow: bins, rowsPerImage: rows },
          { width: bins, height: rows, depthOrArrayLayers: 1 }
        );
      }
      if (this._dataTex) this._dataTex.destroy();
      this._dataTex = tex;
      this._dataView = tex.createView({ dimension: '2d-array' });
    } catch (e) {
      return false;
    }
    this._meta = { cols, bins, layerRows: layout.layerRows, minDb, maxDb };
    this._hasData = true;
    this._rebuildBindGroups();
    this._dirty = true;
    return true;
  }

  setViewport(colStart, colEnd, logFMin, logFMax, nyquist) {
    if (this._dead) return;
    const vp = this._vp;
    if (vp.colStart === colStart && vp.colEnd === colEnd && vp.logFMin === logFMin
        && vp.logFMax === logFMax && vp.nyquist === nyquist) return;
    vp.colStart = colStart;
    vp.colEnd = colEnd;
    vp.logFMin = logFMin;
    vp.logFMax = logFMax;
    vp.nyquist = nyquist;
    this._dirty = true;
  }

  setColormap(stops) {
    if (this._dead || !Array.isArray(stops) || !stops.length) return;
    try {
      this._device.queue.writeTexture(
        { texture: this._lutTex },
        buildLutBytes(stops),
        { bytesPerRow: LUT_W * 4 },
        { width: LUT_W, height: 1 }
      );
    } catch (e) {
      return;
    }
    this._dirty = true;
  }

  setPhosphor(on) {
    if (this._dead) return;
    const want = !!on;
    if (want === this._phosphor) return;
    this._phosphor = want;
    if (!want) this._dropPhosphor();     // destroying both targets IS the clear
    this._dirty = true;
  }

  onLost(cb) {
    this._lostCb = typeof cb === 'function' ? cb : null;
  }

  render(dtMs) {
    if (this._dead || !this._pPresent) return;
    const resized = this._syncSize();
    const animating = this._phosphor && this._hasData;
    if (!this._dirty && !resized && !animating) return;   // nothing changed: skip the encode
    const device = this._device;
    try {
      const target = this._context.getCurrentTexture().createView();
      const encoder = device.createCommandEncoder();
      const drawable = !!(this._hasData && this._bgData);
      if (drawable) {
        const dt = isFinite(dtMs) && dtMs > 0 ? dtMs : 16.7;
        packUniforms(this._uArr, this._vp, this._meta, phosphorDecay(dt));
        device.queue.writeBuffer(this._uBuf, 0, this._uArr);
      }
      if (drawable && this._phosphor && this._ensurePhosphor()) {
        const next = 1 - this._phosIdx;
        const decayPass = encoder.beginRenderPass({
          colorAttachments: [{ view: this._phosView[next], loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        decayPass.setPipeline(this._pPhosphor);
        decayPass.setBindGroup(0, this._bgPhos[this._phosIdx]);
        decayPass.draw(3);
        decayPass.end();
        const present = encoder.beginRenderPass({
          colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        present.setPipeline(this._pBlit);
        present.setBindGroup(0, this._bgBlit[next]);
        present.draw(3);
        present.end();
        this._phosIdx = next;
      } else {
        const present = encoder.beginRenderPass({
          colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        if (drawable) {
          present.setPipeline(this._pPresent);
          present.setBindGroup(0, this._bgData);
          present.draw(3);
        }
        present.end();
      }
      device.queue.submit([encoder.finish()]);
      this._dirty = false;
    } catch (e) {
      // a device lost mid-frame throws here; the device.lost promise demotes
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._dead = true;
    this._dropPhosphor();
    if (this._dataTex) {
      this._dataTex.destroy();
      this._dataTex = null;
      this._dataView = null;
    }
    if (this._lutTex) {
      this._lutTex.destroy();
      this._lutTex = null;
      this._lutView = null;
    }
    if (this._uBuf) {
      this._uBuf.destroy();
      this._uBuf = null;
    }
    try { this._context.unconfigure(); } catch (e) { /* context may be gone */ }
    try { this._device.destroy(); } catch (e) { /* device may be gone */ }
  }

  // ---------- internals ----------

  _syncSize() {
    const canvas = this._canvas;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.min(Math.round(rect.width * dpr), this._maxDim));
    const h = Math.max(1, Math.min(Math.round(rect.height * dpr), this._maxDim));
    if (w === this._w && h === this._h) return false;
    this._w = w;
    this._h = h;
    canvas.width = w;
    canvas.height = h;
    this._dropPhosphor();     // targets are canvas-sized; recreated zeroed on demand
    return true;
  }

  _rebuildBindGroups() {
    if (!this._dataView || !this._uBuf) return;
    const device = this._device;
    const base = [
      { binding: 0, resource: { buffer: this._uBuf } },
      { binding: 1, resource: this._dataView },
      { binding: 2, resource: this._lutView },
    ];
    this._bgData = device.createBindGroup({ layout: this._bglData, entries: base });
    if (this._phosView[0]) {
      for (const i of [0, 1]) {
        this._bgPhos[i] = device.createBindGroup({
          layout: this._bglPhos,
          entries: [...base, { binding: 3, resource: this._phosView[i] }],
        });
        this._bgBlit[i] = device.createBindGroup({
          layout: this._bglBlit,
          entries: [{ binding: 3, resource: this._phosView[i] }],
        });
      }
    } else {
      this._bgPhos = [null, null];
      this._bgBlit = [null, null];
    }
  }

  _ensurePhosphor() {
    if (this._phosTex[0]) return true;
    if (!this._w || !this._h || !this._dataView) return false;
    // fresh targets are zero-initialized: enable and post-seek both start black
    for (const i of [0, 1]) {
      this._phosTex[i] = this._device.createTexture({
        size: [this._w, this._h],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._phosView[i] = this._phosTex[i].createView();
    }
    this._phosIdx = 0;
    this._rebuildBindGroups();
    return true;
  }

  _dropPhosphor() {
    for (const i of [0, 1]) {
      if (this._phosTex[i]) this._phosTex[i].destroy();
      this._phosTex[i] = null;
      this._phosView[i] = null;
      this._bgPhos[i] = null;
      this._bgBlit[i] = null;
    }
    this._phosIdx = 0;
  }
}
