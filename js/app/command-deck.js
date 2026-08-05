// Command deck: one searchable map over a bench with many surfaces. It does
// not own actions or application state; the composition root supplies a fresh
// action list whenever it opens and receives a single 'run' event in return.

const STYLE = `
.yj-command {
  position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-start;
  justify-content: center; padding: min(12vh, 112px) 18px 24px;
  background: rgba(7, 6, 4, .9);
}
.yj-command[hidden] { display: none; }
.yj-command-deck {
  width: min(760px, 100%); max-height: min(720px, 78vh); overflow: hidden;
  display: flex; flex-direction: column; background: var(--yj-panel);
  border: 1px solid var(--yj-line-hi); border-top: 6px solid transparent;
  border-image: var(--yj-hazard-dim) 6 0 0 0;
}
.yj-command-head { display: flex; align-items: flex-start; gap: 14px; padding: 15px 17px 12px; }
.yj-command-kicker { font-size: 9px; font-weight: 700; letter-spacing: .13em; color: var(--yj-ink-dim); }
.yj-command-title { margin-top: 2px; font-size: 16px; font-weight: 700; letter-spacing: .11em; color: var(--yj-yellow); }
.yj-command-context {
  margin-left: auto; max-width: 48%; text-align: right; font-family: var(--f-mono);
  font-size: 9px; line-height: 1.55; letter-spacing: .03em; color: var(--yj-amber);
}
.yj-command-search-wrap { position: relative; margin: 0 17px 10px; }
.yj-command-search {
  width: 100%; padding: 12px 86px 12px 13px; background: var(--yj-well);
  border: 1px solid var(--yj-line-hi); border-radius: 2px; color: var(--yj-ink);
  font-family: var(--f-mono); font-size: 13px; outline: none;
}
.yj-command-search:focus { border-color: var(--yj-yellow); }
.yj-command-search::placeholder { color: var(--yj-ink-dim); }
.yj-command-search-key {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  font-family: var(--f-mono); font-size: 9px; color: var(--yj-ink-dim);
}
.yj-command-results { overflow-y: auto; padding: 0 8px 8px; border-top: 1px solid var(--yj-line); }
.yj-command-group {
  padding: 11px 9px 5px; font-size: 9px; font-weight: 700; letter-spacing: .13em;
  color: var(--yj-amber-dim);
}
.yj-command-row {
  width: 100%; display: grid; grid-template-columns: minmax(170px, .8fr) minmax(220px, 1.4fr) auto;
  align-items: center; gap: 14px; padding: 9px 10px; text-align: left;
  border: 1px solid transparent; border-radius: 2px; background: transparent;
}
.yj-command-row:hover:not(:disabled), .yj-command-row.is-selected {
  background: var(--yj-select); border-color: var(--yj-line-hi);
}
.yj-command-row.is-selected { border-left-color: var(--yj-yellow); }
.yj-command-row:disabled { opacity: .42; cursor: default; }
.yj-command-name { font-size: 11px; font-weight: 700; letter-spacing: .07em; color: var(--yj-ink); }
.yj-command-row:not(:disabled) .yj-command-name { color: var(--yj-yellow); }
.yj-command-note { font-family: var(--f-mono); font-size: 9px; line-height: 1.4; color: var(--yj-ink-dim); }
.yj-command-key {
  min-width: 56px; text-align: right; font-family: var(--f-mono); font-size: 9px;
  letter-spacing: .04em; color: var(--yj-amber);
}
.yj-command-empty { padding: 28px 12px; text-align: center; font-family: var(--f-mono); font-size: 10px; color: var(--yj-ink-dim); }
.yj-command-foot {
  display: flex; align-items: center; gap: 12px; padding: 8px 17px;
  border-top: 1px solid var(--yj-line); font-family: var(--f-mono);
  font-size: 9px; color: var(--yj-ink-dim);
}
.yj-command-foot span:last-child { margin-left: auto; color: var(--yj-amber-dim); }
@media (max-width: 700px) {
  .yj-command { padding: 10px; align-items: stretch; }
  .yj-command-deck { max-height: 100%; }
  .yj-command-context { display: none; }
  .yj-command-search { padding-right: 12px; }
  .yj-command-search-key { display: none; }
  .yj-command-row { grid-template-columns: 1fr auto; gap: 7px; }
  .yj-command-note { grid-column: 1 / -1; }
}
`;

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function searchable(action) {
  return [action.label, action.note, action.group, action.keywords]
    .filter(Boolean).join(' ').toLowerCase();
}

function matches(action, query) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = searchable(action);
  return words.every((word) => haystack.includes(word));
}

