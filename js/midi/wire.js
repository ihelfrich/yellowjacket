// MidiWire: the only module that touches Web MIDI (CONTRACT-WIRE.md section 3).
// Ports cross this boundary as plain {id, name, dir} objects; no MIDIAccess or
// MIDIPort object leaks past this file. Import-safe outside the browser:
// navigator is only touched inside requestAccess().

// OP-Z emits a burst of kill notes when stop is pressed; suppress note input
// for 50 ms after an incoming 0xFC (CONTRACT-WIRE.md section 2).
const STOP_SUPPRESS_MS = 50;

// Pure parser for a complete MIDIMessageEvent.data payload. Web MIDI never
// delivers running status: every event carries a full message. Returns null
// for anything the wire does not carry (sysex, pitch bend, aftertouch, ...).
export function parseMidiMessage(data) {
  if (!data || data.length === 0) return null;
  const status = data[0];
  if (status === 0xF8) return { type: 'clocktick' };
  if (status === 0xFA) return { type: 'start' };
  if (status === 0xFB) return { type: 'continue' };
  if (status === 0xFC) return { type: 'stop' };
  if (status < 0x80 || status >= 0xF0) return null;
  const kind = status & 0xF0;
  const channel = status & 0x0F;
  if (kind === 0x90) {
    if (data.length < 3) return null;
    // Note-on with velocity 0 is a note-off (MIDI 1.0 spec).
    const type = data[2] === 0 ? 'noteoff' : 'noteon';
    return { type, channel, note: data[1], velocity: data[2] };
  }
  if (kind === 0x80) {
    if (data.length < 3) return null;
    return { type: 'noteoff', channel, note: data[1], velocity: data[2] };
  }
  if (kind === 0xB0) {
    if (data.length < 3) return null;
    return { type: 'cc', channel, num: data[1], value: data[2] };
  }
  return null;
}

export class MidiWire extends EventTarget {
  // events: 'noteon' {note, velocity, channel, timeStamp}
  //         'noteoff' {note, velocity, channel, timeStamp}
  //         'cc' {num, value, channel, timeStamp}
  //         'clocktick' {timeStamp}
  //         'transport' {type: 'start'|'stop'|'continue', timeStamp}
  //         'portschange' {}
  constructor() {
    super();
    this.channel = null; // channel filter 0..15; null = ALL (default)
    this._access = null;
    this._inId = null;
    this._outId = null;
    this._in = null;
    this._out = null;
    this._suppressUntil = -Infinity;
    this._onMessage = (e) => this._handleMessage(e);
  }

  // Call from an explicit user gesture: Chrome 124+ prompts for plain access.
  // NO sysex option, ever; nothing here needs it (CONTRACT-WIRE.md section 2).
  async requestAccess() {
    if (!this._access) {
      const access = await navigator.requestMIDIAccess();
      this._access = access;
      access.addEventListener('statechange', () => {
        this._rebind();
        this._emit('portschange', {});
      });
    }
    this._rebind();
    return { ins: this._portList('in'), outs: this._portList('out') };
  }

  ports() {
    return this._portList('in').concat(this._portList('out'));
  }

  setInput(id) {
    this._inId = id == null ? null : id;
    this._rebind();
  }

  setOutput(id) {
    this._outId = id == null ? null : id;
    this._rebind();
  }

  // Thin passthrough to the selected output; midiTs is a DOMHighResTimeStamp
  // honored by the browser for driver-level scheduling (CONTRACT-WIRE.md sec 2).
  send(bytes, midiTs) {
    if (!this._out) return;
    if (midiTs == null) this._out.send(bytes);
    else this._out.send(bytes, midiTs);
  }

  _portList(dir) {
    if (!this._access) return [];
    const map = dir === 'in' ? this._access.inputs : this._access.outputs;
    const list = [];
    map.forEach((port) => list.push({ id: port.id, name: port.name || port.id, dir }));
    return list;
  }

  // The chosen id survives unplug: while the port is absent the wire is simply
  // unbound, and the statechange handler re-runs this to pick it back up.
  _rebind() {
    if (!this._access) return;
    const input = this._inId == null ? null : this._access.inputs.get(this._inId) || null;
    if (this._in && this._in !== input) this._in.onmidimessage = null;
    this._in = input;
    if (this._in) this._in.onmidimessage = this._onMessage;
    this._out = this._outId == null ? null : this._access.outputs.get(this._outId) || null;
  }

  _handleMessage(e) {
    const msg = parseMidiMessage(e.data);
    if (!msg) return;
    // All clock math on event.timeStamp (CoreMIDI receive time on macOS),
    // never on handler-entry time (CONTRACT-WIRE.md section 2).
    const timeStamp = e.timeStamp;
    if (msg.type === 'clocktick') {
      this._emit('clocktick', { timeStamp });
      return;
    }
    if (msg.type === 'start' || msg.type === 'stop' || msg.type === 'continue') {
      if (msg.type === 'stop') this._suppressUntil = timeStamp + STOP_SUPPRESS_MS;
      this._emit('transport', { type: msg.type, timeStamp });
      return;
    }
    if (this.channel != null && msg.channel !== this.channel) return;
    if (msg.type === 'cc') {
      this._emit('cc', { num: msg.num, value: msg.value, channel: msg.channel, timeStamp });
      return;
    }
    if (timeStamp < this._suppressUntil) return;
    this._emit(msg.type, { note: msg.note, velocity: msg.velocity, channel: msg.channel, timeStamp });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
