# Yellowjacket — build contract, GPU renderer (ships only if acceptance is clean)

The spectrogram image moves to WebGPU where available: instant zoom/pan with no
recompute, and analog-scope phosphor persistence during playback. Canvas2D remains a
first-class renderer (Firefox Linux, pre-26 Safari, blocklisted GPUs), not legacy.
The full researched recipe (texture layout, WGSL, limits, Safari device-lost caveats)
is binding background: docs/research/ has it summarized; follow it.

## DOM contract (integrator provides in index.html)
The spectrogram canvas #specMain sits inside a positioned wrapper #specWrap with a
sibling canvas #specGpu UNDERNEATH it (z-index below, same CSS box). When the GPU
path is active, SpectrogramView paints only overlays (selection, repairs, ruler,
playhead, chip) on #specMain with a transparent background; the image lives on
#specGpu. When inactive, #specGpu stays hidden and today's Canvas2D path is
untouched.

## js/render/spectrogram-gpu.js (fleet agent)
```js
export class GpuSpectrogram {
  static async create(canvas): GpuSpectrogram|null   // null on any failure: no
        // adapter, requestDevice reject, context.configure throw. NEVER throws.
  setData(mags: Float32Array, cols, bins, minDb, maxDb)  // column-major dB array,
        // uploaded as a TRANSPOSED r32float texture (width=bins, height=cols);
        // texture_2d_array chunking when cols exceed maxTextureDimension2D
  setViewport(colStart, colEnd, logFMin, logFMax, nyquist) // uniforms only
  setColormap(stops: [{t, r, g, b}])                  // 256x1 rgba8 LUT
  setPhosphor(on: bool)                               // ping-pong decay pass, rgba16float,
        // decay exp(-dt/0.5s); clear both targets on seek/disable
  render(dtMs)                                        // one encoder: optional phosphor
        // pass + present pass (fullscreen triangle, textureLoad + manual bilinear —
        // do NOT require float32-filterable)
  onLost(cb)                                          // device.lost -> cb, so the view demotes
  destroy()
}
```
WGSL per the recipe: log-frequency remap in the fragment stage, dB normalize,
LUT sample. bgra8unorm swapchain via getPreferredCanvasFormat, render-pass
compositing only (no storage-texture writes). DPR-aware canvas sizing clamped to
device limits. No allocations per frame after init.

## js/spectrogram.js (fleet agent, same one — integrate behind a flag)
On construction, attempt GpuSpectrogram.create(#specGpu) async; on success set
this._gpu, push current data/viewport/colormap (from the SAME single view object
that drives the 2D path and the overlay projection — one source of truth, or zoom
desyncs), reveal #specGpu, and switch _paintImage to a no-op that clears to
transparent. Every setView/compute/setPlayhead keeps updating the GPU uniforms.
Phosphor: enabled while the playhead is moving, disabled (and cleared) when
stopped. On onLost: hide #specGpu, restore the 2D image path, keep working.
If #specGpu is absent in the DOM, never attempt GPU (test pages).

## Acceptance (integrator; GPU commit held back unless all pass)
- Chrome (pane): GPU path activates, image matches 2D rendering (same colormap
  ramp; spot-check pixel colors at 3 coordinates within ~10%), zoom/pan track the
  waveform sync exactly (no drift vs overlay), selection + repairs + playhead draw
  correctly above the GPU image.
- Fallback: with #specGpu removed or create() forced to null, everything renders
  exactly as today.
- Phosphor: visible trailing during playback, cleared on stop/seek; no console
  errors; frame encode skipped when nothing changed.