export class CommandDeckView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this.actions = [];
    this.visible = false;
    this.selected = -1;
    if (!host) return;

    host.className = 'yj-command';
    host.hidden = true;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Yellowjacket command deck');

    const deck = document.createElement('div');
    deck.className = 'yj-command-deck';
    this.deck = deck;

    const head = document.createElement('div');
    head.className = 'yj-command-head';
    const titleWrap = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'yj-command-kicker';
    kicker.textContent = 'WORKBENCH MAP';
    const title = document.createElement('div');
    title.className = 'yj-command-title';
    title.textContent = 'COMMAND DECK';
    titleWrap.append(kicker, title);
    const context = document.createElement('div');
    context.className = 'yj-command-context';
    context.textContent = 'EMPTY BENCH · LOCAL';
    this.context = context;
    head.append(titleWrap, context);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'yj-command-search-wrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'yj-command-search';
    search.placeholder = 'TYPE AN ACTION · PROJECT, TRANSCRIBE, HARVEST, SIGNAL…';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Search commands');
    this.search = search;
    const searchKey = document.createElement('span');
    searchKey.className = 'yj-command-search-key';
    searchKey.textContent = 'ESC CLOSES';
    searchWrap.append(search, searchKey);

    const results = document.createElement('div');
    results.className = 'yj-command-results';
    results.setAttribute('role', 'listbox');
    this.results = results;

    const foot = document.createElement('div');
    foot.className = 'yj-command-foot';
    foot.innerHTML = '<span>↑↓ MOVE · ENTER RUNS</span><span>EVERYTHING STAYS LOCAL</span>';

    deck.append(head, searchWrap, results, foot);
    host.appendChild(deck);

    host.addEventListener('pointerdown', (event) => {
      if (event.target === host) this.hide();
    });
    search.addEventListener('input', () => this.render());
    search.addEventListener('keydown', (event) => this.onKey(event));
    results.addEventListener('click', (event) => {
      const row = event.target.closest && event.target.closest('.yj-command-row');
      if (!row || row.disabled) return;
      this.run(row.dataset.id);
    });
  }

  setActions(actions) {
    this.actions = Array.isArray(actions) ? actions.slice() : [];
    if (this.visible) this.render();
  }

  setContext(text) {
    if (this.context) this.context.textContent = text || 'EMPTY BENCH · LOCAL';
  }

  show() {
    if (!this.host) return;
    this.visible = true;
    this.host.hidden = false;
    this.search.value = '';
    this.render();
    this.search.focus();
  }

  hide() {
    if (!this.host) return;
    this.visible = false;
    this.host.hidden = true;
    this.selected = -1;
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  filtered() { return this.actions.filter((action) => matches(action, this.search.value)); }

  enabledRows() {
    return Array.from(this.results.querySelectorAll('.yj-command-row:not(:disabled)'));
  }

  onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.hide(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    const rows = this.enabledRows();
    if (!rows.length) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      const row = rows.find((item) => item.classList.contains('is-selected')) || rows[0];
      this.run(row.dataset.id);
      return;
    }
    let index = rows.findIndex((item) => item.classList.contains('is-selected'));
    index += event.key === 'ArrowDown' ? 1 : -1;
    if (index < 0) index = rows.length - 1;
    if (index >= rows.length) index = 0;
    for (const row of rows) row.classList.remove('is-selected');
    rows[index].classList.add('is-selected');
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  run(id) {
    const action = this.actions.find((item) => item.id === id);
    if (!action || action.enabled === false) return;
    this.hide();
    this.dispatchEvent(new CustomEvent('run', { detail: { id } }));
  }

  render() {
    if (!this.results) return;
    this.results.textContent = '';
    const filtered = this.filtered();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'yj-command-empty';
      empty.textContent = 'NO MATCH · try a bench name or an output';
      this.results.appendChild(empty);
      return;
    }
    let group = null;
    let firstEnabled = true;
    for (const action of filtered) {
      if (action.group !== group) {
        group = action.group;
        const heading = document.createElement('div');
        heading.className = 'yj-command-group';
        heading.textContent = group || 'ACTIONS';
        this.results.appendChild(heading);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'yj-command-row';
      row.dataset.id = action.id;
      row.disabled = action.enabled === false;
      row.setAttribute('role', 'option');
      if (firstEnabled && !row.disabled) { row.classList.add('is-selected'); firstEnabled = false; }
      const name = document.createElement('span');
      name.className = 'yj-command-name';
      name.textContent = action.label;
      const note = document.createElement('span');
      note.className = 'yj-command-note';
      note.textContent = row.disabled && action.reason ? action.reason : (action.note || '');
      const key = document.createElement('span');
      key.className = 'yj-command-key';
      key.textContent = action.key || '';
      row.append(name, note, key);
      this.results.appendChild(row);
    }
  }
}
