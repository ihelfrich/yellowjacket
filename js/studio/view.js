// Studio surface: six instrument channels, sound designer, note palette, and
// a four-bar piano-roll-style step editor. Pure view; all edits are events.

import { INSTRUMENT_PRESETS, KEY_NAMES, STUDIO_SCALES, CARD_EXCITATIONS, noteName, scaleSpec } from './model.js';
import { FOUND_CARDS } from './found-cards.js';

const STYLE = `
.yj-studio { height:100%; min-height:0; display:flex; flex-direction:column; gap:10px; overflow:auto; }
.yj-studio-transport { display:flex; flex-direction:column; border:1px solid var(--yj-line); background:var(--yj-panel); }
.yj-studio-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:9px; }
.yj-studio-head .yj-param { min-width:120px; margin-left:8px; }
.yj-studio-readout { font-family:var(--f-mono); font-size:10px; color:var(--yj-amber); margin-left:auto; }
.yj-studio-progress { display:grid; gap:2px; grid-template-columns:repeat(var(--steps),1fr); padding:0 9px 7px; }
.yj-studio-progress-step { height:4px; background:var(--yj-line-hi); }
.yj-studio-progress-step:nth-child(16n+1) { background:var(--yj-amber-dim); }
.yj-studio-progress-step.is-playing { background:var(--yj-hot); box-shadow:0 0 7px rgba(215,255,0,.55); }
.yj-studio-mixer { display:grid; grid-template-columns:repeat(6,minmax(132px,1fr)); gap:5px; min-width:840px; }
.yj-channel { position:relative; display:flex; flex-direction:column; gap:6px; min-width:0; padding:9px; background:var(--yj-panel); border:1px solid var(--yj-line); }
.yj-channel.is-selected { border-color:var(--yj-yellow); box-shadow:inset 0 3px 0 var(--yj-yellow); }
.yj-channel.is-playing { background:linear-gradient(180deg,rgba(255,212,0,.1),var(--yj-panel) 42%); }
.yj-channel-pick { display:flex; align-items:center; gap:7px; text-align:left; color:var(--yj-yellow); font-size:10px; font-weight:700; letter-spacing:.08em; }
.yj-channel-index { display:grid; place-items:center; width:20px; height:20px; background:var(--yj-yellow); color:#0b0a07; font-family:var(--f-mono); }
.yj-channel-name { overflow:hidden; text-overflow:ellipsis; }
.yj-channel .yj-select { width:100%; min-width:0; }
.yj-mini-param { display:grid; grid-template-columns:34px 1fr 36px; align-items:center; gap:4px; color:var(--yj-ink-dim); font-family:var(--f-mono); font-size:8px; }
.yj-mini-param output { text-align:right; color:var(--yj-amber); }
.yj-channel-actions { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
.yj-channel-actions .yj-btn { padding:5px 3px; font-size:9px; }
.yj-studio-work { display:grid; grid-template-columns:minmax(300px,.75fr) minmax(520px,1.6fr); gap:10px; min-height:380px; }
.yj-sound-panel,.yj-roll-panel { padding:12px; border:1px solid var(--yj-line); background:var(--yj-panel); min-width:0; }
.yj-studio-title { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; color:var(--yj-yellow); font-size:12px; font-weight:700; letter-spacing:.1em; }
.yj-studio-title span { color:var(--yj-ink-dim); font-family:var(--f-mono); font-size:9px; font-weight:400; letter-spacing:.03em; }
.yj-sound-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px 12px; }
.yj-synth-scope { width:100%; height:76px; margin:0 0 10px; border:1px solid var(--yj-line); background:var(--yj-well); }
.yj-sound-control { display:grid; grid-template-columns:66px 1fr 48px; align-items:center; gap:6px; font-family:var(--f-mono); font-size:9px; color:var(--yj-ink-dim); }
.yj-sound-control select { grid-column:2/4; }
.yj-sound-control output { color:var(--yj-amber); text-align:right; }
.yj-roll-tools { display:flex; gap:5px; align-items:center; flex-wrap:wrap; margin-bottom:9px; }
.yj-roll-tools .yj-btn { padding:5px 8px; font-size:9px; }
.yj-roll-tools .yj-select { width:auto; }
.yj-roll-tools .yj-mini-param { flex:0 0 112px; width:112px; }
.yj-roll-grid { display:grid; grid-template-columns:repeat(16,minmax(32px,1fr)); gap:3px; }
.yj-note-step { position:relative; height:52px; padding:5px 2px 2px; border:1px solid var(--yj-line); background:var(--yj-well); color:var(--yj-ink-dim); font-family:var(--f-mono); font-size:9px; }
.yj-note-step:nth-child(4n+1)::after { content:''; position:absolute; left:-3px; top:-1px; bottom:-1px; width:1px; background:var(--yj-amber-dim); }
.yj-note-step.is-on { color:#0b0a07; background:var(--yj-yellow); border-color:var(--yj-yellow); font-weight:600; }
.yj-note-step.is-playing { outline:2px solid var(--yj-hot); outline-offset:1px; }
.yj-step-num { display:block; opacity:.55; font-size:7px; margin-bottom:5px; }
.yj-keyboard { display:grid; grid-template-columns:repeat(24,1fr); gap:2px; margin-top:10px; }
.yj-key { height:42px; min-width:21px; border:1px solid var(--yj-line-hi); background:var(--yj-ink); color:#0b0a07; font-family:var(--f-mono); font-size:7px; padding-top:17px; }
.yj-key.is-black { height:30px; background:#18170f; color:var(--yj-ink); padding-top:9px; }
.yj-key.is-selected { border-color:var(--yj-yellow); box-shadow:inset 0 -4px 0 var(--yj-yellow); }
.yj-octave-readout { min-width:54px; text-align:center; font-family:var(--f-mono); font-size:9px; color:var(--yj-amber); }
.yj-studio-empty-note { margin-top:9px; color:var(--yj-ink-dim); font-family:var(--f-mono); font-size:9px; line-height:1.5; }
@media(max-width:1050px){.yj-studio-work{grid-template-columns:1fr}.yj-studio-mixer{grid-template-columns:repeat(3,minmax(150px,1fr));min-width:0}.yj-roll-panel{overflow-x:auto}.yj-roll-grid,.yj-keyboard{min-width:680px}}
@media(max-width:620px){.yj-studio-mixer{grid-template-columns:repeat(2,minmax(140px,1fr))}.yj-sound-grid{grid-template-columns:1fr}.yj-studio-readout{width:100%;margin-left:0}}
`;

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
}
function button(label, className = 'yj-btn') {
  const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label; return node;
}
function select(options, value) {
  const node = document.createElement('select'); node.className = 'yj-select';
  for (const [key, label] of options) { const option = document.createElement('option'); option.value = key; option.textContent = label; node.appendChild(option); }
  node.value = String(value); return node;
}
function range(label, value, min, max, step, format, onChange) {
  const wrap = document.createElement('label'); wrap.className = 'yj-sound-control';
  const name = document.createElement('span'); name.textContent = label;
  const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const out = document.createElement('output'); out.textContent = format(Number(value));
  input.addEventListener('input', () => { out.textContent = format(Number(input.value)); });
  input.addEventListener('change', () => onChange(Number(input.value)));
  wrap.append(name, input, out); return wrap;
}

