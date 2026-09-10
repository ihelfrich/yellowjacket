// RTTY: ITA2 / Baudot over 2-FSK, framed asynchronously.
//
// The material this serves is ordinary shortwave traffic — weather bulletins,
// press, utility nets, numbers-station groups — sent in the clear at 45.45
// baud with a 170 Hz shift. Decoding it is reading a broadcast, not breaking
// one; ITA2 is a character set, not a cipher.
//
// POLARITY, which is the one thing that silently inverts an entire decode:
//   * On the air, MARK is conventionally the HIGHER radio frequency.
//   * The standard audio AFSK pairs put mark on the LOWER audio tone:
//     2125 mark / 2295 space, and 1275 mark / 1445 space.
//   * Upper-sideband reception maps higher-RF to higher-audio, which inverts
//     the sense a second time, so a USB receiver hearing an ordinary RTTY
//     signal often needs the reverse setting.
// Because the two inversions can cancel, no rule decides this from first
// principles at the far end of an unknown receiving chain. So the polarity is
// a setting, 'auto' measures it from the framing, and every result says which
// convention it assumed.

import { toneTrace, estimateTones, transitions, estimateBaud, armSeparation } from './fsk.js';

export const BAUD = 45.45;
export const SHIFT_HZ = 170;
/** The two standard AFSK pairs, mark first. Mark is the lower audio tone in
 *  both, which is the pairing every commercial modem shipped with. */
export const AFSK_PAIRS = Object.freeze({
  high: Object.freeze({ mark: 2125, space: 2295 }),
  low: Object.freeze({ mark: 1275, space: 1445 }),
});

// --- how much evidence is enough ------------------------------------------
//
// Each threshold is a false-accept rate under an explicit null, not a taste.
// Measured over 40 independent eight-second regions of white noise through a
// 2125/2295 bank at 45.45 baud, and against the same message at falling SNR;
// the table is in test/cases-sigint-fsk.mjs, which fails if these stop
// separating. The gate costs nothing above -12 dB in 4 kHz on that material.
/** Joint false-accept rate the three tests must beat together, by Fisher.
 *  Measured: 200 independent eight-second regions of white noise through a
 *  2125/2295 bank produced 0 accepts, the best of them reaching e^-9.4. */
const MAX_JOINT_LOG_P = Math.log(1e-9);
/** ...and no single test may point the other way while the others carry it.
 *  This is what stops a steady carrier — which separates its arms perfectly,
 *  z = 32, and frames nothing — from being combined into a decode. */
const MAX_SINGLE_LOG_P = Math.log(0.05);

const LTRS_CODE = 31;
const FIGS_CODE = 27;
const SPACE_CODE = 4;

// Index is the 5-bit code with the first-transmitted bit as the LSB, which is
// the numbering every Baudot table uses: A = 3 = 11000 sent left to right.
const LETTERS = [
  '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U',
  '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K',
  'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q',
  'O', 'B', 'G', '', 'M', 'X', 'V', '',
];

// ITA2 as standardised: positions 13 and 20 are reserved for national use and
// are blank here rather than guessed, 9 is WRU (enquiry) and 11 is the bell.
const FIGURES_ITA2 = [
  '\0', '3', '\n', '-', ' ', '\'', '8', '7',
  '\r', '', '4', '', ',', '', ':', '(',
  '5', '+', ')', '2', '', '6', '0', '1',
  '9', '?', '&', '', '.', '/', '=', '',
];

// USTTY: the American variant, which fills the national slots and moves the
// bell. The digits are identical in both, which is why a numbers transmission
// decodes the same either way and a press bulletin does not.
const FIGURES_US = FIGURES_ITA2.slice();
FIGURES_US[5] = '';        // S = BELL
FIGURES_US[9] = '$';
FIGURES_US[11] = '\'';
FIGURES_US[13] = '!';
FIGURES_US[17] = '"';
FIGURES_US[20] = '#';
FIGURES_US[30] = ';';

export const FIGURE_VARIANTS = Object.freeze({ ita2: FIGURES_ITA2, us: FIGURES_US });

