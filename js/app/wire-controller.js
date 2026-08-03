// WIRE controller: hardware I/O per docs/CONTRACT-WIRE.md. Two independent
// flows share this file: the PATCH exporter (clips -> OP-1/OP-Z drum kit
// .aif, works everywhere) and the Web MIDI layer (notes in, clock out,
// clock-in display + adopt, learn mappings). MIDI state lives in project.wire
// so it persists; Web MIDI objects never leak past js/midi/wire.js.

import { MidiWire } from '../midi/wire.js';
import { ClockOut, ClockIn } from '../midi/clock.js';
import { buildDrumPatch, PATCH_SLOTS } from '../export/op1patch.js';
import { resample } from '../dsp/resample.js';
import { download } from '../export.js';

const PATCH_SOURCE_CAP_SEC = 120;  // resampling runs on the main thread; keep it honest
const CLOCK_UI_MS = 250;
const LED_FLASH_MS = 120;

const LEARN_ACTIONS = [];
for (let i = 0; i < 8; i++) LEARN_ACTIONS.push({ key: 'mute' + (i + 1), label: 'MUTE ' + (i + 1) });
for (let i = 0; i < 8; i++) LEARN_ACTIONS.push({ key: 'scene' + (i + 1), label: 'SCENE ' + (i + 1) });
LEARN_ACTIONS.push({ key: 'fill', label: 'FILL' });