export class StudioView extends EventTarget {
  constructor(host) {
    super(); injectStyle(); this.host = host; this.studio = null; this.selectedTrack = 0;
    this.page = 0; this.note = 48; this.chord = 'single'; this.velocity = 0.82; this.gate = 0.9;
    this.keyboardBase = 48; this.playing = false; this.activeStep = -1;
  }

  setStudio(studio) { this.studio = studio; this.page = Math.min(this.page, Math.max(0, studio.bars - 1)); this.render(); }
  setPlaying(playing) { this.playing = !!playing; this._paintTransport(); }
  setStep(step) { this.activeStep = step; this._paintStep(); }

  render() {
    if (!this.host || !this.studio) return;
    this.host.textContent = '';
    const root = document.createElement('div'); root.className = 'yj-studio'; this.root = root;
    root.append(this._transport(), this._mixer(), this._workbench());
    this.host.appendChild(root); this._paintTransport(); this._paintStep();
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _transport() {
    const wrap = document.createElement('div'); wrap.className = 'yj-studio-transport';
    const row = document.createElement('div'); row.className = 'yj-studio-head';
    const hasNotes = this.studio.tracks.some((track) => track.steps.some(Boolean));
    const play = button(this.playing ? 'PAUSE' : 'PLAY', 'yj-btn yj-btn-primary'); play.dataset.action = 'play'; play.addEventListener('click', () => this._emit('play'));
    const stop = button('STOP'); stop.addEventListener('click', () => this._emit('stop'));
    const bpm = document.createElement('input'); bpm.type = 'number'; bpm.className = 'yj-select'; bpm.min = '30'; bpm.max = '300'; bpm.value = this.studio.bpm; bpm.setAttribute('aria-label', 'Studio tempo'); bpm.style.width = '72px'; bpm.addEventListener('change', () => this._emit('studio', { key: 'bpm', value: Number(bpm.value) }));
    const bpmLabel = document.createElement('span'); bpmLabel.className = 'yj-label'; bpmLabel.textContent = 'BPM';
    const bars = select([['1','1 BAR'],['2','2 BARS'],['3','3 BARS'],['4','4 BARS']], this.studio.bars); bars.style.width = '92px'; bars.addEventListener('change', () => this._emit('studio', { key: 'bars', value: Number(bars.value) }));
    const key = select(KEY_NAMES.map((name, index) => [String(index), name]), this.studio.keyRoot); key.title = 'Musical key'; key.style.width = '62px'; key.addEventListener('change', () => this._emit('studio', { key: 'keyRoot', value: Number(key.value) }));
    const scaleOptions = Object.entries(STUDIO_SCALES).map(([id, spec]) => [id, spec.name]);
    if (this.studio.customScale) scaleOptions.unshift(['custom', '◇ ' + this.studio.customScale.name]);
    const scale = select(scaleOptions, this.studio.scale); scale.title = 'Scale used by IDEA'; scale.style.width = '110px'; scale.addEventListener('change', () => this._emit('studio', { key: 'scale', value: scale.value }));
    const metro = button('CLICK · ' + (this.studio.metronome ? 'ON' : 'OFF'), this.studio.metronome ? 'yj-btn is-active' : 'yj-btn'); metro.addEventListener('click', () => this._emit('studio', { key: 'metronome', value: !this.studio.metronome }));
    const idea = button('IDEA', 'yj-btn yj-btn-primary'); idea.id = 'btnStudioIdea'; idea.title = 'Write a fresh arrangement in the selected key and scale'; idea.addEventListener('click', () => this._emit('idea'));
    const midi = button('MIDI OUT', 'yj-btn'); midi.id = 'btnStudioMidi'; midi.title = 'Export all six instruments as a Standard MIDI File'; midi.addEventListener('click', () => this._emit('midiexport'));
    const bounce = button('BOUNCE WAV', 'yj-btn'); bounce.id = 'btnStudioBounce'; bounce.addEventListener('click', () => this._emit('bounce'));
    midi.disabled = !hasNotes; bounce.disabled = !hasNotes;
    const swing = range('SWING', this.studio.swing, 50, 75, 1, (v) => v + '%', (value) => this._emit('studio', { key: 'swing', value }));
    const master = range('MASTER', this.studio.masterDb, -18, 3, 1, (v) => v + ' dB', (value) => this._emit('studio', { key: 'masterDb', value }));
    const readout = document.createElement('div'); readout.className = 'yj-studio-readout'; readout.textContent = KEY_NAMES[this.studio.keyRoot] + ' ' + scaleSpec(this.studio).name + ' · 6 PARTS';
    row.append(play, stop, bpmLabel, bpm, bars, key, scale, idea, metro, midi, bounce, swing, master, readout);
    const progress = document.createElement('div'); progress.className = 'yj-studio-progress'; progress.style.setProperty('--steps', this.studio.bars * 16);
    for (let i = 0; i < this.studio.bars * 16; i++) { const dot = document.createElement('span'); dot.className = 'yj-studio-progress-step'; dot.dataset.progressStep = i; progress.appendChild(dot); }
    wrap.append(row, progress); return wrap;
  }

  _mixer() {
    const mixer = document.createElement('div'); mixer.className = 'yj-studio-mixer';
    this.studio.tracks.forEach((track, index) => {
      const channel = document.createElement('section'); channel.className = 'yj-channel' + (index === this.selectedTrack ? ' is-selected' : ''); channel.dataset.track = index;
      const pick = button('', 'yj-channel-pick');
      const badge = document.createElement('span'); badge.className = 'yj-channel-index'; badge.textContent = index + 1;
      const name = document.createElement('span'); name.className = 'yj-channel-name'; name.textContent = track.name;
      pick.append(badge, name); pick.addEventListener('click', () => { this.selectedTrack = index; this.render(); });
      // The chooser: this part's card under each of its excitations (when it
      // plays one), the synth presets, then the lab's found cards.
      const presetOptions = INSTRUMENT_PRESETS.map((p) => [p.id, p.name]);
      if (track.preset === 'custom') presetOptions.unshift(['custom', 'CUSTOM']);
      if (track.card) presetOptions.unshift(...CARD_EXCITATIONS.map((e) => ['card:' + e, track.name + ' · ' + e.toUpperCase()]));
      presetOptions.push(...FOUND_CARDS.map((c) => ['found:' + c.id, '◇ ' + c.name]));
      const preset = select(presetOptions, track.card ? 'card:' + track.card.excitation : track.preset); preset.addEventListener('change', () => {
        if (preset.value !== 'custom') this._emit('preset', { track: index, id: preset.value });
      });
      const level = this._miniRange('VOL', track.gainDb, -36, 6, 1, (v) => v + '', (value) => this._emit('track', { track: index, key: 'gainDb', value }));
      const pan = this._miniRange('PAN', track.pan, -1, 1, .05, (v) => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), (value) => this._emit('track', { track: index, key: 'pan', value }));
      const actions = document.createElement('div'); actions.className = 'yj-channel-actions';
      const mute = button('MUTE', track.mute ? 'yj-btn is-active' : 'yj-btn'); mute.addEventListener('click', () => this._emit('track', { track: index, key: 'mute', value: !track.mute }));
      const solo = button('SOLO', track.solo ? 'yj-btn is-active' : 'yj-btn'); solo.addEventListener('click', () => this._emit('track', { track: index, key: 'solo', value: !track.solo }));
      actions.append(mute, solo); channel.append(pick, preset, level, pan, actions); mixer.appendChild(channel);
    });
    return mixer;
  }