function figuresFor(variant) {
  const t = FIGURE_VARIANTS[variant];
  if (!t) throw new Error(`unknown figures variant '${variant}' (ita2 or us)`);
  return t;
}

/**
 * Asynchronous framing over a soft mark/space trace.
 *
 * The frame is 1 start bit (space), 5 data bits first-bit-first, then 1.5 stop
 * bits (mark) — 7.5 bit times, which is why this cannot be done by taking the
 * bit stream modulo a fixed frame length. Each character is hunted from its own
 * falling edge instead, and the stop bit is the check that the edge was real.
 */
function frameStream(soft, stepsPerBit, timeOfStep, { minStopMargin = 0 }) {
  const at = (idx) => {
    if (idx <= 0) return soft[0];
    if (idx >= soft.length - 1) return soft[soft.length - 1];
    const i = Math.floor(idx), f = idx - i;
    return soft[i] * (1 - f) + soft[i + 1] * f;
  };
  const S = stepsPerBit;
  const chars = [];
  let tried = 0, failed = 0, startPassed = 0;
  let s = 1;
  const last = soft.length - 1;
  while (s < last) {
    if (!(soft[s - 1] > 0 && soft[s] <= 0)) { s++; continue; }
    const d = soft[s - 1] - soft[s];
    const e = (s - 1) + (d !== 0 ? soft[s - 1] / d : 0.5);
    if (e + 7.0 * S > last) break;
    tried++;
    if (at(e + 0.5 * S) >= 0) { failed++; s++; continue; }   // start bit was not a space
    // Every edge that gets this far is a candidate frame. Counting them is what
    // makes the stop-bit check a test with a known null: see `stopBitPValue`.
    startPassed++;
    const stop = at(e + 6.5 * S);
    if (stop <= minStopMargin) { failed++; s++; continue; }  // stop bit was not a mark
    let code = 0, worst = 1;
    for (let k = 0; k < 5; k++) {
      const v = at(e + (1.5 + k) * S);
      if (v > 0) code |= (1 << k);
      const m = Math.abs(v);
      if (m < worst) worst = m;
    }
    chars.push({
      code,
      at: timeOfStep(e),
      margin: worst,
      stopMargin: stop,
      lateStop: at(e + 7.0 * S),
    });
    s = Math.ceil(e + 6.0 * S);
  }
  return { chars, tried, failed, startPassed };
}

function render(codes, { variant, unshiftOnSpace }) {
  const figures = figuresFor(variant);
  let shift = 'letters';
  const out = [];
  let printable = 0, controls = 0, shifts = 0;
  for (const c of codes) {
    if (c.code === LTRS_CODE) { shift = 'letters'; shifts++; out.push({ ...c, shift, char: '', kind: 'LTRS' }); continue; }
    if (c.code === FIGS_CODE) { shift = 'figures'; shifts++; out.push({ ...c, shift, char: '', kind: 'FIGS' }); continue; }
    const ch = shift === 'letters' ? LETTERS[c.code] : figures[c.code];
    if (c.code === SPACE_CODE && unshiftOnSpace) shift = 'letters';
    const kind = ch === '' || ch === '\0' ? 'unassigned' : (ch === '\n' || ch === '\r' ? 'control' : 'print');
    if (kind === 'print') printable++;
    else controls++;
    out.push({ ...c, shift, char: ch === '\0' ? '' : ch, kind });
  }
  let text = out.map((c) => c.char).join('');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { chars: out, text, printable, controls, shifts };
}

/**
 * Do the characters lie on the frame grid?
 *
 * A continuous RTTY transmission emits one character every 7.5 bit times, idle
 * included, because the idle is itself LTRS characters. So the start instants
 * concentrate at the frame rate. A decode of the WRONG polarity frames off
 * whatever falling edges happen to pass the stop test, and those instants are
 * spread across the frame. This is the discriminator that works, because the
 * character-set ones do not: 30 of the 32 ITA2 codes are assigned, so garbage
 * decodes to assigned characters just as often as text does.
 */
