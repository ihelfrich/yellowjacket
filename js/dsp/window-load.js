// Windowed loading of long encoded captures: fetch a byte range, decode it,
// and place it on the source's clock. An MPEG stream resynchronises at any
// frame boundary, so a range cut anywhere decodes (experiment 2, lab log);
// the window's position is estimated from the stream's average bitrate, so
// it is stated as "≈". Exact for CBR; within a few seconds for VBR.

export const WINDOW_SPANS_SEC = Object.freeze([120, 300, 600]);
export const DEFAULT_WINDOW_SEC = 300;

function finite(n, fallback = 0) { return Number.isFinite(n) ? n : fallback; }

// Byte range for [startSec, startSec + spanSec) of a file of totalBytes and
// totalSec, skipping `headBytes` of container header at the front.
// Returns {start, end, startSec, spanSec, approx} or null when unloadable.
export function windowRange({ totalBytes, totalSec, startSec = 0, spanSec = DEFAULT_WINDOW_SEC, headBytes = 0 } = {}) {
  const bytes = finite(totalBytes);
  const secs = finite(totalSec);
  if (!(bytes > 0) || !(secs > 0)) return null;
  const head = Math.max(0, Math.min(bytes - 1, finite(headBytes)));
  const span = Math.max(1, Math.min(secs, finite(spanSec, DEFAULT_WINDOW_SEC)));
  let from = Math.max(0, Math.min(secs, finite(startSec)));
  if (from + span > secs) from = Math.max(0, secs - span);
  const bps = (bytes - head) / secs;
  const start = Math.floor(head + from * bps);
  const end = Math.min(bytes - 1, Math.ceil(head + (from + span) * bps) - 1);
  if (end <= start) return null;
  return { start, end, startSec: from, spanSec: span, approx: from > 0 };
}

export function clock(sec) {
  const s = Math.max(0, Math.round(finite(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
}

// "12:00" / "1:02:30" / "750" → seconds, or null.
export function parseClock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
}

export function windowLabel(title, range) {
  if (!range) return title;
  return title + ' · ' + (range.approx ? '≈ ' : '') + clock(range.startSec) + ' + ' + clock(range.spanSec);
}
