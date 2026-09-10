// The ITU emission designator — an assertion, not a measurement.
//
// A designator such as 249HF1B says four things: that the emission is 249 Hz
// wide, that its carrier is frequency modulated, that it carries one channel of
// digital information with no modulating subcarrier, and that the information
// is telegraphy for automatic reception. Only the first of those is measurable
// from a recording. The other three are a CLASSIFICATION, supplied by whoever
// is reading the waterfall, and the necessary bandwidth is then computed from
// the measurement plus that classification plus a constant or two that nobody
// can measure at all (the fading state of the path; how many dot units the
// operator's words are worth).
//
// So this module refuses to emit a designator when the classification is
// unknown, refuses when an input it needs is null, and returns every assumption
// it made alongside the answer. The bandwidth formulas are ITU-R SM.1138.
//
// Nothing here decodes or intercepts anything. It writes down, in the standard
// notation, what a public broadcast looks like on a spectrum analyser.

/**
 * Necessary bandwidth in the ITU's four-character form: three numerals and one
 * letter, the letter occupying the position of the decimal point (ITU-R
 * SM.1138). H, K, M, G are hertz, kilohertz, megahertz, gigahertz. The first
 * character is never a zero and never the unit letter unless the value is below
 * one hertz.
 *
 * Checked against every worked example in the recommendation: 0.002 Hz -> H002,
 * 0.1 Hz -> H100, 25.3 Hz -> 25H3, 400 Hz -> 400H, 2.4 kHz -> 2K40, 6 kHz ->
 * 6K00, 12.5 kHz -> 12K5, 180.4 kHz -> 180K, 180.5 kHz -> 181K, 1.25 MHz ->
 * 1M25, 2 MHz -> 2M00, 10 MHz -> 10M0, 202 MHz -> 202M, 5.65 GHz -> 5G65.
 */
export function formatBandwidth(hz) {
  const v0 = Number(hz);
  if (!isFinite(v0) || v0 <= 0) return null;
  const units = [['H', 1], ['K', 1e3], ['M', 1e6], ['G', 1e9]];
  for (const [letter, scale] of units) {
    const v = v0 / scale;
    // Rounding is applied before the decade is chosen, so 999.6 Hz becomes
    // 1K00 rather than an impossible "1000H".
    if (v >= 999.5) continue;
    if (letter === 'H' && v < 0.9995) {
      const d = Math.round(v * 1000);
      // The scale bottoms out at one millihertz; below that there is no form.
      return d >= 1 ? letter + String(d).padStart(3, '0') : null;
    }
    if (v < 0.9995) continue;
    if (v < 9.995) {
      const n = Math.round(v * 100);
      return String(Math.floor(n / 100)) + letter + String(n % 100).padStart(2, '0');
    }
    if (v < 99.95) {
      const n = Math.round(v * 10);
      return String(Math.floor(n / 10)) + letter + String(n % 10);
    }
    return String(Math.round(v)) + letter;
  }
  return null;
}

/** First symbol: how the main carrier is modulated. */
export const MODULATION = Object.freeze({
  N: 'unmodulated carrier',
  A: 'double-sideband amplitude modulation',
  H: 'single sideband, full carrier',
  R: 'single sideband, reduced or variable-level carrier',
  J: 'single sideband, suppressed carrier',
  B: 'independent sidebands',
  C: 'vestigial sideband',
  F: 'frequency modulation',
  G: 'phase modulation',
  D: 'amplitude and angle modulation together',
  P: 'a sequence of unmodulated pulses',
});

/** Second symbol: the nature of the signal modulating the main carrier. */
export const SIGNAL = Object.freeze({
  0: 'no modulating signal',
  1: 'one channel of digital information, no modulating subcarrier',
  2: 'one channel of digital information, with a modulating subcarrier',
  3: 'one channel of analogue information',
  7: 'two or more channels of digital information',
  8: 'two or more channels of analogue information',
  9: 'composite',
});

