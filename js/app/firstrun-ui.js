// First run: one screen that says what this bench is and offers four ways in.
// A new arrival sees a black page and a drop zone, which hides the fact that
// the thing transcribes, repairs, chops records into kits, sequences them, and
// prints OP-Z patches. Not a tutorial and not a modal: focus is never trapped,
// Escape closes it, a click on the backdrop closes it, and it is meant to be
// seen exactly once.
//
// Pure view. show() / hide() / setVisible(bool). Emits 'start' {path} where
// path is 'kit' | 'clean' | 'synth', and 'dismiss' {}. The view hides itself on
// any of those gestures; the caller owns the dismissed flag and should persist
// it on BOTH events, since taking a path also means never showing this again.

const STYLE = `
.yj-firstrun {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(7, 6, 4, 0.9);
}
.yj-firstrun[hidden] { display: none; }
.yj-firstrun-panel {
  width: 100%; max-width: 560px; max-height: 100%; overflow-y: auto;
  display: flex; flex-direction: column; gap: 13px;
  padding: 0 0 18px;
  background: var(--yj-panel);
  border: 1px solid var(--yj-line-hi);
}
.yj-firstrun-panel:focus { outline: none; }
.yj-firstrun-rule { height: 6px; background: var(--yj-hazard-dim); flex-shrink: 0; }
.yj-firstrun-head { display: flex; flex-direction: column; gap: 3px; padding: 14px 22px 0; }
.yj-firstrun-tag {
  font-family: var(--f-ui); font-size: 10px; font-weight: 600;
  letter-spacing: 0.14em; color: var(--yj-ink-dim);
}
.yj-firstrun-title {
  font-family: var(--f-ui); font-size: 21px; font-weight: 700;
  letter-spacing: 0.16em; color: var(--yj-yellow);
}
.yj-firstrun-copy { display: flex; flex-direction: column; gap: 8px; padding: 0 22px; }
.yj-firstrun-copy p {
  font-family: var(--f-ui); font-size: 13px; line-height: 1.55;
  color: var(--yj-ink-dim);
}
.yj-firstrun-copy .yj-firstrun-lede { color: var(--yj-ink); }
.yj-firstrun-paths { display: flex; flex-direction: column; gap: 6px; padding: 2px 22px 0; }
.yj-firstrun-path {
  display: block; width: 100%; text-align: left; white-space: normal;
  padding: 9px 12px; background: var(--yj-well);
}
.yj-firstrun-path-name {
  display: block; font-family: var(--f-ui); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; color: var(--yj-yellow);
}
.yj-firstrun-path-note {
  display: block; margin-top: 4px;
  font-family: var(--f-ui); font-size: 11px; font-weight: 400;
  letter-spacing: 0.01em; line-height: 1.5; color: var(--yj-ink-dim);
}
.yj-firstrun-path:hover:not(:disabled) .yj-firstrun-path-name { color: var(--yj-yellow-hi); }
.yj-firstrun-path:hover:not(:disabled) .yj-firstrun-path-note { color: var(--yj-ink); }
.yj-firstrun-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 4px 22px 0; }
.yj-firstrun-note {
  font-family: var(--f-mono); font-size: 9px; letter-spacing: 0.04em;
  line-height: 1.5; color: var(--yj-line-hi);
}
`;

// Order is the order they appear. Each note is one sentence, in the same plain
// register as the rest of the bench: what happens, not how good it is.
const PATHS = [
  {
    path: 'kit',
    name: 'CHOP A RECORD INTO A KIT',
    note: 'Load a track, press HARVEST, and the bench mines the whole thing for kicks, snares, hats, and chops you can play.',
  },
  {
    path: 'clean',
    name: 'CLEAN UP A RECORDING',
    note: 'Load a voice recording, transcribe it, delete the words you do not want, then paint the remaining noise off the spectrogram.',
  },
  {
    path: 'synth',
    name: 'WRITE A SOUND AS MATHS',
    note: 'Type a formula into the SYNTH panel and hear the sample it makes, with no audio loaded at all.',
  },
  {
    path: 'project',
    name: 'OPEN A YELLOWJACKET PROJECT',
    note: 'Bring back a complete .yjkt session: source audio, transcript, repairs, slices, instruments, scenes, and song.',
  },
];

