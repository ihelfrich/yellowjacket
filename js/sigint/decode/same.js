// SAME — Specific Area Message Encoding, the digital header on NOAA Weather
// Radio and the Emergency Alert System. 520.83 baud AFSK, mark 2083.3 Hz for a
// one and space 1562.5 Hz for a zero, eight-bit characters sent least
// significant bit first with no start or stop bits, sixteen bytes of 0xAB
// preamble, then an ASCII header of the form
//
//   ZCZC-ORG-EEE-PSSCCC-PSSCCC+TTTT-JJJHHMM-LLLLLLLL-
//
// sent three times about a second apart, and NNNN three times to end.
//
// What comes back is the header as text, the three repetitions voted
// character by character, and the fields read out in words — who sent it,
// what for, which counties, when it was issued and how long it stands. And
// a refusal, by name, when the preamble is not there: a bench that prints a
// header out of noise is worse than one with no SAME decoder at all.
//
// Pure and worker-safe. The demodulator is a sliding complex correlation at
// the two tones with a window of exactly one bit, so it is O(n) and does not
// care what the sample rate is.

export const BAUD = 520.8333333333334;      // 25000 / 48
export const MARK_HZ = 2083.3333333333335;  // 25000 / 12
export const SPACE_HZ = 1562.5;             // 25000 / 16
export const PREAMBLE = 0xab;

export const ORIGINATORS = Object.freeze({
  PEP: 'Primary Entry Point (national)',
  CIV: 'civil authority',
  WXR: 'National Weather Service',
  EAS: 'broadcast station or cable system',
  EAN: 'Emergency Action Notification network',
});

// Event codes a listener is likely to meet. Unknown codes pass through as-is.
export const EVENTS = Object.freeze({
  RWT: 'Required Weekly Test', RMT: 'Required Monthly Test', NPT: 'National Periodic Test',
  DMO: 'Practice / Demo Warning', EAN: 'Emergency Action Notification', EAT: 'Emergency Action Termination',
  ADR: 'Administrative Message', AVW: 'Avalanche Warning', AVA: 'Avalanche Watch',
  BZW: 'Blizzard Warning', CAE: 'Child Abduction Emergency', CDW: 'Civil Danger Warning',
  CEM: 'Civil Emergency Message', CFW: 'Coastal Flood Warning', CFA: 'Coastal Flood Watch',
  DSW: 'Dust Storm Warning', EQW: 'Earthquake Warning', EVI: 'Evacuation Immediate',
  EWW: 'Extreme Wind Warning', FRW: 'Fire Warning', FFW: 'Flash Flood Warning',
  FFA: 'Flash Flood Watch', FFS: 'Flash Flood Statement', FLW: 'Flood Warning',
  FLA: 'Flood Watch', FLS: 'Flood Statement', HMW: 'Hazardous Materials Warning',
  HWW: 'High Wind Warning', HWA: 'High Wind Watch', HUW: 'Hurricane Warning',
  HUA: 'Hurricane Watch', HLS: 'Hurricane Statement', LEW: 'Law Enforcement Warning',
  LAE: 'Local Area Emergency', NMN: 'Network Message Notification', TOE: '911 Telephone Outage Emergency',
  NUW: 'Nuclear Power Plant Warning', RHW: 'Radiological Hazard Warning',
  SVR: 'Severe Thunderstorm Warning', SVA: 'Severe Thunderstorm Watch', SVS: 'Severe Weather Statement',
  SPW: 'Shelter in Place Warning', SMW: 'Special Marine Warning', SPS: 'Special Weather Statement',
  SSA: 'Storm Surge Watch', SSW: 'Storm Surge Warning', TOR: 'Tornado Warning', TOA: 'Tornado Watch',
  TRW: 'Tropical Storm Warning', TRA: 'Tropical Storm Watch', TSW: 'Tsunami Warning', TSA: 'Tsunami Watch',
  VOW: 'Volcano Warning', WSW: 'Winter Storm Warning', WSA: 'Winter Storm Watch',
});

export const STATE_FIPS = Object.freeze({
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California', '08': 'Colorado',
  '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia',
  '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa', '20': 'Kansas',
  '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan',
  '27': 'Minnesota', '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
  '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York', '37': 'North Carolina',
  '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
  '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont',
  '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
  '60': 'American Samoa', '66': 'Guam', '69': 'Northern Mariana Islands', '72': 'Puerto Rico', '78': 'U.S. Virgin Islands',
  '00': 'the whole United States',
});