/** Third symbol: the type of information carried. */
export const INFORMATION = Object.freeze({
  N: 'no information transmitted',
  A: 'telegraphy, for aural reception',
  B: 'telegraphy, for automatic reception',
  C: 'facsimile',
  D: 'data, telemetry or telecommand',
  E: 'telephony, including sound broadcasting',
  F: 'video',
  W: 'a combination of the above',
  X: 'not otherwise covered',
});

// K in the on-off-keying formulas is a property of the PATH, not of the
// transmitter, and no recording of the audio can tell you which one applies.
// ITU-R SM.1138 gives 5 for a fading circuit and 3 for a non-fading one. HF
// skywave is a fading circuit, so 5 is the default here, and the assumption is
// returned with the answer so it can be overruled by someone who knows the
// path.
export const K_FADING = 5;
export const K_NON_FADING = 3;
// FSK telegraphy: SM.1138 gives K = 1.2 as the typical value.
export const K_FSK = 1.2;
// FM telephony reduces to Carson's rule, 2(M + D), at K = 1.
export const K_FM = 1;

// Dot units per word. PARIS — the word on which the modern wpm standard is
// built — is 50 units including the trailing word space, so a speed of W words
// per minute is 50W/60 = 0.8333W dots per second. ITU-R SM.1138's own A1A
// example instead reads "B = 20 bauds (25 words per minute)", which is 48 units
// per word. Both conventions are in use and they differ by 4%, which is 4% of
// the bandwidth. The default is PARIS; pass `unitsPerWord: 48` to reproduce the
// recommendation's arithmetic exactly.
export const UNITS_PER_WORD_PARIS = 50;

/**
 * The necessary-bandwidth formulas of ITU-R SM.1138, one per emission class.
 *
 * `needs` names the inputs; `bn` computes the bandwidth in hertz. Each is
 * written in the recommendation's own variables so the arithmetic can be
 * checked against it directly:
 *   B = telegraph speed in bauds (dots per second for Morse)
 *   M = for telegraphy, half the modulation rate; for telephony, the highest
 *       modulating frequency
 *   D = half the peak-to-peak frequency deviation, i.e. half the FSK shift
 *   K = the path/overall factor described above
 */
export const CLASSES = Object.freeze({
  A1A: {
    needs: ['baud', 'K'],
    formula: 'Bn = B x K',
    note: 'on-off keying of the carrier itself, read by ear',
    bn: ({ baud, K }) => baud * K,
  },
  A1B: {
    needs: ['baud', 'K'],
    formula: 'Bn = B x K',
    note: 'on-off keying of the carrier itself, read by machine',
    bn: ({ baud, K }) => baud * K,
  },
  A2A: {
    needs: ['baud', 'K', 'maxModulationHz'],
    formula: 'Bn = B x K + 2M',
    note: 'on-off keying of an amplitude-modulating audio tone (MCW), read by ear',
    bn: ({ baud, K, maxModulationHz }) => baud * K + 2 * maxModulationHz,
  },
  A2B: {
    needs: ['baud', 'K', 'maxModulationHz'],
    formula: 'Bn = B x K + 2M',
    note: 'on-off keying of an amplitude-modulating audio tone, read by machine',
    bn: ({ baud, K, maxModulationHz }) => baud * K + 2 * maxModulationHz,
  },
  F1A: {
    needs: ['baud', 'shiftHz', 'K'],
    formula: 'Bn = 2M + 2DK, with M = B/2 and D = shift/2',
    note: 'frequency-shift keying, read by ear',
    bn: ({ baud, shiftHz, K }) => 2 * (baud / 2) + 2 * (shiftHz / 2) * K,
  },
  F1B: {
    needs: ['baud', 'shiftHz', 'K'],
    formula: 'Bn = 2M + 2DK, with M = B/2 and D = shift/2',
    note: 'frequency-shift keying without error correction, read by machine',
    bn: ({ baud, shiftHz, K }) => 2 * (baud / 2) + 2 * (shiftHz / 2) * K,
  },
  A3E: {
    needs: ['maxModulationHz'],
    formula: 'Bn = 2M',
    note: 'double-sideband amplitude-modulated telephony',
    bn: ({ maxModulationHz }) => 2 * maxModulationHz,
  },
  J3E: {
    needs: ['maxModulationHz', 'minModulationHz'],
    formula: 'Bn = M - (lowest modulating frequency)',
    note: 'single-sideband suppressed-carrier telephony',
    bn: ({ maxModulationHz, minModulationHz }) => maxModulationHz - minModulationHz,
  },
  F3E: {
    needs: ['maxModulationHz', 'deviationHz', 'K'],
    formula: 'Bn = 2M + 2DK, which at K = 1 is Carson\'s rule',
    note: 'frequency-modulated telephony',
    bn: ({ maxModulationHz, deviationHz, K }) => 2 * maxModulationHz + 2 * deviationHz * K,
  },
});