let styled = false;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export class FirstRunView extends EventTarget {
  constructor(host) {
    super();
    injectStyle();
    this.host = host;
    this._visible = false;
    this._onKey = (e) => {
      if (e.key !== 'Escape') return;
      this._act('dismiss', {});
    };
    if (!host) return;

    host.className = 'yj-firstrun';
    host.hidden = true;
    // Backdrop dismiss without swallowing clicks in the panel: only a hit on
    // the host itself is the backdrop, anything in the panel targets deeper.
    host.addEventListener('click', (e) => {
      if (e.target !== host) return;
      this._act('dismiss', {});
    });

    const panel = document.createElement('div');
    panel.className = 'yj-firstrun-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'What this bench does');
    // Focusable so show() can put the keyboard here, but nothing holds it:
    // Tab walks straight out into the page behind.
    panel.tabIndex = -1;
    this._panel = panel;

    const rule = document.createElement('div');
    rule.className = 'yj-firstrun-rule';

    const head = document.createElement('div');
    head.className = 'yj-firstrun-head';
    const tag = document.createElement('span');
    tag.className = 'yj-firstrun-tag';
    tag.textContent = 'FIRST RUN';
    const title = document.createElement('h2');
    title.className = 'yj-firstrun-title';
    title.textContent = 'YELLOWJACKET';
    head.append(tag, title);

    const copy = document.createElement('div');
    copy.className = 'yj-firstrun-copy';
    const lede = document.createElement('p');
    lede.className = 'yj-firstrun-lede';
    lede.textContent = 'This is an audio bench that runs entirely in this browser tab.';
    const what = document.createElement('p');
    what.textContent = 'It transcribes speech, so you can cut a recording by deleting words from the transcript. '
      + 'Noise and coughs come out by painting over them on the spectrogram. '
      + 'The MACHINE bench chops a record into a drum kit, sequences that kit across eight tracks, and prints kits an OP-Z reads.';
    const limits = document.createElement('p');
    limits.textContent = 'Nothing you load leaves this machine, because there is no server to send it to. '
      + 'Everything runs on your own hardware, so a long file takes real time. Save a .yjkt project when the whole bench needs to travel with you.';
    copy.append(lede, what, limits);

    const paths = document.createElement('div');
    paths.className = 'yj-firstrun-paths';
    for (const spec of PATHS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yj-btn yj-firstrun-path';
      btn.dataset.path = spec.path;
      const name = document.createElement('span');
      name.className = 'yj-firstrun-path-name';
      name.textContent = spec.name;
      const note = document.createElement('span');
      note.className = 'yj-firstrun-path-note';
      note.textContent = spec.note;
      btn.append(name, note);
      btn.addEventListener('click', () => this._act('start', { path: spec.path }));
      paths.appendChild(btn);
    }

    const foot = document.createElement('div');
    foot.className = 'yj-firstrun-foot';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'yj-btn';
    dismiss.textContent = 'DISMISS';
    dismiss.addEventListener('click', () => this._act('dismiss', {}));
    this._dismiss = dismiss;
    const note = document.createElement('span');
    note.className = 'yj-firstrun-note';
    note.textContent = 'ESCAPE OR A CLICK OUTSIDE DOES THE SAME · THIS PANEL DOES NOT COME BACK';
    foot.append(dismiss, note);

    panel.append(rule, head, copy, paths, foot);
    host.appendChild(panel);
  }

  // ---------- public API ----------

  show() { this.setVisible(true); }

  hide() { this.setVisible(false); }

  setVisible(on) {
    const want = !!on;
    if (want === this._visible) return;
    this._visible = want;
    if (!this.host) return;
    this.host.hidden = !want;
    if (typeof document === 'undefined' || !document.addEventListener) return;
    if (want) {
      document.addEventListener('keydown', this._onKey);
      if (this._panel && this._panel.focus) this._panel.focus();
    } else {
      document.removeEventListener('keydown', this._onKey);
    }
  }

  get visible() { return this._visible; }

  // ---------- internals ----------

  // Every gesture closes the panel. Leaving it up after a choice would sit on
  // top of the surface the choice just asked for.
  _act(type, detail) {
    this.setVisible(false);
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