  _miniRange(label, value, min, max, step, format, onChange) {
    const wrap = document.createElement('label'); wrap.className = 'yj-mini-param';
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
    const out = document.createElement('output'); out.textContent = format(Number(value));
    input.addEventListener('input', () => { out.textContent = format(Number(input.value)); }); input.addEventListener('change', () => onChange(Number(input.value)));
    wrap.append(name, input, out); return wrap;
  }

  _workbench() {
    const work = document.createElement('div'); work.className = 'yj-studio-work'; work.append(this._designer(), this._roll()); return work;
  }

  _designer() {
    const track = this.studio.tracks[this.selectedTrack]; const synth = track.synth;
    const panel = document.createElement('section'); panel.className = 'yj-sound-panel';
    const title = document.createElement('div'); title.className = 'yj-studio-title'; title.textContent = 'SOUND DESIGN · ' + track.name;
    const tag = document.createElement('span'); tag.textContent = 'DUAL OSCILLATOR / FILTER / ADSR'; title.appendChild(tag);
    const scope = document.createElement('canvas'); scope.className = 'yj-synth-scope'; scope.setAttribute('aria-label', 'Oscillator and envelope preview');
    const grid = document.createElement('div'); grid.className = 'yj-sound-grid';
    const waveOptions = [['sine','SINE'],['triangle','TRIANGLE'],['sawtooth','SAW'],['square','SQUARE']];
    for (const key of ['wave1','wave2']) {
      const wrap = document.createElement('label'); wrap.className = 'yj-sound-control'; const label = document.createElement('span'); label.textContent = key === 'wave1' ? 'OSC 1' : 'OSC 2';
      const sel = select(waveOptions, synth[key]); sel.addEventListener('change', () => this._emit('synth', { track: this.selectedTrack, key, value: sel.value })); wrap.append(label, sel); grid.appendChild(wrap);
    }
    const controls = [
      ['MIX','mix',0,1,.01,(v)=>Math.round(v*100)+'%'], ['DETUNE','detune',-1200,1200,1,(v)=>v+'¢'],
      ['TRANSPOSE','transpose',-36,36,12,(v)=>(v>0?'+':'')+v+' st'], ['CUTOFF','cutoff',40,20000,10,(v)=>v>=1000?(v/1000).toFixed(1)+'k':v+''],
      ['RESONANCE','resonance',.1,20,.1,(v)=>v.toFixed(1)], ['ATTACK','attack',.001,2,.005,(v)=>v.toFixed(3)+'s'],
      ['DECAY','decay',.005,2,.005,(v)=>v.toFixed(2)+'s'], ['SUSTAIN','sustain',0,1,.01,(v)=>Math.round(v*100)+'%'],
      ['RELEASE','release',.01,4,.01,(v)=>v.toFixed(2)+'s'],
    ];
    for (const [label,key,min,max,step,format] of controls) grid.appendChild(range(label,synth[key],min,max,step,format,(value)=>this._emit('synth',{track:this.selectedTrack,key,value})));
    grid.appendChild(range('REVERB',track.sendVerb,0,1,.01,(v)=>Math.round(v*100)+'%',(value)=>this._emit('track',{track:this.selectedTrack,key:'sendVerb',value})));
    grid.appendChild(range('DELAY',track.sendDelay,0,1,.01,(v)=>Math.round(v*100)+'%',(value)=>this._emit('track',{track:this.selectedTrack,key:'sendDelay',value})));
    const preview = button('AUDITION ' + noteName(this.note), 'yj-btn yj-btn-primary'); preview.addEventListener('click',()=>this._emit('preview',{track:this.selectedTrack,note:this.note,chord:this.chord,velocity:this.velocity}));
    const note = document.createElement('p'); note.className = 'yj-studio-empty-note'; note.textContent = 'Every voice is polyphonic. DETUNE can be subtle width or a harmonic interval; TRANSPOSE moves the instrument without rewriting the sequence.';
    panel.append(title, scope, grid, preview, note);
    requestAnimationFrame(() => this._drawScope(scope, synth));
    return panel;
  }

