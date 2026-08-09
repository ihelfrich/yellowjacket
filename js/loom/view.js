// LOOM is a compiler/inspector surface, not another DAW. It renders one shared
// 16-step coordinate grid so source, MIDI gesture, destinations, and hardware
// routing remain visibly aligned.

import { noteName } from '../studio/model.js';

function node(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== '') el.textContent = text;
  return el;
}

function button(label, className = 'yj-btn') {
  const el = node('button', className, label);
  el.type = 'button';
  return el;
}

function seconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const min = Math.floor(total / 60);
  const sec = total - min * 60;
  return String(min).padStart(2, '0') + ':' + sec.toFixed(3).padStart(6, '0');
}

function duration(material) {
  return material ? Math.max(0, material.endSec - material.startSec) : 0;
}

function shortSource(value) {
  return String(value || 'SOURCE').replace(/\.[^.]+$/, '').toUpperCase().slice(0, 24);
}

function readout(label, value) {
  const row = node('div');
  row.append(node('dt', '', label), node('dd', 'yj-well', value));
  return row;
}

export class LoomView extends EventTarget {
  constructor(host) {
    super();
    this.host = host;
    this.state = {
      material: null, gesture: null, gestureOptions: [], gestureChoice: 'demo',
      plan: null, selectedEventId: null, activeEventId: null, playing: false,
      armedSceneIndex: null, armedPlanId: null, sourceOnline: null,
      midiCaptureAvailable: false, midiCaptureState: 'unavailable',
    };
  }

