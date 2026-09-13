// Did two ears hear the same thing, or did one ear hear itself?
//
// A single receiver cannot tell a transmitter from its own noise. This morning
// a live grab on 4724 kHz decoded as clean ALE traffic and was nothing at all:
// the tones stood 0.1 dB above their own gaps. Three statistical gates caught
// it. A second receiver in another country would have caught it instantly and
// without any statistics, because the signal was never on the air.
//
// The asymmetry that this module exists to respect:
//
//   two receivers hearing it is strong evidence it was transmitted
//   a DISTANT receiver not hearing it is almost no evidence at all
//
// The second line is the one that is easy to get wrong. Shortwave reaches some
// places and not others; silence 5000 km away is explained by the ionosphere
// long before it is explained by the signal being absent. Only a receiver
// close enough to share the path, and sensitive enough to have heard it, gets
// to vote against. Everything else abstains, and abstention is reported as
// abstention rather than being quietly counted as agreement.

import { greatCircleKm } from './geo.js';

export const DEFAULTS = Object.freeze({
  minKm: 500,        // two ears closer than this are one ear for this purpose
  // Close enough to share a propagation path, so silence here is evidence.
  // This MUST exceed the minimum separation the picker enforces, or the two
  // constraints exclude each other and the `local` verdict can never fire —
  // which is exactly what happened when the picker moved to clusters at least
  // 400 km apart while this still said 400. On HF, two receivers 1500 km apart
  // see substantially the same sky for a distant transmitter, while being far
  // enough apart not to share a local noise environment.
  nearKm: 1500,
  toleranceHz: 60,   // only 86 of ~865 public receivers discipline their clock
  minOverDb: 6,      // below this a "detection" is floor wander
  maxChance: 0.25,   // above this, an agreement is too cheap to be evidence
  // The occupancy to assume when a receiver's band could not be measured.
  // Returning "maximum chance" for unknown looked conservative and was not: it
  // made every agreement look like a coincidence and killed every on-air
  // verdict the moment one whole-band grab failed. A live sweep measured 41%,
  // so that is the stated assumption, and the result says it was assumed.
  assumedOccupancy: 0.41,
});

/**
 * A receiver that heard nothing anywhere in the span is not a witness. Its
 * antenna may be disconnected, its slot may have been pre-empted, its audio
 * may never have started. A dead ear must abstain, not testify.
 */
export function isDeaf(report) {
  if (!report) return true;
  if (report.error) return true;
  if (!Number.isFinite(report.floorDb)) return true;
  // Nothing at all above the floor across a whole span of shortwave is not a
  // quiet band, it is a receiver with no antenna on it.
  return report.spanOccupancy === 0;
}

/**
 * How surprising is it that two receivers both show energy here?
 *
 * On an empty band, not at all surprising is impossible — it is strong
 * evidence. On the 31-metre broadcast band, where most bins carry something,
 * two receivers agreeing that "there is energy near 9.86 MHz" says nothing:
 * they are hearing two different transmitters. Treating occupancy as the
 * chance any one bin is busy, the chance of an independent coincidence is the
 * product.
 */
export function chanceCoincidence(reports, { assumedOccupancy = DEFAULTS.assumedOccupancy } = {}) {
  if (!reports || reports.length < 2) return 1;
  let product = 1, assumed = 0;
  for (const r of reports) {
    if (Number.isFinite(r.spanOccupancy)) product *= r.spanOccupancy;
    else { product *= assumedOccupancy; assumed++; }
  }
  return { value: product, assumed };
}

/**
 * The verdict for one frequency, given what every receiver reported.
 *
 * Returns `on-air`, `local`, or `inconclusive`, always with `why` naming the
 * evidence and `witnesses` naming who counted. `inconclusive` is a real answer
 * here and the commonest one: most of the time the map simply cannot say.
 */
