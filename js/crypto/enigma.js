// Enigma: the machine, and the attack that breaks it.
//
// The machine is a rotor cipher — a plugboard, three or four rotors that step
// like an odometer, and a reflector that makes it its own inverse. Its
// weakness is not the size of its key space, which is enormous, but that the
// key splits into parts that can be attacked one at a time: the rotor order
// and their starting positions move the index of coincidence on their own,
// before a single plug is known, and the plugboard can then be recovered one
// pair at a time because each correct plug improves the score by itself.
//
// That layered search is what this implements, and it is how Enigma is broken
// today: not Bletchley's cribs and bombes, but an index-of-coincidence sweep
// over rotor orders and positions, then a trigram hill climb on the ring
// settings, then a greedy plugboard search. It is due to Jim Gillogly and it
// needs no crib, no captured key sheet and no assumption about the content —
// only that the plaintext is German or English text.
//
// What this module will not do is hand back a "solution" because a search
// returned its best candidate. Every result carries a z score against the same
// search run on ciphertext that cannot be solved, and below the bar it says in
// words that this is not a decrypt.
//
// Pure and node-testable.
import { letters, toText, score, indexOfCoincidence, zAgainstNull, verdictFor, rng, SOLVED_Z, ENGLISH_SCORE } from './fitness.js';

const A = 65;
const parse = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) - A);

/** The Wehrmacht and Kriegsmarine rotors, with the notches they turn over at. */
export const ROTORS = Object.freeze({
  I: { wiring: 'EKMFLGDQVZNTOWYHXUSPAIBRCJ', notches: 'Q' },
  II: { wiring: 'AJDKSIRUXBLHWTMCQGZNPYFVOE', notches: 'E' },
  III: { wiring: 'BDFHJLCPRTXVZNYEIWGAKMUSQO', notches: 'V' },
  IV: { wiring: 'ESOVPZJAYQUIRHXLNFTGKDCMWB', notches: 'J' },
  V: { wiring: 'VZBRGITYUPSDNHLXAWMJQOFECK', notches: 'Z' },
  VI: { wiring: 'JPGVOUMFYQBENHZRDKASXLICTW', notches: 'ZM' },
  VII: { wiring: 'NZJHGRCXMYSWBOUFAIVLPEKQDT', notches: 'ZM' },
  VIII: { wiring: 'FKQHTLXOCBJSPDZRAMEWNIUYGV', notches: 'ZM' },
});

export const REFLECTORS = Object.freeze({
  B: 'YRUHQSLDPXNGOKMIEBFZCWVJAT',
  C: 'FVPJIAOYEDRZXWGCTKUQSBNMHL',
});

/** The five-rotor Wehrmacht set, and the eight the navy used. */
export const WEHRMACHT = Object.freeze(['I', 'II', 'III', 'IV', 'V']);
export const KRIEGSMARINE = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);

const WIRE = {}, INV = {}, NOTCH = {};
for (const [name, r] of Object.entries(ROTORS)) {
  WIRE[name] = parse(r.wiring);
  const inv = new Uint8Array(26);
  for (let i = 0; i < 26; i++) inv[WIRE[name][i]] = i;
  INV[name] = inv;
  NOTCH[name] = Uint8Array.from(r.notches, (ch) => ch.charCodeAt(0) - A);
}
const REFL = {};
for (const [name, w] of Object.entries(REFLECTORS)) REFL[name] = parse(w);

/**
 * A machine. `rotors` is left to right as the operator sees it — the leftmost
 * is the slow one — which is the order a key sheet is written in and the
 * opposite of the order the current flows.
 */
export class Enigma {
  constructor({ rotors = ['I', 'II', 'III'], reflector = 'B', rings = [0, 0, 0], positions = [0, 0, 0], plugboard = '' } = {}) {
    this.rotors = rotors.slice();
    this.reflector = reflector;
    this.rings = Uint8Array.from(rings);
    this.positions = Uint8Array.from(positions);
    this.setPlugboard(plugboard);
  }