/**
 * Soft bits: for every sample, log power at mark minus log power at space over
 * the one-bit window ending there. Positive means mark. Sliding complex sums,
 * so the whole span costs a handful of multiplies per sample.
 */
export function softBits(x, sampleRate) {
  const n = x.length;
  const win = Math.max(4, Math.round(sampleRate / BAUD));
  const tones = [MARK_HZ, SPACE_HZ];
  const acc = tones.map(() => ({ re: new Float64Array(n + 1), im: new Float64Array(n + 1) }));
  for (let k = 0; k < 2; k++) {
    const w = 2 * Math.PI * tones[k] / sampleRate;
    const { re, im } = acc[k];
    // Cumulative sums; the window sum is a difference of two. Recurrence for
    // the oscillator keeps it from calling cos/sin four million times.
    let c = 1, s = 0;
    const dc = Math.cos(w), ds = Math.sin(w);
    for (let i = 0; i < n; i++) {
      re[i + 1] = re[i] + x[i] * c;
      im[i + 1] = im[i] - x[i] * s;
      const c2 = c * dc - s * ds;
      s = s * dc + c * ds;
      c = c2;
    }
  }
  const soft = new Float32Array(n);
  const power = new Float32Array(n);     // log of mark + space power: where the tones are
  for (let i = win; i <= n; i++) {
    const p = [];
    for (let k = 0; k < 2; k++) {
      const { re, im } = acc[k];
      const r = re[i] - re[i - win], m = im[i] - im[i - win];
      p.push(r * r + m * m + 1e-30);
    }
    soft[i - 1] = Math.log(p[0]) - Math.log(p[1]);
    power[i - 1] = Math.log(p[0] + p[1]);
  }
  return { soft, power, win, samplesPerBit: sampleRate / BAUD };
}

/**
 * Where the AFSK actually is. A SAME transmission is a few seconds of tones in
 * a minute or more of voice, alert tone and silence, and a bit clock measured
 * over all of it is measured on the wrong thing — on the shelf's NOAA test
 * recording the transition phases concentrated at 0.008, which is noise, while
 * the bursts alone concentrate at 0.6. So the tone power is thresholded at
 * `aboveMedianDb` over its own median, runs are kept when they last at least
 * `minSec`, and gaps shorter than `mergeSec` are bridged. When the whole span
 * is tones — a synthetic with no gaps — the median IS the tone level and no
 * region clears it; then the span is one region.
 */
export function activeRegions(power, sampleRate, { aboveMedianDb = 9, minSec = 0.25, mergeSec = 0.15 } = {}) {
  const n = power.length;
  if (!n) return [];
  const sorted = Float32Array.from(power).sort();
  const median = sorted[n >> 1];
  const thr = median + aboveMedianDb * Math.LN10 / 10;
  const regions = [];
  let on = false, start = 0;
  const merge = Math.round(mergeSec * sampleRate);
  for (let i = 0; i <= n; i++) {
    const s = i < n && power[i] > thr;
    if (s && !on) {
      on = true;
      const last = regions[regions.length - 1];
      start = last && i - last.to < merge ? regions.pop().from : i;
    } else if (!s && on) { on = false; regions.push({ from: start, to: i }); }
  }
  const kept = regions.filter((r) => r.to - r.from >= minSec * sampleRate);
  return kept.length ? kept : [{ from: 0, to: n }];
}

/**
 * Bit clock from the transitions: the sign of the soft signal flips at bit
 * boundaries, so the fractional phase where flips cluster is the boundary and
 * the centre is half a bit later. Returns the phase and how concentrated the
 * flips were (0 = uniform, 1 = all in one place), which is the evidence that
 * there is a bit clock at all.
 */
