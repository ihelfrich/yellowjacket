// Choosing which ears to listen with.
//
// Pure selection, no network: the fetching and caching live in
// tools/kiwi-net.mjs. Three separate questions, and getting any of them wrong
// quietly ruins a scan.
//
//   Can this receiver hear this frequency, and does it have room for us?
//   Are these receivers independent of each other?
//   Are they anywhere near the transmitter?
//
// The third is the one that was missing. A first watch of five marker channels
// heard none of them: the picker had chosen the quietest receivers on the whole
// network, which were all in North America, while four of the five transmitters
// are in Russia. Good ears in the wrong hemisphere hear nothing at all.

import { greatCircleKm } from './geo.js';

/** Covers the frequency, and has a slot free for us. */
export function canHear(rx, hz) {
  return rx.free > 0 && hz >= rx.lowHz && hz <= rx.highHz;
}

/**
 * Ranked by how quiet the antenna is, then by having a disciplined clock.
 * A receiver with no published figure sorts last rather than being dropped:
 * absent is not the same as bad.
 */
export function rank(list, hz) {
  return list.filter(r => canHear(r, hz)).sort((a, b) => {
    const s = (b.snrDb ?? -1) - (a.snrDb ?? -1);
    if (s) return s;
    return (b.gpsLocked ? 1 : 0) - (a.gpsLocked ? 1 : 0);
  });
}

/**
 * Receivers at least `minKm` from each other, as far apart as possible.
 * The right pick for "is this signal reaching the whole world" — and the wrong
 * one for corroboration, because ears on different continents share almost no
 * propagation and so can confirm very little about each other.
 */
export function spread(list, hz, n = 2, minKm = 1000) {
  const ranked = rank(list, hz).filter(r => r.gps);
  const picked = [];
  for (const r of ranked) {
    if (picked.length >= n) break;
    if (picked.every(p => greatCircleKm(p.gps, r.gps) >= minKm)) picked.push(r);
  }
  return picked;
}

/**
 * Receivers far enough apart to be independent and close enough to share a
 * sky — and, when the transmitter's rough position is known, near enough to it
 * to stand a chance.
 *
 * `minKm` stops two ears in one town counting as two. `maxKm` keeps them on
 * the same side of the ionosphere, so that one hearing something and another
 * not is a fact about the signal rather than about the path. `near` is the
 * transmitter site; when the map cannot supply enough receivers within
 * `withinKm` of it the constraint is dropped rather than returning too few,
 * because a distant ear is still better than no ear.
 */
export function cluster(list, hz, n = 3, minKm = 400, maxKm = 3000, { near = null, withinKm = 4000 } = {}) {
  let ranked = rank(list, hz).filter(r => r.gps);
  if (near) {
    const inRange = ranked.filter(r => greatCircleKm(near, r.gps) <= withinKm);
    if (inRange.length >= n) ranked = inRange;
  }
  let best = [];
  for (const seed of ranked.slice(0, 40)) {
    const group = [seed];
    for (const r of ranked) {
      if (group.length >= n) break;
      if (group.some(g => g.host === r.host)) continue;
      const ok = group.every(g => {
        const km = greatCircleKm(g.gps, r.gps);
        return km >= minKm && km <= maxKm;
      });
      if (ok) group.push(r);
    }
    if (group.length > best.length) best = group;
    if (best.length >= n) break;
  }
  return best;
}
