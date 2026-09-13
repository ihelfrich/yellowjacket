// The WWV / WWVH time code: the date and time a recording was made, read out
// of the recording itself.
//
// Both NIST stations key a 100 Hz subcarrier once a second. A pulse of 170 ms
// is a binary zero, 470 ms a one, 770 ms a position marker; markers fall at
// seconds 9, 19, 29, 39, 49 and 59, and second 0 carries no pulse at all,
// which is what lets a decoder find the top of the minute. The bits between
// the markers are BCD: minutes at seconds 10-17, hours at 20-26, day of year
// at 30-41, the year's last two digits at 4-7 and 51-54, plus DUT1, daylight
// saving and leap-second flags.
//
// Nothing here is tuned to a recording. The subcarrier is a sliding Goertzel
// at 100 Hz; the on/off threshold sits at the geometric mean of the envelope's
// own quiet and loud quantiles; the seconds grid is found by folding pulse
// onsets modulo one second; and the frame is found from the hole after a
// marker. Every minute in the span is decoded on its own and reported, so a
// span of thirteen minutes has to read as thirteen consecutive times or say
// where it did not. The recording of WWV from 8 December 1991 that this was
// built against reads 02:18 UTC in its first minute, which is what its label
// says.
//
// Pure and worker-safe.

export const SUBCARRIER_HZ = 100;
// Pulse widths in the standard, seconds.
export const ZERO_SEC = 0.170, ONE_SEC = 0.470, MARKER_SEC = 0.770;
export const MARKER_SECONDS = [9, 19, 29, 39, 49, 59];
// Seconds that are always zero in the frame. They are a free consistency check:
// a decode that reads ones here has slipped or is not this code.
export const FIXED_ZERO_SECONDS = [1, 8, 14, 18, 24, 27, 28, 34, 42, 43, 44, 45, 46, 47, 48];