export function bitClock(soft, samplesPerBit, { from = 0, to = soft.length } = {}) {
  const bins = 32;
  const hist = new Float64Array(bins);
  let flips = 0;
  for (let i = Math.max(from + 1, 1); i < to; i++) {
    if ((soft[i] > 0) !== (soft[i - 1] > 0)) {
      const phase = (i / samplesPerBit) % 1;
      hist[Math.floor(phase * bins) % bins] += 1;
      flips++;
    }
  }
  if (!flips) return { ok: false, reason: 'no transitions', phase: 0, concentration: 0 };
  // Circular mean of the histogram, which is robust to the wrap at 0.
  let cx = 0, cy = 0;
  for (let b = 0; b < bins; b++) {
    const a = 2 * Math.PI * (b + 0.5) / bins;
    cx += hist[b] * Math.cos(a); cy += hist[b] * Math.sin(a);
  }
  const concentration = Math.hypot(cx, cy) / flips;
  const boundary = ((Math.atan2(cy, cx) / (2 * Math.PI)) + 1) % 1;
  return { ok: true, phase: (boundary + 0.5) % 1, concentration, flips };
}

/** Sample the soft signal at bit centres. */
export function sliceBits(soft, samplesPerBit, phase, { from = 0, to = soft.length } = {}) {
  const bits = [];
  const centres = [];
  const margins = [];      // |mean soft| per bit: how sure the demodulator was
  let t = (Math.floor(from / samplesPerBit) + phase) * samplesPerBit;
  while (t < from) t += samplesPerBit;
  // The decision is the mean of the soft signal over the middle half of the
  // bit, not its value at one sample: the window edges are where a bit is
  // still blended with its neighbour, and one sample there is a coin toss on a
  // noisy copy. Measured on the shelf's NOAA test, this took the three copies
  // of the header from several disputed characters to none.
  const half = Math.max(1, Math.floor(samplesPerBit / 4));
  for (; t < to; t += samplesPerBit) {
    const i = Math.round(t);
    if (i >= soft.length) break;
    let acc = 0, cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(soft.length - 1, i + half); j++) { acc += soft[j]; cnt++; }
    bits.push(acc > 0 ? 1 : 0);
    margins.push(cnt ? Math.abs(acc / cnt) : 0);
    centres.push(i);
  }
  return { bits, centres, margins };
}

/**
 * Bytes from bits at a given byte phase, LSB first. Returns the byte array and
 * the bit index each byte started at.
 */
export function bytesAt(bits, offset, margins = null) {
  const out = [], at = [], conf = [];
  for (let i = offset; i + 8 <= bits.length; i += 8) {
    let b = 0, m = Infinity;
    for (let k = 0; k < 8; k++) {
      b |= bits[i + k] << k;
      if (margins) m = Math.min(m, margins[i + k]);
    }
    out.push(b); at.push(i); conf.push(margins ? m : 1);
  }
  return { bytes: out, at, conf };
}

/**
 * Find the messages in a bit stream: every place a run of preamble bytes is
 * followed by printable ASCII, at whichever of the eight byte phases makes the
 * preamble line up. Returns each message's text and where it sat.
 */
export const UNKNOWN = '\u0000';

export function findMessages(bits, centres, { minPreamble = 4, margins = null } = {}) {
  const found = [];
  for (let offset = 0; offset < 8; offset++) {
    const { bytes, at, conf } = bytesAt(bits, offset, margins);
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] !== PREAMBLE) { i++; continue; }
      let j = i;
      while (j < bytes.length && bytes[j] === PREAMBLE) j++;
      const run = j - i;
      if (run >= minPreamble) {
        // Read text until it stops being text. One or two unprintable bytes in
        // a row are a bit error inside a message, kept as placeholders so the
        // copy still lines up with the others and the vote can fill them; three
        // in a row is the end of the message.
        let text = '';
        const confs = [];
        let k = j, bad = 0;
        for (; k < bytes.length; k++) {
          const c = bytes[k] & 0x7f;
          const printable = c >= 0x20 && c <= 0x7e;
          if (!printable && ++bad >= 3) break;
          if (printable) bad = 0;
          text += printable ? String.fromCharCode(c) : UNKNOWN;
          confs.push(printable ? conf[k] : 0);
          if (text.length > 400) break;
        }
        while (text.endsWith(UNKNOWN)) { text = text.slice(0, -1); confs.pop(); }
        // The last preamble byte often straddles a bit error and reads as '+'
        // (0xAB masked to seven bits) or a neighbour of it. Whatever sits
        // before the first ZCZC or NNNN within the first six characters is
        // that residue, not message.
        const body = /^(?:[^Z N]{0,6})(ZCZC.*|N{3,}.*)$/s.exec(text);
        let drop = 0;
        if (body) { drop = text.length - body[1].length; text = body[1]; }
        if (text.length >= 4) {
          found.push({ text, conf: confs.slice(drop), preambleBytes: run, offset, startBit: at[i], endBit: k < at.length ? at[k] : bits.length,
            startSample: centres[at[i]] ?? null });
        }
        i = Math.max(j, k);
      } else i = j;
    }
  }
  found.sort((a, b) => a.startBit - b.startBit || b.preambleBytes - a.preambleBytes);
  const out = [];
  for (const m of found) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.startBit - m.startBit) < 64) continue;
    out.push(m);
  }
  return out;
}