export function initWireController(ctx) {
  const { store, engine, sequencer, views, $, status, statusFault } = ctx;
  const { patternView } = views;
  const P = store.project;
  const R = store.runtime;
  const W = P.wire;

  // ---------- PATCH export (no MIDI required) ----------
  function patchStem() {
    const raw = (P.fileName || 'yellowjacket').replace(/\.[^.]+$/, '');
    const stem = raw.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 24);
    return stem || 'yellowjacket';
  }

  function exportPatch() {
    if (!R.mono || !P.clips.length) return;
    const clips = P.clips.slice().sort((a, b) => a.start - b.start);
    const chosen = clips.slice(0, PATCH_SLOTS);
    const sr = R.sampleRate;
    let totalSec = 0;
    for (const clip of chosen) totalSec += Math.max(0, clip.end - clip.start);
    if (totalSec > PATCH_SOURCE_CAP_SEC) {
      statusFault('PATCH FAULT · ' + Math.round(totalSec) + 's of clips. Carve tighter: a kit holds 12s.');
      return;
    }
    status('PRINTING KIT…', true);
    try {
      const segments = [];
      for (const clip of chosen) {
        const s = Math.max(0, Math.floor(clip.start * sr));
        const e = Math.min(R.mono.length, Math.ceil(clip.end * sr));
        if (e - s < 32) continue;
        const cut = R.mono.slice(s, e);
        segments.push({ samples: sr === 44100 ? cut : resample(cut, sr, 44100) });
      }
      if (!segments.length) {
        statusFault('PATCH FAULT · every clip was too short to slice.');
        return;
      }
      const { bytes, report } = buildDrumPatch({ segments, name: patchStem() });
      download(bytes, patchStem() + '-kit.aif', 'audio/aiff');
      const parts = ['KIT PRINTED · ' + report.slices + (report.slices === 1 ? ' SLICE' : ' SLICES'),
        report.seconds.toFixed(2) + 'S'];
      if (report.scaled) parts.push('TRIMMED TO FIT 12S');
      if (clips.length > PATCH_SLOTS) parts.push('FIRST ' + PATCH_SLOTS + ' OF ' + clips.length + ' CLIPS');
      status(parts.join(' · '));
    } catch (err) {
      statusFault('PATCH FAULT · ' + (err.message || err));
    }
  }

  function refreshPatchButton() {
    $('btnPatch').disabled = !(R.mono && P.clips.length);
  }
  store.addEventListener('change', refreshPatchButton);
  $('btnPatch').addEventListener('click', exportPatch);

  // ---------- Web MIDI ----------
  if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
    $('wireUnsupported').hidden = false;
    $('wireConnect').hidden = true;
    ctx.api.wireRestored = () => {};
    return;
  }

  const wire = new MidiWire();
  const clockOut = new ClockOut();
  const clockIn = new ClockIn();
  let connected = false;
  let armedAction = null;    // action key being learned, or 'base'
  let ledTimer = 0;
  let clockUiTimer = 0;
  let lastTickAt = 0;

  function saveWire(fn) {
    store.update('wire', () => fn());
  }

  function flashLed() {
    const led = $('ledWire');
    led.classList.add('is-on');
    if (ledTimer) clearTimeout(ledTimer);
    ledTimer = setTimeout(() => led.classList.remove('is-on'), LED_FLASH_MS);
  }

  function fmtBinding(m) {
    if (!m) return 'TAP TO LEARN';
    return (m.kind === 'cc' ? 'CC' : 'NOTE') + ' ' + m.num + ' · CH ' + (m.channel + 1);
  }

  function renderMap() {
    const host = $('wireMap');
    host.textContent = '';
    for (const action of LEARN_ACTIONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'yj-wire-chip'
        + (armedAction === action.key ? ' is-armed' : '')
        + (W.mappings[action.key] ? ' is-bound' : '');
      chip.innerHTML = action.label + '<span class="b"></span>';
      chip.querySelector('.b').textContent = armedAction === action.key ? 'SEND SOMETHING…' : fmtBinding(W.mappings[action.key]);
      chip.title = W.mappings[action.key] ? 'Alt+click clears the binding' : 'Click, then move a control on your device';
      chip.addEventListener('click', (e) => {
        if (e.altKey && W.mappings[action.key]) {
          saveWire(() => { delete W.mappings[action.key]; });
          if (armedAction === action.key) armedAction = null;
        } else {
          armedAction = armedAction === action.key ? null : action.key;
        }
        renderMap();
      });
      host.appendChild(chip);
    }
  }

  function refreshNoteBase() {
    $('roNoteBase').textContent = 'NOTES ' + W.noteBase + '-' + (W.noteBase + 7) + ' → TRACKS 1-8';
    $('btnLearnBase').classList.toggle('is-active', armedAction === 'base');
    $('btnLearnBase').textContent = armedAction === 'base' ? 'PRESS A PAD…' : 'LEARN BASE';
  }

  function refreshClockOutButton() {
    $('btnClockOut').textContent = 'CLOCK OUT · ' + (W.clockOut ? 'ON' : 'OFF');
    $('btnClockOut').classList.toggle('is-active', W.clockOut);
  }

  function fillPortSelect(sel, ports, dir, savedId) {
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'NONE';
    sel.appendChild(none);
    for (const p of ports.filter((x) => x.dir === dir)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name.toUpperCase().slice(0, 28);
      sel.appendChild(opt);
    }
    sel.value = savedId && ports.some((x) => x.id === savedId && x.dir === dir) ? savedId : '';
  }

  function refreshPorts() {
    const ports = wire.ports();
    fillPortSelect($('wireIn'), ports, 'in', W.inId);
    fillPortSelect($('wireOut'), ports, 'out', W.outId);
    wire.setInput(W.inId);
    wire.setOutput(W.outId);
  }

  function refreshClockIn() {
    const el = $('roClockIn');
    const fresh = lastTickAt && (performance.now() - lastTickAt) < 2000;
    if (!fresh) {
      el.textContent = 'CLOCK IN · SILENT';
      $('btnAdoptBpm').disabled = true;
      return;
    }
    const bpm = clockIn.bpm;
    if (bpm) {
      el.textContent = 'CLOCK IN · ' + bpm.toFixed(1) + ' BPM' + (clockIn.stable ? '' : ' · SETTLING');
      $('btnAdoptBpm').disabled = !clockIn.stable;
    }
  }

  // ---------- actions ----------
  function actMute(i) {
    store.update('machine', (p) => {
      const t = p.machine.tracks[i];
      if (t) t.mute = !t.mute;
    });
    patternView.setMachine(P.machine);
  }

  function actScene(i) {
    patternView.dispatchEvent(new CustomEvent('scene', { detail: { index: i } }));
  }

  function actFill(on) {
    sequencer.fill = on;
    if (typeof patternView.setFill === 'function') patternView.setFill(on);
  }

  function runAction(key, on) {
    if (key.startsWith('mute')) { if (on) actMute((key.slice(4) | 0) - 1); return; }
    if (key.startsWith('scene')) { if (on) actScene((key.slice(5) | 0) - 1); return; }
    if (key === 'fill') actFill(on);
  }

  function findMapping(kind, channel, num) {
    for (const key of Object.keys(W.mappings)) {
      const m = W.mappings[key];
      if (m && m.kind === kind && m.channel === channel && m.num === num) return key;
    }
    return null;
  }

  function learnBinding(kind, channel, num) {
    if (armedAction === 'base') {
      if (kind !== 'note') return false;
      saveWire(() => { W.noteBase = Math.max(0, Math.min(119, num)); });
      armedAction = null;
      refreshNoteBase();
      renderMap();
      status('NOTE BASE ' + W.noteBase + ' · PADS FIRE TRACKS 1-8');
      return true;
    }
    if (armedAction) {
      const key = armedAction;
      saveWire(() => { W.mappings[key] = { kind, channel, num }; });
      armedAction = null;
      renderMap();
      status('LEARNED · ' + key.toUpperCase() + ' ← ' + fmtBinding(W.mappings[key]));
      return true;
    }
    return false;
  }

  // ---------- incoming MIDI ----------
  wire.addEventListener('noteon', (e) => {
    const { note, velocity, channel } = e.detail;
    flashLed();
    if (learnBinding('note', channel, note)) return;
    const mapped = findMapping('note', channel, note);
    if (mapped) { runAction(mapped, true); return; }
    const track = note - W.noteBase;
    // Through the shared fan-out so an incoming pad hit lights the on-screen
    // pad too: the hardware and the software surface stay in agreement.
    if (track >= 0 && track < 8) {
      if (ctx.api.fireTrack) ctx.api.fireTrack(track, velocity / 127);
      else sequencer.trigger(track, 0, velocity / 127);
    }
  });

  wire.addEventListener('noteoff', (e) => {
    const mapped = findMapping('note', e.detail.channel, e.detail.note);
    if (mapped === 'fill') runAction('fill', false);
  });

  wire.addEventListener('cc', (e) => {
    const { num, value, channel } = e.detail;
    flashLed();
    if (learnBinding('cc', channel, num)) return;
    const mapped = findMapping('cc', channel, num);
    if (mapped) runAction(mapped, value >= 64);
  });

  wire.addEventListener('clocktick', (e) => {
    lastTickAt = performance.now();
    clockIn.feed(e.detail.timeStamp);
  });

  wire.addEventListener('transport', (e) => {
    if (e.detail.type === 'start' || e.detail.type === 'stop') clockIn.reset();
  });

  wire.addEventListener('portschange', refreshPorts);

  // ---------- clock out follows the sequencer ----------
  let clockArmed = false;
  function syncClockOut() {
    const want = W.clockOut && !!W.outId && !!engine.ctx;
    if (want && !clockArmed) {
      clockOut.start(engine.ctx, wire, P.machine);
      clockArmed = true;
    } else if (!want && clockArmed) {
      clockOut.stop();  // sends 0xFC if ticks were flowing
      clockArmed = false;
      return;
    }
    if (clockArmed) clockOut.setRunning(sequencer.running);
  }
  sequencer.addEventListener('state', syncClockOut);

  // ---------- panel wiring ----------
  $('btnMidiConnect').addEventListener('click', async () => {
    try {
      await wire.requestAccess();
    } catch (err) {
      statusFault('MIDI DENIED · the browser said no. Check the permission and try again.');
      return;
    }
    connected = true;
    $('wireConnect').hidden = true;
    $('wireDeck').hidden = false;
    refreshPorts();
    refreshNoteBase();
    refreshClockOutButton();
    renderMap();
    // Cleared before re-arming: connecting twice used to leave the first
    // interval running forever with no handle to stop it.
    if (clockUiTimer) clearInterval(clockUiTimer);
    clockUiTimer = setInterval(refreshClockIn, CLOCK_UI_MS);
    status('MIDI CONNECTED · ' + wire.ports().length + ' PORTS');
  });

  $('wireIn').addEventListener('change', (e) => {
    saveWire(() => { W.inId = e.target.value || null; });
    wire.setInput(W.inId);
    clockIn.reset();
  });
  $('wireOut').addEventListener('change', (e) => {
    saveWire(() => { W.outId = e.target.value || null; });
    wire.setOutput(W.outId);
    syncClockOut();
  });
  $('btnClockOut').addEventListener('click', () => {
    saveWire(() => { W.clockOut = !W.clockOut; });
    refreshClockOutButton();
    syncClockOut();
    status(W.clockOut ? 'CLOCK OUT ARMED · hardware follows when the machine runs' : 'CLOCK OUT OFF');
  });
  $('btnAdoptBpm').addEventListener('click', () => {
    const bpm = clockIn.bpm;
    if (!bpm) return;
    const v = Math.max(40, Math.min(240, Math.round(bpm * 10) / 10));
    store.update('machine', (p) => { p.machine.bpm = v; });
    patternView.setMachine(P.machine);
    status('TEMPO ADOPTED · ' + v.toFixed(1) + ' BPM FROM CLOCK IN');
  });
  $('btnLearnBase').addEventListener('click', () => {
    armedAction = armedAction === 'base' ? null : 'base';
    refreshNoteBase();
    renderMap();
  });

  // RESUME reapplies saved wire prefs; if MIDI was never connected this session
  // the panel just reflects them when the user connects.
  ctx.api.wireRestored = () => {
    refreshNoteBase();
    refreshClockOutButton();
    if (connected) {
      refreshPorts();
      renderMap();
      syncClockOut();
    }
    refreshPatchButton();
  };

  refreshPatchButton();
}
