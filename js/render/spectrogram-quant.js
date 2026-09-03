// The spectrogram matrix is dB quantised to one byte per cell: the 2D painter
// already collapses dB to a 256-entry LUT and the GPU shader does the same in
// WGSL, so a byte is the index both consumers were computing anyway. Float32
// storage was 31 MB for an 8000 × 1024 matrix (E15); bytes are 8 MB on the CPU
// and 8 MB as an r8unorm texture. Bin interpolation now happens on bytes, so a
// pixel can differ from the float path by at most one LUT step (0.35 dB).
export const MAG_LEVELS = 256;

export function dbToByte(db, minDb, maxDb) {
  const span = (maxDb - minDb) || 1;
  let idx = ((db - minDb) * (MAG_LEVELS - 1) / span) | 0;
  if (idx < 0) idx = 0;
  else if (idx > MAG_LEVELS - 1) idx = MAG_LEVELS - 1;
  return idx;
}
