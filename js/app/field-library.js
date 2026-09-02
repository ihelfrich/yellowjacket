import { MineStore, formatMineMeta } from './mine.js';

// The SHELF: public-domain recordings streamed from archive.org on demand.
// Started as FIELD (nature and city) and grew into five shelves, because a
// bench that transcribes speech had no speech to try, and a bench that keeps
// 96 kHz files had nothing above 48 kHz to keep.
//
// Every entry was licence-checked by hand at its archive.org item page: CC0,
// Public Domain Mark, or a sound recording old enough to be public domain in
// the United States outright. Nothing here owes attribution downstream.
//
// Two variants per entry where the archive has them: `light` is the MP3 the
// archive derived, and `hi` is the lossless original. The rate and depth on a
// `hi` entry were read from the file header, not from the archive's metadata,
// which is silent about both. A 96 kHz CONTAINER does not imply 96 kHz of
// content — Cicada Orni is 96 kHz on the label and ordinary bandwidth inside,
// so the spectrogram, not the badge, is the authority on what a file holds.

export const SHELVES = Object.freeze(['FIELD', 'VOICE', 'SCORE', 'MUSIC', 'ODD']);
// The sixth drawer is not in the manifest: MINE is whatever this visitor kept,
// held in the browser's private storage (js/app/mine.js), never published.
export const MINE_SHELF = 'MINE';

const IA = 'https://archive.org/download/';
const IA_ITEM = 'https://archive.org/details/';

function light(item, file, mb) {
  return { url: IA + item + '/' + file, mb, format: 'MP3' };
}
function hi(item, file, mb, rate, bits) {
  return { url: IA + item + '/' + file, mb, format: 'FLAC', rate, bits };
}

