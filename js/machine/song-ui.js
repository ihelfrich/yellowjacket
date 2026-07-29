// Yellowjacket MACHINE — SONG state view. Chain editor (one row per section:
// scene letter, reps stepper, move up/down, delete), transport row (PLAY SONG
// / STOP, LOOP, RENDER SONG) and a readout well: sections + total duration
// when idle, SECTION X · REP Y/Z while playing. Pure view per CONTRACT-SONG.md
// section 3: no store access, all DOM built here, every edit emits a CLONED
// chain array (the controller owns machine.song). Because dispatchEvent is
// synchronous, each edit re-reads the live song reference right after
// emitting, so rows show whatever the controller actually applied.

const SCENES = 8;
const REP_MIN = 1;
const REP_MAX = 99;
const REPS_NEW = 4;                 // ADD SECTION appends {scene: active, reps: 4}
const LETTERS = 'ABCDEFGH';

const STYLE = `
.yj-song { display: flex; flex-direction: column; gap: 10px; }
.yj-song-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yj-song-play { min-width: 96px; }
.yj-song-readout { flex: 1 1 170px; min-width: 150px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-song-chain { display: flex; flex-direction: column; gap: 4px; }
.yj-song-row { display: flex; align-items: center; gap: 6px; max-width: 420px; padding: 3px 4px; border: 1px solid transparent; border-radius: 2px; }
.yj-song-row.is-now { border-color: var(--yj-amber); background: var(--yj-select); }
.yj-song-idx { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); width: 18px; text-align: right; flex-shrink: 0; }
.yj-song-scene { width: 26px; height: 26px; font-size: 11px; font-weight: 700; }
.yj-song-reps { font-family: var(--f-mono); font-size: 11px; color: var(--yj-ink); font-variant-numeric: tabular-nums; width: 34px; text-align: center; flex-shrink: 0; }
.yj-song-tools { display: flex; gap: 3px; margin-left: auto; }
.yj-song-empty { font-size: 10px; letter-spacing: 0.08em; color: var(--yj-ink-dim); padding: 8px 4px; }
.yj-song-add { align-self: flex-start; }
`;

export class SongView extends EventTarget {
  // Contract events: 'chainedit' {chain} (always a fresh clone, never the
  // internal array), 'loop' {loop}, 'play', 'stop', 'render',
  // 'audition' {scene}. The scene letter is the only letter gesture, so a
  // click both cycles the entry to the next scene (chainedit) and emits
  // 'audition' for the scene it landed on (the preview-switch of
  // CONTRACT-SONG.md section 3).
  constructor(host) {
    super();
    this.host = host;
    this._song = null;              // live reference; controller mutates contents
    this._scenes = null;
    this._sectionSecs = null;
    this._activeScene = null;       // optional 4th setSong arg; ADD SECTION seed
    this._playing = false;
    this._section = null;
    this._rep = null;
    this._rows = [];

    host.classList.add('yj-song');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'yj-song-bar';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'yj-btn yj-btn-primary yj-song-play';
    play.textContent = 'PLAY SONG';
    play.title = 'Play the arrangement from the top / stop';
    play.disabled = true;
    play.addEventListener('click', () => this._playClick());
    this._btnPlay = play;

    const loop = document.createElement('button');
    loop.type = 'button';
    loop.className = 'yj-btn';
    loop.textContent = 'LOOP';
    loop.title = 'Loop the song when it reaches the end';
    loop.addEventListener('click', () => this._toggleLoop());
    this._btnLoop = loop;

    const render = document.createElement('button');
    render.type = 'button';
    render.className = 'yj-btn';
    render.textContent = 'RENDER SONG';
    render.title = 'Render the arrangement offline to a WAV: prints exactly what PLAY SONG plays';
    render.disabled = true;
    render.addEventListener('click', () => this._emit('render', {}));
    this._btnRender = render;

    const readout = document.createElement('div');
    readout.className = 'yj-well yj-count yj-song-readout';
    readout.textContent = 'NO SECTIONS';
    readout.title = 'Sections and total duration; position while playing. Songs are deterministic: every pass replays the same seeded take, so RENDER SONG prints exactly what PLAY SONG played.';
    this._readout = readout;

    bar.append(play, loop, render, readout);
    host.appendChild(bar);

    const chainEl = document.createElement('div');
    chainEl.className = 'yj-song-chain';
    host.appendChild(chainEl);
    this._chainEl = chainEl;

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'yj-btn yj-song-add';
    add.textContent = 'ADD SECTION';
    add.title = 'Append a section: the active scene, repeated 4 times';
    add.addEventListener('click', () => this._addSection());
    this._btnAdd = add;
    host.appendChild(add);
  }