/**
 * Vote three (or two) repetitions of one header into one, character by
 * character. A burst that takes one character out of one copy is outvoted;
 * where the copies do not even agree on length, the longest that parses wins.
 */
// What kind of character the header grammar allows at a position, derived from
// the voted-so-far prefix: letters inside ORG and EEE, digits inside location
// blocks, purge time and issue time, anything in the sender field. Used to
// break ties between copies, never to invent a character.
function expectedAt(prefix) {
  // ZCZC-ORG-EEE-PSSCCC(-PSSCCC)*+TTTT-JJJHHMM-LLLLLLLL-
  const m = /^ZCZC-([A-Z]{0,3})(-?)([A-Z]{0,3})?(-?)((?:\d{6}-)*\d{0,6})(\+?)(\d{0,4})(-?)(\d{0,7})(-?)(.*)$/s.exec(prefix);
  if (!m) return null;
  const [, org, d1, eee, d2, locs, plus, purge, d3, issued, d4] = m;
  if (org.length < 3) return 'letter';
  if (!d1) return 'dash';
  if ((eee || '').length < 3) return 'letter';
  if (!d2) return 'dash';
  if (!plus) { const tail = locs.length % 7; return tail === 6 ? 'dashOrPlus' : 'digit'; }
  if (purge.length < 4) return 'digit';
  if (!d3) return 'dash';
  if (issued.length < 7) return 'digit';
  if (!d4) return 'dash';
  return null;
}
const fits = (ch, kind) => {
  if (!kind || ch === UNKNOWN) return kind === null;
  if (kind === 'letter') return /[A-Z]/.test(ch);
  if (kind === 'digit') return /\d/.test(ch);
  if (kind === 'dash') return ch === '-';
  if (kind === 'dashOrPlus') return ch === '-' || ch === '+';
  return true;
};

export function voteHeaders(copies) {
  const heads = copies.map((c) => (typeof c === 'string' ? { text: c, conf: null } : c)).filter((c) => c.text.startsWith('ZCZC'));
  if (!heads.length) return null;
  // Copies differ in length when a run of bit errors ended the reader early —
  // a truncation, not a shift, because every copy of a SAME header is the same
  // fixed string. So the vote runs to the longest copy and at each position
  // counts whichever copies reach it, each weighted by how sure the
  // demodulator was of that character's bits. The header's grammar breaks
  // what is left: where a digit has to be, a symbol does not win.
  const complete = heads.filter((h) => h.text.endsWith('-'));
  const len = Math.max(...(complete.length ? complete : heads).map((h) => h.text.length));
  let out = '';
  const disputed = [], thin = [];
  for (let i = 0; i < len; i++) {
    const kind = expectedAt(out);
    const weight = new Map();
    let n = 0, plausible = 0;
    for (const h of heads) {
      if (i >= h.text.length) continue;
      const ch = h.text[i];
      n++;
      if (ch === UNKNOWN) continue;
      const ok = fits(ch, kind);
      if (ok) plausible++;
      const w = (h.conf ? h.conf[i] : 1) + (ok ? 0 : -1e6);
      weight.set(ch, (weight.get(ch) || 0) + w);
    }
    if (!n) break;
    const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) { out += UNKNOWN; disputed.push(i); continue; }
    const ch = ranked[0][0];
    out += ch;
    const votes = heads.filter((h) => i < h.text.length && h.text[i] !== UNKNOWN);
    if (votes.some((h) => h.text[i] !== ch)) disputed.push(i);
    if (n < heads.length) thin.push(i);
  }
  // The last referee is the vocabulary. The originator and event fields each
  // come from a short published list, so where the vote lands on a code that
  // is not in it and some copy's character at that position would make one
  // that is, the vote is overruled — by at most one character per field, and
  // only towards a code some copy actually read. Measured on the shelf's NOAA
  // test: position 11 read P, T and U across the three copies, the weights
  // picked P, and RWP is nothing while RWT is the Required Weekly Test.
  const repaired = [];
  const fix = (from, to, table) => {
    const field = out.slice(from, to);
    if (field.length < to - from || table[field]) return;
    for (let i = from; i < to; i++) {
      for (const h of heads) {
        const alt = h.text[i];
        if (!alt || alt === UNKNOWN || alt === out[i]) continue;
        const cand = out.slice(from, i) + alt + out.slice(i + 1, to);
        if (table[cand]) { out = out.slice(0, from) + cand + out.slice(to); repaired.push(i); return; }
      }
    }
  };
  fix(5, 8, ORIGINATORS);
  fix(9, 12, EVENTS);
  const clean = out.replace(new RegExp(UNKNOWN, 'g'), '?');
  return {
    text: clean, copies: heads.length, agreed: heads.filter((h) => h.text === out).length,
    disputed, thin, repaired, unknown: (out.match(new RegExp(UNKNOWN, 'g')) || []).length,
  };
}

