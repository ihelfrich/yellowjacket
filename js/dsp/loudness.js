import { truePeakLinear } from './truepeak.js';

const LOUDNESS_OFFSET = -0.691;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE_OFFSET = -10;

const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const SHELF_VB_EXPONENT = 0.4996667741545416;
const HIGHPASS_F0 = 38.13547087602444;
const HIGHPASS_Q = 0.5003270373238773;

function validateSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= SHELF_F0 * 2) {
    throw new RangeError('Sample rate is too low for BS.1770 K-weighting');
  }
}

export function kWeightingCoeffs(sampleRate) {
  validateSampleRate(sampleRate);

  // BS.1770-4 Table 1 analog parameters, bilinear transform with f0 pre-warp.
  const shelfK = Math.tan(Math.PI * SHELF_F0 / sampleRate);
  const shelfVh = 10 ** (SHELF_GAIN_DB / 20);
  const shelfVb = shelfVh ** SHELF_VB_EXPONENT;
  const shelfD = 1 + shelfK / SHELF_Q + shelfK * shelfK;
  const b1 = [
    (shelfVh + shelfVb * shelfK / SHELF_Q + shelfK * shelfK) / shelfD,
    2 * (shelfK * shelfK - shelfVh) / shelfD,
    (shelfVh - shelfVb * shelfK / SHELF_Q + shelfK * shelfK) / shelfD
  ];
  const a1 = [
    1,
    2 * (shelfK * shelfK - 1) / shelfD,
    (1 - shelfK / SHELF_Q + shelfK * shelfK) / shelfD
  ];

  const highpassK = Math.tan(Math.PI * HIGHPASS_F0 / sampleRate);
  const highpassD = 1 + highpassK / HIGHPASS_Q + highpassK * highpassK;
  const b2 = [1, -2, 1];
  const a2 = [
    1,
    2 * (highpassK * highpassK - 1) / highpassD,
    (1 - highpassK / HIGHPASS_Q + highpassK * highpassK) / highpassD
  ];

  // At 48 kHz this yields b1=[1.535124860,-2.691696189,1.198392811],
  // a1=[1,-1.690659293,0.732480774], b2=[1,-2,1],
  // a2=[1,-1.990047455,0.990072250], matching BS.1770-4 within 1e-9.
  return { b1, a1, b2, a2 };
}

export function applyBiquad(input, coeffs) {
  const { b, a } = coeffs;
  if (!b || !a || b.length !== 3 || a.length !== 3) {
    throw new TypeError('Biquad coefficients must contain three b and a values');
  }

  const output = new Float32Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const value = b[0] * input[i] + z1;
    z1 = b[1] * input[i] - a[1] * value + z2;
    z2 = b[2] * input[i] - a[2] * value;
    output[i] = value;
  }
  return output;
}

function unpackAudio(buffer) {
  if (buffer && Array.isArray(buffer.channels)) {
    return {
      channels: buffer.channels,
      sampleRate: buffer.sampleRate
    };
  }

  if (buffer && typeof buffer.getChannelData === 'function') {
    const channels = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      channels.push(buffer.getChannelData(channel));
    }
    return { channels, sampleRate: buffer.sampleRate };
  }

  throw new TypeError('Expected an AudioBuffer or {channels, sampleRate}');
}

function channelWeights(channelCount) {
  const weights = new Float64Array(channelCount);
  weights.fill(1);

  if (channelCount === 4) {
    weights[2] = 1.41;
    weights[3] = 1.41;
  } else if (channelCount === 5) {
    weights[3] = 1.41;
    weights[4] = 1.41;
  } else if (channelCount >= 6) {
    weights[3] = 0;
    weights[4] = 1.41;
    weights[5] = 1.41;
  }

  return weights;
}

function energyToLufs(energy) {
  return energy > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(energy) : -Infinity;
}

function maxLoudness(energies) {
  let maximum = -Infinity;
  for (const energy of energies) maximum = Math.max(maximum, energyToLufs(energy));
  return maximum;
}

function integratedLoudness(energies) {
  const absoluteGated = [];
  for (const energy of energies) {
    if (energyToLufs(energy) > ABSOLUTE_GATE) absoluteGated.push(energy);
  }
  if (absoluteGated.length === 0) return -Infinity;

  let absoluteEnergy = 0;
  for (const energy of absoluteGated) absoluteEnergy += energy;
  absoluteEnergy /= absoluteGated.length;

  // BS.1770-4: relative threshold is 10 LU below the absolute-gated mean.
  const relativeGate = energyToLufs(absoluteEnergy) + RELATIVE_GATE_OFFSET;
  const gate = Math.max(ABSOLUTE_GATE, relativeGate);
  let gatedEnergy = 0;
  let gatedCount = 0;
  for (const energy of absoluteGated) {
    if (energyToLufs(energy) > gate) {
      gatedEnergy += energy;
      gatedCount++;
    }
  }

  return gatedCount > 0 ? energyToLufs(gatedEnergy / gatedCount) : -Infinity;
}