  // ---------- public API ----------

  setSong(song, scenes, sectionSecs, activeScene) {
    this._song = song || null;
    this._scenes = scenes || null;
    this._sectionSecs = sectionSecs || null;
    this._activeScene = (typeof activeScene === 'number' && isFinite(activeScene))
      ? Math.min(SCENES - 1, Math.max(0, activeScene | 0))
      : this._activeScene;
    this._syncChain();
    this._syncBar();
  }

  setPosition(sectionIndex, rep) {
    // rep is 0-based (matches sectionIndex); the readout shows rep + 1.
    this._section = (typeof sectionIndex === 'number' && sectionIndex >= 0) ? sectionIndex | 0 : null;
    this._rep = (typeof rep === 'number' && rep >= 0) ? rep | 0 : 0;
    this._syncPosition();
  }

  setPlaying(b) {
    this._playing = !!b;
    this._btnPlay.textContent = this._playing ? 'STOP' : 'PLAY SONG';
    this._btnPlay.classList.toggle('is-working', this._playing);
    if (!this._playing) {
      this._section = null;
      this._rep = null;
    }
    this._syncBar();
  }

  // ---------- chain state helpers ----------

  _chain() {
    return (this._song && Array.isArray(this._song.chain)) ? this._song.chain : [];
  }

  _cloneChain() {
    // Emits never share objects with the internal chain; clamps keep any
    // stray persisted values inside the contract ranges.
    return this._chain().map((en) => ({
      scene: (((en.scene | 0) % SCENES) + SCENES) % SCENES,
      reps: Math.min(REP_MAX, Math.max(REP_MIN, en.reps | 0)),
    }));
  }

  // ---------- edits (all emit a cloned chain, then re-read live state) ----------

  _cycleScene(i) {
    const chain = this._cloneChain();
    if (!chain[i]) return;
    const next = (chain[i].scene + 1) % SCENES;
    chain[i].scene = next;
    this._emit('chainedit', { chain });
    this._emit('audition', { scene: next });
    this._syncChain();
    this._syncBar();
  }

  _stepReps(i, d) {
    const chain = this._cloneChain();
    if (!chain[i]) return;
    const v = Math.min(REP_MAX, Math.max(REP_MIN, chain[i].reps + d));
    if (v === chain[i].reps) return;
    chain[i].reps = v;
    this._emit('chainedit', { chain });
    this._syncChain();
    this._syncBar();
  }

  _moveRow(i, d) {
    const chain = this._cloneChain();
    const j = i + d;
    if (!chain[i] || j < 0 || j >= chain.length) return;
    const t = chain[i];
    chain[i] = chain[j];
    chain[j] = t;
    this._emit('chainedit', { chain });
    this._syncChain();
    this._syncBar();
  }

  _deleteRow(i) {
    const chain = this._cloneChain();
    if (!chain[i]) return;
    chain.splice(i, 1);
    this._emit('chainedit', { chain });
    this._syncChain();
    this._syncBar();
  }

  _addSection() {
    const chain = this._cloneChain();
    const scene = this._activeScene != null
      ? this._activeScene
      : (chain.length ? chain[chain.length - 1].scene : 0);
    chain.push({ scene, reps: REPS_NEW });
    this._emit('chainedit', { chain });
    this._syncChain();
    this._syncBar();
  }

  _toggleLoop() {
    if (!this._song) return;
    this._emit('loop', { loop: !this._song.loop });
    this._syncBar();
  }

  _playClick() {
    this._emit(this._playing ? 'stop' : 'play', {});
  }

  // ---------- rendering ----------