function frameGridness(chars, baud) {
  if (chars.length < 4) return 0;
  const f = baud / 7.5;
  let cr = 0, ci = 0;
  for (const c of chars) {
    const a = 2 * Math.PI * f * c.at;
    cr += Math.cos(a); ci += Math.sin(a);
  }
  return Math.hypot(cr, ci) / chars.length;
}

// --- p-values, kept in logs -----------------------------------------------
//
// Everything below works in natural logs. The evidence a long clean region
// produces is around e^-300, which is not representable as a number, and
// combining tests means adding logs anyway.

/**
 * log of the probability of `k` or more successes in `n` fair coin tosses.
 * Exact, summed with the largest term factored out.
 */
function binomialUpperLogP(k, n) {
  if (n <= 0 || k <= 0) return 0;
  if (k > n) return -Infinity;
  const terms = [];
  let logC = 0;
  for (let j = 0; j < k; j++) logC += Math.log((n - j) / (j + 1));
  const ln2 = Math.log(2);
  for (let j = k; j <= n; j++) {
    terms.push(logC - n * ln2);
    logC += Math.log((n - j) / (j + 1));
  }
  let max = -Infinity;
  for (const t of terms) if (t > max) max = t;
  let sum = 0;
  for (const t of terms) sum += Math.exp(t - max);
  return Math.min(0, max + Math.log(sum));
}

/**
 * Fisher's combination of three independent tests.
 *
 * -2 * sum(ln p) is chi-squared on 2k degrees of freedom under the null, and
 * for even degrees of freedom the upper tail is a closed form:
 *   Q(x; 2k) = exp(-x/2) * sum_{j<k} (x/2)^j / j!
 * Returned as a log, because the whole point is that it goes very small.
 *
 * Combining is what makes the gate work on a five-character transmission. The
 * stop-bit test on n frames cannot produce evidence stronger than 2^-n however
 * clean the signal is, so demanding a fixed p from it demands the impossible of
 * a short region and refuses '90210' off a noiseless recording. What a short
 * region does have is enormous arm separation, and Fisher lets that carry the
 * decision — while the conjunction rule below still stops one loud test from
 * outvoting two that actively disagree.
 */
function fisherLogP(logs) {
  // A -Infinity from any one test would take the sum to Infinity and the
  // series below to NaN. No test here can produce one, but a floor at the
  // smallest double keeps that true if one ever changes.
  const x = -2 * logs.reduce((a, b) => a + Math.max(b, Math.log(Number.MIN_VALUE)), 0);
  const k = logs.length;                 // 2k degrees of freedom
  const h = x / 2;
  let term = 1, sum = 1;
  for (let j = 1; j < k; j++) { term *= h / j; sum += term; }
  return -h + Math.log(sum);
}

/**
 * THE STOP-BIT TEST, and the reason it is worth more than any check on the
 * decoded text.
 *
 * Once an edge has passed the start-bit check, the stop bit is sampled 6.5 bit
 * times later. That is more than six symbol widths away from the edge, and the
 * Goertzel window is one symbol wide, so under noise the stop sample shares no
 * samples with anything the edge decision used and is independent of it. The
 * two arms are exchangeable under noise, so the stop sample is positive with
 * probability exactly one half.
 *
 * The null is therefore a fair coin, with no parameter to tune and nothing
 * estimated from the data. A real transmission puts a mark there every time.
 * Measured over 40 eight-second regions of white noise through a 2125/2295 bank
 * the observed rate is 0.500 (see the test file); on clean traffic it is 1.000.
 */
function stopBitPValue(framed) {
  const n = framed.startPassed;
  const k = framed.chars.length;
  const logP = binomialUpperLogP(k, n);
  return {
    stopTrials: n, stopPassed: k, stopRate: n ? k / n : 0,
    stopLogP: logP, stopP: Math.exp(logP),
  };
}

/** log-probability that `n` characters scattered uniformly around the frame
 *  cycle would concentrate as hard as R by chance. Rayleigh: n*R^2 is
 *  exponential, so the tail is exactly exp(-n*R^2). */