export function corroborate(reports, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const usable = reports.filter(r => !isDeaf(r));
  const deaf = reports.filter(r => isDeaf(r));

  const base = {
    receivers: reports.length,
    abstained: deaf.length,
    abstainedFor: deaf.map(r => ({ rx: r.rx?.loc ?? r.rx?.host ?? '?', why: r.error ? String(r.error).slice(0, 60) : 'heard nothing anywhere' })),
  };

  if (usable.length < 2) {
    return { ...base, verdict: 'inconclusive', why: `only ${usable.length} receiver${usable.length === 1 ? '' : 's'} returned usable audio, and one ear cannot corroborate itself`, witnesses: [] };
  }

  const heard = usable.filter(r => r.heard && (r.overDb ?? 0) >= o.minOverDb);
  const silent = usable.filter(r => !heard.includes(r));

  if (!heard.length) {
    return { ...base, verdict: 'inconclusive', why: `nothing above ${o.minOverDb} dB at any of ${usable.length} receivers; the channel was empty while we listened`, witnesses: [] };
  }

  // Do the ones that heard it agree on WHERE it is? Two receivers can both be
  // busy near a frequency and be hearing different transmitters.
  const centres = heard.filter(r => Number.isFinite(r.hz)).map(r => r.hz);
  const spreadHz = centres.length > 1 ? Math.max(...centres) - Math.min(...centres) : 0;

  // Agreement can never be finer than the coarsest measurement that produced
  // it. A whole-band waterfall has 29.3 kHz bins, so two transmitters 20 kHz
  // apart land in one bin and their centres "agree exactly" — a claim of 0 Hz
  // agreement that overstates the evidence by a factor of five hundred. The
  // tolerance therefore opens up to the measurement, and the wording says what
  // was actually established.
  const resolutions = heard.map(r => r.resolutionHz).filter(Number.isFinite);
  const resolutionHz = resolutions.length ? Math.max(...resolutions) : 0;
  const tol = Math.max(o.toleranceHz, resolutionHz);
  const agreement = resolutionHz > o.toleranceHz
    ? `to within the ${Math.round(resolutionHz / 100) / 10} kHz these measurements can resolve`
    : `within ${Math.round(spreadHz)} Hz`;

  // The widest separation among receivers that heard it.
  let bestKm = 0, pair = null;
  for (let i = 0; i < heard.length; i++) {
    for (let j = i + 1; j < heard.length; j++) {
      const km = greatCircleKm(heard[i].rx?.gps, heard[j].rx?.gps);
      if (Number.isFinite(km) && km > bestKm) { bestKm = km; pair = [heard[i], heard[j]]; }
    }
  }

  const { value: chance, assumed: assumedFor } = chanceCoincidence(heard, { assumedOccupancy: o.assumedOccupancy });
  const witnesses = heard.map(r => ({
    rx: r.rx?.loc ?? r.rx?.host ?? '?',
    gps: r.rx?.gps ?? null,
    overDb: r.overDb ?? null,
    hz: r.hz ?? null,
  })).sort((a, b) => (b.overDb ?? 0) - (a.overDb ?? 0));

  if (heard.length >= 2 && bestKm >= o.minKm) {
    if (spreadHz > tol) {
      return { ...base, verdict: 'inconclusive', witnesses, separationKm: Math.round(bestKm), resolutionHz,
        why: `${heard.length} receivers heard energy here but their centres disagree by ${Math.round(spreadHz)} Hz, more than the ${Math.round(tol)} Hz that a free-running receiver clock and this measurement's resolution together explain; these are probably different transmitters` };
    }
    if (chance > o.maxChance) {
      return { ...base, verdict: 'inconclusive', witnesses, separationKm: Math.round(bestKm), chanceCoincidence: +chance.toFixed(3), resolutionHz,
        why: `${heard.length} receivers agree, but both bands are busy enough that two unrelated signals land here by chance ${(chance * 100).toFixed(0)}% of the time; agreement this cheap is not evidence`
        + (assumedFor ? ` (${assumedFor} band${assumedFor === 1 ? '' : 's'} could not be measured, so ${(o.assumedOccupancy * 100).toFixed(0)}% was assumed)` : '') };
    }
    return { ...base, verdict: 'on-air', witnesses, separationKm: Math.round(bestKm), chanceCoincidence: +chance.toFixed(3), occupancyAssumedFor: assumedFor || undefined, resolutionHz,
      why: `heard at ${heard.length} receivers ${Math.round(bestKm)} km apart (${pair.map(r => r.rx?.loc ?? '?').join(' and ')}), centres agreeing ${agreement}; a signal present on two independent paths was transmitted`
        + (assumedFor ? `. ${assumedFor} receiver${assumedFor === 1 ? "'s band was" : "s' bands were"} not measured, so how cheap this agreement is rests on an assumed ${(o.assumedOccupancy * 100).toFixed(0)}% occupancy` : '') };
  }

  if (heard.length >= 2) {
    return { ...base, verdict: 'inconclusive', witnesses, separationKm: Math.round(bestKm),
      why: `${heard.length} receivers heard it but the furthest apart are only ${Math.round(bestKm)} km, closer than the ${o.minKm} km that makes them independent` };
  }

  // Exactly one receiver heard it. Silence only counts against it from a
  // neighbour that shares the path AND could have heard it.
  const one = heard[0];
  const neighbours = silent.filter(r => {
    const km = greatCircleKm(one.rx?.gps, r.rx?.gps);
    if (!Number.isFinite(km) || km > o.nearKm) return false;
    return atLeastAsSensitive(r, one);
  });

  if (neighbours.length) {
    return { ...base, verdict: 'local', witnesses, 
      why: `only ${one.rx?.loc ?? 'one receiver'} heard it, while ${neighbours.length} receiver${neighbours.length === 1 ? '' : 's'} within ${o.nearKm} km and at least as sensitive heard nothing; on a shared path that makes it local to the receiver, not on the air` };
  }

  return { ...base, verdict: 'inconclusive', witnesses,
    why: `only ${one.rx?.loc ?? 'one receiver'} heard it, and no receiver near enough to share its path was listening; distant silence is explained by propagation, so this cannot be called either way` };
}