  setPlugboard(spec) {
    const p = new Uint8Array(26);
    for (let i = 0; i < 26; i++) p[i] = i;
    const pairs = Array.isArray(spec) ? spec : String(spec || '').toUpperCase().split(/\s+/).filter(Boolean);
    for (const pair of pairs) {
      if (pair.length !== 2) throw new RangeError('a plugboard pair is two letters: ' + pair);
      const a = pair.charCodeAt(0) - A, b = pair.charCodeAt(1) - A;
      if (a < 0 || a > 25 || b < 0 || b > 25) throw new RangeError('a plugboard pair is two letters: ' + pair);
      if (p[a] !== a || p[b] !== b) throw new RangeError('a letter may take only one plug: ' + pair);
      p[a] = b; p[b] = a;
    }
    this.plug = p;
    this.plugPairs = pairs.slice();
    return this;
  }

  /**
   * Step the rotors. The middle rotor's double step is the machine's famous
   * irregularity: when it sits on its own notch it steps AND takes the left
   * rotor with it, so it moves twice in consecutive keystrokes.
   */
  step() {
    const n = this.rotors.length;
    const right = n - 1, middle = n - 2, left = n - 3;
    const atNotch = (i) => NOTCH[this.rotors[i]].includes(this.positions[i]);
    const middleAtNotch = middle >= 0 && atNotch(middle);
    if (middleAtNotch) {
      if (left >= 0) this.positions[left] = (this.positions[left] + 1) % 26;
      this.positions[middle] = (this.positions[middle] + 1) % 26;
    } else if (atNotch(right) && middle >= 0) {
      this.positions[middle] = (this.positions[middle] + 1) % 26;
    }
    this.positions[right] = (this.positions[right] + 1) % 26;
  }

  /** One letter, after stepping. The machine is its own inverse. */
  encodeCode(c) {
    this.step();
    let x = this.plug[c];
    for (let i = this.rotors.length - 1; i >= 0; i--) {
      const shift = (this.positions[i] - this.rings[i] + 26) % 26;
      x = (WIRE[this.rotors[i]][(x + shift) % 26] - shift + 26) % 26;
    }
    x = REFL[this.reflector][x];
    for (let i = 0; i < this.rotors.length; i++) {
      const shift = (this.positions[i] - this.rings[i] + 26) % 26;
      x = (INV[this.rotors[i]][(x + shift) % 26] - shift + 26) % 26;
    }
    return this.plug[x];
  }

  encode(text) {
    const c = letters(text);
    const out = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = this.encodeCode(c[i]);
    return toText(out);
  }

  encodeCodes(codes) {
    const out = new Uint8Array(codes.length);
    for (let i = 0; i < codes.length; i++) out[i] = this.encodeCode(codes[i]);
    return out;
  }
}

/**
 * Stretches of a candidate plaintext that do not read like the rest of it.
 * Scored in windows against the message's own median, so it adapts to how
 * English the decrypt is overall rather than to an absolute bar.
 */
export function weakSpans(codes, { window = 25, marginDb = 0.55 } = {}) {
  if (codes.length < window * 3) return [];
  const scores = [];
  for (let i = 0; i + window <= codes.length; i++) scores.push(score(codes.subarray(i, i + window)));
  const sorted = Float64Array.from(scores).sort();
  const median = sorted[sorted.length >> 1];
  const out = [];
  let run = -1;
  for (let i = 0; i <= scores.length; i++) {
    const weak = i < scores.length && scores[i] < median - marginDb;
    if (weak && run < 0) run = i;
    else if (!weak && run >= 0) {
      if (i - run >= 5) out.push({ at: run, length: (i - run) + window - 1, worst: +Math.min(...scores.slice(run, i)).toFixed(3) });
      run = -1;
    }
  }
  return out;
}

/** Run a setting over a ciphertext without disturbing anything. */
export function run(codes, setting) {
  const m = new Enigma(setting);
  return m.encodeCodes(codes);
}