function rayleighLogP(n, r) {
  return Math.min(0, -n * r * r);
}

/** How much this looks like a transmission rather than a decode of the wrong
 *  polarity or the wrong rate: characters on the frame grid, characters that
 *  landed on an assigned code, less the shift churn a garbage stream produces
 *  because LTRS and FIGS are 11111 and 11011. Zero to two. */
function textScore(rendered, frames, gridness) {
  if (!frames) return 0;
  const assigned = rendered.printable + rendered.controls;
  const churn = rendered.shifts / frames;
  return gridness + (assigned / frames) - Math.max(0, churn - 0.12) * 2;
}

function runOne(x, sampleRate, markHz, spaceHz, opts) {
  const {
    baud, oversample, start, length, variant, unshiftOnSpace, agc, minStopMargin,
  } = opts;
  const trace = toneTrace(x, sampleRate, {
    tones: [markHz, spaceHz], baud, oversample, start, length, agc,
  });
  if (!trace.steps) return null;
  const soft = new Float32Array(trace.steps);
  for (let s = 0; s < trace.steps; s++) soft[s] = trace.norm[s * 2] - trace.norm[s * 2 + 1];
  const stepsPerBit = trace.win / trace.step;
  const framed = frameStream(soft, stepsPerBit, (idx) => trace.timeAt(idx), { minStopMargin });
  const rendered = render(framed.chars, { variant, unshiftOnSpace });
  const gridness = frameGridness(framed.chars, baud);
  const stop = stopBitPValue(framed);
  const separation = armSeparation(trace);
  const gridLogP = rayleighLogP(framed.chars.length, gridness);
  const seconds = (trace.steps * trace.step + trace.win) / sampleRate;
  // Characters framed against the most this baud could carry. A raw count
  // rewards guessing a rate that is too high, because twice the baud offers
  // twice as many places for a spurious frame to start; occupancy does not.
  const occupancy = framed.chars.length / Math.max(1e-6, seconds * baud / 7.5);
  return {
    trace, soft, framed, rendered,
    markHz, spaceHz, seconds,
    frames: framed.chars.length,
    framesTried: framed.tried,
    frameSuccess: framed.tried ? framed.chars.length / framed.tried : 0,
    gridness, occupancy,
    separation, gridLogP, gridP: Math.exp(gridLogP), ...stop,
    score: textScore(rendered, framed.chars.length, gridness),
  };
}

/**
 * Decode RTTY from an audio region.
 *
 * `tones` may be omitted, in which case the two strongest steady tones in the
 * region are found and the shift they imply is checked against `shiftHz`.
 * `polarity` is 'auto' (decode both ways and keep the one that frames), or
 * 'normal' (mark on the LOWER audio tone, the standard AFSK pairing) or
 * 'reverse' (mark on the higher audio tone, which is what a USB receiver
 * usually needs).
 *
 * `unshiftOnSpace` is a RECEIVING convention, not part of ITA2: it returns the
 * shift state to letters after every space, which repairs a missed LTRS in
 * plain-language traffic and corrupts any transmission that legitimately sends
 * space-separated digit groups. Off by default for that second reason.
 */
