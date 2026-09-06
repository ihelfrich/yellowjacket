// From a recording to a card, the way the bench does it: a ringing hit, if the
// physics finds one, becomes a modal card; otherwise the longest steady voiced
// run becomes a spectral card at its own f0; failing both, the loudest half
// second is read as peaks. Pure apart from the optional progress callback and
// yield between candidates, so it runs the same in a worker, in the page, and
// in node.

import { highpass, bestHitAsync } from './hits.js';
import { spectralCard } from './spectral.js';
import { trackPitch, voicedRuns } from '../analysis/pitch.js';

export const CARD_SECONDS = 60;

/**
 * Card the source. A ringing hit, if the physics finds one, becomes a modal
 * card; otherwise the longest steady voiced run becomes a spectral card at its
 * own f0; failing both, the loudest half second is read as peaks. Pure apart
 * from the optional progress callback and yield between candidates.
 * → Promise<{ card, path: 'struck' | 'sustained', how }>
 */
export async function cardFromSource(mono, sampleRate, { name = 'source', license = '', seconds = CARD_SECONDS, onProgress = null, yieldFn = null } = {}) {
  const span = mono.subarray(0, Math.min(mono.length, Math.floor(seconds * sampleRate)));
  const hp = highpass(span, sampleRate);
  const best = await bestHitAsync(hp, sampleRate, { tries: 12, name, license, note: 'from the bench.', onProgress, yieldFn });
  if (best && best.card.modes.length >= 2) {
    return { card: best.card, path: 'struck', how: `struck · hit at ${best.hit.start.toFixed(2)} s · ${best.tried.length} candidate${best.tried.length === 1 ? '' : 's'} judged` };
  }
  const track = trackPitch(hp, sampleRate, { minHz: 50, maxHz: 1200 });
  const runs = voicedRuns(track, { minSec: 0.25 }).sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec));
  if (runs.length) {
    const run = runs[0];
    const s = Math.floor(run.startSec * sampleRate), e = Math.min(hp.length, Math.floor(Math.min(run.endSec, run.startSec + 1) * sampleRate));
    const card = spectralCard(hp.subarray(s, e), sampleRate, { name, license, f0Hz: run.meanHz, note: 'from the bench.' });
    return { card, path: 'sustained', how: `sustained · voiced ${(run.endSec - run.startSec).toFixed(1)} s at ${run.meanHz.toFixed(1)} Hz from ${run.startSec.toFixed(2)} s` };
  }
  const win = Math.floor(0.5 * sampleRate);
  let at = 0, most = -1;
  for (let i = 0; i + win <= hp.length; i += win >> 1) { let en = 0; for (let k = i; k < i + win; k++) en += hp[k] * hp[k]; if (en > most) { most = en; at = i; } }
  const card = spectralCard(hp.subarray(at, Math.min(hp.length, at + win)), sampleRate, { name, license, note: 'from the bench.' });
  return { card, path: 'sustained', how: `sustained · loudest half second at ${(at / sampleRate).toFixed(2)} s, read as peaks` };
}

