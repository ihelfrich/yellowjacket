// What changed since last time, which is the only part of a repeated scan
// worth a human's attention.
//
// A scanner that reports everything it finds reports the same eighty lines
// every hour, and the one line that matters is buried in it. The buzzer on
// 4625 kHz has been buzzing since the 1970s; the interesting fact about that
// channel is never "it is buzzing", it is the nine minutes in 2010 when it
// stopped and somebody read names into it.
//
// Two rules keep the diff honest:
//
//   a channel that could not be checked has not changed. A receiver that lost
//   its slot produces silence, and silence from a failed check must never be
//   reported as a transmitter going off the air.
//
//   a change is only reported once the evidence is as good as it was before.
//   Going from 'on-air' on two receivers to 'inconclusive' on one is a change
//   in what we could measure, not a change in the world, and it says so.

/** Was this observation good enough to compare against anything? */
export function isUsable(obs) {
  return !!obs && !obs.error && obs.verdict !== undefined
    && (obs.receivers ?? 0) - (obs.abstained ?? 0) >= 1;
}

const heardIn = (obs) => obs?.verdict === 'on-air' || obs?.verdict === 'local'
  || (obs?.witnesses?.length ?? 0) > 0;

/**
 * Compare one channel's latest observation against the last good one.
 * Returns null when nothing worth saying has happened.
 */
export function changeFor(target, before, after, { toleranceHz = 60 } = {}) {
  if (!isUsable(after)) {
    return { hz: target.hz, name: target.name, kind: 'unchecked',
      note: `could not be checked this pass: ${after?.error || after?.why || 'no usable receiver'}` };
  }
  if (!isUsable(before)) {
    return { hz: target.hz, name: target.name, kind: 'first-look',
      note: `first usable observation: ${after.verdict}`, verdict: after.verdict };
  }

  const was = heardIn(before), now = heardIn(after);

  if (was && !now) {
    // The headline case, and the one that must not be cried wolf. Only call a
    // transmitter stopped if this pass listened at least as hard as last pass.
    const listened = (after.receivers ?? 0) - (after.abstained ?? 0);
    const listenedBefore = (before.receivers ?? 0) - (before.abstained ?? 0);
    if (listened < listenedBefore) {
      return { hz: target.hz, name: target.name, kind: 'weaker-evidence',
        note: `nothing heard, but only ${listened} receiver${listened === 1 ? '' : 's'} were listening against ${listenedBefore} last time; this is a thinner look, not a silence` };
    }
    return { hz: target.hz, name: target.name, kind: 'stopped', priority: 1,
      note: `was ${before.verdict} at ${before.witnesses.length} receiver${before.witnesses.length === 1 ? '' : 's'}, now nothing at ${listened}`,
      wasDb: before.witnesses?.[0]?.overDb ?? null };
  }

  if (!was && now) {
    return { hz: target.hz, name: target.name, kind: 'appeared', priority: 2,
      note: `nothing here last pass, now ${after.verdict} at ${after.witnesses.length} receiver${after.witnesses.length === 1 ? '' : 's'}`,
      verdict: after.verdict, nowDb: after.witnesses?.[0]?.overDb ?? null };
  }

  if (was && now) {
    if (before.verdict !== after.verdict) {
      return { hz: target.hz, name: target.name, kind: 'verdict-changed', priority: 3,
        note: `${before.verdict} -> ${after.verdict}: ${after.why}`, verdict: after.verdict };
    }
    const a = before.witnesses?.[0]?.hz, b = after.witnesses?.[0]?.hz;
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > toleranceHz) {
      return { hz: target.hz, name: target.name, kind: 'moved', priority: 2,
        note: `centre moved ${Math.round(b - a)} Hz, more than a receiver clock explains` };
    }
  }
  return null;
}

/** Every change across a whole pass, most interesting first. */
export function diffPass(targets, previous, current, opts = {}) {
  const out = [];
  for (const t of targets) {
    const key = String(t.hz);
    const c = changeFor(t, previous?.[key], current?.[key], opts);
    if (c) out.push(c);
  }
  const rank = { stopped: 1, appeared: 2, moved: 3, 'verdict-changed': 4, 'first-look': 5, 'weaker-evidence': 6, unchecked: 7 };
  return out.sort((x, y) => (rank[x.kind] ?? 9) - (rank[y.kind] ?? 9));
}

/** The state to carry into the next pass: only observations worth comparing to. */
export function nextState(previous, current) {
  const out = { ...(previous || {}) };
  for (const [k, v] of Object.entries(current || {})) if (isUsable(v)) out[k] = v;
  return out;
}