  _syncChain() {
    const chain = this._chain();
    this._rows = [];
    const nodes = [];
    for (let i = 0; i < chain.length; i++) nodes.push(this._buildRow(i, chain[i], chain.length));
    if (!chain.length) {
      const d = document.createElement('div');
      d.className = 'yj-song-empty';
      d.textContent = 'NO SECTIONS · ADD SECTION APPENDS THE ACTIVE SCENE ×4';
      nodes.push(d);
    }
    this._chainEl.replaceChildren(...nodes);
  }

  _buildRow(i, entry, count) {
    const row = document.createElement('div');
    row.className = 'yj-song-row';

    const idx = document.createElement('span');
    idx.className = 'yj-song-idx';
    idx.textContent = String(i + 1);

    const sq = (txt, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yj-pattern-sq';
      b.textContent = txt;
      b.title = title;
      return b;
    };

    const sceneIdx = (((entry.scene | 0) % SCENES) + SCENES) % SCENES;
    const sc = this._scenes ? this._scenes[sceneIdx] : null;
    const scene = sq(
      LETTERS[sceneIdx],
      'Section ' + (i + 1) + ': ' + (sc && sc.name ? sc.name : 'SCENE ' + (sceneIdx + 1))
        + '. Click cycles to the next scene (wraps) and previews it in PATTERN.',
    );
    scene.classList.add('yj-song-scene');
    const hasSteps = !!(sc && sc.tracks && sc.tracks.some(
      (t) => t && t.steps && Array.prototype.some.call(t.steps, (v) => v),
    ));
    scene.classList.toggle('has-dot', hasSteps);
    scene.addEventListener('click', () => this._cycleScene(i));

    const minus = sq('−', 'One repeat fewer');
    minus.addEventListener('click', () => this._stepReps(i, -1));
    const reps = document.createElement('span');
    reps.className = 'yj-song-reps';
    reps.textContent = '×' + Math.min(REP_MAX, Math.max(REP_MIN, entry.reps | 0));
    const plus = sq('+', 'One repeat more');
    plus.addEventListener('click', () => this._stepReps(i, 1));

    const tools = document.createElement('div');
    tools.className = 'yj-song-tools';
    const up = sq('↑', 'Move section up');
    up.disabled = i === 0;
    up.addEventListener('click', () => this._moveRow(i, -1));
    const down = sq('↓', 'Move section down');
    down.disabled = i === count - 1;
    down.addEventListener('click', () => this._moveRow(i, 1));
    const del = sq('×', 'Delete section');
    del.addEventListener('click', () => this._deleteRow(i));
    tools.append(up, down, del);

    row.append(idx, scene, minus, reps, plus, tools);
    this._rows.push(row);
    return row;
  }

  _syncBar() {
    this._btnLoop.classList.toggle('is-active', !!(this._song && this._song.loop));
    const empty = !this._chain().length;
    this._btnPlay.disabled = empty && !this._playing;
    this._btnRender.disabled = empty;
    this._syncPosition();
  }

  _syncPosition() {
    const chain = this._chain();
    for (let i = 0; i < this._rows.length; i++) {
      this._rows[i].classList.toggle('is-now', this._playing && i === this._section);
    }
    const ro = this._readout;
    if (this._playing && this._section != null && chain[this._section]) {
      const reps = Math.min(REP_MAX, Math.max(REP_MIN, chain[this._section].reps | 0));
      const rep = Math.min(reps, Math.max(1, (this._rep | 0) + 1));
      ro.textContent = 'SECTION ' + (this._section + 1) + ' · REP ' + rep + '/' + reps;
    } else if (!chain.length) {
      ro.textContent = 'NO SECTIONS';
    } else {
      const total = this._totalSec();
      ro.textContent = chain.length + (chain.length === 1 ? ' SECTION' : ' SECTIONS')
        + (total != null ? ' · ' + this._fmtMSS(total) : '');
    }
  }

  _totalSec() {
    const secs = this._sectionSecs;
    if (!secs || !secs.length) return null;
    let t = 0;
    for (const v of secs) t += isFinite(v) ? Number(v) : 0;
    return t;
  }

  _fmtMSS(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return m + ':' + String(s - m * 60).padStart(2, '0');
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
