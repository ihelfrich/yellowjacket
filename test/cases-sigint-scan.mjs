// Scanning a band through other people's receivers: reading a spectrum, and
// deciding whether two ears heard the same thing or one ear heard itself.
//
// Every case here is pinned to something that actually went wrong against live
// receivers on 2026-09-13, because all of it went wrong at least once.
import assert from 'node:assert/strict';

import { noiseFloor, occupancy, emissions, busyRegions, surveySpan } from '../js/sigint/spectrum.js';
import { corroborate, isDeaf, chanceCoincidence, strongestAt, atLeastAsSensitive } from '../js/sigint/corroborate.js';
import { greatCircleKm } from '../js/sigint/geo.js';
import { CATALOG, KINDS, byKind, nearest, explain, allocationAt } from '../js/sigint/catalog.js';
import { changeFor, diffPass, isUsable, nextState } from '../js/sigint/watchdiff.js';
import { canHear, rank, spread, cluster } from '../js/sigint/receivers.js';

export const NAME = 'sigint: scanning and corroboration';

const BIN = 1000;   // 1 kHz bins keeps the arithmetic in the cases readable

/** A flat noise floor with peaks painted on, shaped like real carriers. */
function spectrum(n, floorDb, peaks = []) {
  const b = new Float64Array(n).fill(floorDb);
  for (const { bin, db, width = 1 } of peaks) {
    for (let k = -width * 3; k <= width * 3; k++) {
      const i = bin + k;
      if (i < 0 || i >= n) continue;
      const shape = db * Math.exp(-(k * k) / (2 * width * width));
      b[i] = Math.max(b[i], floorDb + shape);
    }
  }
  return Array.from(b);
}

const rx = (id, gps, extra = {}) => ({ rx: { loc: id, host: id + '.example', gps }, ...extra });
const MISSOURI = [37.16, -93.57];
const CHICHESTER = [50.85, -0.66];
const FINLAND = [62.15, 25.69];
const NEAR_MISSOURI = [37.9, -92.1];        // ~150 km away, shares the path
const KANSAS = [39.0, -98.5];               // ~460 km: past the picker's minimum, still one sky

