// Clip list: the readable half of SLICE. The canvas shows where slices are in
// time; this shows what they ARE, as rows you can read, sort by eye, audition,
// and act on. Pure view, no store access. Events: 'select' {id}, 'audition'
// {id}, 'remove' {id}, 'assign' {id}.

const STYLE = `
.yj-cliplist { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; }
.yj-cliprow {
  display: grid; grid-template-columns: 1fr auto auto auto auto; gap: 6px; align-items: center;
  padding: 4px 6px; background: var(--yj-well); border: 1px solid var(--yj-line);
  font-family: var(--f-mono); font-size: 10px; letter-spacing: 0.04em; cursor: pointer;
}
.yj-cliprow:hover { border-color: var(--yj-amber-dim); }
.yj-cliprow.is-sel { border-color: var(--yj-yellow); background: var(--yj-select); }
.yj-cliprow-name { color: var(--yj-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-cliprow-role {
  color: #0B0A07; background: var(--yj-amber-dim); padding: 1px 4px; font-size: 9px;
}
.yj-cliprow-num { color: var(--yj-ink-dim); font-variant-numeric: tabular-nums; }
.yj-cliprow-btn {
  background: transparent; border: 1px solid var(--yj-line); color: var(--yj-ink-dim);
  font-family: var(--f-mono); font-size: 9px; padding: 1px 5px; cursor: pointer;
}
.yj-cliprow-btn:hover { color: var(--yj-yellow); border-color: var(--yj-yellow); }
.yj-cliplist-empty { font-family: var(--f-mono); font-size: 10px; color: var(--yj-ink-dim); padding: 6px; line-height: 1.5; }
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function fmtSec(t) {
  if (!isFinite(t)) return '--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? m + ':' + s.toFixed(1).padStart(4, '0') : s.toFixed(2) + 's';
}

export class ClipListView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this._clips = [];
    this._selectedId = null;
    if (host) {
      host.className = 'yj-cliplist';
      host.addEventListener('click', (e) => this._onClick(e));
    }
  }

  setClips(clips, selectedId) {
    this._clips = clips || [];
    this._selectedId = selectedId == null ? null : selectedId;
    this._render();
  }

  setSelected(id) {
    this._selectedId = id == null ? null : id;
    this._render();
  }

  _onClick(e) {
    const row = e.target.closest ? e.target.closest('.yj-cliprow') : null;
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.dataset ? e.target.dataset.act : null;
    if (act === 'remove') { this._emit('remove', { id }); return; }
    if (act === 'assign') { this._emit('assign', { id }); return; }
    if (act === 'play') { this._emit('audition', { id }); return; }
    this._emit('select', { id });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _render() {
    const host = this.host;
    if (!host) return;
    host.textContent = '';
    if (!this._clips.length) {
      const p = document.createElement('p');
      p.className = 'yj-cliplist-empty';
      p.textContent = 'No clips yet. Drag across the waveform to carve one, or press HARVEST to mine the whole track for a kit.';
      host.appendChild(p);
      return;
    }
    for (const clip of this._clips) {
      const row = document.createElement('div');
      row.className = 'yj-cliprow' + (clip.id === this._selectedId ? ' is-sel' : '');
      row.dataset.id = clip.id;
      row.title = clip.start.toFixed(3) + 's to ' + clip.end.toFixed(3) + 's';

      const name = document.createElement('span');
      name.className = 'yj-cliprow-name';
      name.textContent = clip.label || clip.tag || clip.id;

      const role = document.createElement('span');
      role.className = 'yj-cliprow-role';
      role.textContent = (clip.tag || '?').toUpperCase().slice(0, 6);

      const at = document.createElement('span');
      at.className = 'yj-cliprow-num';
      at.textContent = fmtSec(clip.start);

      const len = document.createElement('span');
      len.className = 'yj-cliprow-num';
      len.textContent = fmtSec(Math.max(0, clip.end - clip.start));

      const tools = document.createElement('span');
      const mk = (act, txt, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'yj-cliprow-btn';
        b.dataset.act = act;
        b.textContent = txt;
        b.title = title;
        return b;
      };
      tools.append(
        mk('play', '▶', 'Audition this clip'),
        mk('assign', 'A', 'Assign to the next free machine track'),
        mk('remove', '×', 'Delete this clip'),
      );

      row.append(name, role, at, len, tools);
      host.appendChild(row);
    }
  }
}
