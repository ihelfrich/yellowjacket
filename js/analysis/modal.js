// Exponentially damped sinusoid analysis by spectral peaks and heterodyning.

import { FFT, hann, nextPow2 } from '../fft.js';

const ANALYSIS_SECONDS = 0.2;
const ZERO_PAD_FACTOR = 4;
const HETERODYNE_PERIODS = 8;
const MIN_SPECTRAL_SNR_DB = 18;
const MIN_DECAY_R2 = 0.8;
const MIN_PHASE_COHERENCE = 0.8;

function emptyResult(samples) {
  return {
    modes: [],
    residual: samples,
    fitDb: 0,
    fundamentalHz: 0,
  };
}

function finiteOption(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function wrapPhase(phase) {
  let wrapped = (phase + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

function linearFit(times, values, first, last) {
  const count = last - first + 1;
  if (count < 3) return null;

  let sumT = 0;
  let sumY = 0;
  for (let i = first; i <= last; i++) {
    sumT += times[i];
    sumY += values[i];
  }
  const meanT = sumT / count;
  const meanY = sumY / count;

  let covariance = 0;
  let varianceT = 0;
  let varianceY = 0;
  for (let i = first; i <= last; i++) {
    const dt = times[i] - meanT;
    const dy = values[i] - meanY;
    covariance += dt * dy;
    varianceT += dt * dt;
    varianceY += dy * dy;
  }
  if (!(varianceT > 0)) return null;

  const slope = covariance / varianceT;
  const intercept = meanY - slope * meanT;
  const r2 = varianceY > 0 ? covariance * covariance / (varianceT * varianceY) : 0;
  return { slope, intercept, r2 };
}

function candidateFrequencies(samples, sampleRate, minFreqHz, maxFreqHz, floorDb, maxCandidates) {
  const length = Math.min(samples.length, Math.max(16, Math.round(sampleRate * ANALYSIS_SECONDS)));
  if (length < 16 || maxCandidates < 1) return [];

  const fftSize = nextPow2(Math.max(2, length * ZERO_PAD_FACTOR));
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const window = hann(length);
  for (let i = 0; i < length; i++) re[i] = samples[i] * window[i];
  new FFT(fftSize).forward(re, im);

  const firstBin = Math.max(1, Math.ceil(minFreqHz * fftSize / sampleRate));
  const lastBin = Math.min(fftSize / 2 - 2, Math.floor(maxFreqHz * fftSize / sampleRate));
  if (lastBin < firstBin) return [];

  const magnitudes = new Float32Array(lastBin - firstBin + 1);
  let strongest = 0;
  for (let bin = firstBin; bin <= lastBin; bin++) {
    const magnitude = Math.hypot(re[bin], im[bin]);
    magnitudes[bin - firstBin] = magnitude;
    if (magnitude > strongest) strongest = magnitude;
  }
  if (!(strongest > 0)) return [];

  const sortedMagnitudes = Array.from(magnitudes).sort((a, b) => a - b);
  const median = sortedMagnitudes[Math.floor(sortedMagnitudes.length / 2)];
  const relativeThreshold = strongest * Math.pow(10, floorDb / 20);
  const noiseThreshold = median * Math.pow(10, MIN_SPECTRAL_SNR_DB / 20);
  if (strongest < noiseThreshold) return [];

  const peaks = [];
  const threshold = Math.max(relativeThreshold, noiseThreshold);
  for (let bin = firstBin; bin <= lastBin; bin++) {
    const center = Math.hypot(re[bin], im[bin]);
    if (center < threshold) continue;
    const left = Math.hypot(re[bin - 1], im[bin - 1]);
    const right = Math.hypot(re[bin + 1], im[bin + 1]);
    if (center <= left || center < right) continue;

    const logLeft = Math.log(Math.max(left, Number.MIN_VALUE));
    const logCenter = Math.log(Math.max(center, Number.MIN_VALUE));
    const logRight = Math.log(Math.max(right, Number.MIN_VALUE));
    const denominator = logLeft - 2 * logCenter + logRight;
    let offset = denominator !== 0 ? 0.5 * (logLeft - logRight) / denominator : 0;
    if (!Number.isFinite(offset)) offset = 0;
    offset = Math.max(-0.5, Math.min(0.5, offset));
    peaks.push({
      freqHz: (bin + offset) * sampleRate / fftSize,
      magnitude: center,
    });
  }

  peaks.sort((a, b) => b.magnitude - a.magnitude);
  return peaks.slice(0, maxCandidates).map((peak) => peak.freqHz);
}

function heterodyne(samples, sampleRate, freqHz) {
  // Eight-period Hann FIRs suppress longer adjacent modes without smearing short decays.
  let filterLength = Math.round(HETERODYNE_PERIODS * sampleRate / freqHz);
  filterLength = Math.max(8, Math.min(samples.length, filterLength));
  if (filterLength < 8) return null;

  const window = hann(filterLength);
  let windowSum = 0;
  for (let i = 0; i < filterLength; i++) windowSum += window[i];
  if (!(windowSum > 0)) return null;

  const hop = Math.max(1, Math.floor(filterLength / 4));
  const starts = [];
  for (let start = 0; start + filterLength <= samples.length; start += hop) starts.push(start);
  const finalStart = samples.length - filterLength;
  if (starts.length === 0 || starts[starts.length - 1] !== finalStart) starts.push(finalStart);

  const times = new Float64Array(starts.length);
  const real = new Float64Array(starts.length);
  const imag = new Float64Array(starts.length);
  const amplitude = new Float64Array(starts.length);
  const omega = 2 * Math.PI * freqHz / sampleRate;
  const center = (filterLength - 1) / 2;

  for (let frame = 0; frame < starts.length; frame++) {
    const start = starts[frame];
    let sumReal = 0;
    let sumImag = 0;
    for (let i = 0; i < filterLength; i++) {
      const weighted = samples[start + i] * window[i];
      const angle = omega * (start + i);
      sumReal += weighted * Math.cos(angle);
      sumImag -= weighted * Math.sin(angle);
    }
    real[frame] = sumReal / windowSum;
    imag[frame] = sumImag / windowSum;
    amplitude[frame] = 2 * Math.hypot(real[frame], imag[frame]);
    times[frame] = (start + center) / sampleRate;
  }

  return { times, real, imag, amplitude, window, windowSum, center };
}

function fitCandidate(samples, sampleRate, freqHz, minTauSec, floorDb) {
  const envelope = heterodyne(samples, sampleRate, freqHz);
  if (!envelope || envelope.amplitude.length < 4) return null;

  let peakIndex = 0;
  let peak = 0;
  for (let i = 0; i < envelope.amplitude.length; i++) {
    if (envelope.amplitude[i] > peak) {
      peak = envelope.amplitude[i];
      peakIndex = i;
    }
  }
  if (!(peak > 0) || peakIndex > envelope.amplitude.length - 4) return null;

  const floor = peak * Math.pow(10, floorDb / 20);
  let last = envelope.amplitude.length - 1;
  for (let i = peakIndex + 3; i < envelope.amplitude.length; i++) {
    if (envelope.amplitude[i] <= floor) {
      last = i - 1;
      break;
    }
  }
  if (last - peakIndex + 1 < 4) return null;

  const logAmplitude = new Float64Array(envelope.amplitude.length);
  for (let i = peakIndex; i <= last; i++) {
    logAmplitude[i] = Math.log(Math.max(envelope.amplitude[i], Number.MIN_VALUE));
  }
  const fit = linearFit(envelope.times, logAmplitude, peakIndex, last);
  if (!fit || !(fit.slope < 0) || fit.r2 < MIN_DECAY_R2) return null;

  const tauSec = -1 / fit.slope;
  if (!Number.isFinite(tauSec) || tauSec < minTauSec) return null;

  let phaseReal = 0;
  let phaseImag = 0;
  let phaseWeight = 0;
  for (let i = peakIndex; i <= last; i++) {
    phaseReal += envelope.real[i];
    phaseImag += envelope.imag[i];
    phaseWeight += Math.hypot(envelope.real[i], envelope.imag[i]);
  }
  const coherence = phaseWeight > 0 ? Math.hypot(phaseReal, phaseImag) / phaseWeight : 0;
  if (coherence < MIN_PHASE_COHERENCE) return null;

  let decayCorrection = 0;
  for (let i = 0; i < envelope.window.length; i++) {
    const offsetSec = (i - envelope.center) / sampleRate;
    decayCorrection += envelope.window[i] * Math.exp(-offsetSec / tauSec);
  }
  decayCorrection /= envelope.windowSum;
  const amp = Math.exp(fit.intercept) / decayCorrection;
  const phase = wrapPhase(Math.atan2(phaseImag, phaseReal) + Math.PI / 2);
  if (!Number.isFinite(amp) || !(amp > 0) || !Number.isFinite(phase)) return null;

  return { freqHz, tauSec, amp, phase };
}

export function synthModal(modes, sampleRate, seconds) {
  if (!Array.isArray(modes) || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(seconds) || seconds <= 0) return new Float32Array(0);
  const length = Math.round(sampleRate * seconds);
  if (!Number.isSafeInteger(length) || length <= 0) return new Float32Array(0);

  const output = new Float32Array(length);
  for (const mode of modes) {
    if (!mode || !Number.isFinite(mode.freqHz) || !Number.isFinite(mode.tauSec) ||
        !Number.isFinite(mode.amp) || !Number.isFinite(mode.phase) || mode.tauSec <= 0) continue;
    const omega = 2 * Math.PI * mode.freqHz / sampleRate;
    const decay = Math.exp(-1 / (sampleRate * mode.tauSec));
    let gain = mode.amp;
    for (let i = 0; i < length; i++) {
      output[i] += gain * Math.sin(omega * i + mode.phase);
      gain *= decay;
    }
  }
  return output;
}

export function fitModal(samples, sampleRate, opts = {}) {
  const length = samples && Number.isSafeInteger(samples.length) ? samples.length : 0;
  const input = new Float32Array(length);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;
    input[i] = value;
    sum += value;
    peak = Math.max(peak, Math.abs(value));
  }
  if (length < 16 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !(peak > 0)) {
    return emptyResult(input);
  }

  const maxModes = Math.max(0, Math.floor(finiteOption(opts.maxModes, 12)));
  let minFreqHz = Math.max(0, finiteOption(opts.minFreqHz, 30));
  let maxFreqHz = Math.min(sampleRate / 2, finiteOption(opts.maxFreqHz, 12000));
  const minTauSec = Math.max(0, finiteOption(opts.minTauSec, 0.005));
  const floorDb = Math.min(0, finiteOption(opts.floorDb, -60));
  if (maxModes === 0 || maxFreqHz <= minFreqHz) return emptyResult(input);

  const mean = sum / length;
  const centered = new Float32Array(length);
  let acEnergy = 0;
  for (let i = 0; i < length; i++) {
    centered[i] = input[i] - mean;
    acEnergy += centered[i] * centered[i];
  }
  if (!(acEnergy > peak * peak * 1e-12)) return emptyResult(input);

  minFreqHz = Math.max(minFreqHz, sampleRate / length);
  maxFreqHz = Math.min(maxFreqHz, sampleRate / 2 - sampleRate / nextPow2(length * ZERO_PAD_FACTOR));
  if (maxFreqHz <= minFreqHz) return emptyResult(input);

  const candidateLimit = Math.max(24, maxModes * 8);
  const frequencies = candidateFrequencies(
    centered,
    sampleRate,
    minFreqHz,
    maxFreqHz,
    floorDb,
    candidateLimit,
  );
  const fitted = [];
  for (const freqHz of frequencies) {
    const mode = fitCandidate(centered, sampleRate, freqHz, minTauSec, floorDb);
    if (mode) fitted.push(mode);
  }

  // Integral energy is proportional to amp^2 * tau for an isolated damped sinusoid.
  for (const mode of fitted) mode.energy = mode.amp * mode.amp * mode.tauSec;
  fitted.sort((a, b) => b.energy - a.energy);
  const selected = fitted.slice(0, maxModes);
  let totalEnergy = 0;
  for (const mode of selected) totalEnergy += mode.energy;
  const modes = selected.map((mode) => ({
    freqHz: mode.freqHz,
    tauSec: mode.tauSec,
    amp: mode.amp,
    phase: mode.phase,
    energyFrac: totalEnergy > 0 ? mode.energy / totalEnergy : 0,
  }));

  const model = synthModal(modes, sampleRate, length / sampleRate);
  const residual = new Float32Array(length);
  let signalEnergy = 0;
  let residualEnergy = 0;
  for (let i = 0; i < length; i++) {
    residual[i] = input[i] - model[i];
    signalEnergy += input[i] * input[i];
    residualEnergy += residual[i] * residual[i];
  }
  const fitDb = signalEnergy > 0 && residualEnergy > 0
    ? 10 * Math.log10(residualEnergy / signalEnergy)
    : 0;

  return {
    modes,
    residual,
    fitDb: Number.isFinite(fitDb) ? fitDb : 0,
    fundamentalHz: modes.length > 0 ? modes[0].freqHz : 0,
  };
}