export function decodeRtty(x, sampleRate, {
  tones = null, markHz = null, spaceHz = null,
  baud = BAUD, shiftHz = SHIFT_HZ, polarity = 'auto',
  variant = 'ita2', unshiftOnSpace = false,
  oversample = 16, start = 0, length = 0, agc = true, minStopMargin = 0,
  estimateBaudFromSignal = false,
  maxJointLogP = MAX_JOINT_LOG_P, maxSingleLogP = MAX_SINGLE_LOG_P,
  requireSignal = true,
} = {}) {
  const warnings = [];
  let low = null, high = null, toneEstimate = null;

  if (markHz != null && spaceHz != null) {
    low = Math.min(markHz, spaceHz); high = Math.max(markHz, spaceHz);
    polarity = markHz < spaceHz ? 'normal' : 'reverse';
  } else if (tones && tones.length >= 2) {
    low = Math.min(tones[0], tones[1]); high = Math.max(tones[0], tones[1]);
  } else {
    const region = x.subarray ? x.subarray(start, length ? start + length : x.length) : x;
    toneEstimate = estimateTones(region, sampleRate);
    warnings.push(...toneEstimate.warnings);
    if (!toneEstimate.ok || toneEstimate.tones.length < 2) {
      return { ok: false, text: '', reason: toneEstimate.reason || 'could not find two tones', toneEstimate, warnings };
    }
    // Two strongest, by histogram weight, then ordered by frequency.
    const byWeight = toneEstimate.tones
      .map((hz, i) => ({ hz, w: toneEstimate.weights[i] }))
      .sort((a, b) => b.w - a.w).slice(0, 2)
      .map((t) => t.hz).sort((a, b) => a - b);
    low = byWeight[0]; high = byWeight[1];
    if (toneEstimate.tones.length > 2) {
      warnings.push(`${toneEstimate.tones.length} steady tones found; the two strongest (${low.toFixed(1)} / ${high.toFixed(1)} Hz) were taken as the RTTY pair`);
    }
  }

  const measuredShift = high - low;
  if (shiftHz && Math.abs(measuredShift - shiftHz) > Math.max(15, shiftHz * 0.12)) {
    warnings.push(`measured shift ${measuredShift.toFixed(1)} Hz is not the ${shiftHz} Hz expected; the tone pair may be wrong`);
  }

  let rate = baud, baudEstimate = null;
  let candidates = [baud];
  if (estimateBaudFromSignal) {
    const probe = toneTrace(x, sampleRate, { tones: [low, high], baud, oversample: 16, start, length, agc });
    if (probe.steps) {
      baudEstimate = estimateBaud(transitions(probe), { minBaud: 20, maxBaud: 300 });
      if (baudEstimate.ok) {
        // A 7.5-bit frame puts every other character's transitions on a
        // half-bit offset, so the transition grid this measures runs at TWICE
        // the baud and concentrates harder there than at the baud itself. The
        // grid alone cannot tell the two apart; the framing can, so every
        // submultiple is decoded and the one that frames characters wins.
        const seen = [];
        for (const f of [baudEstimate.baud, ...baudEstimate.submultiples.map((m) => m.baud)]) {
          if (f < 20 || f > 200) continue;
          if (seen.some((g) => Math.abs(g - f) / f < 0.01)) continue;
          seen.push(f);
        }
        if (seen.length) candidates = seen;
      } else {
        warnings.push(`symbol rate not measurable (${baudEstimate.reason}); kept ${baud} baud`);
      }
    }
  }

  const figure = (r) => (r ? r.occupancy * (1 + Math.max(0, r.score)) : -1);
  let normal = null, reverse = null;
  for (const f of candidates) {
    const opts = { baud: f, oversample, start, length, variant, unshiftOnSpace, agc, minStopMargin };
    const a = runOne(x, sampleRate, low, high, opts);         // mark = lower tone
    const b = runOne(x, sampleRate, high, low, opts);         // mark = higher tone
    if (!a || !b) continue;
    if (Math.max(figure(a), figure(b)) > Math.max(figure(normal), figure(reverse))) {
      normal = a; reverse = b; rate = f;
    }
  }
  if (!normal || !reverse) {
    return { ok: false, text: '', reason: 'region shorter than four character frames', warnings };
  }
  if (estimateBaudFromSignal && Math.abs(rate - baud) > baud * 0.005) {
    warnings.push(`measured ${rate.toFixed(2)} baud, not the ${baud} assumed`);
  }

  let chosen, chosenName, margin = null;
  if (polarity === 'normal') { chosen = normal; chosenName = 'normal'; }
  else if (polarity === 'reverse') { chosen = reverse; chosenName = 'reverse'; }
  else {
    // Framing decides it: inverting mark and space turns start bits into stop
    // bits, so the wrong sense fails the stop check on most characters.
    const a = figure(normal), b = figure(reverse);
    chosen = a >= b ? normal : reverse;
    chosenName = a >= b ? 'normal' : 'reverse';
    const lo = Math.min(a, b), hi = Math.max(a, b);
    margin = lo > 0 ? hi / lo : (hi > 0 ? Infinity : 1);
    if (margin < 1.25) {
      warnings.push(`polarity is ambiguous: normal framed ${normal.frames} characters (score ${normal.score.toFixed(2)}), reverse framed ${reverse.frames} (score ${reverse.score.toFixed(2)}); ${chosenName} was taken but the text may be inverted`);
    }
  }

  const marks = chosen.markHz, spaces = chosen.spaceHz;
  const convention = `mark = ${marks.toFixed(1)} Hz, space = ${spaces.toFixed(1)} Hz `
    + `(${chosenName}: mark on the ${marks < spaces ? 'lower' : 'higher'} audio tone`
    + `${marks < spaces ? ', the standard AFSK pairing' : ', which is what upper-sideband reception usually gives'})`;

  const rendered = chosen.rendered;
  const margins = rendered.chars.map((c) => c.margin);
  margins.sort((a, b) => a - b);
  const medianMargin = margins.length ? margins[margins.length >> 1] : 0;

  // --- is there a teleprinter here at all? --------------------------------
  //
  // Three tests, none of which looks at the decoded text. Any test on the
  // characters is worthless here: 30 of the 32 ITA2 codes are assigned, so hiss
  // frames into pronounceable uppercase as readily as traffic does. Measured
  // before this gate existed, eight seconds of white noise told markHz = 2125
  // and spaceHz = 2295 returned ok, no warnings, and strings like 'EKDXHR...'
  // on five seeds out of five.
  //
  // The rule is their Fisher combination against a joint bar, AND a floor under
  // each one separately. Combining is what lets a short transmission through:
  // the stop-bit test on n frames cannot beat 2^-n however clean the signal, so
  // a fixed per-test bar refuses a five-character message off a noiseless
  // recording. The per-test floor is what stops the combination being gamed
  // from the other side: a steady carrier separates its arms at z = 32 and
  // frames nothing, and without the floor that one enormous p would carry it.
  const tests = [
    {
      name: 'arm separation',
      logP: chosen.separation.logP,
      says: `mean arm margin ${chosen.separation.separation.toFixed(3)} against the ${chosen.separation.chance.toFixed(3)} that two arms of pure noise give, ${chosen.separation.z.toFixed(1)} standard errors over ${Math.round(chosen.separation.nEff)} independent symbol windows`,
    },
    {
      name: 'stop bit',
      logP: chosen.stopLogP,
      says: `${chosen.stopPassed} of ${chosen.stopTrials} candidate frames carried a mark 6.5 bits after their start edge, a rate of ${chosen.stopRate.toFixed(3)} against the 0.500 a fair coin gives`,
    },
    {
      name: 'frame clock',
      logP: chosen.gridLogP,
      says: `${chosen.frames} character start instants concentrate at R = ${chosen.gridness.toFixed(3)} on the ${(rate / 7.5).toFixed(2)} Hz frame rate`,
    },
  ];
  const jointLogP = fisherLogP(tests.map((t) => t.logP));
  const failed = [];
  for (const t of tests) {
    if (t.logP > maxSingleLogP) failed.push(`the ${t.name} test finds nothing: ${t.says}, which chance alone would beat with probability ${Math.exp(t.logP).toExponential(1)}`);
  }
  if (jointLogP > maxJointLogP) {
    failed.push(`the three tests together reach only p = ${Math.exp(jointLogP).toExponential(1)}, short of the ${Math.exp(maxJointLogP).toExponential(0)} required (${tests.map((t) => `${t.name} ${Math.exp(t.logP).toExponential(1)}`).join(', ')})`);
  }
  const signalPresent = failed.length === 0;
  // Present is not the same as readable. Between about -6 and -12 dB in 4 kHz
  // on synthetic 45.45/170 material the gates all pass — there really is a
  // teleprinter there — while characters are already being dropped and
  // mis-read. Saying so is the difference between a degraded decode and a
  // confident one.
  if (signalPresent && chosen.stopRate < 0.95) {
    warnings.push(`${chosen.stopTrials - chosen.stopPassed} of ${chosen.stopTrials} candidate frames failed their stop bit (${((1 - chosen.stopRate) * 100).toFixed(0)}%); the signal is there but characters are being lost and those that survive may be wrong`);
  }
  if (signalPresent && chosen.gridness < 0.9) {
    warnings.push(`character start instants hold only R = ${chosen.gridness.toFixed(2)} on the frame clock; the framing is slipping and the text is not reliable`);
  }
  const presence = {
    ok: signalPresent,
    separation: chosen.separation.separation,
    separationChance: chosen.separation.chance,
    separationZ: chosen.separation.z,
    independentWindows: chosen.separation.nEff,
    stopTrials: chosen.stopTrials, stopPassed: chosen.stopPassed,
    stopRate: chosen.stopRate, stopP: chosen.stopP, stopLogP: chosen.stopLogP,
    gridness: chosen.gridness, gridP: chosen.gridP, gridLogP: chosen.gridLogP,
    jointLogP, jointP: Math.exp(jointLogP),
    tests: tests.map((t) => ({ name: t.name, logP: t.logP, p: Math.exp(t.logP) })),
    failed,
  };
  const gated = requireSignal && !signalPresent;

  return {
    ok: chosen.frames > 0 && !gated,
    // Empty on a refusal. The characters the framer produced are still in
    // `rejectedText` and `chars` for inspection, but they are not a decode and
    // must not be shown as one.
    text: gated ? '' : rendered.text,
    rejectedText: gated ? rendered.text : null,
    presence,
    chars: rendered.chars,
    frames: chosen.frames,
    framesTried: chosen.framesTried,
    frameSuccess: chosen.frameSuccess,
    polarity: chosenName,
    polarityMargin: margin,
    convention,
    markHz: marks, spaceHz: spaces,
    shiftHz: measuredShift,
    baud: rate,
    variant,
    unshiftOnSpace,
    armSnrDb: chosen.trace.armSnrDb,
    bitMargin: medianMargin,
    printable: rendered.printable,
    shifts: rendered.shifts,
    frameGridness: chosen.gridness,
    frameOccupancy: chosen.occupancy,
    score: chosen.score,
    alternates: { normal: { frames: normal.frames, score: normal.score, text: normal.rendered.text }, reverse: { frames: reverse.frames, score: reverse.score, text: reverse.rendered.text } },
    toneEstimate, baudEstimate,
    warnings,
    reason: chosen.frames === 0
      ? 'no character framed: no start/stop pattern at this baud in this region'
      : gated
        ? `no RTTY signal in this region — ${failed.join('; and ')}`
        : null,
  };
}