/**
 * Could `candidate` have heard what `hearer` heard? Only a receiver at least
 * as good gets to contradict one that detected something.
 *
 * The obvious test — compare noise floors — is wrong on this network. Every
 * receiver runs AGC, so a floor measured in dBFS on its audio output says what
 * its gain is doing, not how sensitive its antenna is, and the waterfall's dBm
 * scale is calibrated per receiver (each publishes its own `wf_cal`). Neither
 * number is comparable between two ears.
 *
 * What IS comparable is the site's published HF signal-to-noise figure, which
 * is measured the same way at every receiver and is exactly "how quiet is this
 * antenna". Floors are used only as a fallback, and when neither is available
 * the candidate does not get a vote — an unknown receiver is not evidence.
 */
export function atLeastAsSensitive(candidate, hearer, { marginDb = 3 } = {}) {
  const a = candidate?.rx?.snrDb, b = hearer?.rx?.snrDb;
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b - marginDb;
  const fa = candidate?.floorDb, fb = hearer?.floorDb;
  if (Number.isFinite(fa) && Number.isFinite(fb)) return fa <= fb + marginDb;
  return false;
}

/**
 * Where it was loudest. Emphatically NOT a bearing: it is the receiver that
 * happened to have the best path at that moment, which correlates with
 * distance to the transmitter only loosely and sometimes not at all.
 */
export function strongestAt(result) {
  const w = result?.witnesses?.[0];
  if (!w) return null;
  return { rx: w.rx, gps: w.gps, overDb: w.overDb, caveat: 'loudest path, not a direction find' };
}
