// Yellowjacket MACHINE — compact factory-kit strip for PATTERN.
//
// This view owns no project or audio state. It exposes intent through events
// and reflects the live Machine document through setState(). Factory kit
// definitions are deliberately tolerated in a few compact shapes so the UI
// does not dictate how synthesis recipes are stored.

const PAD_COUNT = 8;

const STYLE = `
.yj-kit-strip {
  display: flex; flex-direction: column; gap: 7px; margin-bottom: 9px;
  padding: 8px; background: var(--yj-well); border: 1px solid var(--yj-line);
  border-radius: 2px;
}
.yj-kit-head,.yj-kit-actions {
  display: flex; align-items: center; gap: 6px; min-width: 0;
}
.yj-kit-head { flex-wrap: wrap; }
.yj-kit-tag {
  flex: 0 0 auto; font-size: 9px; font-weight: 700; letter-spacing: .1em;
  color: var(--yj-yellow);
}
.yj-kit-select { min-width: 150px; max-width: 220px; }
.yj-kit-groove { min-width: 132px; max-width: 190px; }
.yj-kit-readout {
  flex: 1 1 190px; min-width: 150px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; text-align: left; font-family: var(--f-mono);
  font-size: 9px; font-variant-numeric: tabular-nums;
}
.yj-kit-fidelity {
  flex: 0 1 auto; color: var(--yj-ink-dim); font-family: var(--f-mono);
  font-size: 8px; letter-spacing: .035em; white-space: nowrap;
}
.yj-kit-actions { flex-wrap: wrap; }
.yj-kit-actions .yj-btn { padding: 5px 8px; font-size: 9px; }
.yj-kit-actions .yj-kit-print { margin-left: auto; }
.yj-kit-pads-wrap { min-width: 0; overflow-x: auto; padding-bottom: 1px; }
.yj-kit-pads { display: grid; grid-template-columns: repeat(8,minmax(72px,1fr)); gap: 4px; min-width: 620px; }
.yj-kit-pad {
  position: relative; height: 42px; min-width: 0; padding: 5px 6px;
  display: grid; grid-template-columns: 16px minmax(0,1fr); grid-template-rows: 1fr 1fr;
  align-items: center; column-gap: 5px; text-align: left; cursor: pointer;
  background: var(--yj-panel); color: var(--yj-ink-dim); border: 1px solid var(--yj-line);
  border-radius: 2px; touch-action: manipulation;
}
.yj-kit-pad:hover:not(:disabled) { border-color: var(--yj-line-hi); color: var(--yj-ink); }
.yj-kit-pad:active:not(:disabled) { transform: translateY(1px); }
.yj-kit-pad:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: 1px; }
.yj-kit-pad.is-loaded { border-color: var(--yj-amber-dim); }
.yj-kit-pad.is-hit { background: var(--yj-yellow); color: var(--yj-black); border-color: var(--yj-yellow); }
.yj-kit-pad.is-hit .yj-kit-pad-role,.yj-kit-pad.is-hit .yj-kit-pad-name,.yj-kit-pad.is-hit .yj-kit-pad-num { color: var(--yj-black); }
.yj-kit-pad.is-loaded::after {
  content: ''; position: absolute; top: 4px; right: 4px; width: 3px; height: 3px;
  background: var(--yj-yellow);
}
.yj-kit-pad-num {
  grid-row: 1 / 3; font-family: var(--f-mono); font-size: 9px; color: var(--yj-amber);
}
.yj-kit-pad-role,.yj-kit-pad-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-kit-pad-role { font-size: 8px; font-weight: 700; letter-spacing: .08em; color: var(--yj-ink); }
.yj-kit-pad-name { font-family: var(--f-mono); font-size: 8px; color: var(--yj-ink-dim); }
.yj-kit-note {
  margin: 0; color: var(--yj-ink-dim); font-family: var(--f-mono); font-size: 8px;
  line-height: 1.35; letter-spacing: .025em;
}
.yj-kit-strip[aria-busy="true"] .yj-kit-readout { color: var(--yj-yellow); }
@media (max-width: 760px) {
  .yj-kit-actions .yj-kit-print { margin-left: 0; }
  .yj-kit-fidelity { width: 100%; }
}
@media (max-width: 560px) {
  .yj-kit-head .yj-kit-select,.yj-kit-head .yj-kit-groove { flex: 1 1 130px; min-width: 0; }
  .yj-kit-readout { order: 4; flex-basis: 100%; }
  .yj-kit-pads { min-width: 0; grid-template-columns: repeat(4,minmax(0,1fr)); }
  .yj-kit-pad { height: 44px; }
}
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined' || !document.head) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function itemId(item, index, prefix) {
  if (typeof item === 'string') return item;
  return String(item && (item.id ?? item.key ?? item.slug) || prefix + (index + 1));
}

function itemName(item, fallback) {
  if (typeof item === 'string') return item.replace(/[-_]+/g, ' ').toUpperCase();
  return String(item && (item.name ?? item.label ?? item.title) || fallback);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, spec]) => (
      spec && typeof spec === 'object' ? { id, ...spec } : { id, name: spec }
    ));
  }
  return [];
}

function tracksOf(machine) {
  if (!machine) return [];
  if (Array.isArray(machine.tracks)) return machine.tracks;
  const scenes = Array.isArray(machine.scenes) ? machine.scenes : [];
  const scene = scenes[machine.activeScene | 0];
  return scene && Array.isArray(scene.tracks) ? scene.tracks : [];
}

function formatRate(rate) {
  const n = Number(rate);
  if (!(n > 0) || !Number.isFinite(n)) return 'DEVICE RATE ON START';
  const khz = n / 1000;
  return (Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)) + ' kHz';
}

function oversamplingOf(kit) {
  const value = Number(kit && (kit.oversample ?? kit.oversampling ?? kit.dspOversample));
  return Number.isFinite(value) && value > 1 ? Math.round(value) : 0;
}

function kitGrooves(kit) {
  const list = asList(kit && (kit.grooves ?? kit.patterns ?? kit.takes));
  if (list.length) return list;
  const id = kit && (kit.defaultGrooveId ?? kit.grooveId);
  return id == null ? [] : [{ id: String(id), name: 'STARTER GROOVE' }];
}

function kitVoices(kit) {
  return asList(kit && (kit.voices ?? kit.pads ?? kit.tracks));
}

function isActiveFactoryKit(tracks, kitId) {
  if (!kitId || tracks.length < PAD_COUNT) return false;
  for (let i = 0; i < PAD_COUNT; i++) {
    const track = tracks[i];
    const sample = track && track.sample;
    const stableId = String(track && track.sampleId || '');
    const tagged = sample && sample.factoryKitId === kitId;
    const persisted = stableId.startsWith('factory-drum-v')
      && stableId.endsWith('-' + kitId + '-' + i);
    if (!sample || (!tagged && !persisted)) return false;
  }
  return true;
}

export class KitView extends EventTarget {
  constructor(host, kits = []) {
    super();
    injectStyle();
    this.host = host || null;
    this.kits = asList(kits);
    this.machine = null;
    this.audioRate = 0;
    this.busy = false;
    this.busyText = '';
    this._flashTimers = [];
    this._pads = [];
    if (!this.host || typeof document === 'undefined') return;
    this._build();
  }

  setState(machine, audioRate) {
    this.machine = machine || null;
    this.audioRate = Number(audioRate) > 0 ? Number(audioRate) : 0;
    const drums = this.machine && this.machine.drums;
    if (drums && drums.kitId != null && this._hasOption(this._kitSelect, drums.kitId)) {
      this._kitSelect.value = String(drums.kitId);
      this._syncGrooves(drums.grooveId);
    } else {
      this._syncGrooves();
    }
    this._sync();
  }

  setBusy(busy, text = '') {
    this.busy = !!busy;
    this.busyText = this.busy ? String(text || 'BUILDING KIT…') : '';
    if (!this.host) return;
    this.host.setAttribute('aria-busy', this.busy ? 'true' : 'false');
    this._sync();
  }

  flash(track) {
    const index = Number(track);
    const view = Number.isInteger(index) ? this._pads[index] : null;
    if (!view) return;
    view.pad.classList.add('is-hit');
    if (this._flashTimers[index]) clearTimeout(this._flashTimers[index]);
    this._flashTimers[index] = setTimeout(() => {
      view.pad.classList.remove('is-hit');
      this._flashTimers[index] = 0;
    }, 110);
  }

  _build() {
    this.host.classList.add('yj-kit-strip');

    const head = document.createElement('div');
    head.className = 'yj-kit-head';
    const tag = document.createElement('span');
    tag.className = 'yj-kit-tag';
    tag.textContent = 'FACTORY KIT';

    const kitSelect = document.createElement('select');
    kitSelect.className = 'yj-select yj-kit-select';
    kitSelect.setAttribute('aria-label', 'Factory drum kit');
    this.kits.forEach((kit, index) => {
      const option = document.createElement('option');
      option.value = itemId(kit, index, 'kit-');
      option.textContent = itemName(kit, 'KIT ' + (index + 1));
      kitSelect.appendChild(option);
    });
    if (!this.kits.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'NO FACTORY KITS';
      kitSelect.appendChild(option);
      kitSelect.disabled = true;
    }
    kitSelect.addEventListener('change', () => {
      this._syncGrooves();
      this._sync();
    });
    this._kitSelect = kitSelect;

    const grooveSelect = document.createElement('select');
    grooveSelect.className = 'yj-select yj-kit-groove';
    grooveSelect.setAttribute('aria-label', 'Starter groove');
    grooveSelect.addEventListener('change', () => this._sync());
    this._grooveSelect = grooveSelect;

    const readout = document.createElement('div');
    readout.className = 'yj-well yj-kit-readout';
    readout.textContent = '0 / 8 LOADED';
    this._readout = readout;

    const fidelity = document.createElement('span');
    fidelity.className = 'yj-kit-fidelity';
    this._fidelity = fidelity;
    head.append(tag, kitSelect, grooveSelect, readout, fidelity);

    const actions = document.createElement('div');
    actions.className = 'yj-kit-actions';
    const sounds = this._button('LOAD SOUNDS');
    sounds.title = 'Replace the eight track sounds; keep the current pattern';
    sounds.addEventListener('click', () => this._load(false));
    const both = this._button('LOAD + GROOVE', 'yj-btn yj-btn-primary');
    both.title = 'Load the kit and write its selected starter groove';
    both.addEventListener('click', () => this._load(true));
    const variation = this._button('NEW TAKE');
    variation.title = 'Rewrite the current groove with the next deterministic take';
    variation.addEventListener('click', () => this._emit('variation', {
      kitId: this._kitId(), grooveId: this._grooveId(),
    }));
    const print = this._button('PRINT OP-Z / OP-1');
    print.classList.add('yj-kit-print');
    print.title = 'Print the loaded eight-voice kit as a hardware drum patch';
    print.addEventListener('click', () => this._emit('export', {
      kitId: this._kitId(), grooveId: this._grooveId(),
    }));
    actions.append(sounds, both, variation, print);
    this._buttons = { sounds, both, variation, print };

    const padsWrap = document.createElement('div');
    padsWrap.className = 'yj-kit-pads-wrap';
    const pads = document.createElement('div');
    pads.className = 'yj-kit-pads';
    for (let i = 0; i < PAD_COUNT; i++) pads.appendChild(this._buildPad(i));
    padsWrap.appendChild(pads);

    const note = document.createElement('p');
    note.className = 'yj-kit-note';
    this._note = note;

    this.host.append(head, actions, padsWrap, note);
    this._syncGrooves();
    this._sync();
  }

  _button(label, className = 'yj-btn') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  _buildPad(track) {
    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'yj-kit-pad';
    pad.dataset.track = String(track);
    pad.title = 'Audition track ' + (track + 1) + ' · key ' + (track + 1);
    const number = document.createElement('span');
    number.className = 'yj-kit-pad-num';
    number.textContent = String(track + 1);
    const role = document.createElement('span');
    role.className = 'yj-kit-pad-role';
    role.textContent = 'VOICE ' + (track + 1);
    const name = document.createElement('span');
    name.className = 'yj-kit-pad-name';
    name.textContent = 'NOT LOADED';
    pad.append(number, role, name);
    pad.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this._emit('trig', { track });
    });
    pad.addEventListener('keydown', (event) => {
      if (event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return;
      event.preventDefault();
      event.stopPropagation();
      this._emit('trig', { track });
    });
    this._pads.push({ pad, role, name });
    return pad;
  }

  _load(withGroove) {
    this._emit('kitload', {
      kitId: this._kitId(),
      grooveId: this._grooveId(),
      withGroove: !!withGroove,
    });
  }

  _emit(type, detail) {
    if (this.busy || !detail || !detail.kitId && type !== 'trig') return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _kitId() {
    return this._kitSelect ? this._kitSelect.value : '';
  }

  _grooveId() {
    return this._grooveSelect && !this._grooveSelect.disabled ? this._grooveSelect.value : null;
  }

  _selectedKit() {
    const id = this._kitId();
    return this.kits.find((kit, index) => itemId(kit, index, 'kit-') === id) || null;
  }

  _hasOption(select, value) {
    if (!select || value == null) return false;
    return Array.from(select.options).some((option) => option.value === String(value));
  }

  _syncGrooves(preferred = null) {
    if (!this._grooveSelect) return;
    const previous = preferred == null ? this._grooveSelect.value : String(preferred);
    const grooves = kitGrooves(this._selectedKit());
    const options = grooves.map((groove, index) => {
      const option = document.createElement('option');
      option.value = itemId(groove, index, 'groove-');
      option.textContent = itemName(groove, 'GROOVE ' + (index + 1));
      return option;
    });
    if (!options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'NO STARTER GROOVE';
      options.push(option);
    }
    this._grooveSelect.replaceChildren(...options);
    this._grooveSelect.disabled = !grooves.length;
    if (this._hasOption(this._grooveSelect, previous)) this._grooveSelect.value = previous;
  }

  _sync() {
    if (!this.host || !this._buttons) return;
    const kitId = this._kitId();
    // Read the selected value independently of the select's *previous* busy
    // disabled state. Otherwise setBusy(false) enabled the select but left
    // LOAD + GROOVE / NEW TAKE disabled until the user changed it manually.
    const availableGrooves = kitGrooves(this._selectedKit());
    const grooveId = this._grooveSelect && availableGrooves.length
      ? this._grooveSelect.value : null;
    const tracks = tracksOf(this.machine);
    const loaded = tracks.slice(0, PAD_COUNT).filter((track) => !!(track && track.sample)).length;
    const drums = this.machine && this.machine.drums || {};
    const factoryActive = drums.kitId === kitId && isActiveFactoryKit(tracks, kitId);
    const take = factoryActive && drums.grooveId
      ? String(Math.max(0, Number(drums.variation) | 0) + 1).padStart(2, '0') : '—';
    const sourceRates = tracks.slice(0, PAD_COUNT)
      .map((track) => Number(track && track.sample && track.sample.sampleRate))
      .filter((rate) => rate > 0 && Number.isFinite(rate));
    const rateText = sourceRates.length
      ? (Math.min(...sourceRates) === Math.max(...sourceRates)
        ? ' · SOURCE ' + formatRate(sourceRates[0])
        : ' · SOURCES ' + formatRate(Math.min(...sourceRates)) + '–' + formatRate(Math.max(...sourceRates)))
      : '';
    this._readout.textContent = this.busy
      ? this.busyText
      : loaded + ' / ' + PAD_COUNT + ' LOADED · TAKE ' + take + rateText;
    const oversampling = factoryActive ? oversamplingOf(this._selectedKit()) : 0;
    this._fidelity.textContent = 'LIVE · ' + formatRate(this.audioRate)
      + (oversampling ? ' · ' + oversampling + '× DSP' : '');
    this._note.textContent = factoryActive
      ? 'CANONICAL FACTORY AUDIO · 96 kHz. LIVE AUDITION USES THE DEVICE RATE. HARDWARE PRINT IS BAND-LIMITED TO 44.1 kHz FOR OP-Z / OP-1.'
      : (loaded
        ? 'ACTIVE KIT · STORED SOURCE RATES SHOWN ABOVE. FACTORY 96 kHz / 4× CLAIMS APPLY ONLY AFTER A COMPLETE FACTORY KIT LOAD.'
        : 'FACTORY KITS RENDER LOCALLY AT 4× TO CANONICAL 96 kHz PCM. LIVE AUDITION REPORTS THE REAL DEVICE RATE.');

    const disabled = this.busy || !kitId;
    this._kitSelect.disabled = this.busy || !this.kits.length;
    this._grooveSelect.disabled = this.busy || !availableGrooves.length;
    this._buttons.sounds.disabled = disabled;
    this._buttons.both.disabled = disabled || !grooveId;
    this._buttons.variation.disabled = disabled || !grooveId
      || !factoryActive || drums.grooveId !== grooveId;
    this._buttons.print.disabled = this.busy || loaded === 0;
    this._syncPads(tracks);
  }

  _syncPads(tracks) {
    const voices = kitVoices(this._selectedKit());
    for (let i = 0; i < PAD_COUNT; i++) {
      const view = this._pads[i];
      const track = tracks[i];
      const sample = track && track.sample;
      const planned = voices[i];
      const role = sample && sample.role || planned && (planned.role ?? planned.kind);
      const name = sample && sample.label || planned && (planned.name ?? planned.label);
      view.role.textContent = String(role || 'VOICE ' + (i + 1)).toUpperCase();
      view.name.textContent = String(name || (sample ? 'LOADED' : 'NOT LOADED')).toUpperCase();
      view.pad.classList.toggle('is-loaded', !!sample);
      view.pad.disabled = this.busy;
      view.pad.setAttribute('aria-label', 'Track ' + (i + 1) + ' · ' + view.role.textContent
        + ' · ' + view.name.textContent);
    }
  }
}
