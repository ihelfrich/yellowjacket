// Formula synthesis: a sound written as maths, evaluated per sample.
//
// For a recorded hit there is no closed form, only 44100 measurements a second
// that you can FIT a model to. For a synthesized one the function IS the sound,
// so it can simply be typed. An 808 kick is two lines:
//
//   f = 48 + 132*env(t, 0.03)          pitch falls from 180 Hz to 48 Hz
//   x = sin(tau*f*t) * env(t, 0.18)    and the whole thing decays
//
// The parser is a small recursive-descent compiler to a closure tree. It is
// deliberately NOT eval or new Function: those would run arbitrary page script
// from a text field that gets persisted and shared, which is a real hazard for
// a tool whose whole pitch is that nothing leaves your machine.

const MAX_SECONDS = 8;
const MAX_RATE = 192000;

// Deterministic noise: the same formula must render the same audio every time,
// or a synth voice would drift between the live pass and the offline render.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSTANTS = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

// Every callable the language exposes. Anything not here is a parse error, so
// a formula can never reach outside this table.
const FUNCTIONS = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  exp: { arity: 1, fn: Math.exp },
  log: { arity: 1, fn: (x) => Math.log(Math.max(1e-12, x)) },
  abs: { arity: 1, fn: Math.abs },
  sqrt: { arity: 1, fn: (x) => Math.sqrt(Math.max(0, x)) },
  floor: { arity: 1, fn: Math.floor },
  sign: { arity: 1, fn: Math.sign },
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  pow: { arity: 2, fn: Math.pow },
  // env(t, tau): exponential decay, the shape almost every percussive sound has
  env: { arity: 2, fn: (t, tau) => Math.exp(-t / Math.max(1e-6, tau)) },
  // Waveshapes take RADIANS, like sin, so they interchange freely
  saw: { arity: 1, fn: (x) => { const p = x / (Math.PI * 2); return 2 * (p - Math.floor(p + 0.5)); } },
  sqr: { arity: 1, fn: (x) => (Math.sin(x) >= 0 ? 1 : -1) },
  tri: { arity: 1, fn: (x) => { const p = x / (Math.PI * 2); const q = p - Math.floor(p + 0.5); return 4 * Math.abs(q) - 1; } },
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
};

const NOISE = 'noise';

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j])) {
        // exponent sign belongs to the number: 1e-3
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '-' || src[j + 1] === '+')) j++;
        j++;
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error('bad number "' + text + '"');
      out.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ type: c }); i++; continue; }
    throw new Error('unexpected character "' + c + '"');
  }
  return out;
}

// Compiles to a closure taking (t, n, rand) so evaluation costs no dispatch.
export function compileFormula(src, vars = {}) {
  const tokens = tokenize(String(src || ''));
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type) => {
    const tk = tokens[pos];
    if (!tk || tk.type !== type) throw new Error('expected ' + type);
    pos++;
    return tk;
  };

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const tk = peek();
      if (!tk || (tk.type !== '+' && tk.type !== '-')) return left;
      pos++;
      const right = parseTerm();
      const a = left;
      left = tk.type === '+'
        ? (t, n, r) => a(t, n, r) + right(t, n, r)
        : (t, n, r) => a(t, n, r) - right(t, n, r);
    }
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (!tk || (tk.type !== '*' && tk.type !== '/')) return left;
      pos++;
      const right = parseUnary();
      const a = left;
      left = tk.type === '*'
        ? (t, n, r) => a(t, n, r) * right(t, n, r)
        : (t, n, r) => { const d = right(t, n, r); return d === 0 ? 0 : a(t, n, r) / d; };
    }
  }

  function parseUnary() {
    const tk = peek();
    if (tk && tk.type === '-') { pos++; const v = parseUnary(); return (t, n, r) => -v(t, n, r); }
    if (tk && tk.type === '+') { pos++; return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    const tk = peek();
    if (tk && tk.type === '^') {
      pos++;
      const exp = parseUnary();   // right associative
      return (t, n, r) => Math.pow(base(t, n, r), exp(t, n, r));
    }
    return base;
  }

  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('unexpected end of formula');
    if (tk.type === 'num') { pos++; const v = tk.value; return () => v; }
    if (tk.type === '(') {
      pos++;
      const v = parseExpr();
      eat(')');
      return v;
    }
    if (tk.type === 'ident') {
      pos++;
      const name = tk.value;
      if (peek() && peek().type === '(') {
        pos++;
        const args = [];
        if (peek() && peek().type !== ')') {
          args.push(parseExpr());
          while (peek() && peek().type === ',') { pos++; args.push(parseExpr()); }
        }
        eat(')');
        if (name === NOISE) {
          if (args.length) throw new Error('noise() takes no arguments');
          return (t, n, r) => r() * 2 - 1;
        }
        const spec = FUNCTIONS[name];
        if (!spec) throw new Error('unknown function "' + name + '"');
        if (args.length !== spec.arity) {
          throw new Error(name + '() takes ' + spec.arity + ' argument' + (spec.arity === 1 ? '' : 's'));
        }
        const f = spec.fn;
        if (spec.arity === 1) { const a = args[0]; return (t, n, r) => f(a(t, n, r)); }
        if (spec.arity === 2) { const a = args[0], b = args[1]; return (t, n, r) => f(a(t, n, r), b(t, n, r)); }
        const [a, b, c] = args;
        return (t, n, r) => f(a(t, n, r), b(t, n, r), c(t, n, r));
      }
      if (name === 't') return (t) => t;
      if (name === 'n') return (t, n) => n;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
        const v = CONSTANTS[name];
        return () => v;
      }
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        const v = Number(vars[name]);
        if (!Number.isFinite(v)) throw new Error('variable "' + name + '" is not a number');
        return () => v;
      }
      throw new Error('unknown name "' + name + '"');
    }
    throw new Error('unexpected token');
  }

  const root = parseExpr();
  if (pos !== tokens.length) throw new Error('trailing input after the formula');
  return root;
}