export const FIELD_RECORDINGS = Object.freeze([
  // ---------- FIELD: places ----------
  { id: 'nightingale', shelf: 'FIELD', kind: 'BIRDS', title: 'NIGHTINGALE, MIDNIGHT', place: 'English hedgerow', dur: '4:00',
    license: 'CC0', source: IA_ITEM + 'NightingaleSongMay2012',
    light: light('NightingaleSongMay2012', 'NightingaleMay12.mp3', 5.5) },
  { id: 'berlin-dawn', shelf: 'FIELD', kind: 'EDGE', title: 'SONGBIRDS VS RUSH HOUR', place: 'Berlin, dawn', dur: '4:11',
    license: 'PD', source: IA_ITEM + 'aporee_63516_73093',
    light: light('aporee_63516_73093', '2403220817rushhourroarsenseofspacedistsongbirdsjaywdpgncrowsgrnwdpkredit.mp3', 9.6) },
  { id: 'pico-caves', shelf: 'FIELD', kind: 'SEA', title: 'WAVES IN LAVA CAVES', place: 'Pico Island, Azores', dur: '3:50',
    license: 'PD', source: IA_ITEM + 'aporee_61033_70158',
    light: light('aporee_61033_70158', 'CAVERNWAVESCACHORROILHAPICO.mp3', 5.0),
    hi: hi('aporee_61033_70158', 'CAVERNWAVESCACHORROILHAPICO.flac', 42.5, 48000, 24) },
  { id: 'coxs-bazar', shelf: 'FIELD', kind: 'SEA', title: 'SURF ON A LONG BEACH', place: "Cox's Bazar, Bangladesh", dur: '5:35',
    license: 'PD', source: IA_ITEM + 'aporee_55131_63018',
    light: light('aporee_55131_63018', 'coxbazarsea.mp3', 12.8) },
  { id: 'somerset-storm', shelf: 'FIELD', kind: 'STORM', title: 'THUNDERSTORM OVERHEAD', place: 'Wedmore, Somerset', dur: '3:43',
    license: 'PD', source: IA_ITEM + 'aporee_19025_22067',
    light: light('aporee_19025_22067', 'THUNDERLIGHTNINGJULY2013SPHEREX4000011MAX.mp3', 4.1),
    hi: hi('aporee_19025_22067', 'THUNDERLIGHTNINGJULY2013SPHEREX4000011MAX.flac', 27.2, 48000, 24) },
  { id: 'thunder-rain', shelf: 'FIELD', kind: 'STORM', title: 'THUNDER THROUGH RAIN', place: 'a porch in the rain', dur: '2:31',
    license: 'PD', source: IA_ITEM + 'thunder-and-rain-sounds-18-d.-d.-teoli-jr.-a.-c.',
    light: light('thunder-and-rain-sounds-18-d.-d.-teoli-jr.-a.-c.', 'Thunder%20and%20Rain%20sounds%2018%20D.D.Teoli%20Jr.%20A.C..mp3', 2.3) },
  { id: 'marsh-brook', shelf: 'FIELD', kind: 'WATER', title: 'A SMALL BROOK', place: 'Constitution Marsh, NY', dur: '2:08',
    license: 'PD', source: IA_ITEM + 'smallbrookconstitutionmarsh',
    light: light('smallbrookconstitutionmarsh', 'Small%20brook%2C%20Constitution%20Marsh.mp3', 3.3),
    hi: hi('smallbrookconstitutionmarsh', 'Small%20brook%2C%20Constitution%20Marsh.flac', 25.3, 44100, 24) },
  { id: 'spring-peepers', shelf: 'FIELD', kind: 'NIGHT', title: 'SPRING PEEPERS, DARK', place: 'a wetland at night', dur: '8:29',
    license: 'CC0', source: IA_ITEM + 'frogs-toads-spring-peepers-crickets-sound-effects',
    light: light('frogs-toads-spring-peepers-crickets-sound-effects', '2014-spring-peepers-edit-19426.mp3', 9.7) },
  { id: 'night-insects', shelf: 'FIELD', kind: 'NIGHT', title: 'NIGHT FOREST INSECTS', place: 'Los Gatos, California', dur: '2:31',
    license: 'PD', source: IA_ITEM + 'aporee_41451_47281',
    light: light('aporee_41451_47281', 'nightgarden2.mp3', 1.9),
    hi: hi('aporee_41451_47281', 'nightgarden2.flac', 12.1, 44100, 24) },
  { id: 'cicada-orni', shelf: 'FIELD', kind: 'INSECT', title: 'CICADA ORNI, MIDDAY', place: 'Catalonia, one tree', dur: '0:59',
    license: 'CC0', source: IA_ITEM + 'cicadaorni_201909',
    light: light('cicadaorni_201909', 'Cicada%20Orni.mp3', 1.0),
    hi: hi('cicadaorni_201909', 'Cicada%20Orni.flac', 7.1, 96000, 16) },
  { id: 'sevilla-street', shelf: 'FIELD', kind: 'CITY', title: 'MARATHON AND CHURCH BELLS', place: 'Sevilla, Spain', dur: '3:07',
    license: 'PD', source: IA_ITEM + 'aporee_33774_38854',
    light: light('aporee_33774_38854', 'SevillaMacarenaMarathonundGlocken.mp3', 5.7) },

  // ---------- VOICE: words ----------
  { id: 'hiawatha', shelf: 'VOICE', kind: 'POEM', title: "HIAWATHA'S CHILDHOOD", place: 'Longfellow, read aloud', dur: '4:52',
    license: 'PD', source: IA_ITEM + 'poems_every_child_should_know_librivox',
    light: light('poems_every_child_should_know_librivox', 'poems_every_child_21_burt.mp3', 4.5) },
  { id: 'voyager-1', shelf: 'VOICE', kind: 'MISSION', title: 'VOYAGER 1, LAUNCH DAY', place: 'NASA control room, 1977', dur: '8:12',
    license: 'PD', source: IA_ITEM + 'Voyager1',
    light: light('Voyager1', '495-AAB_8min10sec.mp3', 8.6),
    hi: hi('Voyager1', '495-AAB_8min10sec.flac', 43.7, 44100, 16) },

  // ---------- SCORE ----------
  { id: 'goldberg-22', shelf: 'SCORE', kind: 'PIANO', title: 'GOLDBERG VARIATION 22', place: 'J. S. Bach · Shelley Katz', dur: '2:17',
    license: 'PD', source: IA_ITEM + 'MusopenCollectionAsFlac',
    hi: hi('MusopenCollectionAsFlac', 'Bach_GoldbergVariations/JohannSebastianBach-23-GoldbergVariationsBwv.988-Variation22.flac', 4.8, 44100, 24) },
  { id: 'goldberg-4', shelf: 'SCORE', kind: 'PIANO', title: 'GOLDBERG VARIATION 4', place: 'J. S. Bach · Shelley Katz', dur: '0:54',
    license: 'PD', source: IA_ITEM + 'MusopenCollectionAsFlac',
    hi: hi('MusopenCollectionAsFlac', 'Bach_GoldbergVariations/JohannSebastianBach-05-GoldbergVariationsBwv.988-Variation4.flac', 2.9, 44100, 24) },

  // ---------- MUSIC: records ----------
  { id: 'kid-ory-1921', shelf: 'MUSIC', kind: 'JAZZ', title: 'SOCIETY BLUES · 1921', place: "Kid Ory's Sunshine Orchestra", dur: '3:12',
    license: 'PD', source: IA_ITEM + '78_society-blues_kid-orys-sunshine-orchestra-papa-mutt-carey-kid-ory-dink-johnson-fre_gbia0215087b',
    light: light('78_society-blues_kid-orys-sunshine-orchestra-papa-mutt-carey-kid-ory-dink-johnson-fre_gbia0215087b', 'SOCIETY%20BLUES%20-%20KID%20ORY%27S%20SUNSHINE%20ORCHESTRA.mp3', 5.4),
    hi: hi('78_society-blues_kid-orys-sunshine-orchestra-papa-mutt-carey-kid-ory-dink-johnson-fre_gbia0215087b', 'SOCIETY%20BLUES%20-%20KID%20ORY%27S%20SUNSHINE%20ORCHESTRA.flac', 63.6, 96000, 24) },
  { id: 'ethel-waters-1922', shelf: 'MUSIC', kind: 'BLUES', title: "JAZZIN' BABIES BLUES · 1922", place: 'Ethel Waters, sung', dur: '3:07',
    license: 'PD', source: IA_ITEM + '78_jazzin-babies-blues_ethel-waters-and-joe-smiths-jazz-masters-richard-jones_gbia0363130a',
    light: light('78_jazzin-babies-blues_ethel-waters-and-joe-smiths-jazz-masters-richard-jones_gbia0363130a', 'JAZZIN%27%20BABIES%20BLUES%20-%20ETHEL%20WATERS%20And%20Joe%20Smith%27s%20Jazz%20Masters.mp3', 5.7),
    hi: hi('78_jazzin-babies-blues_ethel-waters-and-joe-smiths-jazz-masters-richard-jones_gbia0363130a', 'JAZZIN%27%20BABIES%20BLUES%20-%20ETHEL%20WATERS%20And%20Joe%20Smith%27s%20Jazz%20Masters.flac', 61.7, 96000, 24) },

  // ---------- ODD ----------
  { id: 'vlf-chorus', shelf: 'ODD', kind: 'VLF', title: 'CHORUS FROM THE MAGNETOSPHERE', place: 'Manitoba, natural radio', dur: '3:00',
    license: 'PD', source: IA_ITEM + 'auroral_chorus_2_cd',
    light: light('auroral_chorus_2_cd', '06Track06-highandmedpitchchorusmanitobaaug96.mp3', 3.4) },
  { id: 'vlf-whistler', shelf: 'ODD', kind: 'VLF', title: 'LIGHTNING, HEARD AS A WHISTLER', place: 'Alberta, natural radio', dur: '5:52',
    license: 'PD', source: IA_ITEM + 'auroral_chorus_2_cd',
    light: light('auroral_chorus_2_cd', '02Track02-AlbertaNoseWhistlerjune96-mono.mp3', 6.7) },
]);