  _drawScope(canvas, synth) {
    if (!canvas || !canvas.getContext) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(280, Math.round((canvas.clientWidth || 520) * dpr));
    const height = Math.max(76, Math.round((canvas.clientHeight || 76) * dpr));
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#262418'; ctx.lineWidth = dpr;
    for (let x = width / 8; x < width; x += width / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
    const wave = (type, phase) => {
      const cycle = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
      if (type === 'sine') return Math.sin(phase);
      if (type === 'square') return Math.sin(phase) >= 0 ? 1 : -1;
      if (type === 'triangle') return 1 - 4 * Math.abs(Math.round(cycle) - cycle);
      return 2 * (cycle - Math.floor(cycle + 0.5));
    };
    const detuneRatio = Math.pow(2, synth.detune / 1200);
    ctx.strokeStyle = '#FFD400'; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const phase = x / width * Math.PI * 2 * 4;
      const sample = wave(synth.wave1, phase) * (1 - synth.mix) + wave(synth.wave2, phase * detuneRatio) * synth.mix;
      const y = height * 0.5 - sample * height * 0.34;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const total = Math.max(0.1, synth.attack + synth.decay + 0.5 + synth.release);
    const ax = synth.attack / total * width;
    const dx = (synth.attack + synth.decay) / total * width;
    const sx = (synth.attack + synth.decay + 0.5) / total * width;
    ctx.strokeStyle = '#C79A00'; ctx.lineWidth = dpr; ctx.beginPath();
    ctx.moveTo(0, height - 3 * dpr); ctx.lineTo(ax, 3 * dpr); ctx.lineTo(dx, height - (height - 6 * dpr) * synth.sustain); ctx.lineTo(sx, height - (height - 6 * dpr) * synth.sustain); ctx.lineTo(width, height - 3 * dpr); ctx.stroke();
  }

  _roll() {
    const track = this.studio.tracks[this.selectedTrack]; const panel = document.createElement('section'); panel.className = 'yj-roll-panel';
    const title = document.createElement('div'); title.className = 'yj-studio-title'; title.textContent = 'NOTE SEQUENCER · ' + track.name;
    const tag = document.createElement('span'); tag.textContent = 'BAR ' + (this.page + 1) + ' / ' + this.studio.bars; title.appendChild(tag);
    const tools = document.createElement('div'); tools.className = 'yj-roll-tools';
    for (let i=0;i<this.studio.bars;i++){const b=button('BAR '+(i+1),this.page===i?'yj-btn is-active':'yj-btn');b.addEventListener('click',()=>{this.page=i;this.render();});tools.appendChild(b);}
    const chord = select([['single','NOTE'],['fifth','FIFTH'],['minor','MINOR'],['major','MAJOR'],['seventh','DOM 7']],this.chord); chord.addEventListener('change',()=>{this.chord=chord.value;});
    const velocity = this._miniRange('VEL',this.velocity,.05,1,.05,(v)=>Math.round(v*100)+'',(value)=>{this.velocity=value;});
    const gate = this._miniRange('GATE',this.gate,.1,16,.1,(v)=>v.toFixed(1)+'×',(value)=>{this.gate=value;});
    const left=button('SHIFT ←');left.title='Rotate this bar one sixteenth earlier';left.addEventListener('click',()=>this._emit('transform',{track:this.selectedTrack,page:this.page,operation:'left'}));
    const right=button('SHIFT →');right.title='Rotate this bar one sixteenth later';right.addEventListener('click',()=>this._emit('transform',{track:this.selectedTrack,page:this.page,operation:'right'}));
    const invert=button('INVERT');invert.title='Mirror this bar around its pitch center';invert.addEventListener('click',()=>this._emit('transform',{track:this.selectedTrack,page:this.page,operation:'invert'}));
    const duplicate=button('DUPLICATE');duplicate.title='Copy this bar into the next bar';duplicate.disabled=this.page>=3;duplicate.addEventListener('click',()=>{const from=this.page;this.page=Math.min(3,this.page+1);this._emit('transform',{track:this.selectedTrack,page:from,operation:'duplicate'});});
    const clear=button('CLEAR');clear.addEventListener('click',()=>this._emit('clearbar',{track:this.selectedTrack,page:this.page})); tools.append(chord,velocity,gate,left,right,invert,duplicate,clear);
    const grid=document.createElement('div');grid.className='yj-roll-grid';
    for(let local=0;local<16;local++){const index=this.page*16+local;const event=track.steps[index];const step=button('', 'yj-note-step'+(event?' is-on':''));step.dataset.step=index;
      const num=document.createElement('span');num.className='yj-step-num';num.textContent=String(index+1).padStart(2,'0');step.appendChild(num,document.createTextNode(event?noteName(event.note)+(event.chord==='single'?'':' '+event.chord.toUpperCase()):'—'));
      step.title=event?'Click to replace; right-click to clear':'Place '+noteName(this.note)+' '+this.chord;
      step.addEventListener('click',()=>this._emit('step',{track:this.selectedTrack,index,value:event&&event.note===this.note&&event.chord===this.chord?null:{note:this.note,chord:this.chord,velocity:this.velocity,gate:this.gate}}));
      step.addEventListener('contextmenu',(e)=>{e.preventDefault();this._emit('step',{track:this.selectedTrack,index,value:null});});grid.appendChild(step);}
    const keyboard=document.createElement('div');keyboard.className='yj-keyboard';
    for(let midi=this.keyboardBase;midi<this.keyboardBase+24;midi++){const black=[1,3,6,8,10].includes(midi%12);const key=button(noteName(midi),'yj-key'+(black?' is-black':'')+(this.note===midi?' is-selected':''));key.addEventListener('click',()=>{this.note=midi;this._emit('preview',{track:this.selectedTrack,note:midi,chord:this.chord,velocity:this.velocity});this.render();});keyboard.appendChild(key);}
    const octaves=document.createElement('div');octaves.className='yj-roll-tools';octaves.style.marginTop='7px';
    const octDown=button('OCTAVE −');octDown.disabled=this.keyboardBase<=24;octDown.addEventListener('click',()=>{this.keyboardBase=Math.max(24,this.keyboardBase-12);this.note=this.keyboardBase;this.render();});
    const octRead=document.createElement('span');octRead.className='yj-octave-readout';octRead.textContent=noteName(this.keyboardBase)+'–'+noteName(this.keyboardBase+23);
    const octUp=button('OCTAVE +');octUp.disabled=this.keyboardBase>=84;octUp.addEventListener('click',()=>{this.keyboardBase=Math.min(84,this.keyboardBase+12);this.note=this.keyboardBase;this.render();});
    octaves.append(octDown,octRead,octUp);
    const help=document.createElement('p');help.className='yj-studio-empty-note';help.textContent='Choose a key and chord, then place notes. Click the same note twice or right-click to erase. SHIFT rotates the groove; INVERT mirrors its melody; DUPLICATE grows the loop.';
    panel.append(title,tools,grid,keyboard,octaves,help);return panel;
  }

  _paintTransport(){if(!this.root)return;const play=this.root.querySelector('[data-action="play"]');if(play){play.textContent=this.playing?'PAUSE':'PLAY';play.classList.toggle('is-active',this.playing);}}
  _paintStep(){if(!this.root)return;for(const node of this.root.querySelectorAll('.yj-note-step'))node.classList.toggle('is-playing',Number(node.dataset.step)===this.activeStep);for(const node of this.root.querySelectorAll('.yj-studio-progress-step'))node.classList.toggle('is-playing',Number(node.dataset.progressStep)===this.activeStep);for(const node of this.root.querySelectorAll('.yj-channel')){const index=Number(node.dataset.track);const track=this.studio&&this.studio.tracks[index];const hit=this.activeStep>=0&&track&&track.steps[this.activeStep];node.classList.toggle('is-playing',!!hit);}}
}