export const cases = [

  // ---------------------------------------------------------------- spectrum

  /**
   * The median is the obvious floor estimate and it fails on exactly the bands
   * worth surveying. A live 0-30 MHz grab read 41% occupancy; a broadcast band
   * reads more. Once more than half the bins carry something the median climbs
   * into the traffic and every weak signal disappears underneath it.
   */
  function aLowQuantileStaysUnderneathHeavyTraffic() {
    const n = 200;
    const b = new Float64Array(n).fill(-100);
    for (let i = 0; i < 120; i++) b[i] = -40;           // 60% of the band is busy
    const floor = noiseFloor(Array.from(b), { q: 0.25 });
    assert.equal(floor, -100, 'the quarter-quantile must still find the empty bins');
    const median = Array.from(b).sort((x, y) => x - y)[Math.floor(n / 2)];
    assert.equal(median, -40, 'the median is up inside the traffic, which is the whole problem');
  },

  /**
   * One transmitter lands in several adjacent bins. Against the 31-metre
   * broadcast band the first version of this reported 9.8584, 9.8566 and
   * 9.8602 MHz as three stations. They are one station and its skirts.
   */
  function oneCarrierWithSkirtsIsOneStation() {
    const b = spectrum(120, -100, [{ bin: 60, db: 45, width: 2 }]);
    const found = emissions(b, { binHz: BIN, overDb: 8, prominenceDb: 6 });
    assert.equal(found.length, 1, 'a carrier and its skirts are one emission');
    assert.equal(found[0].hz, 60 * BIN);
  },

  /** Two real stations with a valley between them stay two stations. */
  function twoStationsWithAValleyBetweenThemStayTwo() {
    const b = spectrum(120, -100, [
      { bin: 40, db: 40, width: 1 },
      { bin: 60, db: 38, width: 1 },
    ]);
    const found = emissions(b, { binHz: BIN, overDb: 8, prominenceDb: 6 });
    assert.equal(found.length, 2);
    assert.deepEqual(found.map(e => e.hz).sort((x, y) => x - y), [40 * BIN, 60 * BIN]);
  },

  /**
   * The defect that replaced the first one. Bridging gaps to merge a carrier
   * with its own skirts also bridged the entire medium-wave band: a live
   * survey reported a single emission 10,459 kHz wide centred on 1.0155 MHz,
   * which is not a transmitter and has no meaningful centre frequency.
   */
  function aWallOfBusyBinsDoesNotBecomeOneEnormousStation() {
    const n = 400;
    const b = new Float64Array(n).fill(-100);
    for (let i = 50; i < 350; i++) b[i] = -45 + 6 * Math.sin(i / 3);   // 300 bins, continuously busy
    const found = emissions(Array.from(b), { binHz: BIN, overDb: 8, prominenceDb: 6 });
    for (const e of found) {
      assert.ok(e.widthHz < 100 * BIN, `no emission may span the whole occupied stretch, got ${e.widthHz} Hz`);
    }
  },

  /** What that wall should be reported as instead. */
  function aContinuouslyOccupiedStretchIsReportedAsARegion() {
    const n = 400;
    const b = new Float64Array(n).fill(-100);
    for (let i = 50; i < 250; i++) b[i] = -45;        // half the span, as a real band runs
    const regions = busyRegions(Array.from(b), { binHz: BIN, minWidthHz: 50 * BIN });
    assert.equal(regions.length, 1);
    assert.equal(regions[0].fromHz, 50 * BIN);
    assert.equal(regions[0].widthHz, 200 * BIN);
  },

  /**
   * The edges of a receiver's span roll off, and a slope reads as a signal to
   * anything looking for a rise. The guard exists so a survey does not report
   * two emissions at the two ends of every window it ever takes.
   */
  function theRollOffAtTheEdgeOfASpanIsNotASignal() {
    const n = 200;
    const b = new Float64Array(n).fill(-100);
    for (let i = 0; i < 12; i++) { b[i] = -60 + i * 3; b[n - 1 - i] = -60 + i * 3; }
    const s = surveySpan(Array.from(b), { binHz: BIN, leftHz: 0, overDb: 8, edgeGuardBins: 16 });
    assert.equal(s.emissions.length, 0, 'the guard must drop the roll-off at both ends');
  },

  /**
   * The floor estimator has a ceiling and it should be stated rather than
   * discovered. Above 1 - q occupied, the quantile is itself inside the
   * traffic and the "floor" it returns is a signal level. Real HF does not go
   * there — a live whole-band survey measured 41% — but a single crowded
   * broadcast window can.
   */
  function theFloorEstimatorHasAStatedCeiling() {
    const n = 400;
    const b = new Float64Array(n).fill(-100);
    for (let i = 0; i < 360; i++) b[i] = -45;          // 90% busy, past the default
    assert.equal(noiseFloor(Array.from(b), { q: 0.15 }), -45, 'past the ceiling it returns a signal level');
    assert.equal(noiseFloor(Array.from(b), { q: 0.05 }), -100, 'a lower quantile still reaches the floor');
  },

  function occupancyCountsBinsNotPower() {
    const b = spectrum(100, -100, [{ bin: 50, db: 60, width: 1 }]);
    assert.ok(occupancy(b, { overDb: 6 }) < 0.1, 'one loud carrier does not make a band busy');
  },

  // ----------------------------------------------------------- corroboration

  /**
   * The thing the whole exercise is for. A signal heard at two receivers on
   * two continents was transmitted; no single receiver can establish that.
   */
  function twoDistantReceiversHearingItMeansItWasTransmitted() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Finland', FINLAND, { heard: true, overDb: 18, hz: 1000, floorDb: -98, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'on-air');
    assert.ok(v.separationKm > 5000);
    assert.match(v.why, /independent paths/);
  },

  /**
   * The asymmetry, and the easiest thing in all of this to get wrong.
   * Shortwave reaches some places and not others. A receiver on another
   * continent hearing nothing is explained by the ionosphere long before it is
   * explained by the transmitter being silent, so it cannot vote against.
   */
  function silenceAtADistantReceiverIsNotEvidenceOfAbsence() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Finland', FINLAND, { heard: false, overDb: 0, floorDb: -100, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'inconclusive', 'one hearer and one distant sceptic settles nothing');
    assert.match(v.why, /propagation/);
  },

  /**
   * The case where silence DOES count: a receiver close enough to share the
   * path, and sensitive enough to have heard it. That is the discriminator
   * that separates a transmitter from interference inside one receiver — the
   * exact failure that produced a confident false ALE decode on 4724 kHz.
   */
  function aNearAndEquallyDeafReceiverHearingNothingMakesItLocal() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Missouri neighbour', NEAR_MISSOURI, { heard: false, overDb: 0, floorDb: -102, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'local');
    assert.match(v.why, /shared path/);
  },

  /** A deafer neighbour's silence proves nothing, however close it is. */
  function aNeighbourWithAWorseFloorDoesNotGetAVote() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -110, spanOccupancy: 0.1 }),
      rx('deaf neighbour', NEAR_MISSOURI, { heard: false, overDb: 0, floorDb: -80, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'inconclusive', 'a receiver 30 dB deafer cannot contradict one that heard it');
  },

  /**
   * Which number decides that. Every receiver on this network runs AGC, so a
   * floor in dBFS describes its gain, not its antenna, and the waterfall's dBm
   * scale is calibrated per receiver. Neither travels. The site's published HF
   * signal-to-noise figure is measured the same way everywhere and is the one
   * comparable quantity, so it wins when both sides have it.
   */
  function sensitivityIsComparedOnTheOneFigureThatTravels() {
    const withSnr = (snrDb, floorDb) => ({ rx: { snrDb }, floorDb });
    // The published figures say the candidate is the better ear; the floors
    // say the opposite. The published figures must decide.
    assert.equal(atLeastAsSensitive(withSnr(45, -60), withSnr(30, -110)), true);
    assert.equal(atLeastAsSensitive(withSnr(20, -120), withSnr(45, -60)), false);
    // With no published figures, floors are the fallback.
    assert.equal(atLeastAsSensitive({ floorDb: -110 }, { floorDb: -100 }), true);
    // And a receiver we know nothing about does not get to contradict one that heard it.
    assert.equal(atLeastAsSensitive({}, { floorDb: -100 }), false);
  },

  /**
   * A receiver with nothing anywhere in its spectrum has no antenna on it, or
   * lost its slot. It must abstain and be reported as abstaining, not counted
   * as a receiver that listened and disagreed.
   */
  function aDeafReceiverAbstainsAndSaysSo() {
    assert.equal(isDeaf({ rx: {}, error: 'socket error' }), true);
    assert.equal(isDeaf({ rx: {}, floorDb: -100, spanOccupancy: 0 }), true);
    assert.equal(isDeaf({ rx: {}, floorDb: -100, spanOccupancy: 0.2 }), false);
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('broken', CHICHESTER, { error: 'socket error', heard: false }),
    ]);
    assert.equal(v.abstained, 1);
    assert.equal(v.abstainedFor[0].why, 'socket error');
    assert.equal(v.verdict, 'inconclusive');
  },

  /**
   * Agreement is only evidence when it is expensive. On a band where nearly
   * every channel carries something, two receivers both showing energy at one
   * frequency is what you would expect from two unrelated transmitters.
   */
  function agreementOnACrowdedBandIsTooCheapToCount() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.8 }),
      rx('Finland', FINLAND, { heard: true, overDb: 20, hz: 1000, floorDb: -98, spanOccupancy: 0.8 }),
    ]);
    assert.equal(v.verdict, 'inconclusive');
    assert.match(v.why, /chance/);
    assert.ok(chanceCoincidence([{ spanOccupancy: 0.8 }, { spanOccupancy: 0.8 }]).value > 0.6);
  },

  /**
   * An unmeasured band must not be treated as the worst case. Returning
   * maximum chance for unknown looked conservative and was the opposite: it
   * made every agreement look like a coincidence, so a single failed
   * whole-band grab silently destroyed every on-air verdict in the pass.
   */
  function anUnmeasuredBandIsAssumedNotFearedTheWorst() {
    const c = chanceCoincidence([{ spanOccupancy: 0.1 }, {}]);
    assert.ok(c.value < 0.25, `unknown must not force a dismissal, got ${c.value}`);
    assert.equal(c.assumed, 1);
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Finland', FINLAND, { heard: true, overDb: 18, hz: 1000, floorDb: -98 }),   // band not measured
    ]);
    assert.equal(v.verdict, 'on-air');
    assert.equal(v.occupancyAssumedFor, 1);
    assert.match(v.why, /assumed 41% occupancy/, 'and the assumption must be stated');
  },

  /**
   * Only 86 of about 865 public receivers discipline their clock against GPS.
   * A small disagreement in measured centre is a free-running oscillator; a
   * large one is two different transmitters, and calling those corroboration
   * would be worse than saying nothing.
   */
  function centresThatDisagreeByMoreThanAClockErrorAreTwoSignals() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Finland', FINLAND, { heard: true, overDb: 20, hz: 1800, floorDb: -98, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'inconclusive');
    assert.match(v.why, /disagree/);
  },

  /** Two ears in one town are one ear for this purpose. */
  /**
   * Agreement cannot be finer than the instrument. A whole-band waterfall has
   * 29.3 kHz bins, so two transmitters 20 kHz apart fall in one bin and their
   * centres "agree to 0 Hz" — a claim five hundred times stronger than the
   * measurement supports. The verdict may still be on-air; the wording must
   * not pretend to a precision that was never there.
   */
  function agreementIsNeverFinerThanTheMeasurement() {
    const at = (hz) => ({ heard: true, overDb: 25, hz, floorDb: -100, spanOccupancy: 0.1, resolutionHz: 29297 });
    const v = corroborate([
      { rx: { loc: 'Missouri', gps: MISSOURI }, ...at(9_000_000) },
      { rx: { loc: 'Finland', gps: FINLAND }, ...at(9_000_000) },
    ]);
    assert.equal(v.verdict, 'on-air');
    assert.equal(v.resolutionHz, 29297);
    assert.doesNotMatch(v.why, /within 0 Hz/, 'must not claim exact agreement from a 29 kHz bin');
    assert.match(v.why, /29\.3 kHz these measurements can resolve/);
  },

  /** And one bin of quantisation is not a disagreement either. */
  function aSingleBinOfQuantisationIsNotTwoTransmitters() {
    const at = (hz) => ({ heard: true, overDb: 25, hz, floorDb: -100, spanOccupancy: 0.1, resolutionHz: 29297 });
    const v = corroborate([
      { rx: { loc: 'Missouri', gps: MISSOURI }, ...at(9_000_000) },
      { rx: { loc: 'Finland', gps: FINLAND }, ...at(9_020_000) },
    ]);
    assert.equal(v.verdict, 'on-air', '20 kHz inside a 29 kHz bin is the same bin');
  },

  function twoReceiversInTheSameTownAreNotIndependent() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Missouri neighbour', NEAR_MISSOURI, { heard: true, overDb: 24, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
    ]);
    assert.equal(v.verdict, 'inconclusive');
    assert.match(v.why, /closer than/);
  },

  function oneEarCannotCorroborateItself() {
    const v = corroborate([rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 })]);
    assert.equal(v.verdict, 'inconclusive');
    assert.match(v.why, /one ear cannot corroborate itself/);
  },

  /** Loudest is not a bearing, and the result says so in words. */
  function theLoudestReceiverIsNotADirectionFind() {
    const v = corroborate([
      rx('Missouri', MISSOURI, { heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 }),
      rx('Finland', FINLAND, { heard: true, overDb: 18, hz: 1000, floorDb: -98, spanOccupancy: 0.1 }),
    ]);
    const s = strongestAt(v);
    assert.equal(s.rx, 'Missouri');
    assert.match(s.caveat, /not a direction find/);
  },

  // ---------------------------------------------------------------- catalogue

  function theCatalogueSeparatesWhatIsKnownFromWhatIsNot() {
    assert.equal(explain(10_000_000).status, 'catalogued');
    assert.equal(explain(4_625_000).entry.name, 'UVB-76 "The Buzzer"');
    assert.equal(explain(9_860_000).status, 'allocated');
    assert.equal(explain(9_860_000).allocation, '31m broadcast');
    assert.equal(explain(6_543_000).status, 'unknown');
  },

  /**
   * The most interesting thing the scanner can find is a transmitter that is
   * supposed to be gone, so those get their own status rather than being
   * filed under "catalogued, nothing to see".
   */
  function aStationBelievedOffTheAirIsFlaggedSeparately() {
    const v = explain(11_545_000);
    assert.equal(v.status, 'historic-hit');
    assert.match(v.entry.name, /Lincolnshire Poacher/);
  },

  function everyEntryCarriesItsConfidenceAndHistoricOnesSayWhy() {
    for (const e of CATALOG) {
      assert.ok(e.name && e.kind && e.mode, `${e.hz} needs a name, a kind and a mode`);
      assert.ok(['fixed', 'reported', 'historic'].includes(e.confidence), `${e.name} has confidence "${e.confidence}"`);
      if (e.confidence === 'historic') assert.ok(e.note, `${e.name} is listed as gone and must say what that means`);
    }
    assert.ok(KINDS.length >= 6);
    assert.ok(byKind('time').length >= 6);
  },

  /** A signal inside a general allocation is not a finding on its own. */
  function ordinaryTrafficInsideAnAllocationIsNotNews() {
    assert.equal(allocationAt(7_100_000), 'amateur 40m');
    assert.equal(allocationAt(1_000_000), 'medium wave broadcast');
    assert.equal(allocationAt(6_543_000), null);
  },

  function nearestRefusesToReachTooFar() {
    assert.equal(nearest(10_000_000).name, 'WWV / WWVH');
    assert.equal(nearest(10_050_000, { toleranceHz: 2000 }), null);
  },

  /**
   * The two distance constraints have to be compatible, and for a while they
   * were not. The picker takes receivers at least 400 km apart so they are
   * independent; corroboration counted a silence as evidence only from within
   * 400 km. Those exclude each other, so with the default geometry the `local`
   * verdict could never fire at all and interference inside one receiver would
   * always have come back as merely inconclusive.
   */
  function theTwoDistanceRulesMustNotExcludeEachOther() {
    const v = corroborate([
      { rx: { loc: 'Missouri', gps: MISSOURI, snrDb: 40 }, heard: true, overDb: 25, hz: 1000, floorDb: -100, spanOccupancy: 0.1 },
      { rx: { loc: 'Kansas', gps: KANSAS, snrDb: 45 }, heard: false, overDb: 0, floorDb: -100, spanOccupancy: 0.1 },
    ]);
    assert.equal(v.verdict, 'local',
      'a receiver 460 km away — past the picker\'s minimum separation — must still be able to contradict');
    assert.ok(greatCircleKm(MISSOURI, KANSAS) > 400, 'and it is genuinely past that minimum');
  },

  // ------------------------------------------------------- choosing the ears

  /**
   * The bug this was written for. A first watch of the five marker channels
   * heard none of them, because the picker took the quietest receivers on the
   * whole network — all in North America — while four of the five transmitters
   * are in Russia. Quality is not the only thing that matters; being able to
   * hear the transmitter matters more.
   */
  function goodEarsInTheWrongHemisphereHearNothing() {
    const at = (host, gps, snrDb) => ({ host, loc: host, gps, snrDb, free: 4, lowHz: 0, highHz: 30e6, gpsLocked: false });
    const list = [
      at('missouri', [37.16, -93.57], 48),
      at('pennsylvania', [40.7, -78.4], 45),
      at('ontario', [45.5, -77.1], 44),
      at('chichester', [50.85, -0.66], 30),
      at('sweden', [59.55, 12.53], 29),
      at('france', [46.43, 0.89], 28),
    ];
    const MOSCOW = [56.08, 37.10];
    const blind = cluster(list, 4_625_000, 2, 400, 3000);
    assert.ok(blind.every(r => r.gps[1] < 0), 'ranking alone picks the loud North American receivers');
    const aimed = cluster(list, 4_625_000, 2, 400, 3000, { near: MOSCOW });
    assert.ok(aimed.every(r => greatCircleKm(MOSCOW, r.gps) < 4000), 'with a site it must pick ears that can hear it');
    assert.ok(aimed.length >= 2);
  },

  /** A site nobody can reach must not leave the scan with no ears at all. */
  function anUnreachableSiteFallsBackToTheBestAvailable() {
    const at = (host, gps, snrDb) => ({ host, loc: host, gps, snrDb, free: 4, lowHz: 0, highHz: 30e6, gpsLocked: false });
    const list = [at('a', [37.16, -93.57], 48), at('b', [40.7, -78.4], 45)];
    const picks = cluster(list, 10e6, 2, 400, 3000, { near: [-45, 170] });   // nothing within 4000 km
    assert.equal(picks.length, 2, 'a distant ear beats no ear');
  },

  function aReceiverWithNoFreeSlotIsNeverOffered() {
    const rxs = [
      { host: 'full', gps: [0, 0], snrDb: 50, free: 0, lowHz: 0, highHz: 30e6 },
      { host: 'open', gps: [10, 10], snrDb: 20, free: 1, lowHz: 0, highHz: 30e6 },
    ];
    assert.equal(canHear(rxs[0], 10e6), false, 'no slot free');
    assert.deepEqual(rank(rxs, 10e6).map(r => r.host), ['open']);
  },

  function aReceiverThatDoesNotCoverTheFrequencyIsNeverOffered() {
    const rx = { host: 'vlf-only', gps: [0, 0], snrDb: 50, free: 4, lowHz: 0, highHz: 500_000 };
    assert.equal(canHear(rx, 10e6), false);
    assert.equal(canHear(rx, 100_000), true);
  },

  /** A published figure is preferred, but its absence is not a demerit. */
  function areceiverWithNoPublishedFigureSortsLastRatherThanVanishing() {
    const rxs = [
      { host: 'unknown', gps: [0, 0], snrDb: null, free: 4, lowHz: 0, highHz: 30e6 },
      { host: 'quiet', gps: [10, 10], snrDb: 40, free: 4, lowHz: 0, highHz: 30e6 },
    ];
    const r = rank(rxs, 10e6);
    assert.deepEqual(r.map(x => x.host), ['quiet', 'unknown']);
    assert.equal(r.length, 2, 'absent is not the same as bad');
  },

  function spreadAndClusterAnswerDifferentQuestions() {
    const at = (host, gps) => ({ host, loc: host, gps, snrDb: 40, free: 4, lowHz: 0, highHz: 30e6 });
    const list = [at('a', [37, -93]), at('b', [40, -78]), at('c', [-33, 151]), at('d', [51, 0])];
    const far = spread(list, 10e6, 2, 5000);
    assert.ok(greatCircleKm(far[0].gps, far[1].gps) >= 5000, 'spread maximises separation');
    const near = cluster(list, 10e6, 2, 400, 3000);
    assert.ok(greatCircleKm(near[0].gps, near[1].gps) <= 3000, 'cluster keeps them under one sky');
  },

  // ------------------------------------------------------------- watch diffing

  /**
   * The headline this whole loop exists to produce, and the only one that
   * earns a priority of 1: a channel that was being held, and is not any more.
   */
  function aMarkerThatStopsIsTheHeadline() {
    const t = { hz: 4_625_000, name: 'UVB-76' };
    const before = { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'a', overDb: 20, hz: 1000 }, { rx: 'b', overDb: 15, hz: 1000 }] };
    const after = { verdict: 'inconclusive', receivers: 2, abstained: 0, witnesses: [], why: 'nothing above 6 dB' };
    const c = changeFor(t, before, after);
    assert.equal(c.kind, 'stopped');
    assert.equal(c.priority, 1);
  },

  /**
   * And the reason that headline is hard to earn. A receiver that lost its
   * slot produces exactly the same silence as a transmitter going off the air.
   * Reporting the first as the second is the worst thing this tool could do,
   * so a thinner look is named as a thinner look.
   */
  function listeningOnFewerEarsIsNotATransmitterGoingSilent() {
    const t = { hz: 4_625_000, name: 'UVB-76' };
    const before = { verdict: 'on-air', receivers: 3, abstained: 0, witnesses: [{ rx: 'a', overDb: 20, hz: 1000 }] };
    const after = { verdict: 'inconclusive', receivers: 3, abstained: 2, witnesses: [], why: 'two receivers dropped' };
    const c = changeFor(t, before, after);
    assert.equal(c.kind, 'weaker-evidence');
    assert.match(c.note, /thinner look/);
  },

  function aChannelThatCouldNotBeCheckedHasNotChanged() {
    const t = { hz: 5_000_000, name: 'WWV' };
    const c = changeFor(t, { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'a', overDb: 9, hz: 1 }] }, { error: 'no receiver covers this frequency' });
    assert.equal(c.kind, 'unchecked');
    assert.equal(isUsable({ error: 'x' }), false);
  },

  function somethingNewOnADeadChannelIsReported() {
    const t = { hz: 11_545_000, name: 'Lincolnshire Poacher' };
    const before = { verdict: 'inconclusive', receivers: 2, abstained: 0, witnesses: [], why: 'empty' };
    const after = { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'a', overDb: 22, hz: 1000 }, { rx: 'b', overDb: 19, hz: 1000 }] };
    const c = changeFor(t, before, after);
    assert.equal(c.kind, 'appeared');
    assert.equal(c.verdict, 'on-air');
  },

  function aCentreThatMovesFurtherThanAClockErrorIsAChange() {
    const t = { hz: 4_625_000, name: 'UVB-76' };
    const on = (hz) => ({ verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'a', overDb: 20, hz }] });
    assert.equal(changeFor(t, on(1000), on(1030)), null, '30 Hz is a receiver clock, not a move');
    assert.equal(changeFor(t, on(1000), on(1400)).kind, 'moved');
  },

  function anUnchangedChannelProducesNothingToRead() {
    const t = { hz: 10_000_000, name: 'WWV' };
    const same = { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'a', overDb: 20, hz: 1000 }] };
    assert.equal(changeFor(t, same, same), null);
  },

  function onlyUsableObservationsBecomeTheBaseline() {
    const prev = { '10000000': { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [] } };
    const now = { '10000000': { error: 'socket error' }, '4625000': { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [] } };
    const next = nextState(prev, now);
    assert.equal(next['10000000'].verdict, 'on-air', 'a failed check must not overwrite a good one');
    assert.ok(next['4625000']);
  },

  function changesAreRankedWithSilenceFirst() {
    const targets = [{ hz: 1, name: 'a' }, { hz: 2, name: 'b' }];
    const heard = { verdict: 'on-air', receivers: 2, abstained: 0, witnesses: [{ rx: 'x', overDb: 20, hz: 100 }] };
    const gone = { verdict: 'inconclusive', receivers: 2, abstained: 0, witnesses: [], why: 'empty' };
    const d = diffPass(targets, { 1: gone, 2: heard }, { 1: heard, 2: gone });
    assert.equal(d[0].kind, 'stopped', 'a channel going quiet outranks a new one appearing');
    assert.equal(d[1].kind, 'appeared');
  },

  // ---------------------------------------------------------------------- geo

  function greatCircleMatchesKnownDistances() {
    // Missouri to Chichester is about 7,000 km by any atlas.
    const km = greatCircleKm(MISSOURI, CHICHESTER);
    assert.ok(km > 6800 && km < 7300, `got ${km}`);
    assert.equal(greatCircleKm(MISSOURI, MISSOURI), 0);
    assert.ok(Number.isNaN(greatCircleKm(null, MISSOURI)));
  },
];