const LICENSE_URLS = Object.freeze({
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  PD: 'https://creativecommons.org/publicdomain/mark/1.0/',
});

export function fieldLicenseUrl(tag) {
  return LICENSE_URLS[tag] || null;
}

/** The variant to stream for a given quality preference, never null for a real entry. */
export function variantFor(rec, lossless) {
  if (!rec) return null;
  if (lossless && rec.hi) return rec.hi;
  return rec.light || rec.hi || null;
}

const PREF_KEY = 'yj-shelf-lossless';

function readPref() {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch (e) { return false; }
}
function writePref(on) {
  try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
}

export function initFieldLibrary(ctx) {
  const { $ } = ctx;
  const host = $('fieldLibrary');
  if (!host) return;

  let shelf = 'FIELD';
  let lossless = readPref();
  const R = ctx.store.runtime;
  const P = ctx.store.project;

  // ---- MINE: the visitor's own kept recordings ----
  let mine = null;          // MineStore, or null where the browser has no OPFS write path
  let mineOpened = false;
  let mineItems = [];
  let mineUsage = null;
  async function refreshMine() {
    mineItems = mine ? await mine.list() : [];
    mineUsage = mine ? await mine.estimate() : null;
  }
  MineStore.open().then(async (store) => {
    mine = store;
    mineOpened = true;
    await refreshMine();
    render();
  }).catch(() => { mineOpened = true; render(); });

  function canKeep() { return !!(R.buffer && R.sourceBytes); }

  async function keepLoaded() {
    if (!canKeep()) { ctx.statusFault('KEEP · LOAD A RECORDING FIRST'); return false; }
    if (!mine) { ctx.statusFault('KEEP · THIS BROWSER HAS NO PRIVATE STORAGE FOR A SHELF'); return false; }
    const name = P.fileName || 'RECORDING';
    const report = ctx.engine && ctx.engine.decodeReport;
    try {
      const res = await mine.put({
        name, bytes: R.sourceBytes, hash: R.sourceHash, seconds: R.buffer.duration,
        rate: (report && report.nativeRate) || 0, channels: R.buffer.numberOfChannels,
      });
      await refreshMine();
      shelf = MINE_SHELF;
      render();
      ctx.status(res.duplicate
        ? 'ALREADY ON MY SHELF · ' + name
        : 'KEPT ON MY SHELF · ' + name + ' · STAYS IN THIS BROWSER, NEVER UPLOADED');
      return true;
    } catch (e) {
      ctx.statusFault('KEEP FAILED · ' + (e && e.message ? e.message : 'STORAGE REFUSED'));
      return false;
    }
  }

  async function openMine(id) {
    if (!mine || !ctx.api.loadArrayBuffer) return false;
    const got = await mine.get(id);
    if (!got) {
      ctx.statusFault('THAT KEEP IS GONE · ITS BYTES ARE MISSING FROM STORAGE');
      await refreshMine();
      render();
      return false;
    }
    await ctx.api.loadArrayBuffer(got.bytes, got.meta.name);
    return true;
  }

  async function removeMine(id) {
    if (!mine) return false;
    const ok = await mine.remove(id);
    await refreshMine();
    render();
    if (ok) ctx.status('REMOVED FROM MY SHELF');
    return ok;
  }

  const keepBtn = $('btnKeep');
  if (keepBtn) {
    keepBtn.addEventListener('click', keepLoaded);
    keepBtn.disabled = !canKeep();
    ctx.store.addEventListener('change', () => {
      keepBtn.disabled = !canKeep();
      if (shelf === MINE_SHELF) render();
    });
  }
  ctx.api.keepOnShelf = keepLoaded;
  ctx.api.openKept = openMine;

  function reveal() {
    $('dropZone').classList.remove('is-hidden');
    const first = host.querySelector('.yj-field-btn');
    if (first) first.focus();
  }
  const opener = $('btnField');
  if (opener) opener.addEventListener('click', reveal);
  ctx.api.revealFieldLibrary = reveal;

  // ---- shelf chips ----
  const chips = document.createElement('div');
  chips.className = 'yj-shelf-chips';
  for (const name of [...SHELVES, MINE_SHELF]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'yj-shelf-chip';
    b.dataset.shelf = name;
    b.textContent = name;
    if (name === MINE_SHELF) b.title = 'Your own recordings, kept in this browser. Nothing is uploaded.';
    b.addEventListener('click', () => { shelf = name; render(); });
    chips.appendChild(b);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'yj-shelf-chip yj-shelf-quality';
  toggle.title = 'LIGHT streams the MP3 the archive derived. LOSSLESS streams the original — larger, and the rate on the badge is what the file header says.';
  toggle.addEventListener('click', () => { lossless = !lossless; writePref(lossless); render(); });
  chips.appendChild(toggle);
  host.appendChild(chips);

  const grid = document.createElement('div');
  grid.className = 'yj-field-grid';
  host.appendChild(grid);

  function badgeFor(v) {
    if (!v) return '';
    if (v.format === 'FLAC' && v.rate) return Math.round(v.rate / 1000) + 'k · ' + v.bits + '-bit';
    return 'MP3';
  }

  function render() {
    for (const b of chips.querySelectorAll('[data-shelf]')) {
      b.classList.toggle('is-active', b.dataset.shelf === shelf);
    }
    toggle.textContent = lossless ? 'LOSSLESS' : 'LIGHT';
    toggle.classList.toggle('is-active', lossless);
    toggle.hidden = shelf === MINE_SHELF;

    grid.textContent = '';
    if (shelf === MINE_SHELF) { renderMine(); return; }
    for (const rec of FIELD_RECORDINGS) {
      if (rec.shelf !== shelf) continue;
      const v = variantFor(rec, lossless);
      if (!v) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yj-field-btn';
      btn.dataset.fieldId = rec.id;
      btn.title = rec.title + ' · ' + rec.place + ' · ' + rec.dur + ' · ' + badgeFor(v) + ' · ' + v.mb + ' MB';

      const kind = document.createElement('span');
      kind.className = 'yj-field-kind';
      kind.textContent = rec.kind;
      const badge = document.createElement('span');
      badge.className = 'yj-field-badge' + (v.format === 'FLAC' ? ' is-lossless' : '');
      badge.textContent = badgeFor(v);
      const title = document.createElement('span');
      title.className = 'yj-field-title';
      title.textContent = rec.title;
      const meta = document.createElement('span');
      meta.className = 'yj-field-meta';
      meta.textContent = rec.place + ' · ' + rec.dur + ' · ' + v.mb + ' MB';

      const head = document.createElement('span');
      head.className = 'yj-field-head-row';
      head.append(kind, badge);
      btn.append(head, title, meta);
      btn.addEventListener('click', () => {
        if (!ctx.api.loadFromUrl) return;
        ctx.api.loadFromUrl(v.url, rec.title + ' — ' + rec.place + (v.format === 'FLAC' ? '.flac' : '.mp3'));
      });
      grid.appendChild(btn);
    }
  }

  function renderMine() {
    const bar = document.createElement('div');
    bar.className = 'yj-mine-bar';
    const note = document.createElement('span');
    note.className = 'yj-field-meta';
    if (!mineOpened) note.textContent = 'OPENING YOUR SHELF…';
    else if (!mine) note.textContent = 'THIS BROWSER CANNOT KEEP FILES · NO PRIVATE STORAGE WRITE PATH';
    else {
      const total = mineItems.reduce((sum, m) => sum + m.bytes, 0);
      note.textContent = mineItems.length + (mineItems.length === 1 ? ' KEPT' : ' KEPT')
        + ' · ' + (total / (1024 * 1024)).toFixed(1) + ' MB IN THIS BROWSER'
        + (mineUsage && mineUsage.quota ? ' · ' + Math.round(mineUsage.quota / (1024 * 1024 * 1024)) + ' GB ALLOWED' : '')
        + ' · NEVER UPLOADED';
    }
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'yj-btn yj-btn-primary yj-btn-compact';
    keep.textContent = 'KEEP THE LOADED RECORDING';
    keep.disabled = !mine || !canKeep();
    keep.title = canKeep() ? 'Keep ' + (P.fileName || 'this recording') + ' on this shelf' : 'Load a recording first';
    keep.addEventListener('click', keepLoaded);
    bar.append(note, keep);
    grid.appendChild(bar);

    if (mine && !mineItems.length) {
      const empty = document.createElement('p');
      empty.className = 'yj-mine-empty';
      empty.textContent = 'NOTHING KEPT YET · OPEN A FILE, THEN PRESS KEEP';
      grid.appendChild(empty);
      return;
    }
    for (const m of mineItems) {
      const card = document.createElement('div');
      card.className = 'yj-mine-card';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'yj-field-btn';
      btn.dataset.mineId = m.id;
      btn.title = m.name + ' · ' + formatMineMeta(m);
      const kind = document.createElement('span');
      kind.className = 'yj-field-kind';
      kind.textContent = 'MINE';
      const badge = document.createElement('span');
      badge.className = 'yj-field-badge' + (m.rate > 48000 ? ' is-lossless' : '');
      badge.textContent = m.channels ? (m.channels === 1 ? 'MONO' : m.channels === 2 ? 'STEREO' : m.channels + 'CH') : '';
      const title = document.createElement('span');
      title.className = 'yj-field-title';
      title.textContent = m.name;
      const meta = document.createElement('span');
      meta.className = 'yj-field-meta';
      meta.textContent = formatMineMeta(m);
      const head = document.createElement('span');
      head.className = 'yj-field-head-row';
      head.append(kind, badge);
      btn.append(head, title, meta);
      btn.addEventListener('click', () => openMine(m.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'yj-mine-remove';
      remove.textContent = 'REMOVE';
      remove.title = 'Remove this keep from the browser (the original file on disk is untouched)';
      let armed = 0;
      remove.addEventListener('click', () => {
        if (!armed) {
          remove.textContent = 'SURE?';
          remove.classList.add('is-armed');
          armed = setTimeout(() => { armed = 0; remove.textContent = 'REMOVE'; remove.classList.remove('is-armed'); }, 3000);
          return;
        }
        clearTimeout(armed);
        removeMine(m.id);
      });
      card.append(btn, remove);
      grid.appendChild(card);
    }
  }
  render();
}