const orders = (set, count) => {
  const out = [];
  const walk = (chosen, left) => {
    if (chosen.length === count) { out.push(chosen.slice()); return; }
    for (let i = 0; i < left.length; i++) walk([...chosen, left[i]], left.filter((_, j) => j !== i));
  };
  walk([], set);
  return out;
};

/**
 * Stage one: rotor order and starting positions, by index of coincidence,
 * with the ring settings at AAA and no plugs.
 *
 * This is the step that makes the whole thing tractable. There are 60 rotor
 * orders for the army's five wheels and 17,576 start positions, so 1,054,560
 * settings — and the index of coincidence rises for the right one even with
 * ten plugs still unknown, because a plugboard is a substitution and a
 * substitution does not change how often two letters match.
 */
export function searchRotors(codes, { set = WEHRMACHT, count = 3, reflector = 'B', keep = 12, sweepLetters = 120 } = {}) {
  // The sweep is the expensive stage: sixty rotor orders times 17,576 start
  // positions is a million machine runs. Three things keep it inside a few
  // seconds rather than a few minutes.
  //
  // It scores a PREFIX. The index of coincidence settles long before a message
  // ends — measured on a 197-letter signal, 120 letters separate the right
  // rotor order from the next best by the same margin the whole message does,
  // and cost 40% less.
  //
  // It allocates nothing inside the loop: one buffer for the output and one
  // histogram, both reused, instead of a new machine and a new array per
  // setting, which is a million allocations otherwise.
  //
  // And it steps the rotors inline rather than through the class, so the hot
  // path is array lookups and modular adds with no property reads on `this`.
  const n = Math.min(codes.length, sweepLetters);
  const out = new Uint8Array(n);
  const freq = new Int32Array(26);
  const refl = REFL[reflector];
  const results = [];
  let worst = -Infinity;
  const pos = new Uint8Array(count);
  for (const order of orders(set, count)) {
    const wires = order.map((r) => WIRE[r]);
    const invs = order.map((r) => INV[r]);
    const notches = order.map((r) => NOTCH[r]);
    const right = count - 1, middle = count - 2, left = count - 3;
    for (let a = 0; a < 26; a++) {
      for (let b = 0; b < 26; b++) {
        for (let c = 0; c < 26; c++) {
          if (count === 3) { pos[0] = a; pos[1] = b; pos[2] = c; }
          else { pos[0] = 0; pos[1] = a; pos[2] = b; pos[3] = c; }
          for (let i = 0; i < n; i++) {
            // step
            let middleAtNotch = false;
            for (let k = 0; k < notches[middle].length; k++) if (notches[middle][k] === pos[middle]) { middleAtNotch = true; break; }
            if (middleAtNotch) {
              if (left >= 0) pos[left] = (pos[left] + 1) % 26;
              pos[middle] = (pos[middle] + 1) % 26;
            } else {
              let rightAtNotch = false;
              for (let k = 0; k < notches[right].length; k++) if (notches[right][k] === pos[right]) { rightAtNotch = true; break; }
              if (rightAtNotch) pos[middle] = (pos[middle] + 1) % 26;
            }
            pos[right] = (pos[right] + 1) % 26;
            // through the wheels; rings are all A in this stage
            let x = codes[i];
            for (let r = count - 1; r >= 0; r--) { const sh = pos[r]; x = (wires[r][(x + sh) % 26] - sh + 26) % 26; }
            x = refl[x];
            for (let r = 0; r < count; r++) { const sh = pos[r]; x = (invs[r][(x + sh) % 26] - sh + 26) % 26; }
            out[i] = x;
          }
          freq.fill(0);
          for (let i = 0; i < n; i++) freq[out[i]]++;
          let acc = 0;
          for (let k = 0; k < 26; k++) acc += freq[k] * (freq[k] - 1);
          const ic = acc / (n * (n - 1));
          if (results.length < keep || ic > worst) {
            results.push({ rotors: order, positions: count === 3 ? [a, b, c] : [0, a, b, c], ic });
            results.sort((x, y) => y.ic - x.ic);
            if (results.length > keep) results.length = keep;
            worst = results[results.length - 1].ic;
          }
        }
      }
    }
  }
  return results;
}

