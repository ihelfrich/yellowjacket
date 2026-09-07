// The bench's own confirm, in place of window.confirm: a native confirm blocks
// the page, ignores the theme, cannot be styled, cannot be tested, and reads
// as the browser talking rather than the bench. This one is a small modal
// panel in the bench's type: a title, a body, a cancel and an act button.
// Escape, the backdrop and CANCEL resolve false; Enter and the act button
// resolve true. Destructive acts focus CANCEL first, so a stray Enter keeps
// things. One at a time: a second call while one is open resolves false.

let styled = false;
let open = null;

const STYLE = `
.yj-confirm { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(7, 6, 4, 0.82); }
.yj-confirm-panel { width: min(480px, 100%); background: var(--yj-panel); border: 1px solid var(--yj-line-hi); box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; }
.yj-confirm-panel:focus { outline: none; }
.yj-confirm-rule { height: 6px; background: var(--yj-hazard-dim); flex-shrink: 0; }
.yj-confirm-panel.is-danger .yj-confirm-rule { background: var(--yj-hazard); }
.yj-confirm-body { padding: 16px 22px 6px; display: flex; flex-direction: column; gap: 8px; }
.yj-confirm-title { margin: 0; font-family: var(--f-ui); font-size: 13px; font-weight: 700; letter-spacing: 0.08em; color: var(--yj-yellow); }
.yj-confirm-body p { margin: 0; color: var(--yj-ink-dim); font-size: 12.5px; line-height: 1.6; max-width: 46em; }
.yj-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 22px 18px; }
.yj-confirm-actions .yj-btn-danger { border-color: var(--yj-hazard); color: var(--yj-hazard); }
.yj-confirm-actions .yj-btn-danger:hover:not(:disabled) { background: var(--yj-hazard); color: #000; border-color: var(--yj-hazard); }
`;

function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** The body text as paragraphs: a blank line separates them, a single break joins. Pure. */
export function paragraphsOf(body) {
  return String(body || '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

/**
 * confirmDialog({ title, body, ok, cancel, danger }) → Promise<boolean>.
 * `ok` names the act ("REPLACE", "DISCARD"); `danger` marks it destructive.
 */
export function confirmDialog({ title = 'ARE YOU SURE?', body = '', ok = 'OK', cancel = 'CANCEL', danger = false } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (open) return Promise.resolve(false);
  injectStyle();
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'yj-confirm';
    const panel = document.createElement('div');
    panel.className = 'yj-confirm-panel' + (danger ? ' is-danger' : '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    const rule = document.createElement('div'); rule.className = 'yj-confirm-rule';
    const bodyEl = document.createElement('div'); bodyEl.className = 'yj-confirm-body';
    const h = document.createElement('h2'); h.className = 'yj-confirm-title'; h.id = 'yjConfirmTitle'; h.textContent = String(title).toUpperCase();
    panel.setAttribute('aria-labelledby', h.id);
    bodyEl.appendChild(h);
    for (const text of paragraphsOf(body)) { const p = document.createElement('p'); p.textContent = text; bodyEl.appendChild(p); }
    const actions = document.createElement('div'); actions.className = 'yj-confirm-actions';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'yj-btn'; no.textContent = String(cancel).toUpperCase();
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'yj-btn ' + (danger ? 'yj-btn-danger' : 'yj-btn-primary'); yes.textContent = String(ok).toUpperCase();
    actions.append(no, yes);
    panel.append(rule, bodyEl, actions);
    host.appendChild(panel);

    const previous = document.activeElement;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      open = null;
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      if (previous && previous.focus) { try { previous.focus(); } catch (_) { /* gone */ } }
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key === 'Tab') {
        // two buttons, one ring
        e.preventDefault(); e.stopPropagation();
        (document.activeElement === yes ? no : yes).focus();
        return;
      }
      if (e.key === 'Enter' && document.activeElement !== no) { e.preventDefault(); e.stopPropagation(); finish(true); return; }
      // nothing behind the dialog hears keys
      e.stopPropagation();
    };
    no.addEventListener('click', () => finish(false));
    yes.addEventListener('click', () => finish(true));
    host.addEventListener('click', (e) => { if (e.target === host) finish(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(host);
    open = host;
    (danger ? no : yes).focus();
  });
}

/** A confirm that prefers the bench's dialog and falls back to window.confirm where there is no DOM. */
export async function confirmAct(spec) {
  if (typeof document !== 'undefined' && document.body) return confirmDialog(spec);
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(`${spec.title || ''}\n\n${spec.body || ''}`.trim());
  return true;
}