/** Envelope of the subcarrier: sliding window power at `hz`, sampled every hop. */
export function subcarrierEnvelope(x, sampleRate, { hz = SUBCARRIER_HZ, winSec = 0.04, hopSec = 0.005 } = {}) {
  const n = x.length;
  const win = Math.max(8, Math.round(winSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const re = new Float64Array(n + 1), im = new Float64Array(n + 1);
  const w = 2 * Math.PI * hz / sampleRate, dc = Math.cos(w), ds = Math.sin(w);
  let c = 1, s = 0;
  for (let i = 0; i < n; i++) {
    re[i + 1] = re[i] + x[i] * c;
    im[i + 1] = im[i] - x[i] * s;
    const c2 = c * dc - s * ds; s = s * dc + c * ds; c = c2;
  }
  const frames = Math.max(0, Math.floor((n - win) / hop) + 1);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = f * hop, b = a + win;
    const r = re[b] - re[a], m = im[b] - im[a];
    env[f] = Math.sqrt(r * r + m * m) / win;
  }
  return { env, hopSec: hop / sampleRate, winSec: win / sampleRate };
}

/** On-runs of the envelope above a self-set threshold, in seconds. */
export function keyedRuns(env, hopSec, { minSec = 0.08, mergeSec = 0.03 } = {}) {
  const sorted = Float32Array.from(env).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const lo = q(0.2), hi = q(0.9);
  const contrastDb = lo > 0 ? 20 * Math.log10(hi / lo) : Infinity;
  const thr = Math.sqrt(Math.max(lo, 1e-12) * Math.max(hi, 1e-12));
  const runs = [];
  let on = false, start = 0;
  for (let i = 0; i <= env.length; i++) {
    const s = i < env.length && env[i] > thr;
    if (s && !on) {
      on = true;
      const last = runs[runs.length - 1];
      start = last && (i * hopSec - last.end) < mergeSec ? runs.pop().start : i * hopSec;
    } else if (!s && on) { on = false; runs.push({ start, end: i * hopSec }); }
  }
  return { runs: runs.filter((r) => r.end - r.start >= minSec).map((r) => ({ ...r, sec: r.end - r.start })), contrastDb, threshold: thr };
}

/**
 * The seconds grid the pulses sit on: an onset every `periodSec`, starting at
 * `phase`. The period is measured rather than assumed to be one second,
 * because a recording's clock is not the station's. The shelf's WWVH capture
 * from 2015 has onsets that advance 11 ms every second — its sample clock runs
 * 1.1% long — and against an assumed 1.000 s grid only 31% of its pulses land,
 * which refused a recording that is perfectly readable once the grid is its
 * own.
 *
 * Period first, from the mode of successive onset differences near a second
 * (split pulses and dropouts fall outside the window). Then phase by folding
 * onsets modulo that period, then both refined by a straight-line fit of onset
 * time against pulse index for the pulses that landed.
 */
export function secondsGrid(runs, { tolSec = 0.15, periodTol = 0.05 } = {}) {
  if (runs.length < 10) return { ok: false, reason: `only ${runs.length} pulses` };
  const diffs = [];
  for (let i = 1; i < runs.length; i++) {
    const d = runs[i].start - runs[i - 1].start;
    if (Math.abs(d - 1) <= periodTol) diffs.push(d);
  }
  if (diffs.length < 5) return { ok: false, reason: `pulses do not recur about once a second (${diffs.length} one-second gaps)` };
  diffs.sort((a, b) => a - b);
  let period = diffs[diffs.length >> 1];
  let phase = 0;
  for (let pass = 0; pass < 3; pass++) {
    let cx = 0, cy = 0;
    for (const r of runs) { const a = 2 * Math.PI * ((r.start / period) % 1); cx += Math.cos(a); cy += Math.sin(a); }
    phase = (((Math.atan2(cy, cx) / (2 * Math.PI)) + 1) % 1) * period;
    // Regression of onset on index for the pulses that landed near the grid.
    let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const r of runs) {
      const k = Math.round((r.start - phase) / period);
      const resid = r.start - (phase + k * period);
      if (Math.abs(resid) > tolSec) continue;
      n++; sk += k; st += r.start; skk += k * k; skt += k * r.start;
    }
    if (n < 5) break;
    const den = n * skk - sk * sk;
    if (den > 0) {
      const slope = (n * skt - sk * st) / den;
      const icpt = (st - slope * sk) / n;
      if (Math.abs(slope - 1) < 0.05) { period = slope; phase = ((icpt % period) + period) % period; }
    }
  }
  let landed = 0;
  for (const r of runs) {
    const k = Math.round((r.start - phase) / period);
    if (Math.abs(r.start - (phase + k * period)) <= tolSec) landed++;
  }
  const onGrid = landed / runs.length;
  if (onGrid < 0.5) return { ok: false, reason: `only ${(100 * onGrid).toFixed(0)}% of pulses sit on a ${period.toFixed(3)} s grid`, phase, periodSec: period };
  return { ok: true, phase, periodSec: period, onGrid, clockErrorPpm: Math.round((period - 1) * 1e6) };
}

/** Classify a pulse width against the standard's three, given the window smear. */
export function symbolFor(widthSec, winSec) {
  // The analysis window lengthens every pulse by about its own width, so the
  // boundaries sit between the standard widths plus that.
  const w = widthSec - winSec;
  if (w < (ZERO_SEC + ONE_SEC) / 2) return '0';
  if (w < (ONE_SEC + MARKER_SEC) / 2) return '1';
  return 'P';
}

/**
 * Pulses onto seconds: one symbol per integer second on the grid. When two
 * runs land in one second (two stations, a dropout that split a pulse) the
 * longer wins for a marker and the earlier for a bit.
 */