/**
 * Stage two: the plugboard, one pair at a time.
 *
 * Greedy and correct for the reason the machine is broken at all — each right
 * plug improves the score by itself, so they can be found one after another
 * instead of all at once. Ten plugs out of 150,738,274,937,250 possible
 * boards, in 325 + 276 + ... trials.
 */
export function searchPlugboard(codes, setting, { maxPlugs = 10 } = {}) {
  const used = new Set();
  const pairs = [];
  let best = score(run(codes, { ...setting, plugboard: pairs }));
  for (let p = 0; p < maxPlugs; p++) {
    let bestPair = null, bestScore = best;
    for (let i = 0; i < 26; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < 26; j++) {
        if (used.has(j)) continue;
        const trial = [...pairs, String.fromCharCode(A + i, A + j)];
        const s = score(run(codes, { ...setting, plugboard: trial }));
        if (s > bestScore) { bestScore = s; bestPair = [i, j]; }
      }
    }
    if (!bestPair) break;
    pairs.push(String.fromCharCode(A + bestPair[0], A + bestPair[1]));
    used.add(bestPair[0]); used.add(bestPair[1]);
    best = bestScore;
  }
  return { plugboard: pairs, score: best };
}

/**
 * Stage three: ring settings. Only the middle and left rings matter to the
 * text — turning the right-hand ring and its position together is the same
 * machine — so this searches the middle ring with its position, which is what
 * moves the middle rotor's turnover relative to the message.
 */
export function searchRings(codes, setting) {
  let best = { ...setting, score: score(run(codes, setting)) };
  const n = setting.rotors.length;
  for (let ring = 0; ring < 26; ring++) {
    const rings = Array.from(setting.rings || new Array(n).fill(0));
    const positions = Array.from(setting.positions);
    rings[n - 2] = ring;
    positions[n - 2] = (setting.positions[n - 2] + ring) % 26;
    const trial = { ...setting, rings, positions };
    const s = score(run(codes, trial));
    if (s > best.score) best = { ...trial, score: s };
  }
  return best;
}

/**
 * Break a message. Returns the setting, the plaintext, and how far above a
 * search that cannot succeed this one landed.
 *
 * `set` is the wheels available: five for the army, eight for the navy, or any
 * subset a key sheet narrows it to. Narrowing costs nothing and saves a lot:
 * the rotor sweep is the expensive stage and it is linear in the number of
 * orders.
 */