const DEFAULT_K = { A1A: K_FADING, A1B: K_FADING, A2A: K_FADING, A2B: K_FADING, F1A: K_FSK, F1B: K_FSK, F3E: K_FM };

function pick(name, declared, fromMeasurement, unit, source) {
  if (declared != null && isFinite(Number(declared))) {
    return { name, value: Number(declared), unit, source: 'declared', uncertainty: null };
  }
  if (fromMeasurement && fromMeasurement.value != null) {
    return {
      name, value: fromMeasurement.value, unit, source,
      uncertainty: fromMeasurement.uncertainty == null ? null : fromMeasurement.uncertainty,
      measuredBy: fromMeasurement.method || null,
    };
  }
  return { name, value: null, unit, source: null, uncertainty: null };
}

/**
 * Build the designator for a declared classification.
 *
 * `classification` is the three-symbol class ('A1A', 'F1B', ...) or anything
 * else, including 'unknown' or null, in which case nothing is emitted. The
 * classification is NOT inferred from the measurement here: deciding that a
 * tone going on and off is Morse rather than a keyed carrier doing something
 * else is a judgement, and this module will not make it silently.
 *
 * `opts.measurement` is the object from measure(); anything found there is used
 * unless the same quantity is declared explicitly, and each input is returned
 * with the source it came from. `opts.fading` (default true, because HF
 * skywave fades) picks K for the on-off-keying classes.
 */