// Renders a formula to mono PCM. Never throws for a compiled formula: any
// non-finite sample becomes 0 rather than poisoning an AudioBuffer.
export function renderFormula(src, opts = {}) {
  const sampleRate = Math.min(MAX_RATE, Math.max(8000, Math.round(opts.sampleRate || 44100)));
  const seconds = Math.min(MAX_SECONDS, Math.max(0.01, Number(opts.seconds) || 1));
  const fn = compileFormula(src, opts.vars || {});
  const rand = mulberry32(opts.seed == null ? 0x59454C4C : opts.seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = fn(i / sampleRate, i, rand);
    const s = Number.isFinite(v) ? v : 0;
    out[i] = s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  // Normalize to -1 dBFS unless asked not to: a formula has no natural level,
  // and an un-normalized one either vanishes or slams the master.
  if (opts.normalize !== false && peak > 1e-9) {
    const g = 0.891 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  // Short fades at both ends: a formula that does not end at zero clicks.
  const fade = Math.min(Math.round(0.002 * sampleRate), Math.floor(n / 2));
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] *= w;
    out[n - 1 - i] *= w;
  }
  return out;
}

// Starting points that are worth hearing and worth reading. Each one is the
// actual synthesis method for that instrument, not a toy.
export const SYNTH_PRESETS = [
  {
    name: 'KICK', role: 'KICK', seconds: 0.6,
    formula: 'sin(tau * (48 + 132*env(t,0.03)) * t) * env(t,0.18)',
    note: 'Pitch falls 180 Hz to 48 Hz in 30 ms, body decays in 180 ms.',
  },
  {
    name: 'SNARE', role: 'SNARE', seconds: 0.35,
    formula: '(noise()*0.7 + sin(tau*185*t)*0.5) * env(t,0.09)',
    note: 'Noise for the wires plus a tuned shell tone.',
  },
  {
    name: 'HAT', role: 'HAT', seconds: 0.12,
    formula: 'noise() * env(t,0.018)',
    note: 'Noise with a very short decay. Raise 0.018 for an open hat.',
  },
  {
    name: 'BASS', role: 'BASS', seconds: 1.2,
    formula: 'saw(tau*55*t) * env(t,0.7)',
    note: 'A 55 Hz sawtooth. Filter it in the VOICE drawer.',
  },
  {
    name: 'PLUCK', role: 'TONE', seconds: 0.9,
    formula: '(sin(tau*220*t) + 0.5*sin(tau*440*t) + 0.25*sin(tau*660*t)) * env(t,0.25)',
    note: 'Three harmonics at falling weights: the start of any struck string.',
  },
  {
    name: 'BELL', role: 'CRASH', seconds: 2.5,
    formula: 'sin(tau*440*t)*env(t,1.4) + 0.6*sin(tau*1043*t)*env(t,0.9) + 0.4*sin(tau*1809*t)*env(t,0.5)',
    note: 'Inharmonic partials with different decays. This is modal synthesis by hand.',
  },
  {
    name: 'SWEEP', role: 'FX', seconds: 2,
    formula: 'sin(tau * (80 * pow(2, 4*t/2)) * t) * min(1, t*3) * env(t,1.6)',
    note: 'An exponential rise over four octaves.',
  },
];
