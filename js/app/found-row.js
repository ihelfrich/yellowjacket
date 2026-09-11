// The instruments the lab has measured from real recordings, offered on the intake
// overlay. They are the only thing in the bench that sounds with no file, no
// download and no network: a card is a few hundred modes with damping, so
// pressing one resynthesizes the object rather than replaying a sample. That
// makes them the honest answer to "what is this", which is why they sit here
// and not only in a mixer row nine options down a native select.
import { FOUND_CARDS, foundCardUrl } from '../studio/found-cards.js';
import { instrumentPool } from '../instrument/pool.js';
import { cardPitchHz } from '../instrument/family.js';
import { cardVoiceLevel, SILENT_PEAK } from '../studio/card-voice.js';
import { noteName } from './instrument-controller.js';

// A strike rings out on its own; bow and breath are driven and stop when the
// note does, so they need a stated length.
const STRUCK_SECONDS = 2.5;
const DRIVEN_SECONDS = 1.6;

export function initFoundRow(ctx) {
  const { $, engine, status, statusFault } = ctx;
  const host = $('foundRow');
  if (!host) return;

  const cards = new Map();   // id -> card
  const renders = new Map(); // id -> { samples, sampleRate, meta }
  let source = null;
  let last = null;

  const head = document.createElement('p');
  head.className = 'yj-label';
  head.textContent = 'Press a real object';
  const note = document.createElement('p');
  note.className = 'yj-found-note';
  note.innerHTML = 'Instruments measured from real recordings — modes, damping, and how the pitch bends '
    + 'when you hit it harder. No file, no download, nothing fetched. Press one and the object sounds.';
  const row = document.createElement('div');
  row.className = 'yj-found-row';
  const line = document.createElement('p');
  line.className = 'yj-found-line';
  line.setAttribute('role', 'status');
  line.textContent = '';

  const toStudio = document.createElement('button');
  toStudio.className = 'yj-btn yj-btn-primary yj-found-take';
  toStudio.hidden = true;
  toStudio.textContent = 'PLAY IT IN STUDIO';
  toStudio.title = 'Put this instrument on a STUDIO part and open the keyboard';

  const stopPlayback = () => {
    if (!source) return;
    try { source.stop(); } catch { /* already ended */ }
    source = null;
  };

  async function strike(entry, button) {
    stopPlayback();
    let card = cards.get(entry.id);
    if (!card) {
      button.disabled = true;
      line.textContent = 'MEASURING ' + entry.name + '…';
      try {
        const res = await fetch(foundCardUrl(entry.id, document.baseURI));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        card = await res.json();
        cards.set(entry.id, card);
      } catch (err) {
        line.textContent = entry.name + ' DID NOT LOAD · ' + (err && err.message ? err.message : err);
        return;
      } finally { button.disabled = false; }
    }
    const pitchHz = cardPitchHz(card);
    let v = renders.get(entry.id);
    if (!v) {
      const seconds = entry.excitation === 'strike' ? STRUCK_SECONDS : DRIVEN_SECONDS;
      button.disabled = true;
      try { v = await instrumentPool.render({ card, pitchHz, excitation: entry.excitation, seconds }); }
      catch (err) {
        const msg = entry.name + ' DID NOT SOUND · ' + (err && err.message ? err.message : err);
        line.textContent = msg;
        if (statusFault) statusFault(msg);
        return;
      } finally { button.disabled = false; }
      renders.set(entry.id, v);
    }
    const peak = v.meta.peak || 0;
    if (!(peak > SILENT_PEAK)) { line.textContent = entry.name + ' · SILENT UNDER ' + entry.excitation.toUpperCase(); return; }
    source = engine.audition(v.samples, { sampleRate: v.sampleRate, gain: cardVoiceLevel(peak, 1) });
    if (!source) { line.textContent = 'NO AUDIO OUTPUT YET · PRESS AGAIN'; return; }
    source.onended = () => { source = null; };
    last = entry;
    line.textContent = entry.name + ' · ' + entry.note + ' · ' + noteName(pitchHz)
      + ' ' + pitchHz.toFixed(1) + ' Hz · ' + card.modes.length + ' MODES · '
      + v.meta.decay60Sec.toFixed(2) + ' s TO −60 dB';
    toStudio.hidden = false;
    toStudio.textContent = 'PLAY ' + entry.name + ' IN STUDIO';
  }

  for (const entry of FOUND_CARDS) {
    const b = document.createElement('button');
    b.className = 'yj-btn yj-found-btn';
    b.textContent = entry.name;
    b.title = entry.note + ' · ' + entry.excitation;
    b.setAttribute('aria-label', entry.name + ', ' + entry.note + ', press to hear it');
    b.addEventListener('click', () => { strike(entry, b); });
    row.appendChild(b);
  }

  toStudio.addEventListener('click', () => {
    if (!last) return;
    const card = cards.get(last.id);
    if (!card || !ctx.api.studioSetCard) return;
    stopPlayback();
    $('dropZone').classList.add('is-hidden');
    // studioSetCard jumps to STUDIO and previews the card's own pitch itself.
    ctx.api.studioSetCard(card, last.excitation, last.name, 0);
    status(last.name + ' IS ON PART 1 · PLAY IT WITH THE KEYS A W S E D F');
  });

  host.append(head, note, row, line, toStudio);
  ctx.api.stopFoundRow = stopPlayback;
  // The command deck's doorway to the one thing here that needs no source.
  ctx.api.revealFoundRow = () => {
    $('dropZone').classList.remove('is-hidden');
    host.scrollIntoView({ block: 'center' });
    const first = row.querySelector('button');
    if (first) first.focus();
  };
}
