// BLIND A/B — the bench's ABX.
//
// The rail already has a sighted A/B: press ORIGINAL or BENCH and hear the
// difference, knowing which is which. That answers "what does the rack do". It
// cannot answer "can I actually hear it", because knowing which button is
// pressed is most of the answer.
//
// This panel takes the same two takes, matches their loudness, hides which is
// which, and counts. The arithmetic and the protocol live in js/abx/trial.js
// and are node-tested; this file is the wiring: slice, measure, play, and put
// what the session says on the screen.
import { Session, levelMatch } from '../abx/trial.js';
import { sliceAudioBuffer, previewWindow } from '../dsp/preview.js';
import { measureLoudness } from '../dsp/loudness.js';

const SPAN_SEC = 10;
const TRIALS = 12;

export function initAbxController(ctx) {
  const { store, engine, $, status } = ctx;
  const host = $('abxHost');
  if (!host) return;
  const R = store.runtime;
  const P = store.project;

  host.innerHTML = `
    <p class="yj-note" id="abxNote">RENDER FIRST — a blind test needs two takes.</p>
    <div class="yj-toolrow">
      <button id="abxStart" class="yj-btn yj-btn-primary" disabled>START</button>
      <button id="abxFinish" class="yj-btn" hidden>FINISH</button>
    </div>
    <div id="abxRun" hidden>
      <div class="yj-toolrow">
        <button id="abxHearA" class="yj-btn">A</button>
        <button id="abxHearB" class="yj-btn">B</button>
        <button id="abxHearX" class="yj-btn yj-btn-primary">X</button>
      </div>
      <div class="yj-toolrow">
        <button id="abxSayA" class="yj-btn">X IS A</button>
        <button id="abxSayB" class="yj-btn">X IS B</button>
      </div>
      <dl class="yj-readouts">
        <div><dt>TRIAL</dt><dd class="yj-well" id="abxTrial">—</dd></div>
        <div><dt>SCORE</dt><dd class="yj-well" id="abxScore">—</dd></div>
      </dl>
    </div>
    <p class="yj-note" id="abxResult" hidden></p>`;

  const el = (id) => host.querySelector('#' + id);
  const note = el('abxNote'), startBtn = el('abxStart'), finishBtn = el('abxFinish');
  const run = el('abxRun'), result = el('abxResult');
  const trialOut = el('abxTrial'), scoreOut = el('abxScore');

  let session = null;
  let takeA = null, takeB = null;     // {channels, sampleRate}
  let gainA = 1, gainB = 1;
  let playing = null;

  const stop = () => { if (playing) { try { playing.stop(); } catch (_) { /* already ended */ } playing = null; } };

  function channelsOf(buffer) {
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  }

  function hear(which) {
    stop();
    const take = which === 'A' ? takeA : takeB;
    const gain = which === 'A' ? gainA : gainB;
    if (!take) return;
    playing = engine.audition(take.channels, { sampleRate: take.sampleRate, gain });
  }

  // Why the panel is not available, in the words of the thing that is missing.
  function readiness() {
    if (!R.buffer) return 'LOAD A SOURCE FIRST.';
    if (!R.renderedBuffer) return 'RENDER FIRST — a blind test needs two takes.';
    // A render with cuts has a different timeline from the source, so the two
    // takes would not be the same moment of audio. Rather than guess at an
    // alignment, say so.
    if (Array.isArray(P.cuts) && P.cuts.length) {
      return 'CUTS ARE ACTIVE — the two takes no longer share a timeline, so a blind span would not be the same moment.';
    }
    // The rack has moved since the render. Comparing against the old take would
    // answer a question about a rack that is no longer on the screen.
    if (ctx.api.renderIsFresh && !ctx.api.renderIsFresh()) {
      return 'THE RACK HAS CHANGED SINCE THE RENDER — RENDER AGAIN, OR THE BLIND TEST ANSWERS AN OLD QUESTION.';
    }
    return null;
  }

  function refresh() {
    if (session) return;
    const why = readiness();
    note.textContent = why || `${TRIALS} TRIALS ON ${SPAN_SEC}S FROM THE PLAYHEAD · 5 RIGHT IN A ROW WOULD ALREADY BE EVIDENCE.`;
    note.hidden = false;
    startBtn.disabled = !!why;
  }

  function begin() {
    const why = readiness();
    if (why) { note.textContent = why; return; }
    const dur = Math.min(R.buffer.duration, R.renderedBuffer.duration);
    const win = previewWindow({ playheadSec: engine.currentTime || 0, durationSec: dur, spanSec: SPAN_SEC, prerollSec: 0 });
    if (!win) { note.textContent = 'NOTHING TO COMPARE.'; return; }
    const a = sliceAudioBuffer(R.buffer, win.startSec, win.endSec);
    const b = sliceAudioBuffer(R.renderedBuffer, win.startSec, win.endSec);
    const ma = measureLoudness(a), mb = measureLoudness(b);
    const match = levelMatch(ma.integrated, mb.integrated, ma.truePeakDb, mb.truePeakDb);
    if (!match.ok) {
      note.textContent = 'NOT A BLIND TEST · ' + match.reason.toUpperCase();
      return;
    }
    takeA = { channels: channelsOf(a), sampleRate: a.sampleRate };
    takeB = { channels: channelsOf(b), sampleRate: b.sampleRate };
    gainA = 10 ** (match.gainADb / 20);
    gainB = 10 ** (match.gainBDb / 20);
    session = new Session({ trials: TRIALS, seed: (Date.now() & 0x7fffffff) || 1, match });
    const plan = session.plan();
    note.hidden = true;
    result.hidden = true;
    run.hidden = false;
    startBtn.hidden = true;
    finishBtn.hidden = false;
    // Say what was done to the levels, not how close they ended up: the two are
    // matched exactly by construction, and the number worth showing is the
    // correction a listener would otherwise have been judging.
    const applied = match.gainBDb - match.gainADb;
    const level = Math.abs(applied) < 0.05
      ? 'LEVELS ALREADY MATCHED'
      : `B ${applied > 0 ? 'RAISED' : 'LOWERED'} ${Math.abs(applied).toFixed(1)} DB TO MATCH`;
    const trimmed = match.commonTrimDb < -0.01
      ? ` · BOTH DOWN ${Math.abs(match.commonTrimDb).toFixed(1)} DB TO STAY UNDER ${match.ceilingDb} DBTP`
      : '';
    status(`BLIND A/B · ${win.startSec.toFixed(1)}–${win.endSec.toFixed(1)}S · ${level}${trimmed} · ${plan.note.toUpperCase()}`);
    draw();
  }

  function draw() {
    const r = session.result();
    trialOut.textContent = session.done ? 'DONE' : `${session.index + 1} / ${session.planned}`;
    scoreOut.textContent = `${r.correct} / ${r.trials}`;
    for (const id of ['abxSayA', 'abxSayB', 'abxHearX']) el(id).disabled = session.done;
  }

  function say(choice) {
    if (!session || session.done) return;
    const right = session.answer(choice);
    status(right ? 'RIGHT' : 'WRONG');
    if (session.done) end(); else draw();
  }

  function end() {
    stop();
    const r = session.result();
    result.hidden = false;
    result.textContent = r.verdict.toUpperCase() + ' · ' + r.reason;
    run.hidden = true;
    finishBtn.hidden = true;
    startBtn.hidden = false;
    session = null;
    takeA = takeB = null;
    refresh();
  }

  startBtn.addEventListener('click', begin);
  finishBtn.addEventListener('click', () => { if (session) end(); });
  el('abxHearA').addEventListener('click', () => hear('A'));
  el('abxHearB').addEventListener('click', () => hear('B'));
  el('abxHearX').addEventListener('click', () => { if (session) hear(session.xIs()); });
  el('abxSayA').addEventListener('click', () => say('A'));
  el('abxSayB').addEventListener('click', () => say('B'));
  store.addEventListener('change', refresh);
  ctx.api.abxStop = stop;
  ctx.api.abxRefresh = refresh;
  refresh();
}
