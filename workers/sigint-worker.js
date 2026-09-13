// SIGINT worker: measurement, segmentation, classification, decoding and the
// two-station arrival difference, off the main thread. Measured on the shelf's
// M08 recording at 85 s: MEASURE held the page for about twenty seconds and
// DECODE for six and a half, with the spectrogram frozen the whole time.
//
// Pure modules only, and the same ones the in-place path calls, so the two
// cannot disagree about an answer — only about which thread produced it.
//
// Protocol: { type: <task>, job, x, sampleRate, opts } in, one of
// { type: 'done', job, result } or { type: 'error', job, message } out. The
// sample buffer is transferred in and never comes back; a caller that still
// needs it keeps its own copy.
import { measure } from '../js/sigint/measure.js';
import { segment } from '../js/sigint/segment.js';
import { classifySegment } from '../js/sigint/classify.js';
import { decodeCw, cutNumbers } from '../js/sigint/decode/cw.js';
import { decodeRtty } from '../js/sigint/decode/rtty.js';
import { identifySelcall } from '../js/sigint/decode/tones.js';
import { decodeSame } from '../js/sigint/decode/same.js';
import { decodeTimeCode } from '../js/sigint/decode/timecode.js';
import { decodeSstv } from '../js/sigint/decode/sstv.js';
import { decodePocsag } from '../js/sigint/decode/pager.js';
import { arrivalDifference, WWV_WWVH } from '../js/sigint/tdoa.js';

/**
 * The jobs this worker knows. Each takes the samples, the rate and its options
 * and returns something structured-cloneable — no functions, no typed arrays
 * the caller expects to share.
 */
export const TASKS = {
  measure: (x, rate, opts) => measure(x, rate, opts),
  segment: (x, rate, opts) => segment(x, rate, opts),
  classify: (x, rate, opts) => classifySegment(x, rate, opts.detection || null, opts),
  tdoa: (x, rate, opts) => arrivalDifference(x, rate, opts.station || WWV_WWVH, opts),
  decode: (x, rate, opts) => {
    const out = [];
    const cw = decodeCw(x, rate, opts.cw || {});
    out.push({
      name: 'MORSE', ok: !!(cw && cw.ok !== false && cw.text), text: cw && cw.text,
      reason: (cw && cw.reason) || 'nothing that keys like Morse',
      note: cw && cw.wpm ? `${cw.wpm.toFixed(1)} wpm` : null,
    });
    if (cw && cw.ok !== false && cw.chars) {
      const cut = cutNumbers(cw.chars);
      if (cut.ok) {
        const odd = cut.unmapped.map((u) => `${u.pattern} x${u.count}`).join(', ');
        out.push({
          name: 'AS ABBREVIATED NUMERALS', ok: true, text: cut.text,
          note: `${Math.round(cut.fit * 100)}% of the characters are cut numerals`
            + (odd ? `; these are not: ${odd}` : ''),
        });
      }
    }
    const rtty = decodeRtty(x, rate, opts.rtty || {});
    out.push({
      name: 'RTTY', ok: !!(rtty && rtty.ok && rtty.text), text: rtty && rtty.text,
      reason: (rtty && rtty.reason) || 'no teleprinter framing found',
    });
    const sel = identifySelcall(x, rate, opts.selcall || {});
    out.push({
      name: 'SELCALL', ok: !!(sel && sel.ok), text: sel && (sel.text || (sel.calls || []).join(' ')),
      reason: (sel && sel.reason) || 'no selective-calling tones',
    });
    // The Emergency Alert System header: who sent it, what for, which counties,
    // when. Three copies voted; the note says how many agreed.
    const same = decodeSame(x, rate, opts.same || {});
    out.push({
      name: 'SAME / EAS', ok: !!(same && same.ok), text: same && same.ok ? same.summary.join(' · ') : same && same.text,
      reason: (same && same.reason) || 'no SAME header',
      note: same && same.ok
        ? `${same.text} — ${same.copies} cop${same.copies === 1 ? 'y' : 'ies'}, ${same.agreed} exact, `
          + `${same.disputed.length} character${same.disputed.length === 1 ? '' : 's'} settled by vote`
          + (same.repaired.length ? `, ${same.repaired.length} by the code tables` : '')
          + (same.endOfMessage ? `; end-of-message ×${same.endOfMessage}` : '')
        : null,
    });
    // WWV / WWVH: the date and time the recording was made, from its 100 Hz
    // subcarrier. Needs a full minute; on less it says so.
    const tc = decodeTimeCode(x, rate, opts.timecode || {});
    out.push({
      name: 'TIME CODE (WWV/WWVH)', ok: !!(tc && tc.ok), text: tc && tc.text,
      reason: (tc && tc.reason) || 'no time code',
      note: tc && tc.ok
        ? `DUT1 ${tc.dut1 === null ? '?' : (tc.dut1 >= 0 ? '+' : '') + tc.dut1.toFixed(1)} s · DST ${tc.dst.atStart ? 'on' : 'off'}`
          + (tc.leapSecondWarning ? ' · leap second warning' : '')
          + (tc.outliers.length ? ` · minutes with bit errors: ${tc.outliers.map((o) => `#${o.index + 1} read ${o.read}`).join(', ')}` : '')
        : null,
    });
    // Slow-scan television: a picture, not a line of text. The bytes travel
    // back with the result and the panel paints them; everything else here is
    // what a reader needs to trust the picture.
    const pic = decodeSstv(x, rate, opts.sstv || {});
    out.push({
      name: 'SSTV', ok: !!(pic && pic.ok), text: pic && pic.text,
      reason: (pic && pic.reason) || 'no SSTV picture',
      note: pic && pic.ok
        ? `VIS ${pic.vis.code}${pic.vis.parityOk === false ? ' (parity failed)' : ''} · `
          + `${pic.linesRead} lines · sync found on ${(pic.syncLock * 100).toFixed(0)}% of them`
          + (pic.notes.length ? ` · ${pic.notes.join('; ')}` : '')
        : null,
      image: pic && pic.ok ? { width: pic.width, height: pic.height, lines: pic.linesRead, rgba: pic.rgba } : null,
    });
    // POCSAG paging. Unencrypted by design and still carrying real traffic,
    // which is why the reader is told how much of it the BCH code had to
    // repair before believing any of it.
    const pg = decodePocsag(x, rate, opts.pocsag || {});
    out.push({
      name: 'POCSAG', ok: !!(pg && pg.ok), text: pg && pg.text,
      reason: (pg && pg.reason) || 'no paging traffic',
      note: pg && pg.ok ? `${pg.baud} baud${pg.inverted ? ', inverted' : ''} · ${pg.note}` : null,
    });
    return out;
  },
};

/** Run one job. Exported so the in-place fallback and the worker share it exactly. */
export function runTask(type, x, sampleRate, opts = {}) {
  const task = TASKS[type];
  if (!task) throw new Error('unknown job: ' + type);
  return task(x, sampleRate, opts);
}

if (typeof self !== 'undefined' && typeof self.onmessage !== 'undefined') {
  self.onmessage = (e) => {
    const msg = e.data || {};
    const { type, job } = msg;
    try {
      self.postMessage({ type: 'done', job, result: runTask(type, msg.x, msg.sampleRate, msg.opts || {}) });
    } catch (error) {
      self.postMessage({ type: 'error', job, message: (error && error.message) || String(error) });
    }
  };
}
