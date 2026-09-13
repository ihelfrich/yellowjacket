// The marker watch: a channel that exists to be held, and the moments it
// stops. Pinned on constructed markers whose interruptions are known by
// construction; the shelf recordings it was built against are in the lab note.
import assert from 'node:assert/strict';

import { watchMarker, bandFrames, findMarkerBand, bandEnvelope, markerCycle } from '../js/sigint/marker.js';
import { COLOURS } from './noise-colours.mjs';

export const NAME = 'sigint: marker channels';

const SR = 8000;

/**
 * A buzzer: `toneHz` on for `onSec` every `periodSec`, in hiss. `interrupt`
 * spans replace the buzz with either silence or a voice-shaped band.
 */
function buzzer({ seconds = 90, toneHz = 1200, onSec = 1.2, periodSec = 2.4, amp = 0.4, sigma = 0.02, seed = 3, interrupt = [] } = {}) {
  const n = Math.round(seconds * SR);
  const x = COLOURS.white(n, { sigma, seed });
  const inSpan = (t) => interrupt.find((s) => t >= s.startSec && t < s.endSec);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const hit = inSpan(t);
    if (hit) {
      if (hit.voice) {
        // A band of noise where a voice would be: energy the marker's own
        // band does not explain.
        x[i] += hit.amp * (COLOURS.pink(1, { seed: (i % 977) + 1 })[0] || 0) * 6;
      }
      continue;
    }
    if ((t % periodSec) < onSec) { x[i] += amp * Math.sin(phase); phase += 2 * Math.PI * toneHz / SR; if (phase > 2 * Math.PI) phase -= 2 * Math.PI; }
  }
  return x;
}

export const cases = [
  function anUnbrokenMarkerIsMeasuredAndReportedUnbroken() {
    const r = watchMarker(buzzer({ seconds: 90 }), SR);
    assert.ok(r.ok, r.reason);
    assert.ok(Math.abs(r.cycle.periodSec - 2.4) < 0.15, `period ${r.cycle.periodSec} against 2.4`);
    assert.ok(Math.abs(r.cycle.duty - 0.5) < 0.12, `duty ${r.cycle.duty}`);
    assert.ok(r.band.lowHz <= 1200 && r.band.highHz >= 1200, `band ${r.band.lowHz}-${r.band.highHz} should hold 1200 Hz`);
    assert.equal(r.events.length, 0, JSON.stringify(r.events.slice(0, 3)));
    assert.match(r.text, /unbroken across/);
  },

  function theMomentTheMarkerStopsIsFoundAndTimed() {
    const r = watchMarker(buzzer({ interrupt: [{ startSec: 40, endSec: 52 }] }), SR);
    assert.ok(r.ok, r.reason);
    const holes = r.events.filter((e) => e.kind === 'hole');
    assert.equal(holes.length, 1, JSON.stringify(r.events));
    assert.ok(Math.abs(holes[0].startSec - 40) < 2.5, `hole started at ${holes[0].startSec}`);
    assert.ok(Math.abs(holes[0].seconds - 12) < 2.5, `hole lasted ${holes[0].seconds}`);
    assert.match(holes[0].what, /the marker stopped for/);
    assert.match(holes[0].what, /the channel went quiet/);
  },

  function somethingElseInTheChannelIsSaidToBeThere() {
    const r = watchMarker(buzzer({ interrupt: [{ startSec: 40, endSec: 50, voice: true, amp: 0.5 }] }), SR);
    assert.ok(r.ok, r.reason);
    const hole = r.events.find((e) => e.kind === 'hole');
    assert.ok(hole, JSON.stringify(r.events));
    assert.match(hole.what, /something else was in the channel/);
    const intr = r.events.find((e) => e.kind === 'intrusion');
    assert.ok(intr, 'the energy that replaced the marker is its own finding');
    assert.ok(intr.overDb > 4, `only ${intr.overDb} dB over the background`);
    assert.equal(intr.markerStillOn, false, 'it happened while the marker was silent');
  },

  function aShortGapInsideTheCycleIsNotAnEvent() {
    // The marker is off for half of every cycle by design. A watch that called
    // each of those a hole would report fifty findings a minute.
    const r = watchMarker(buzzer({ seconds: 60 }), SR);
    assert.ok(r.ok, r.reason);
    assert.equal(r.holes, 0);
    assert.ok(r.thresholds.minHoleSec >= 1.5 * r.cycle.periodSec - 0.1,
      `the hole floor ${r.thresholds.minHoleSec} must exceed the cycle ${r.cycle.periodSec}`);
  },

  function aChannelWithNoMarkerIsRefusedRatherThanFilledWithFindings() {
    for (const name of ['white', 'pink', 'bursty', 'faded', 'impulsive']) {
      const r = watchMarker(COLOURS[name](SR * 40, { seed: 12 }), SR);
      assert.equal(r.ok, false, `${name} was given a marker: ${r.text}`);
      assert.match(r.reason, /does not repeat regularly enough|no band|does not cycle|never o/);
    }
    // And it says why a list of departures would be meaningless.
    const r = watchMarker(COLOURS.pink(SR * 40, { seed: 2 }), SR);
    if (/does not repeat regularly enough/.test(r.reason)) {
      assert.match(r.reason, /every second is a departure/);
    }
    assert.match(watchMarker(new Float32Array(SR * 2), SR).reason, /at least eight seconds/);
  },

  function theCycleIsAPeakAndNotTheSearchFloor() {
    // Autocorrelation runs high at short lags for anything that varies slowly,
    // so a signal with no cycle peaks at whatever the floor happens to be: the
    // shelf's 2010 UVB-76 capture came back with a "0.3 s cycle", which was
    // the floor, and 38 departures from a cycle that was not there.
    const sp = bandFrames(COLOURS.faded(SR * 40, { seed: 4 }), SR);
    const band = findMarkerBand(sp);
    assert.ok(band, 'a band is always found; it is the cycle that has to earn its place');
    const cycle = markerCycle(bandEnvelope(sp, band.binLo, band.binHi), sp.hopSec);
    if (cycle.ok) {
      assert.ok(cycle.periodSec > 0.5 + sp.hopSec, `the period ${cycle.periodSec} sits on the search floor`);
    } else {
      assert.match(cycle.reason, /no peak in its autocorrelation|never o|no variance/);
    }
  },

  function theBandIsFoundByPersistenceNotByLoudness() {
    // A marker is narrow and almost always on. A single loud burst somewhere
    // else must not take the band away from it.
    const x = buzzer({ seconds: 60, toneHz: 900 });
    let phase = 0;
    for (let i = Math.round(SR * 20); i < Math.round(SR * 21); i++) { x[i] += 3 * Math.sin(phase); phase += 2 * Math.PI * 2400 / SR; }
    const r = watchMarker(x, SR);
    assert.ok(r.ok, r.reason);
    assert.ok(r.band.lowHz <= 900 && r.band.highHz >= 900, `band ${r.band.lowHz}-${r.band.highHz} should still be the marker's`);
    const intr = r.events.find((e) => e.kind === 'intrusion');
    assert.ok(intr && Math.abs(intr.startSec - 20) < 1.5, 'and the loud burst is an intrusion');
  },
];
