// Yellowjacket MACHINE — CRATE state view, per docs/CONTRACT-HARVEST.md
// section 3. One row per crated instrument: NAME · ROLE · SOURCE · SECONDS,
// a LOAD button, Alt+click on LOAD to delete. Pure view: no store access, all
// DOM built here, the list only ever comes from setInstruments. Unlike the
// PATTERN/SONG views it does NOT echo its own edits: every gesture is an OPFS
// round trip, so the controller calls setInstruments when the crate on disk
// has actually changed.

const STYLE = `
.yj-crate { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.yj-crate-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yj-crate-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-ink-dim); flex-shrink: 0; }
.yj-crate-count { flex: 1 1 150px; min-width: 130px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-crate-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
.yj-crate-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 0; padding: 2px 0; }
.yj-crate-name { font-family: var(--f-mono); font-size: 11px; color: var(--yj-yellow); padding: 4px 8px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.yj-crate-role { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-amber); flex-shrink: 0; }
.yj-crate-source { flex: 1 1 auto; min-width: 0; font-size: 10px; color: var(--yj-ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yj-crate-secs { font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.yj-crate-role::before, .yj-crate-source::before, .yj-crate-secs::before { content: '· '; color: var(--yj-ink-dim); }
.yj-crate-load { flex-shrink: 0; margin-left: auto; }
.yj-crate-empty { font-size: 11px; line-height: 1.5; letter-spacing: 0.02em; color: var(--yj-ink-dim); padding: 2px; }
`;

export class CrateView extends EventTarget {
  // Contract events: 'load' {id}, 'delete' {id}, 'refresh' {}.
  constructor(host) {
    super();
    this.host = host;
    this._items = [];
    this._busy = false;
    this._loadBtns = [];

    host.classList.add('yj-crate');
    const style = document.createElement('style');
    style.textContent = STYLE;
    host.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'yj-crate-bar';

    const tag = document.createElement('span');
    tag.className = 'yj-crate-tag';
    tag.textContent = 'CRATE';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'yj-btn';
    refresh.textContent = 'REFRESH';
    refresh.title = 'Re-read the crate from disk';
    refresh.addEventListener('click', () => this._emit('refresh', {}));
    this._refresh = refresh;

    const count = document.createElement('div');
    count.className = 'yj-well yj-count yj-crate-count';
    count.textContent = 'CRATE EMPTY';
    count.title = 'The crate is stored separately from the session: instruments survive DISCARD and outlive the song they came from.';
    this._count = count;

    bar.append(tag, refresh, count);
    host.appendChild(bar);

    const list = document.createElement('div');
    list.className = 'yj-crate-list';
    host.appendChild(list);
    this._list = list;

    this._render();
  }

  // ---------- public API ----------

  setInstruments(list) {
    this._items = Array.isArray(list) ? list.slice() : [];
    this._render();
  }

  setBusy(b) {
    this._busy = !!b;
    this._refresh.classList.toggle('is-working', this._busy);
    this._refresh.disabled = this._busy;
    for (const btn of this._loadBtns) btn.disabled = this._busy;
  }

  // ---------- rendering ----------

  _render() {
    const items = this._items;
    this._loadBtns = [];
    const nodes = items.map((item) => this._buildRow(item));
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'yj-crate-empty';
      empty.textContent = 'NOTHING CRATED YET · OPEN THE VOICE DRAWER ON A TRACK WITH A SAMPLE AND PRESS CRATE + TO KEEP IT HERE';
      nodes.push(empty);
    }
    this._list.replaceChildren(...nodes);
    this._count.textContent = items.length
      ? items.length + (items.length === 1 ? ' INSTRUMENT' : ' INSTRUMENTS')
      : 'CRATE EMPTY';
    this.setBusy(this._busy);
  }

  _buildRow(item) {
    const id = item.id;
    const row = document.createElement('div');
    row.className = 'yj-crate-row';

    const name = document.createElement('span');
    name.className = 'yj-well yj-crate-name';
    name.textContent = item.name || 'INSTRUMENT';
    name.title = item.name || 'INSTRUMENT';

    const role = document.createElement('span');
    role.className = 'yj-crate-role';
    role.textContent = item.role || '—';

    const source = document.createElement('span');
    source.className = 'yj-crate-source';
    source.textContent = item.source || '—';
    source.title = 'Saved from ' + (item.source || 'an unnamed source');

    const secs = document.createElement('span');
    secs.className = 'yj-crate-secs';
    secs.textContent = this._fmtSecs(item.seconds);

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'yj-btn yj-crate-load';
    load.textContent = 'LOAD';
    load.title = 'Load this instrument into a free track of the active scene. Alt+click deletes it from the crate for good.';
    load.addEventListener('click', (e) => {
      this._emit(e && e.altKey ? 'delete' : 'load', { id });
    });
    this._loadBtns.push(load);

    row.append(name, role, source, secs, load);
    return row;
  }

  _fmtSecs(seconds) {
    const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    return s.toFixed(2) + ' S';
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
