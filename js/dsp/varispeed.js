// Varispeed: the found-sound move that makes a 96 kHz recording worth keeping.
//
// Run a recording at a quarter of its clock and everything drops two octaves:
// 24-48 kHz, inaudible and invisible on a 48 kHz file, lands at 6-12 kHz. Done
// honestly this is not DSP at all. Playback is AudioBufferSourceNode.playbackRate,
// and the printed file is the SAME samples under a header that says rate / 4 —
// bit-exact, reversible, nothing resampled, nothing invented. It is exactly the
// pair of files that proved the 96 kHz chain: A and B differed only in one
// header field.
//
// Only 2 and 4. Half and quarter keep the clock on a value every container and
// every AudioBuffer accepts; anything else is a resampler wearing a costume.

export const SPEED_FACTORS = Object.freeze([1, 2, 4]);

// WAV and AudioBuffer both refuse a sample rate below this. 22.05 kHz / 4 is
// 5512 Hz, which is not a file, so a source's slowest legal speed depends on
// its own rate.
export const MIN_CLOCK_HZ = 8000;

/** The speeds a source can be played and printed at, always starting with 1. */
export function speedFactorsFor(rate) {
  const hz = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return SPEED_FACTORS.filter((f) => f === 1 || hz / f >= MIN_CLOCK_HZ);
}

/**
 * The same audio under a slower clock. Returns a buffer-shaped object the WAV
 * encoder accepts: identical channel data, sampleRate divided by `factor`,
 * duration multiplied by it. Nothing is copied — the channel arrays are the
 * originals, because the samples do not change.
 */
export function slowedBuffer(buffer, factor) {
  if (!SPEED_FACTORS.includes(factor) || factor === 1) {
    throw new Error('speed factor must be 2 or 4');
  }
  const rate = buffer && buffer.sampleRate ? buffer.sampleRate : 0;
  const clock = rate / factor;
  if (clock < MIN_CLOCK_HZ) {
    throw new Error('a clock of ' + Math.round(clock) + ' Hz would fall below the '
      + MIN_CLOCK_HZ + ' Hz floor that WAV and AudioBuffer allow');
  }
  const length = buffer.length;
  return {
    sampleRate: clock,
    length,
    numberOfChannels: buffer.numberOfChannels,
    duration: length / clock,
    getChannelData: (c) => buffer.getChannelData(c),
  };
}

// The two conversions the engine needs, named so neither direction can be
// inverted by accident. At factor 4, one real second is a quarter second of
// buffer, and a segment two buffer-seconds ahead starts eight real seconds on.
export function bufferSecondsElapsed(realSeconds, factor) {
  return realSeconds / (factor || 1);
}
export function realSecondsUntil(bufferSeconds, factor) {
  return bufferSeconds * (factor || 1);
}

export function speedLabel(factor) {
  return factor === 4 ? '¼×' : factor === 2 ? '½×' : '1×';
}

// Upper edge of hearing used for the SLOW view. Conservative on purpose: the
// point is to show what is above ANY listener's range, not to argue about the
// last kilohertz.
export const AUDIBLE_HZ = 20000;

/**
 * The band that SLOW brings down into hearing: source content above AUDIBLE_HZ
 * that lands at or below AUDIBLE_HZ once divided by `factor`. Null when the
 * source has nothing above hearing to begin with, or at 1x.
 */
export function slowBand(sampleRate, factor, audibleHz = AUDIBLE_HZ) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0;
  const f = SPEED_FACTORS.includes(factor) ? factor : 1;
  const nyquist = rate / 2;
  if (f === 1 || nyquist <= audibleHz) return null;
  const sourceLo = audibleHz;
  const sourceHi = Math.min(nyquist, audibleHz * f);
  if (sourceHi <= sourceLo) return null;
  return { sourceLo, sourceHi, playedLo: sourceLo / f, playedHi: sourceHi / f };
}