export function symbolsBySecond(runs, grid, winSec, { tolSec = 0.15 } = {}) {
  const bySec = new Map();
  const T = grid.periodSec || 1;
  for (const r of runs) {
    const k = Math.round((r.start - grid.phase) / T);
    const d = r.start - (grid.phase + k * T);
    if (Math.abs(d) > tolSec) continue;
    const sym = symbolFor(r.sec, winSec);
    const prev = bySec.get(k);
    if (!prev || (sym === 'P' && prev.sym !== 'P') || (prev.sym !== 'P' && r.sec > prev.sec && sym !== prev.sym && false)) {
      bySec.set(k, { sym, sec: r.sec, at: r.start });
    } else if (prev && sym === prev.sym) {
      // same reading twice: keep the first
    } else if (prev && r.sec > prev.sec * 1.8) {
      bySec.set(k, { sym, sec: r.sec, at: r.start });
    }
  }
  return bySec;
}

/**
 * Where the minute starts. Markers must share a residue modulo 10, and the one
 * at second 59 is the one followed by an empty second. Returns the grid second
 * index that is second 0 of some minute, and the evidence.
 */
export function frameOffset(bySec) {
  const keys = [...bySec.keys()].sort((a, b) => a - b);
  if (!keys.length) return { ok: false, reason: 'no pulses on the grid' };
  const residue = new Array(10).fill(0);
  let markers = 0;
  for (const k of keys) if (bySec.get(k).sym === 'P') { residue[((k % 10) + 10) % 10]++; markers++; }
  if (markers < 3) return { ok: false, reason: `only ${markers} position markers` };
  const m = residue.indexOf(Math.max(...residue));
  const markerShare = residue[m] / markers;
  if (markerShare < 0.6) return { ok: false, reason: `markers do not share a residue modulo 10 (${(100 * markerShare).toFixed(0)}% at the best one)` };
  // Among markers at that residue, the ones followed by a hole vote for the
  // minute boundary.
  const votes = new Map();
  for (const k of keys) {
    const e = bySec.get(k);
    if (e.sym !== 'P' || ((k % 10) + 10) % 10 !== m) continue;
    if (!bySec.has(k + 1) && bySec.has(k + 2)) {
      const zero = ((k + 1) % 60 + 60) % 60;   // grid index of second 0, modulo 60
      votes.set(zero, (votes.get(zero) || 0) + 1);
    }
  }
  if (!votes.size) return { ok: false, reason: 'no marker is followed by the empty second that marks the top of a minute', markerShare };
  const [[zero, n]] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  return { ok: true, zeroMod60: zero, holes: n, holeAgreement: n / total, markerShare, markers };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const bcd = (bits, seconds, weights) => {
  let v = 0, known = 0;
  for (let i = 0; i < seconds.length; i++) {
    const b = bits.get(seconds[i]);
    if (b === '1') v += weights[i];
    if (b === '0' || b === '1') known++;
  }
  return { value: v, known, of: seconds.length };
};

/** Decode one minute given a map second -> symbol for seconds 0..59. */
export function decodeMinute(sec) {
  const minutes = { units: bcd(sec, [10, 11, 12, 13], [1, 2, 4, 8]), tens: bcd(sec, [15, 16, 17], [10, 20, 40]) };
  const hours = { units: bcd(sec, [20, 21, 22, 23], [1, 2, 4, 8]), tens: bcd(sec, [25, 26], [10, 20]) };
  const day = { units: bcd(sec, [30, 31, 32, 33], [1, 2, 4, 8]), tens: bcd(sec, [35, 36, 37, 38], [10, 20, 40, 80]), hundreds: bcd(sec, [40, 41], [100, 200]) };
  const year = { units: bcd(sec, [4, 5, 6, 7], [1, 2, 4, 8]), tens: bcd(sec, [51, 52, 53, 54], [1, 2, 4, 8]) };
  const dut1 = bcd(sec, [56, 57, 58], [0.1, 0.2, 0.4]);
  const flag = (s) => (sec.get(s) === '1' ? true : sec.get(s) === '0' ? false : null);
  const minute = minutes.units.value + minutes.tens.value;
  const hour = hours.units.value + hours.tens.value;
  const dayOfYear = day.units.value + day.tens.value + day.hundreds.value;
  const yy = year.tens.value * 10 + year.units.value;
  // Consistency: markers where markers must be, zeros where zeros must be.
  let markersOk = 0; for (const s of MARKER_SECONDS) if (sec.get(s) === 'P') markersOk++;
  let zerosOk = 0, zerosKnown = 0; for (const s of FIXED_ZERO_SECONDS) { const v = sec.get(s); if (v === '0' || v === '1') { zerosKnown++; if (v === '0') zerosOk++; } }
  let known = 0; for (let s = 1; s < 60; s++) if (sec.has(s)) known++;
  const plausible = minute < 60 && hour < 24 && dayOfYear >= 1 && dayOfYear <= 366;
  const dutSign = flag(50);
  return {
    minute, hour, dayOfYear, year2: yy,
    utc: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    dut1: dutSign === null ? null : (dutSign ? 1 : -1) * +dut1.value.toFixed(1),
    dst: { atStart: flag(2), atEnd: flag(55) },
    leapSecondWarning: flag(3),
    known, of: 59,
    markersOk, markersOf: MARKER_SECONDS.length,
    fixedZerosOk: zerosOk, fixedZerosKnown: zerosKnown,
    plausible,
    hole: !sec.has(0),
  };
}

/** Day of year to a calendar date for a two-digit year, on the 1970-2069 window. */
export function calendar(year2, dayOfYear) {
  if (!(dayOfYear >= 1 && dayOfYear <= 366)) return null;
  const year = year2 >= 70 ? 1900 + year2 : 2000 + year2;
  const d = new Date(Date.UTC(year, 0, dayOfYear));
  if (d.getUTCFullYear() !== year) return null;   // day 366 in a common year
  return { year, month: d.getUTCMonth() + 1, day: d.getUTCDate(), iso: d.toISOString().slice(0, 10) };
}

/**
 * Decode a span. Returns every minute it could read, whether they run
 * consecutively, and the time the span started.
 */
export function decodeTimeCode(x, sampleRate, { minContrastDb = 10 } = {}) {
  if (!x || x.length < sampleRate * 65) return { ok: false, reason: 'a full minute plus a margin is needed; the span is shorter' };
  if (sampleRate < 400) return { ok: false, reason: 'sample rate too low for a 100 Hz subcarrier' };
  const { env, hopSec, winSec } = subcarrierEnvelope(x, sampleRate);
  const { runs, contrastDb } = keyedRuns(env, hopSec);
  if (!(contrastDb >= minContrastDb)) {
    return { ok: false, reason: `no keyed 100 Hz subcarrier: its envelope varies ${contrastDb.toFixed(1)} dB between quiet and loud, need ${minContrastDb}`, contrastDb };
  }
  const grid = secondsGrid(runs);
  if (!grid.ok) return { ok: false, reason: `the 100 Hz pulses do not sit on a one-second grid: ${grid.reason}`, contrastDb };
  const bySec = symbolsBySecond(runs, grid, winSec);
  const frame = frameOffset(bySec);
  if (!frame.ok) return { ok: false, reason: `pulses are on a one-second grid but no minute frame was found: ${frame.reason}`, contrastDb, grid };
  // Every minute whose second 0 sits inside the span.
  const keys = [...bySec.keys()];
  const kMin = Math.min(...keys), kMax = Math.max(...keys);
  const minutes = [];
  let zero = frame.zeroMod60;
  while (zero - 60 >= kMin - 1) zero -= 60;
  for (; zero + 59 <= kMax; zero += 60) {
    const sec = new Map();
    for (let s = 0; s < 60; s++) if (bySec.has(zero + s)) sec.set(s, bySec.get(zero + s).sym);
    if (sec.size < 30) continue;
    const m = decodeMinute(sec);
    m.index = minutes.length;
    m.startsAtSec = +(zero * (grid.periodSec || 1) + grid.phase).toFixed(2);
    m.date = calendar(m.year2, m.dayOfYear);
    minutes.push(m);
  }
  if (!minutes.length) return { ok: false, reason: 'no minute with enough pulses to read', contrastDb, grid, frame };
  // The minutes have to count up by one from a single start. Each plausible
  // minute votes for the start time it implies (its reading minus its index),
  // and the start with the most votes is the span's time; a minute that does
  // not fit that sequence is an outlier with a bit error, and is listed, not
  // averaged in. On the shelf's 2019 WWV/WWVH capture the first minute read
  // 04:50 from two bit errors and the other eleven ran 14:52 to 15:02, which
  // is a 14:51 start; taking the first clean minute would have believed 04:50.
  const good = minutes.filter((m) => m.plausible && m.markersOk >= 5);
  const votes = new Map();
  for (const m of good) {
    const start = ((m.hour * 60 + m.minute - m.index) % 1440 + 1440) % 1440;
    votes.set(start, (votes.get(start) || 0) + 1);
  }
  const top = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1])[0];
  const fitted = top(votes);
  const startMin = fitted ? fitted[0] : null;
  const fits = (m) => startMin !== null && ((startMin + m.index) % 1440) === m.hour * 60 + m.minute;
  const outliers = minutes.filter((m) => !fits(m)).map((m) => ({ index: m.index, read: m.utc, expected: startMin === null ? null : hhmm((startMin + m.index) % 1440) }));
  const inFit = minutes.filter(fits);
  const vote = (key) => { const v = new Map(); for (const m of inFit.length ? inFit : good) v.set(m[key], (v.get(m[key]) || 0) + 1); const t = top(v); return t ? t[0] : null; };
  const dayOfYear = vote('dayOfYear'), year2 = vote('year2');
  const date = dayOfYear !== null && year2 !== null ? calendar(year2, dayOfYear) : null;
  const ok = good.length >= 1 && startMin !== null;
  const first = ok ? hhmm(startMin) : undefined;
  const refMinute = inFit[0] || good[0] || minutes[0];
  const clockNote = grid.clockErrorPpm && Math.abs(grid.clockErrorPpm) >= 500
    ? ` · this recording's seconds run ${(grid.periodSec * 1000).toFixed(0)} ms — its clock is ${(grid.clockErrorPpm / 1e4).toFixed(1)}% off, not the station's`
    : '';
  // The time quoted is the fitted time of the FIRST framed minute at that
  // minute's own position, whether or not that minute read cleanly: the fit
  // is what says what it was.
  const text = ok
    ? `${date ? date.iso : `day ${dayOfYear} of '${String(year2).padStart(2, '0')}`} · ${first} UTC at ${minutes[0].startsAtSec.toFixed(1)} s into the span`
      + (minutes.length > 1 ? ` · ${inFit.length} of ${minutes.length} minutes fit one running clock` + (outliers.length ? `, ${outliers.length} carry bit errors` : '') : '')
      + clockNote
    : undefined;
  return {
    ok,
    reason: ok ? undefined : `minutes were framed but none read as a plausible time with its markers in place (best had ${Math.max(...minutes.map((m) => m.markersOk))} of 6)`,
    text,
    utc: first, atSec: minutes[0].startsAtSec, dayOfYear, year2, date,
    dut1: refMinute.dut1, dst: refMinute.dst, leapSecondWarning: refMinute.leapSecondWarning,
    minutes, outliers, fitted: inFit.length,
    contrastDb: +contrastDb.toFixed(1),
    grid: { phase: +grid.phase.toFixed(3), periodSec: +grid.periodSec.toFixed(5), clockErrorPpm: grid.clockErrorPpm, onGrid: +grid.onGrid.toFixed(3) },
    frame: { markerShare: +frame.markerShare.toFixed(2), holes: frame.holes, holeAgreement: +frame.holeAgreement.toFixed(2) },
    pulses: runs.length,
  };
}