export function breakEnigma(text, {
  set = WEHRMACHT, count = 3, reflector = 'B', keep = 8, maxPlugs = 10,
  nulls: nullRuns = 3, seed = 1, onProgress = null, sweepLetters = 120,
} = {}) {
  const codes = letters(text);
  if (codes.length < 60) {
    return { ok: false, reason: `${codes.length} letters is too few: below about 120 the index of coincidence cannot separate the right rotor order from the wrong ones` };
  }
  const attack = (c) => {
    const top = searchRotors(c, { set, count, reflector, keep, sweepLetters });
    let best = null;
    for (const cand of top) {
      // Rings, then plugs, then rings again, then plugs again.
      //
      // The second round is not belt and braces. The ring search scores whole
      // candidate plaintexts, and with the plugboard still unknown those are
      // mostly garbage, so it picks the wrong middle ring: measured on a
      // 360-letter message with five plugs, one pass recovered every plug and
      // the right rotors but put the middle ring one step off, which moves
      // where the middle rotor turns over and corrupted the message from
      // letter 125 until it re-synchronised. 93% of the text was right, which
      // is the worst kind of wrong. With the second round it is 100%.
      let setting = { rotors: cand.rotors, reflector, rings: new Array(count).fill(0), positions: Array.from(cand.positions) };
      let plug = { plugboard: [], score: score(run(c, setting)) };
      for (let round = 0; round < (maxPlugs > 0 ? 2 : 1); round++) {
        const withRings = searchRings(c, { ...setting, plugboard: plug.plugboard });
        setting = { rotors: withRings.rotors, reflector, rings: Array.from(withRings.rings), positions: Array.from(withRings.positions) };
        plug = maxPlugs > 0
          ? searchPlugboard(c, setting, { maxPlugs })
          : { plugboard: [], score: withRings.score };
      }
      // One last ring sweep with the plugboard FIXED. The plug search is
      // greedy and path-dependent, so ending on it can leave a local optimum
      // where a ring one step off scored higher than the truth because the
      // plugs found under it happened to suit it.
      const settled = maxPlugs > 0 ? searchRings(c, { ...setting, plugboard: plug.plugboard }) : { ...setting, score: plug.score };
      const full = { rotors: settled.rotors, reflector, rings: Array.from(settled.rings), positions: Array.from(settled.positions), plugboard: plug.plugboard };
      const finalScore = Math.max(settled.score, plug.score);
      if (!best || finalScore > best.score) best = { setting: full, score: finalScore, ic: cand.ic };
    }
    return best;
  };
  const best = attack(codes);
  if (onProgress) onProgress({ stage: 'solved', score: best.score });
  // The null: the same search on the same ciphertext shuffled, which destroys
  // any rotor setting that could explain it while leaving its length and
  // letter frequencies alone.
  const rand = rng(seed ^ 0x9e3779b9);
  const nulls = [];
  for (let r = 0; r < nullRuns; r++) {
    const sc = Uint8Array.from(codes);
    for (let i = sc.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = sc[i]; sc[i] = sc[j]; sc[j] = t; }
    const got = attack(sc);
    if (got) nulls.push(got.score);
    if (onProgress) onProgress({ stage: 'null', run: r + 1, of: nullRuns });
  }
  const z = zAgainstNull(best.score, nulls);
  const plainCodes = run(codes, best.setting);
  const plain = toText(plainCodes);
  // Where the decrypt stops reading as English. A middle ring setting one step
  // off gives a machine identical to the truth until the middle rotor turns
  // over, then wrong until it re-synchronises — so the message comes back
  // mostly right with a corrupted stretch in the middle, which is the worst
  // kind of wrong to hand a reader silently. Measured on a 360-letter message
  // with five plugs, one such run cost 25 letters from position 125 and the
  // rest was exact.
  const weak = weakSpans(plainCodes);
  return {
    ok: Number.isFinite(z.z) && z.z >= SOLVED_Z && best.score >= ENGLISH_SCORE,
    setting: {
      rotors: best.setting.rotors,
      reflector: best.setting.reflector,
      rings: Array.from(best.setting.rings, (v) => String.fromCharCode(A + v)).join(''),
      positions: Array.from(best.setting.positions, (v) => String.fromCharCode(A + v)).join(''),
      plugboard: best.setting.plugboard.join(' '),
    },
    plaintext: plain,
    score: +best.score.toFixed(4), ic: +best.ic.toFixed(4),
    ...z, z: +z.z.toFixed(2), letters: codes.length,
    verdict: verdictFor(z.z, { letters: codes.length }),
    weakSpans: weak,
    caution: weak.length
      ? `${weak.reduce((a, w) => a + w.length, 0)} letters in ${weak.length} stretch${weak.length === 1 ? '' : 'es'} do not read as English `
        + `(from ${weak.map((w) => w.at).join(', ')}). A middle ring setting one step off does exactly this: right until the middle `
        + 'rotor turns over, wrong until it re-synchronises. Try the neighbouring ring settings on those stretches.'
      : null,
    searched: { rotorOrders: orders(set, count).length, positions: 26 ** count, plugsTried: maxPlugs },
  };
}