export function designate(classification, opts = {}) {
  const cls = typeof classification === 'string' ? classification.toUpperCase().trim() : '';
  const caveat = 'An emission designator is an assertion built on a classification that no '
    + 'measurement supplies. The bandwidth here is computed from the inputs and assumptions '
    + 'listed, and is only as good as the classification it was given.';

  if (!CLASSES[cls]) {
    return {
      designator: null,
      classification: cls || null,
      refused: {
        reason: !cls || cls === 'UNKNOWN' || cls === 'UNK'
          ? 'the classification is unknown, and it is not something a recording can be measured '
            + 'for: the last two symbols of a designator say what the signal MEANS. Without them '
            + 'there is no formula to apply and no designator to emit.'
          : '"' + cls + '" is not an emission class this module has a bandwidth formula for',
        known: Object.keys(CLASSES),
      },
      caveat,
    };
  }
  const spec = CLASSES[cls];
  const m = opts.measurement || null;
  const assumptions = [];

  const fading = opts.fading == null ? true : !!opts.fading;
  let K = opts.K;
  if (K == null) {
    K = DEFAULT_K[cls];
    if (cls[0] === 'A' && (cls[1] === '1' || cls[1] === '2')) {
      K = fading ? K_FADING : K_NON_FADING;
      assumptions.push({
        name: 'K', value: K, source: 'assumed',
        why: 'ITU-R SM.1138 gives K = ' + K_FADING + ' for a fading circuit and ' + K_NON_FADING
          + ' for a non-fading one. This emission was treated as '
          + (fading ? 'FADING, which is what an HF skywave path is' : 'NON-FADING')
          + '. Nothing in a recording of the audio determines which applies.',
      });
    } else if (K != null) {
      assumptions.push({
        name: 'K', value: K, source: 'assumed',
        why: cls[0] === 'F' && cls[2] === 'E'
          ? 'K = 1 makes the frequency-modulation formula Carson\'s rule'
          : 'ITU-R SM.1138 gives K = ' + K_FSK + ' as the typical value for frequency-shift keying',
      });
    }
  } else {
    assumptions.push({ name: 'K', value: Number(K), source: 'declared', why: 'supplied by the caller' });
    K = Number(K);
  }

  // Morse speed may be given as words per minute, which is not a physical
  // quantity until the length of a word is declared.
  let baudInput;
  if (opts.wpm != null) {
    const units = opts.unitsPerWord == null ? UNITS_PER_WORD_PARIS : Number(opts.unitsPerWord);
    baudInput = {
      name: 'baud', value: Number(opts.wpm) * units / 60, unit: 'Bd',
      source: 'derived from wpm', uncertainty: null,
    };
    assumptions.push({
      name: 'unitsPerWord', value: units, source: opts.unitsPerWord == null ? 'assumed' : 'declared',
      why: units === UNITS_PER_WORD_PARIS
        ? 'PARIS, the standard word, is 50 dot units including its trailing space, so B = '
          + '50 x wpm / 60 = 0.8333 x wpm dots per second'
        : 'a word of ' + units + ' dot units, so B = ' + units + ' x wpm / 60. ITU-R SM.1138\'s '
          + 'own A1A example uses 48, which is 4% away from the PARIS convention and therefore '
          + '4% away in bandwidth',
    });
  } else {
    baudInput = pick('baud', opts.baud, m && m.symbolRate, 'Bd', 'measured symbol rate');
  }
  // A measurement the estimator itself called marginal must not become a
  // confident designator. The warning travels with the answer.
  if (m && m.symbolRate && m.symbolRate.value != null && opts.baud == null && opts.wpm == null) {
    const c = m.symbolRate.confidence || {};
    if (c.level === 'marginal' || c.analogueToneIndistinguishable) {
      assumptions.push({
        name: 'symbolRateIsMarginal', value: true, source: 'from the measurement',
        why: 'the symbol rate this bandwidth rests on was reported as ' + (c.level || 'marginal')
          + (c.analogueToneIndistinguishable
            ? ' with no harmonic support, which makes it as consistent with an analogue '
              + 'modulating tone as with a symbol clock' : '')
          // The measurement caps its own level at 'marginal' when the
          // transition channels peak at rates with no integer relation. That is
          // a different complaint from a weak line and the reader needs to know
          // which one they have: a weak line means measure for longer, two
          // emissions in the band means narrow the region.
          + (c.channelsDisagree
            ? ', because the transition channels peak at rates with no integer relation, which '
              + 'means the region holds more than one emission and this rate belongs to '
              + 'whichever was loudest' : '')
          + '. The designator below is only as good as that line.',
      });
    }
    if (c.mayBeASubHarmonic) {
      assumptions.push({
        name: 'symbolRateMayBeASubHarmonic', value: true, source: 'from the measurement',
        why: 'the measured rate is the lowest line carrying a comb; the true symbol rate may be '
          + 'an integer multiple of it, and the bandwidth would scale with it',
      });
    }
  }
  const inputs = [baudInput];
  inputs.push(pick('shiftHz', opts.shiftHz, m && m.fskShift, 'Hz', 'measured FSK shift'));
  inputs.push({ name: 'K', value: K == null ? null : Number(K), unit: null, source: 'assumption', uncertainty: null });
  inputs.push(pick('maxModulationHz', opts.maxModulationHz, null, 'Hz', null));
  inputs.push(pick('minModulationHz', opts.minModulationHz, null, 'Hz', null));
  inputs.push(pick('deviationHz', opts.deviationHz, null, 'Hz', null));

  const byName = {};
  for (const i of inputs) byName[i.name] = i;
  const missing = spec.needs.filter((n) => byName[n].value == null);
  if (missing.length) {
    return {
      designator: null,
      classification: cls,
      refused: {
        reason: cls + ' needs ' + spec.needs.join(', ') + ' and ' + missing.join(', ')
          + (missing.length === 1 ? ' is' : ' are') + ' not available: '
          + missing.map((n) => n + ' was neither declared nor measurable'
            + (n === 'baud' && m && m.symbolRate && m.symbolRate.reason
              ? ' (' + m.symbolRate.reason + ')'
              : n === 'shiftHz' && m && m.fskShift && m.fskShift.reason
                ? ' (' + m.fskShift.reason + ')' : '')).join('; '),
        missing,
        formula: spec.formula,
      },
      assumptions,
      caveat,
    };
  }

  const values = {};
  for (const n of spec.needs) values[n] = byName[n].value;
  const bn = spec.bn(values);
  if (!(bn > 0)) {
    return {
      designator: null, classification: cls,
      refused: { reason: 'the formula ' + spec.formula + ' gives ' + bn + ' Hz, which is not a bandwidth' },
      assumptions, caveat,
    };
  }

  // Propagate the input uncertainties numerically: perturb each by its own
  // standard error and take the root sum of squares of what that does to Bn.
  // Inputs with no stated uncertainty (the assumptions) contribute nothing,
  // which is the point of listing them separately.
  let varSum = 0;
  const contributions = [];
  for (const n of spec.needs) {
    const u = byName[n].uncertainty;
    if (u == null || !(u > 0)) continue;
    const bumped = Object.assign({}, values, { [n]: values[n] + u });
    const d = Math.abs(spec.bn(bumped) - bn);
    varSum += d * d;
    contributions.push({ input: n, hz: d });
  }
  const uncertainty = contributions.length ? Math.sqrt(varSum) : null;

  const formatted = formatBandwidth(bn);
  if (!formatted) {
    return {
      designator: null, classification: cls,
      refused: { reason: bn + ' Hz is outside the range the ITU four-character form can express '
        + '(0.001 Hz to 999 GHz)' },
      assumptions, caveat,
    };
  }

  return {
    designator: formatted + cls,
    classification: cls,
    bandwidth: {
      value: bn, unit: 'Hz', formatted, uncertainty,
      method: 'ITU-R SM.1138, ' + cls + ': ' + spec.formula,
      contributions,
      // The rounding to three digits is itself a loss, and on a narrow
      // emission it is the largest term in the answer.
      roundingHz: Math.abs(bn - roundedValueOf(formatted)),
    },
    symbols: {
      bandwidth: formatted,
      modulation: cls[0], signal: cls[1], information: cls[2],
      modulationMeans: MODULATION[cls[0]] || null,
      signalMeans: SIGNAL[cls[1]] || null,
      informationMeans: INFORMATION[cls[2]] || null,
      note: spec.note,
    },
    inputs: inputs.filter((i) => spec.needs.includes(i.name)),
    assumptions,
    caveat,
  };
}

/** The value a four-character bandwidth field actually stands for, in hertz. */
export function roundedValueOf(formatted) {
  if (typeof formatted !== 'string' || formatted.length !== 4) return NaN;
  const scale = { H: 1, K: 1e3, M: 1e6, G: 1e9 };
  const at = formatted.search(/[HKMG]/);
  if (at < 0) return NaN;
  const letter = formatted[at];
  const digits = formatted.slice(0, at) + '.' + formatted.slice(at + 1);
  return Number(digits) * scale[letter];
}
