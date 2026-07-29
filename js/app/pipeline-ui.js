// Pipeline strip: one row that answers "where am I, what do I have, what is
// next". The bench is nine screens; without this you have to hold the whole
// flow in your head. Each stage lights when it actually has something in it and
// says what, so the strip is a status readout as much as a navigation bar.
//
// Pure view. setStages(list) where each entry is {key, label, note, done,
// target}. Emits 'jump' {target}.

const STYLE = `
.yj-pipe {
  display: flex; align-items: stretch; gap: 0;
  padding: 0 16px; background: var(--yj-panel);
  border-bottom: 1px solid var(--yj-line);
  overflow-x: auto;
}
.yj-pipe-stage {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  padding: 6px 14px 6px 12px; position: relative;
  border: none; background: none; cursor: pointer; white-space: nowrap;
  min-width: 96px;
}
.yj-pipe-stage::after {
  content: ""; position: absolute; right: 0; top: 50%;
  width: 6px; height: 6px; margin-top: -3px;
  border-top: 1px solid var(--yj-line-hi); border-right: 1px solid var(--yj-line-hi);
  transform: rotate(45deg);
}
.yj-pipe-stage:last-child::after { display: none; }
.yj-pipe-name {
  font-family: var(--f-ui); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--yj-ink-dim);
}
.yj-pipe-note {
  font-family: var(--f-mono); font-size: 9px; letter-spacing: 0.03em;
  color: var(--yj-line-hi);
}
.yj-pipe-stage.is-done .yj-pipe-name { color: var(--yj-yellow); }
.yj-pipe-stage.is-done .yj-pipe-note { color: var(--yj-amber); }
.yj-pipe-stage.is-next .yj-pipe-name { color: var(--yj-ink); }
.yj-pipe-stage.is-next .yj-pipe-note { color: var(--yj-ink-dim); }
.yj-pipe-stage:hover .yj-pipe-name { color: var(--yj-yellow-hi); }
.yj-pipe-stage:focus-visible { outline: 1px solid var(--yj-yellow); outline-offset: -2px; }
.yj-pipe-stage.is-done::before {
  content: ""; position: absolute; left: 0; top: 6px; bottom: 6px;
  width: 2px; background: var(--yj-yellow);
}
.yj-pipe-stage.is-next::before {
  content: ""; position: absolute; left: 0; top: 6px; bottom: 6px;
  width: 2px; background: var(--yj-hazard-dim);
}
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// Derived from the document, not tracked separately, so the strip can never
// claim a stage is done when it is not. Notes say what you HAVE, which is more
// use than a tick: "4 OF 8 TRACKS" tells you where you got to.
export function deriveStages(project, runtime) {
  const P = project;
  const m = P.machine;
  const tracks = m.tracks;
  const kit = tracks.filter((t) => t.sample).length;
  let steps = 0;
  for (const t of tracks) {
    for (let i = 0; i < t.len; i++) if (t.steps[i]) steps++;
  }
  const chain = m.song && m.song.chain ? m.song.chain.length : 0;
  const clips = P.clips.length;
  const loaded = !!runtime.buffer;
  const secs = loaded ? runtime.buffer.duration : 0;
  const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0');

  return [
    {
      key: 'source', label: 'SOURCE', done: loaded,
      note: loaded ? (P.fileName || 'LOADED').replace(/\.[^.]+$/, '').slice(0, 18).toUpperCase() : 'DROP A FILE',
      target: { tab: 'signal' },
      hint: loaded ? mmss(secs) + ' loaded' : 'Load audio to begin',
    },
    {
      key: 'slice', label: 'SLICE', done: clips > 0,
      note: clips ? clips + (clips === 1 ? ' CLIP' : ' CLIPS') : 'CARVE OR HARVEST',
      target: { tab: 'machine', mstate: 'slice' },
      hint: 'Carve clips by dragging, or HARVEST the whole track',
    },
    {
      key: 'kit', label: 'KIT', done: kit > 0,
      note: kit ? kit + ' OF ' + tracks.length + ' TRACKS' : 'ASSIGN SLICES',
      target: { tab: 'machine', mstate: 'pattern' },
      hint: 'Assign slices to machine tracks',
    },
    {
      key: 'pattern', label: 'PATTERN', done: steps > 0,
      note: steps ? steps + (steps === 1 ? ' STEP · ' : ' STEPS · ') + Math.round(m.bpm) + ' BPM' : 'PROGRAM STEPS',
      target: { tab: 'machine', mstate: 'pattern' },
      hint: 'Program the step grid',
    },
    {
      key: 'song', label: 'SONG', done: chain > 0,
      note: chain ? chain + (chain === 1 ? ' SECTION' : ' SECTIONS') : 'CHAIN SCENES',
      target: { tab: 'machine', mstate: 'song' },
      hint: 'Chain scenes into an arrangement',
    },
    {
      key: 'out', label: 'OUT', done: false,
      note: chain ? 'RENDER SONG' : (steps ? 'FREEZE OR PRINT' : 'NOTHING YET'),
      target: { tab: 'machine', mstate: chain ? 'song' : 'pattern' },
      hint: 'Print a WAV, or a drum kit for the OP-Z',
    },
  ];
}

export class PipelineView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this._stages = [];
    if (host) {
      host.className = 'yj-pipe';
      host.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('.yj-pipe-stage') : null;
        if (!btn) return;
        const stage = this._stages.find((s) => s.key === btn.dataset.key);
        if (stage && stage.target) this.dispatchEvent(new CustomEvent('jump', { detail: { target: stage.target } }));
      });
    }
  }

  setStages(stages) {
    this._stages = stages || [];
    this._render();
  }

  _render() {
    const host = this.host;
    if (!host) return;
    host.textContent = '';
    // The first stage that is not done is "next": exactly one hint about where
    // to go, rather than lighting everything and helping with nothing.
    const nextIndex = this._stages.findIndex((s) => !s.done);
    this._stages.forEach((stage, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yj-pipe-stage'
        + (stage.done ? ' is-done' : '')
        + (i === nextIndex ? ' is-next' : '');
      btn.dataset.key = stage.key;
      btn.title = stage.hint || stage.label;

      const name = document.createElement('span');
      name.className = 'yj-pipe-name';
      name.textContent = stage.label;

      const note = document.createElement('span');
      note.className = 'yj-pipe-note';
      note.textContent = stage.note || '—';

      btn.append(name, note);
      host.appendChild(btn);
    });
  }
}