/**
 * Render the code for a run of minutes, for tests and for anyone who wants to
 * hear what a minute of WWV's subcarrier sounds like on its own. `periodSec`
 * other than 1 stretches the recording's clock; `secondStation` adds a second
 * copy delayed and attenuated, which is what a WWV/WWVH capture is; `drop`
 * lists absolute seconds whose pulse is missing.
 */
export function encodeTimeCode({ hour, minute, dayOfYear, year2, dut1 = 0, dst = false, leap = false,
  minutes = 1, sampleRate = 8000, periodSec = 1, amplitude = 0.5, noiseSigma = 0,
  secondStation = null, drop = [], lead = 0 } = {}) {
  const bit = (v, w) => ((v & w) ? '1' : '0');
  const frame = (h, m) => {
    const f = new Array(60).fill('0');
    f[0] = null;
    for (const s of MARKER_SECONDS) f[s] = 'P';
    f[2] = dst ? '1' : '0'; f[3] = leap ? '1' : '0';
    const yu = year2 % 10, yt = Math.floor(year2 / 10);
    [4, 5, 6, 7].forEach((s, i) => { f[s] = bit(yu, 1 << i); });
    [10, 11, 12, 13].forEach((s, i) => { f[s] = bit(m % 10, 1 << i); });
    [15, 16, 17].forEach((s, i) => { f[s] = bit(Math.floor(m / 10), 1 << i); });
    [20, 21, 22, 23].forEach((s, i) => { f[s] = bit(h % 10, 1 << i); });
    [25, 26].forEach((s, i) => { f[s] = bit(Math.floor(h / 10), 1 << i); });
    [30, 31, 32, 33].forEach((s, i) => { f[s] = bit(dayOfYear % 10, 1 << i); });
    [35, 36, 37, 38].forEach((s, i) => { f[s] = bit(Math.floor(dayOfYear / 10) % 10, 1 << i); });
    [40, 41].forEach((s, i) => { f[s] = bit(Math.floor(dayOfYear / 100), 1 << i); });
    f[50] = dut1 >= 0 ? '1' : '0';
    [51, 52, 53, 54].forEach((s, i) => { f[s] = bit(yt, 1 << i); });
    f[55] = dst ? '1' : '0';
    const mag = Math.round(Math.abs(dut1) * 10);
    [56, 57, 58].forEach((s, i) => { f[s] = bit(mag, 1 << i); });
    return f;
  };
  const total = Math.ceil((lead + minutes * 60 * periodSec + 1) * sampleRate);
  const out = new Float32Array(total);
  const width = { '0': ZERO_SEC, '1': ONE_SEC, P: MARKER_SEC };
  const paint = (startSec, sec, amp) => {
    const a = Math.round(startSec * sampleRate), n = Math.round(sec * sampleRate);
    for (let i = 0; i < n && a + i < out.length; i++) out[a + i] += amp * Math.sin(2 * Math.PI * SUBCARRIER_HZ * (a + i) / sampleRate);
  };
  let abs = 0;
  for (let k = 0; k < minutes; k++) {
    const f = frame((hour + Math.floor((minute + k) / 60)) % 24, (minute + k) % 60);
    for (let s = 0; s < 60; s++, abs++) {
      if (f[s] === null || drop.includes(abs)) continue;
      const t = lead + abs * periodSec;
      paint(t, width[f[s]], amplitude);
      if (secondStation) paint(t + secondStation.delaySec, width[f[s]], amplitude * 10 ** (-secondStation.dbDown / 20));
    }
  }
  if (noiseSigma) {
    let seed = 7;
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const u = seed / 4294967296;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out[i] += noiseSigma * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * seed / 4294967296);
    }
  }
  return out;
}