/** The header's fields, in words. Returns null when it is not a SAME header. */
export function parseHeader(text) {
  const m = /^ZCZC-([A-Z]{3})-([A-Z]{3})((?:-\d{6})+)\+(\d{4})-(\d{7})-([^-]{1,8})-?$/.exec(text);
  if (!m) return null;
  const [, org, event, locs, purge, issued, sender] = m;
  const locations = locs.split('-').filter(Boolean).map((code) => {
    const part = code[0], state = code.slice(1, 3), county = code.slice(3, 6);
    const stateName = STATE_FIPS[state] || ('state FIPS ' + state);
    const where = county === '000' ? 'all of ' + stateName : 'county ' + county + ' of ' + stateName;
    const portion = part === '0' ? '' : ' (part ' + part + ')';
    return { code, part, state, county, text: where + portion };
  });
  const purgeH = Number(purge.slice(0, 2)), purgeM = Number(purge.slice(2, 4));
  const day = Number(issued.slice(0, 3)), hh = issued.slice(3, 5), mm = issued.slice(5, 7);
  return {
    originator: org, originatorText: ORIGINATORS[org] || 'originator code ' + org,
    event, eventText: EVENTS[event] || 'event code ' + event,
    locations,
    purge: { hours: purgeH, minutes: purgeM, text: purgeH ? `${purgeH} h${purgeM ? ' ' + purgeM + ' min' : ''}` : `${purgeM} min` },
    issued: { dayOfYear: day, utc: `${hh}:${mm}`, text: `day ${day} at ${hh}:${mm} UTC` },
    sender,
  };
}

/**
 * Decode a span. Options: `minConcentration` (bit-clock evidence a stream has
 * to show before its bits are read), `searchLoHz/HiHz` are accepted for
 * symmetry with the other decoders and ignored: SAME's tones are fixed.
 */