  setState(next) {
    Object.assign(this.state, next || {});
    this.render();
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _sourceOnline() {
    return this.state.sourceOnline == null ? !!this.state.hasSource : !!this.state.sourceOnline;
  }

  _armedScene() {
    const s = this.state;
    if (!s.plan || !Number.isInteger(s.armedSceneIndex)) return null;
    if (s.armedPlanId && s.armedPlanId !== s.plan.id) return null;
    return s.armedSceneIndex;
  }

  render() {
    if (!this.host) return;
    const s = this.state;
    this.host.textContent = '';
    const root = node('div', 'yj-loom');
    root.append(this._equation(), this._inputs());
    if (s.plan) root.append(this._output());
    else root.append(this._emptyMap());
    this.host.appendChild(root);
    requestAnimationFrame(() => this._drawMaterialWave());
  }

  _equation() {
    const s = this.state;
    const panel = node('section', 'yj-panel yj-loom-equation');
    panel.dataset.label = 'LOOM / MATERIAL × GESTURE';
    const row = node('div', 'yj-loom-equation-row');
    const material = node('output', 'yj-well yj-loom-equation-well', s.material
      ? shortSource(s.material.sourceName) + ' / ' + duration(s.material).toFixed(2) + 'S'
      : 'NO MATERIAL');
    const gesture = node('output', 'yj-well yj-loom-equation-well', s.gesture
      ? s.gesture.label + ' / ' + s.gesture.events.length + ' NOTES'
      : 'NO GESTURE');
    const result = node('output', 'yj-well yj-loom-equation-well yj-loom-result', s.plan
      ? 'WEAVE ' + String(s.plan.weaveNumber).padStart(2, '0') + ' · '
        + s.plan.diagnostics.tracedCount + '/' + s.plan.diagnostics.eventCount + ' TRACED'
      : (s.material && s.gesture ? 'READY' : 'WAITING'));
    result.setAttribute('role', 'status');
    row.append(material, node('span', 'yj-loom-operator', '×'), gesture,
      node('span', 'yj-loom-operator', '='), result);
    const thesis = node('p', 'yj-loom-thesis', 'RECORDINGS SUPPLY MEANING · MIDI SUPPLIES GESTURE · HARDWARE SUPPLIES TOUCH');
    panel.append(row, thesis);
    return panel;
  }

  _inputs() {
    const wrap = node('div', 'yj-loom-inputs');
    wrap.append(this._materialPanel(), this._gesturePanel(), this._weavePanel());
    return wrap;
  }

  _materialPanel() {
    const s = this.state;
    const online = this._sourceOnline();
    const panel = node('section', 'yj-panel yj-loom-material');
    panel.dataset.label = 'MATERIAL';
    const led = node('div', 'yj-led-row');
    led.append(node('span', 'yj-led' + (s.material ? ' is-on' : '')),
      node('span', 'yj-led-text', s.material ? 'MATERIAL READY' : 'NO MATERIAL'));
    if (s.material) {
      panel.append(led, node('output', 'yj-well yj-loom-source-readout',
        shortSource(s.material.sourceName) + ' · ' + seconds(s.material.startSec) + '–'
          + seconds(s.material.endSec) + ' · '
          + (s.material.kind === 'transcript'
            ? (s.material.wordCount || s.material.materials.length) + ' WORDS → '
              + s.material.materials.length + ' VOICES'
            : s.material.materials.length + ' SPANS')));
      const canvas = node('canvas', 'yj-loom-wave');
      canvas.id = 'loomMaterialWave';
      panel.appendChild(canvas);
      const tokens = node('div', 'yj-loom-token-strip');
      s.material.materials.forEach((item, index) => {
        const token = button(item.label, 'yj-loom-token');
        token.disabled = !online;
        token.title = online
          ? seconds(item.origin.startSec) + '–' + seconds(item.origin.endSec)
          : 'Source audio is offline; provenance remains available in the weave map';
        token.addEventListener('click', () => this._emit('hearmaterial', { materialIndex: index }));
        tokens.appendChild(token);
      });
      panel.appendChild(tokens);
    } else {
      panel.append(led, node('p', 'yj-loom-empty', 'SELECT WORDS IN TRANSCRIPT OR USE A REAL REGION OF THE LOADED SOURCE.'));
    }
    const tools = node('div', 'yj-toolrow');
    const use = button('USE SELECTION');
    use.disabled = !s.hasSource;
    use.addEventListener('click', () => this._emit('materialselect'));
    const demo = button('DEMO REGION');
    demo.disabled = !s.hasSource;
    demo.addEventListener('click', () => this._emit('demomaterial'));
    tools.append(use, demo);
    panel.append(tools, node('p', 'yj-canvas-note', s.material && s.material.kind === 'transcript'
      ? (s.material.wordCount || s.material.materials.length) + ' WORDS → '
        + s.material.materials.length + ' VOICES · SOURCE SPANS PRESERVED'
      : 'SOURCE SPANS PRESERVED · NO FABRICATED WORDS'));
    return panel;
  }

  _gesturePanel() {
    const s = this.state;
    const panel = node('section', 'yj-panel yj-loom-gesture');
    panel.dataset.label = 'GESTURE / HUMAN INPUT';
    const led = node('div', 'yj-led-row');
    led.append(node('span', 'yj-led' + (s.gesture ? ' is-on' : '')),
      node('span', 'yj-led-text', s.gesture ? 'GESTURE READY' : 'NO GESTURE'));
    const select = node('select', 'yj-select');
    select.setAttribute('aria-label', 'Loom gesture source');
    for (const option of s.gestureOptions || []) {
      const item = node('option', '', option.label);
      item.value = option.id;
      item.disabled = option.disabled === true;
      select.appendChild(item);
    }
    select.value = s.gestureChoice || 'demo';
    select.addEventListener('change', () => this._emit('gesturechange', { id: select.value }));
    panel.append(led, select);
    if (s.gesture) {
      panel.appendChild(node('output', 'yj-well yj-loom-gesture-readout',
        s.gesture.label + ' · CH ' + String((s.gesture.channel || 0) + 1).padStart(2, '0')
          + ' · 1 BAR · ' + s.gesture.events.length + ' NOTES'));
      panel.appendChild(this._midiMini(s.gesture));
    } else {
      panel.appendChild(node('p', 'yj-loom-empty', 'WRITE A STUDIO BAR OR USE THE DETERMINISTIC DEMO MIDI PHRASE.'));
    }
    const captureState = ['idle', 'armed', 'capturing'].includes(s.midiCaptureState)
      ? s.midiCaptureState : 'unavailable';
    const captureActive = captureState === 'armed' || captureState === 'capturing';
    const captureAvailable = !!s.midiCaptureAvailable || captureActive;
    const capture = node('div', 'yj-loom-capture' + (captureActive ? ' is-active' : ''));
    const captureButton = button(
      captureActive ? 'CANCEL CAPTURE' : (captureAvailable ? 'ARM 1 BAR' : 'CONNECT MIDI IN WIRE'),
      'yj-btn yj-btn-primary yj-loom-capture-btn',
    );
    captureButton.disabled = !captureAvailable;
    captureButton.title = captureActive ? 'Cancel this MIDI capture and keep the prior gesture'
      : (captureAvailable ? 'Capture one bar from the selected WIRE MIDI input'
        : 'Choose and connect a MIDI input in Machine / Wire');
    captureButton.addEventListener('click', () => this._emit(captureActive ? 'cancelcapture' : 'capturemidi'));
    const captureLed = node('span', 'yj-led' + (captureActive ? ' is-busy' : (captureAvailable ? ' is-on' : '')));
    captureLed.setAttribute('aria-hidden', 'true');
    const captureCopy = node('output', 'yj-loom-capture-copy', captureState === 'armed'
      ? 'WAITING FOR FIRST NOTE'
      : (captureState === 'capturing' ? 'CAPTURING · 1 BAR'
        : (captureAvailable ? 'MIDI INPUT READY · 1 BAR' : 'MIDI INPUT OFFLINE')));
    captureCopy.setAttribute('role', 'status');
    captureCopy.setAttribute('aria-live', 'polite');
    capture.append(captureButton, captureLed, captureCopy);
    const tools = node('div', 'yj-toolrow');
    const studio = button('OPEN STUDIO');
    studio.addEventListener('click', () => this._emit('replacegesture'));
    const wire = button('OPEN WIRE');
    wire.addEventListener('click', () => this._emit('openwire'));
    tools.append(studio, wire);
    panel.append(capture, tools, node('p', 'yj-canvas-note', captureAvailable
      ? 'CAPTURE · SELECTED WIRE INPUT · NOTE + VELOCITY + GATE'
      : 'CONNECT A MIDI INPUT IN WIRE · STUDIO AND STARTER GESTURES REMAIN AVAILABLE'));
    return panel;
  }

  _midiMini(gesture) {
    const roll = node('div', 'yj-loom-midi-mini');
    const byStep = Array.from({ length: 16 }, () => []);
    for (const event of gesture.events) {
      const raw = Number.isFinite(Number(event.gridStep)) ? Number(event.gridStep) : Number(event.stepIndex);
      if (!Number.isFinite(raw)) continue;
      byStep[((Math.floor(raw) % 16) + 16) % 16].push(event);
    }
    for (let step = 0; step < 16; step++) {
      const events = byStep[step];
      const event = events[0];
      const cell = node('span', 'yj-loom-midi-step' + (event ? ' is-on' : '')
        + (events.length > 1 ? ' is-collision' : ''), events.length > 1 ? '×' + events.length
          : (event ? noteName(event.rootNote) : '·'));
      if (event) {
        const peakVelocity = Math.max(...events.map((item) => Number(item.velocity) || 0));
        cell.style.setProperty('--fill', Math.round(peakVelocity * 100) + '%');
        cell.title = 'STEP ' + (step + 1) + ' · ' + events.map((item) => noteName(item.rootNote)
          + ' · VEL ' + Math.round(item.velocity * 127)).join(' / ');
      }
      roll.appendChild(cell);
    }
    return roll;
  }

  _weavePanel() {
    const s = this.state;
    const panel = node('section', 'yj-panel yj-loom-build');
    panel.dataset.label = 'WEAVE';
    const reads = node('dl', 'yj-readouts');
    reads.append(readout('TEMPO', s.gesture ? Number(s.gesture.bpm).toFixed(2) : '—'),
      readout('MAP', 'SOURCE → NOTE'), readout('MODE', 'CYCLE'));
    const weave = button(s.plan ? 'REWEAVE' : 'WEAVE', 'yj-btn yj-btn-primary yj-btn-block');
    weave.id = 'btnLoomWeave';
    weave.disabled = !(s.material && s.gesture);
    weave.addEventListener('click', () => this._emit('weave'));
    const state = node('div', 'yj-led-row');
    state.append(node('span', 'yj-led' + (s.plan ? ' is-on' : (s.material && s.gesture ? ' is-busy' : ''))),
      node('span', 'yj-led-text', s.plan ? 'WEAVE COMPLETE' : (s.material && s.gesture ? 'READY' : 'WAITING')));
    panel.append(reads, weave, state);
    return panel;
  }

  _emptyMap() {
    const panel = node('section', 'yj-panel yj-loom-empty-map');
    panel.dataset.label = 'WEAVE MAP';
    panel.append(node('div', 'yj-loom-empty-hero', 'NO WEAVE'),
      node('p', 'yj-loom-empty', 'LOAD BOTH INPUTS. LOOM WILL ALIGN EVERY OUTPUT EVENT TO ITS SOURCE SPAN AND MIDI GESTURE.'));
    return panel;
  }

  _output() {
    const s = this.state;
    const armedScene = this._armedScene();
    const armed = armedScene != null;
    const online = this._sourceOnline();
    const wrap = node('div', 'yj-loom-output');
    const mapPanel = node('section', 'yj-panel yj-loom-map-panel');
    mapPanel.dataset.label = 'WEAVE MAP';
    mapPanel.appendChild(this._map());

    const armState = node('div', 'yj-loom-arm-state' + (armed ? ' is-armed' : '') + (!online ? ' is-offline' : ''));
    const armLed = node('span', 'yj-led' + (armed ? ' is-on' : (!online ? ' is-fault' : '')));
    armLed.setAttribute('aria-hidden', 'true');
    const armCopy = node('output', 'yj-loom-arm-copy', armed
      ? 'SCENE ' + (armedScene + 1) + ' ARMED · ' + s.plan.events.length
        + (s.plan.events.length === 1 ? ' EVENT' : ' EVENTS')
      : (online ? 'NOT ARMED · WEAVE REMAINS NON-DESTRUCTIVE' : 'SOURCE OFFLINE · TRACE REMAINS AVAILABLE'));
    armCopy.setAttribute('role', 'status');
    armState.append(armLed, armCopy);

    const actions = node('div', 'yj-toolrow yj-loom-output-actions');
    const audition = button(s.playing ? 'AUDITIONING…' : 'AUDITION WEAVE');
    audition.disabled = s.playing || !online;
    audition.title = online ? 'Audition this weave from its immutable source spans'
      : 'Source audio is offline; trace data is still available';
    audition.addEventListener('click', () => this._emit('audition'));
    const stop = button('STOP');
    stop.disabled = !s.playing;
    stop.addEventListener('click', () => this._emit('stop'));
    const arm = button(armed ? 'UPDATE SCENE' : 'ARM TO SCENE', 'yj-btn yj-btn-primary');
    arm.disabled = !online;
    arm.title = !online ? 'Source audio is offline; reconnect it before arming a scene'
      : (armed ? 'Update scene ' + (armedScene + 1) + ' from this weave'
        : 'Commit this weave to the active Machine scene');
    arm.addEventListener('click', () => this._emit('arm', {
      planId: s.plan && s.plan.id,
      sceneIndex: armedScene,
    }));
    const openMachine = button('OPEN MACHINE');
    openMachine.disabled = !armed;
    openMachine.title = armed ? 'Open Machine at scene ' + (armedScene + 1)
      : 'Arm this weave to a Machine scene first';
    openMachine.addEventListener('click', () => this._emit('openmachine', { sceneIndex: armedScene }));
    const wire = button('OPEN WIRE · OP-Z OFFLINE');
    wire.addEventListener('click', () => this._emit('openwire'));
    actions.append(audition, stop, arm, openMachine, wire);
    const replace = node('div', 'yj-toolrow yj-loom-replace-actions');
    const material = button('REPLACE MATERIAL · KEEP GESTURE');
    material.addEventListener('click', () => this._emit('replacematerial'));
    const gesture = button('REPLACE GESTURE · KEEP MATERIAL');
    gesture.addEventListener('click', () => this._emit('replacegesture'));
    replace.append(material, gesture);
    mapPanel.append(armState, actions, replace,
      node('p', 'yj-canvas-note', 'REPLACE EITHER INPUT INDEPENDENTLY. EVERY OUTPUT EVENT RETAINS BOTH ORIGINS.'));
    wrap.append(mapPanel, this._tracePanel());
    return wrap;
  }

  _map() {
    const plan = this.state.plan;
    const grid = node('div', 'yj-loom-map');
    grid.setAttribute('role', 'grid');
    const byStep = Array.from({ length: 16 }, () => []);
    for (const event of plan.events) {
      const raw = Number.isFinite(Number(event.gridStep)) ? Number(event.gridStep) : Number(event.stepIndex);
      if (!Number.isFinite(raw)) continue;
      byStep[((Math.floor(raw) % 16) + 16) % 16].push(event);
    }
    const rows = [
      ['STEP', (event, step) => String(step + 1).padStart(2, '0')],
      ['SOURCE', (event) => event ? event.source.label : '·'],
      ['MIDI', (event) => event ? noteName(event.gesture.note) : '·'],
      ['MACHINE', (event) => event ? 'V' + event.targets.machineVoice : '·'],
      ['STUDIO', (event) => event ? noteName(event.targets.studioNote) : '·'],
      ['OP-Z', (event) => event ? String(event.targets.opzChannel).padStart(2, '0') : '·'],
    ];
    for (const [label, value] of rows) {
      const row = node('div', 'yj-loom-map-row');
      row.appendChild(node('div', 'yj-loom-lane', label));
      for (let step = 0; step < 16; step++) {
        const events = byStep[step];
        const event = events[0] || null;
        if (label === 'STEP') {
          row.appendChild(node('span', 'yj-loom-map-step', value(event, step)));
          continue;
        }
        if (!event) {
          row.appendChild(node('span', 'yj-loom-map-cell is-rest', '·'));
          continue;
        }
        const cell = button(events.length > 1 ? '×' + events.length : value(event, step),
          'yj-loom-map-cell is-event' + (events.length > 1 ? ' is-collision' : ''));
        cell.dataset.eventId = event.id;
        cell.classList.toggle('is-selected', events.some((item) => item.id === this.state.selectedEventId));
        cell.classList.toggle('is-playing', events.some((item) => item.id === this.state.activeEventId));
        cell.title = events.map((item) => 'EVENT ' + (item.ordinal + 1) + ' · ' + item.source.label
          + ' × ' + noteName(item.gesture.note)).join(' / ')
          + (events.length > 1 ? ' · CLICK TO CYCLE' : '');
        cell.setAttribute('aria-label', cell.title);
        cell.addEventListener('click', () => {
          const at = events.findIndex((item) => item.id === this.state.selectedEventId);
          this._emit('eventselect', { id: events[(at + 1) % events.length].id });
        });
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    return grid;
  }

  _tracePanel() {
    const plan = this.state.plan;
    const event = plan.events.find((item) => item.id === this.state.selectedEventId) || plan.events[0];
    const panel = node('aside', 'yj-panel yj-loom-trace');
    panel.dataset.label = event ? 'TRACE / EVENT ' + String(event.ordinal + 1).padStart(2, '0') : 'TRACE';
    if (!event) return panel;
    const gridStep = Number.isFinite(Number(event.gridStep)) ? Number(event.gridStep) : Number(event.stepIndex);
    const reads = node('dl', 'yj-readouts');
    reads.append(
      readout('OUTPUT', 'STEP ' + String(gridStep + 1).padStart(2, '0') + ' · V' + event.targets.machineVoice),
      readout('MATERIAL', '“' + event.source.label.toUpperCase().slice(0, 18) + '”'),
      readout('SOURCE', seconds(event.source.startSec) + '–' + seconds(event.source.endSec)),
      readout('GESTURE', noteName(event.gesture.note) + ' · VEL ' + Math.round(event.gesture.velocity * 127)),
      readout('PROCESS', (event.transform.semitones >= 0 ? '+' : '') + event.transform.semitones + ' ST · '
        + event.transform.rate.toFixed(2) + '×'),
      readout('OP-Z', 'CH ' + String(event.targets.opzChannel).padStart(2, '0') + ' · OFFLINE'),
    );
    const tools = node('div', 'yj-toolrow');
    const hear = button('HEAR MATERIAL');
    const online = this._sourceOnline();
    hear.disabled = !online;
    hear.title = online ? 'Hear this event from its immutable source span'
      : 'Source audio is offline; trace data remains available';
    hear.addEventListener('click', () => this._emit('hearevent', { id: event.id }));
    const trace = button('TRACE SOURCE', 'yj-btn yj-btn-primary');
    trace.addEventListener('click', () => this._emit('trace', { id: event.id }));
    tools.append(hear, trace);
    panel.append(reads, tools);
    return panel;
  }

  _drawMaterialWave() {
    const canvas = this.host && this.host.querySelector('#loomMaterialWave');
    const wave = this.state.material && this.state.material.waveform;
    if (!canvas || !Array.isArray(wave) || !wave.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(240, Math.round((canvas.clientWidth || 480) * dpr));
    const height = Math.max(64, Math.round((canvas.clientHeight || 72) * dpr));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#070604';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#262418';
    ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
    ctx.fillStyle = '#D9B830';
    for (let index = 0; index < wave.length; index++) {
      const x0 = Math.floor(index / wave.length * width);
      const x1 = Math.max(x0 + 1, Math.ceil((index + 1) / wave.length * width));
      const amp = Math.max(0.02, Math.min(1, Number(wave[index]) || 0));
      const h = amp * height * 0.44;
      ctx.fillRect(x0, height / 2 - h, x1 - x0, h * 2);
    }
  }
}