// True peak: shared BS.1770-5 Annex 2 estimator (js/dsp/truepeak.js), run in
// padded slabs so progress can be reported without materializing 4x arrays.
function truePeakChunked(channels, length, samplePeak, onProgress, progressStart, progressSpan) {
  const SLAB = 262144;
  const PAD = 16;
  let peak = samplePeak;
  const slabs = Math.max(1, Math.ceil(length / SLAB));
  let done = 0;
  for (const channel of channels) {
    for (let s = 0; s < length; s += SLAB) {
      const a = Math.max(0, s - PAD);
      const b = Math.min(length, s + SLAB + PAD);
      const p = truePeakLinear([channel.subarray(a, b)]);
      if (p > peak) peak = p;
      done++;
      if (onProgress) onProgress(progressStart + progressSpan * done / (slabs * channels.length));
    }
  }
  return peak;
}

export function measureLoudness(buffer, onProgress = null) {
  const { channels, sampleRate } = unpackAudio(buffer);
  validateSampleRate(sampleRate);
  if (channels.length === 0) throw new RangeError('At least one channel is required');

  let length = Infinity;
  for (const channel of channels) {
    if (Object.prototype.toString.call(channel) !== '[object Float32Array]') {
      throw new TypeError('Loudness channels must be Float32Array instances');
    }
    length = Math.min(length, channel.length);
  }

  if (onProgress) onProgress(0);
  const totalSamples = length * channels.length;
  const progressEvery = Math.max(1, Math.round(sampleRate * 0.5));
  let samplePeak = 0;
  let sumSquares = 0;
  let sum = 0;
  let clippedSamples = 0;
  let visited = 0;

  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      const value = channel[i];
      const absolute = Math.abs(value);
      samplePeak = Math.max(samplePeak, absolute);
      sumSquares += value * value;
      sum += value;
      if (absolute >= 0.999) clippedSamples++;

      visited++;
      if (onProgress && visited % progressEvery === 0) {
        onProgress(20 * visited / Math.max(1, totalSamples));
      }
    }
  }

  const coeffs = kWeightingCoeffs(sampleRate);
  const weights = channelWeights(channels.length);
  const subBlockSize = Math.max(1, Math.round(sampleRate * 0.1));
  const subBlockCount = Math.floor(length / subBlockSize);
  const subBlockSums = new Float64Array(subBlockCount);
  visited = 0;

  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    if (weights[channelIndex] === 0) {
      visited += length;
      continue;
    }

    const input = channels[channelIndex];
    const weight = weights[channelIndex];
    const coveredLength = subBlockCount * subBlockSize;
    let subBlock = 0;
    let subBlockEnd = subBlockSize;
    let subBlockEnergy = 0;
    let shelfZ1 = 0;
    let shelfZ2 = 0;
    let highpassZ1 = 0;
    let highpassZ2 = 0;
    for (let i = 0; i < length; i++) {
      const shelf = coeffs.b1[0] * input[i] + shelfZ1;
      shelfZ1 = coeffs.b1[1] * input[i] - coeffs.a1[1] * shelf + shelfZ2;
      shelfZ2 = coeffs.b1[2] * input[i] - coeffs.a1[2] * shelf;

      const filtered = coeffs.b2[0] * shelf + highpassZ1;
      highpassZ1 = coeffs.b2[1] * shelf - coeffs.a2[1] * filtered + highpassZ2;
      highpassZ2 = coeffs.b2[2] * shelf - coeffs.a2[2] * filtered;
      if (i < coveredLength) {
        subBlockEnergy += weight * filtered * filtered;
        if (i + 1 === subBlockEnd) {
          subBlockSums[subBlock] += subBlockEnergy;
          subBlock++;
          subBlockEnd += subBlockSize;
          subBlockEnergy = 0;
        }
      }

      visited++;
      if (onProgress && visited % progressEvery === 0) {
        onProgress(20 + 35 * visited / Math.max(1, totalSamples));
      }
    }
  }

  const momentaryEnergies = new Float64Array(Math.max(0, subBlockCount - 3));
  let momentarySum = 0;
  let shortTermSum = 0;
  let shortTermMaximum = -Infinity;
  for (let block = 0; block < subBlockCount; block++) {
    const energy = subBlockSums[block];
    momentarySum += energy;
    shortTermSum += energy;
    if (block >= 4) momentarySum -= subBlockSums[block - 4];
    if (block >= 30) shortTermSum -= subBlockSums[block - 30];
    if (block >= 3) {
      momentaryEnergies[block - 3] = momentarySum / (subBlockSize * 4);
    }
    if (block >= 29) {
      const loudness = energyToLufs(shortTermSum / (subBlockSize * 30));
      if (loudness > shortTermMaximum) shortTermMaximum = loudness;
    }
  }

  const truePeak = truePeakChunked(channels, length, samplePeak, onProgress, 55, 45);
  const rms = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
  if (onProgress) onProgress(100);

  return {
    integrated: integratedLoudness(momentaryEnergies),
    momentaryMax: maxLoudness(momentaryEnergies),
    shortTermMax: shortTermMaximum,
    samplePeakDb: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity,
    truePeakDb: truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    crestDb: samplePeak > 0 && rms > 0 ? 20 * Math.log10(samplePeak / rms) : -Infinity,
    dcOffset: totalSamples > 0 ? sum / totalSamples : 0,
    clippedSamples,
    clippedPct: totalSamples > 0 ? 100 * clippedSamples / totalSamples : 0
  };
}