export function decodeSame(x, sampleRate, { minConcentration = 0.25 } = {}) {
  if (!x || x.length < sampleRate * 0.5) return { ok: false, reason: 'span is shorter than half a second' };
  if (sampleRate < 2 * MARK_HZ * 1.1) return { ok: false, reason: `sample rate ${sampleRate} cannot carry a ${MARK_HZ.toFixed(0)} Hz mark` };
  const { soft, power, samplesPerBit } = softBits(x, sampleRate);
  // Each burst gets its own bit clock: the recording's clock and the
  // transmitter's differ by whatever they differ by, and over the seconds
  // between one copy of the header and the next that is a fraction of a bit.
  const regions = activeRegions(power, sampleRate);
  const messages = [];
  const clocks = [];
  for (const reg of regions) {
    const clock = bitClock(soft, samplesPerBit, reg);
    clocks.push({ fromSec: +(reg.from / sampleRate).toFixed(2), toSec: +(reg.to / sampleRate).toFixed(2),
      concentration: clock.ok ? +clock.concentration.toFixed(3) : 0, flips: clock.flips || 0 });
    if (!clock.ok || clock.concentration < minConcentration) continue;
    const { bits, centres, margins } = sliceBits(soft, samplesPerBit, clock.phase, reg);
    for (const m of findMessages(bits, centres, { margins })) messages.push(m);
  }
  const best = clocks.reduce((a, c) => Math.max(a, c.concentration), 0);
  if (best < minConcentration) {
    return {
      ok: false,
      reason: `no ${BAUD.toFixed(2)} baud bit clock between ${SPACE_HZ.toFixed(0)} and ${MARK_HZ.toFixed(0)} Hz in any of `
        + `${regions.length} tone region${regions.length === 1 ? '' : 's'} (transition phases concentrate ${best.toFixed(2)} at best, need ${minConcentration})`,
      regions: clocks,
    };
  }
  if (!messages.length) {
    return { ok: false, reason: `a ${BAUD.toFixed(2)} baud clock is there but no 0xAB preamble followed by text`, regions: clocks };
  }
  messages.sort((a, b) => (a.startSample ?? 0) - (b.startSample ?? 0));
  const clock = clocks.reduce((a, c) => (c.concentration > a.concentration ? c : a), clocks[0]);
  const headers = messages.filter((m) => m.text.startsWith('ZCZC'));
  const eoms = messages.filter((m) => /^N{3,}/.test(m.text));
  const other = messages.filter((m) => !headers.includes(m) && !eoms.includes(m));
  const vote = voteHeaders(headers);
  const parsed = vote ? parseHeader(vote.text) : null;
  const lines = [];
  if (parsed) {
    lines.push(`${parsed.originatorText} · ${parsed.eventText}`);
    lines.push('for ' + parsed.locations.map((l) => l.text).join('; '));
    lines.push(`issued ${parsed.issued.text}, valid ${parsed.purge.text}, from ${parsed.sender.trim()}`);
  }
  const sec = (m) => (m.startSample === null ? null : +(m.startSample / sampleRate).toFixed(2));
  return {
    ok: !!vote,
    reason: vote ? undefined : `preamble and text found but none of it begins ZCZC: ${messages.map((m) => JSON.stringify(m.text.slice(0, 24))).join(', ')}`,
    text: vote ? vote.text : (messages[0] && messages[0].text),
    header: parsed,
    summary: lines,
    copies: vote ? vote.copies : 0,
    agreed: vote ? vote.agreed : 0,
    disputed: vote ? vote.disputed : [],
    thin: vote ? vote.thin : [],
    repaired: vote ? vote.repaired : [],
    unknown: vote ? vote.unknown : 0,
    endOfMessage: eoms.length,
    at: { headers: headers.map(sec), eom: eoms.map(sec) },
    otherText: other.map((m) => m.text.replace(new RegExp(UNKNOWN, 'g'), '?')),
    rawCopies: headers.map((h) => h.text.replace(new RegExp(UNKNOWN, 'g'), '?')),
    regions: clocks,
    clock,
    baud: BAUD,
  };
}

/**
 * Render a SAME transmission: preamble, text, at continuous phase. For the
 * tests and for anyone who wants to hear what one sounds like.
 */
export function encodeSame(text, sampleRate, { repeats = 1, gapSec = 1, amplitude = 0.5, preambleBytes = 16 } = {}) {
  const bytes = [];
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < preambleBytes; i++) bytes.push(PREAMBLE);
    for (const ch of text) bytes.push(ch.charCodeAt(0) & 0xff);
    bytes.push(null);   // a gap
  }
  const bits = [];
  for (const b of bytes) {
    if (b === null) { bits.push(null); continue; }
    for (let k = 0; k < 8; k++) bits.push((b >> k) & 1);
  }
  const spb = sampleRate / BAUD;
  const gap = Math.round(gapSec * sampleRate);
  let total = 0;
  for (const b of bits) total += b === null ? gap : 0;
  total += Math.ceil(bits.filter((b) => b !== null).length * spb) + 16;
  const out = new Float32Array(total);
  let phase = 0, pos = 0, tBit = 0;
  for (const b of bits) {
    if (b === null) { pos += gap; tBit = pos; continue; }
    const hz = b ? MARK_HZ : SPACE_HZ;
    const end = tBit + spb;
    for (; pos < Math.round(end) && pos < out.length; pos++) {
      out[pos] = amplitude * Math.sin(phase);
      phase += 2 * Math.PI * hz / sampleRate;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    tBit = end;
  }
  return out.subarray(0, pos);
}
