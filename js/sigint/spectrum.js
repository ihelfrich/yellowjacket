// Reading a band the way a survey reads it: where is there energy, and is any
// of it worth a closer listen.
//
// A receiver's waterfall arrives as bins of dB on a scale that is calibrated
// per receiver and per antenna, so the absolute numbers are not comparable
// between two ears. Everything here is therefore expressed as dB ABOVE THE
// LOCAL NOISE FLOOR, which is comparable, and the absolute figure is carried
// along only as provenance.
//
// The one thing this had to get right: a single transmitter lands in several
// adjacent bins. A calibration run against the 31-metre broadcast band read
// 9.8584, 9.8566 and 9.8602 MHz as three separate "peaks" when they are one
// station and its skirts. A peak finder that does not merge neighbours will
// report a band as three times as busy as it is.

/**
 * A robust floor for a band that may be crowded.
 *
 * The median is the obvious choice and it is wrong here: on a broadcast band
 * more than half the bins can be occupied, which drags the median up into the
 * signals and hides everything weak. A low quantile stays underneath the
 * traffic. `q` is the fraction of bins assumed to be empty-ish.
 *
 * The limit is worth stating plainly: this survives occupancy up to 1 - q and
 * not beyond. At the default it copes with 85% of the band being busy, which
 * covers real HF comfortably — a live 0-30 MHz survey measured 41% — but a
 * span that is genuinely full end to end has no floor to find and every
 * estimator including this one will return a signal level instead.
 */
export function noiseFloor(bins, { q = 0.15 } = {}) {
  if (!bins || !bins.length) return NaN;
  const sorted = Float64Array.from(bins).sort();
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

/** How much of the band is carrying something, as a fraction of bins. */
export function occupancy(bins, { overDb = 6 } = {}) {
  if (!bins || !bins.length) return NaN;
  const floor = noiseFloor(bins);
  let n = 0;
  for (const v of bins) if (v - floor >= overDb) n++;
  return n / bins.length;
}

/**
 * Peaks by topographic prominence, which is the only thing that works on a
 * band that is actually busy.
 *
 * Thresholding was tried first and fails in both directions at once. On the
 * 31-metre band it split one broadcaster across three bins and called it three
 * stations. On a live 0-30 MHz survey it did the opposite and merged the whole
 * medium-wave band into a single "emission" 10,459 kHz wide centred on nothing
 * — a run of adjacent busy bins with no gap wide enough to break it.
 *
 * Prominence fixes both because it asks a different question. Not "is this bin
 * loud" but "how far must you descend from this bin before you can climb to a
 * louder one". A carrier's own skirts never descend, so they do not count as
 * separate peaks; two real stations 40 kHz apart have a valley between them and
 * do. It is the same measure that stops every hill on a ridge being a summit.
 */
export function emissions(bins, {
  binHz, leftHz = 0, overDb = 8, prominenceDb = 6, floorDb = null, maxWidthHz = Infinity,
} = {}) {
  if (!bins || bins.length < 3 || !Number.isFinite(binHz)) return [];
  const floor = Number.isFinite(floorDb) ? floorDb : noiseFloor(bins);
  const n = bins.length;
  const out = [];

  for (let i = 1; i < n - 1; i++) {
    if (!(bins[i] >= bins[i - 1] && bins[i] > bins[i + 1])) continue;   // local max
    if (bins[i] - floor < overDb) continue;

    // Descend each way to the lowest point before something higher appears.
    let lMin = bins[i];
    for (let k = i - 1; k >= 0; k--) { if (bins[k] > bins[i]) break; if (bins[k] < lMin) lMin = bins[k]; }
    let rMin = bins[i];
    for (let k = i + 1; k < n; k++) { if (bins[k] > bins[i]) break; if (bins[k] < rMin) rMin = bins[k]; }
    const prominence = bins[i] - Math.max(lMin, rMin);
    if (prominence < prominenceDb) continue;

    // Width where the peak has fallen half its prominence: the shoulder of
    // this signal rather than of the one next door.
    const half = bins[i] - prominence / 2;
    let a = i, b = i;
    while (a > 0 && bins[a - 1] >= half && bins[a - 1] <= bins[a]) a--;
    while (b < n - 1 && bins[b + 1] >= half && bins[b + 1] <= bins[b]) b++;
    const widthHz = (b - a + 1) * binHz;
    if (widthHz > maxWidthHz) continue;

    out.push({
      hz: Math.round(leftHz + i * binHz),
      widthHz: Math.round(widthHz),
      overDb: +(bins[i] - floor).toFixed(1),
      prominenceDb: +prominence.toFixed(1),
      absDb: +bins[i].toFixed(1),
      bins: b - a + 1,
    });
  }
  return out.sort((p, q) => q.overDb - p.overDb);
}

/**
 * Stretches of band that are busy end to end, reported separately from the
 * peaks inside them. "The whole of medium wave is occupied" is a true and
 * useful statement; it is just not a transmitter, and giving it a centre
 * frequency pretends it is one.
 */
export function busyRegions(bins, { binHz, leftHz = 0, overDb = 6, minWidthHz = 200000, floorDb = null } = {}) {
  if (!bins || !bins.length || !Number.isFinite(binHz)) return [];
  const floor = Number.isFinite(floorDb) ? floorDb : noiseFloor(bins);
  const out = [];
  let i = 0;
  while (i < bins.length) {
    if (bins[i] - floor < overDb) { i++; continue; }
    let j = i;
    while (j + 1 < bins.length && bins[j + 1] - floor >= overDb) j++;
    const widthHz = (j - i + 1) * binHz;
    if (widthHz >= minWidthHz) {
      out.push({ fromHz: Math.round(leftHz + i * binHz), toHz: Math.round(leftHz + (j + 1) * binHz), widthHz: Math.round(widthHz) });
    }
    i = j + 1;
  }
  return out;
}

/**
 * A whole survey of one span: the floor, how busy it is, and what is on it.
 * `edgeGuardBins` drops the extreme edges of the span, where the receiver's
 * own filter roll-off makes a slope that a peak finder reads as a signal.
 */
export function surveySpan(bins, { binHz, leftHz = 0, overDb = 8, edgeGuardBins = 8, ...rest } = {}) {
  const guard = Math.min(edgeGuardBins, Math.floor(bins.length / 8));
  const inner = Array.prototype.slice.call(bins, guard, bins.length - guard);
  const floor = noiseFloor(inner);
  return {
    leftHz: Math.round(leftHz + guard * binHz),
    rightHz: Math.round(leftHz + (bins.length - guard) * binHz),
    binHz,
    floorDb: +floor.toFixed(1),
    occupancy: +occupancy(inner, { overDb: 6 }).toFixed(3),
    emissions: emissions(inner, { binHz, leftHz: leftHz + guard * binHz, overDb, floorDb: floor, ...rest }),
    busy: busyRegions(inner, { binHz, leftHz: leftHz + guard * binHz, floorDb: floor }),
  };
}
