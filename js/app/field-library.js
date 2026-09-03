import { MineStore, formatMineMeta } from './mine.js';
import { windowRange, windowLabel, parseClock, clock, WINDOW_SPANS_SEC, DEFAULT_WINDOW_SEC } from '../dsp/window-load.js';

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

export const SHELVES = Object.freeze(['FIELD', 'VOICE', 'SIGNAL', 'SCORE', 'MUSIC', 'ODD']);
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

  // ---------- VOICE (speech that is a work of the US government, so public domain) ----------
  { id: 'fdr-1933', shelf: 'VOICE', kind: 'ADDRESS', title: 'THE FIRST FIRESIDE CHAT', place: 'Franklin D. Roosevelt · March 12, 1933', dur: '13:09',
    license: 'PD', source: IA_ITEM + 'FdrFiresideChat_740',
    light: light('FdrFiresideChat_740', 'FDR_First_Fireside_Chat_3-12-33-1.mp3', 9.0) },
  { id: 'voa-2019', shelf: 'VOICE', kind: 'NEWSCAST', title: 'VOA NEWS, 00:00 UTC', place: 'Voice of America · July 11, 2019', dur: '4:58',
    license: 'PD', source: IA_ITEM + 'voanewscasts2019-07-11',
    light: light('voanewscasts2019-07-11', 'VOA-newscast-2019-07-11-0000Z.mp3', 2.3) },

  // ---------- SIGNAL ----------
  // Radio as it arrives: time stations, a distress-frequency sign-off, a
  // wartime code test, and the espionage stations anyone with a shortwave
  // set can hear. The transmissions are open broadcasts; the recordings are
  // by hobbyists and agencies who released them CC0 or as US government
  // work. Nothing here is decrypted — one-time pads cannot be — but the
  // cadence, the tones, and the symbol timing are all material.
  { id: 'wwv-1991', shelf: 'SIGNAL', kind: 'TIME STATION', title: 'WWV, FORT COLLINS', place: 'NIST · December 8, 1991, 02:18 UTC', dur: '13:10',
    license: 'PD', source: IA_ITEM + 'radio-station-wwv-1991-12-08-0218-utc',
    light: light('radio-station-wwv-1991-12-08-0218-utc', 'Radio%20Station%20WWV%20-%201991-12-08%20%280218%20UTC%29.mp3', 10.2),
    hi: hi('radio-station-wwv-1991-12-08-0218-utc', 'Radio%20Station%20WWV%20-%201991-12-08%20%280218%20UTC%29.flac', 79.2, 48000, 24) },
  { id: 'jjy-2001', shelf: 'SIGNAL', kind: 'TIME STATION', title: 'JJY SIGNS OFF, 8 MHz', place: 'Japan · March 31, 2001, 03:00 UTC', dur: '1:28',
    license: 'CC0', source: IA_ITEM + 'JapanTimeSignalRadioStationJjy8MhzCloses',
    light: light('JapanTimeSignalRadioStationJjy8MhzCloses', 'jjymono.mp3', 0.7) },
  { id: 'kossuth-540', shelf: 'SIGNAL', kind: 'MEDIUMWAVE', title: 'KOSSUTH RADIO, 540 kHz', place: 'Hungary · time signal and identification, 2015', dur: '0:32',
    license: 'CC0', source: IA_ITEM + 'MR1KossuthRadio540KHzHungary',
    light: light('MR1KossuthRadio540KHzHungary', 'MR1%20Kossuth%20Radio%20-%20540%20KHz%20-%20Hungary.mp3', 0.4) },
  { id: 'uvb76-2010', shelf: 'SIGNAL', kind: 'THE BUZZER', title: 'UVB-76 WITH A VOICE MESSAGE', place: 'Russia, 4625 kHz · December 5, 2010, 12:22 UTC', dur: '2:40',
    license: 'CC0', source: IA_ITEM + 'UVB76activity',
    light: light('UVB76activity', 'UVB-76-05-12-2010-1222UTC.mp3', 0.6),
    hi: hi('UVB76activity', 'UVB-76-05-12-2010-1222UTC.flac', 1.6, 8000, 16) },
  { id: 'hm01-2019', shelf: 'SIGNAL', kind: 'NUMBERS', title: 'HM01 AND A FAX BURST', place: 'Cuba, 9240 kHz · July 24, 2019, 09:03 UTC', dur: '2:54',
    license: 'PD', source: IA_ITEM + 'cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz',
    light: light('cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz', 'Cuban%20numbers%20station%20and%20SW%20fax.%202019-07-24T09_03_00Z_9240.0kHz.mp3', 0.6),
    hi: hi('cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz', 'Cuban%20numbers%20station%20and%20SW%20fax.%202019-07-24T09_03_00Z_9240.0kHz.flac', 2.3, 8000, 16) },
  { id: 'm08-2009', shelf: 'SIGNAL', kind: 'NUMBERS · MORSE', title: 'M08, CUBAN NUMBERS IN MORSE', place: 'Cuba, 11435 kHz CW · December 23, 2009, 17:59 UTC', dur: '1:25',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Cuba%20DGI%20-%20M08%2011435%20CW%201759z-1800z%2012-23-09.mp3', 1.3) },
  { id: 'sk01-2009', shelf: 'SIGNAL', kind: 'NUMBERS · DIGITAL', title: 'SK01, DATA BURSTS', place: 'Cuba, 11435 kHz AM · December 23, 2009, 17:44 UTC', dur: '0:45',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Cuba%20DGI%20-%20SK01%2011435%20AM%201744z%2012-23-09.mp3', 0.7) },
  { id: 'g11-2010', shelf: 'SIGNAL', kind: 'NUMBERS', title: 'G11, A WOMAN COUNTING IN GERMAN', place: 'Austria, 8091 kHz USB · March 29, 2010, 09:35 UTC', dur: '3:17',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Austria%20HNA%20-%20G11%208091%20USB%200935z-0938z%2003-29-10.mp3', 3.0) },
  { id: 'code-1942', shelf: 'SIGNAL', kind: 'MORSE', title: 'SIGNAL CORPS CODE APTITUDE TEST', place: 'US War Department training record · c. 1942', dur: '4:05',
    license: 'PD', source: IA_ITEM + 'U.S._Armed_Forces_Institute_Basic_Radio_Code_ca1942',
    light: light('U.S._Armed_Forces_Institute_Basic_Radio_Code_ca1942', '01A_Signal_Corps_Code_Aptitude_Test.mp3', 3.7) },

  // ---------- LONG captures: loaded a window at a time ----------
  // `long` carries the file's total seconds and bytes so the card can offer a
  // window (2 / 5 / 10 minutes from any point). MP3 only: an MPEG stream
  // resyncs at any frame, so a byte range decodes wherever it is cut.
  { id: 'hm01-hour', shelf: 'SIGNAL', kind: 'NUMBERS · HOUR', title: 'HM01, A FULL HOUR', place: 'Cuba, 5855 kHz AM · February 3, 2013, 10:00 UTC', dur: '63:25',
    license: 'CC BY-NC-SA', source: IA_ITEM + 'NumbersStationhm01-5855khz-1000utc-03february2013',
    light: light('NumbersStationhm01-5855khz-1000utc-03february2013', 'HM01-NumbersStation-5.855MHz-1000UTC-03Feb2013.mp3', 36.3),
    long: { seconds: 3805, bytes: 38058848 } },
  { id: 'marine-electric-sos', shelf: 'SIGNAL', kind: 'DISTRESS · MORSE', title: 'SS MARINE ELECTRIC, SOS ON 500 kHz', place: 'USCG COMMSTA Boston · February 12, 1983', dur: '91:38',
    license: 'CC0', source: IA_ITEM + 'SsMarineElectricWoohSos',
    light: light('SsMarineElectricWoohSos', 'Marine_Electric_SOS.mp3', 24.5),
    long: { seconds: 5498, bytes: 25704448 } },
  { id: 'voyager-launch', shelf: 'VOICE', kind: 'MISSION', title: 'VOYAGER 1 LAUNCH COMMENTARY', place: 'NASA · September 5, 1977', dur: '87:37',
    license: 'PD', source: IA_ITEM + 'Voyager1',
    light: light('Voyager1', 'Voyager-1_Launch_Commentary.mp3', 80.3),
    long: { seconds: 5257, bytes: 84200000 } },

  // ---------- ODD (Voyager) ----------
  // NASA tape 495-AAB is catalogued "Voyager Earth Sounds": the Golden Record
  // montage, abstract sounds framed by music. It was shelved as launch-day
  // control-room audio until Ian heard otherwise. The bow shock is the raw
  // thing: the plasma wave instrument, played back as audio.
  { id: 'voyager-earth', shelf: 'ODD', kind: 'GOLDEN RECORD', title: 'SOUNDS OF EARTH', place: 'Voyager Golden Record montage · NASA tape 495-AAB, 1977', dur: '8:12',
    license: 'PD', source: IA_ITEM + 'Voyager1',
    light: light('Voyager1', '495-AAB_8min10sec.mp3', 8.6),
    hi: hi('Voyager1', '495-AAB_8min10sec.flac', 43.7, 44100, 16) },
  { id: 'voyager-bowshock', shelf: 'ODD', kind: 'PLASMA WAVE', title: "VOYAGER 1 AT JUPITER'S BOW SHOCK", place: 'Plasma wave instrument, played as sound · 1979', dur: '0:44',
    license: 'PD', source: IA_ITEM + 'V1JupBowshock',
    light: light('V1JupBowshock', 'v1-jup-bowshock.mp3', 0.4) },

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
  'CC BY-NC-SA': 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
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
        name, bytes: await R.sourceBytes.bytes(), hash: R.sourceHash, seconds: R.buffer.duration,
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
      if (rec.long) {
        badge.textContent = 'LONG · ' + badgeFor(v);
        btn.title += ' · loads a window at a time';
        btn.addEventListener('click', () => openWindowRow(rec, v, btn));
        grid.appendChild(btn);
        continue;
      }
      btn.addEventListener('click', () => {
        if (!ctx.api.loadFromUrl) return;
        ctx.api.loadFromUrl(v.url, rec.title + ' — ' + rec.place + (v.format === 'FLAC' ? '.flac' : '.mp3'));
      });
      grid.appendChild(btn);
    }
  }

  // A long capture: choose where and how much, then fetch only that range.
  let windowRow = null;
  function openWindowRow(rec, v, card) {
    if (windowRow) windowRow.remove();
    const row = document.createElement('div');
    row.className = 'yj-window-row';
    const lede = document.createElement('span');
    lede.className = 'yj-field-meta';
    lede.textContent = clock(rec.long.seconds) + ' TOTAL · LOAD A WINDOW FROM';
    const from = document.createElement('input');
    from.type = 'text';
    from.className = 'yj-window-from';
    from.value = '0:00';
    from.setAttribute('aria-label', 'Start (mm:ss)');
    const span = document.createElement('select');
    span.className = 'yj-window-span';
    for (const s of WINDOW_SPANS_SEC) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = clock(s) + ' LONG';
      if (s === DEFAULT_WINDOW_SEC) o.selected = true;
      span.appendChild(o);
    }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'yj-btn yj-btn-primary yj-btn-compact';
    go.textContent = 'LOAD WINDOW';
    const note = document.createElement('span');
    note.className = 'yj-field-meta';
    note.textContent = 'POSITION IS ≈ FOR A VARIABLE-BITRATE FILE';
    go.addEventListener('click', () => {
      const startSec = parseClock(from.value);
      if (startSec == null) { ctx.statusFault('WINDOW · START MUST BE mm:ss'); from.focus(); return; }
      const range = windowRange({ totalBytes: rec.long.bytes, totalSec: rec.long.seconds, startSec, spanSec: Number(span.value) });
      if (!range || !ctx.api.loadFromUrl) { ctx.statusFault('WINDOW · NOTHING TO LOAD THERE'); return; }
      ctx.api.loadFromUrl(v.url, windowLabel(rec.title, range) + ' — ' + rec.place + '.mp3', { range });
    });
    from.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    row.append(lede, from, span, go, note);
    card.insertAdjacentElement('afterend', row);
    windowRow = row;
    from.focus();
    from.select();
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