/** ITA2 encode, provided so a caller can round-trip a known string through the
 *  same character tables the decoder uses. Returns 5-bit codes with LTRS/FIGS
 *  inserted where the shift has to change. */
export function encodeIta2(text, { variant = 'ita2' } = {}) {
  const figures = figuresFor(variant);
  const letterOf = new Map(), figureOf = new Map();
  for (let i = 0; i < 32; i++) {
    if (i === LTRS_CODE || i === FIGS_CODE) continue;
    if (LETTERS[i] && !letterOf.has(LETTERS[i])) letterOf.set(LETTERS[i], i);
    if (figures[i] && !figureOf.has(figures[i])) figureOf.set(figures[i], i);
  }
  const out = [];
  let shift = 'letters';
  for (const raw of text) {
    const ch = raw === '\n' ? '\n' : raw.toUpperCase();
    const inLetters = letterOf.get(ch), inFigures = figureOf.get(ch);
    if (inLetters != null && (shift === 'letters' || inFigures == null)) {
      if (shift !== 'letters') { out.push(LTRS_CODE); shift = 'letters'; }
      out.push(inLetters);
    } else if (inFigures != null) {
      if (shift !== 'figures') { out.push(FIGS_CODE); shift = 'figures'; }
      out.push(inFigures);
    } else {
      throw new Error(`'${raw}' has no ITA2 code in the ${variant} table`);
    }
  }
  return out;
}
