// FIELD: a curated shelf of public-domain field recordings, streamed from
// archive.org on demand. The bench treats a place the way it treats a song —
// spectrogram, loudness rail, SLICE, MACHINE — so a thunderstorm or a beach
// becomes something you can take apart and read, not just play in the
// background. Nothing here is bundled: like the Whisper weights, a recording
// is fetched over the network only when you ask for it, and archive.org
// serves these files with CORS headers so the fetch happens in the open.
//
// Every entry was license-checked by hand: CC0 or Public Domain Mark, no
// attribution debt passed on to whatever you make from it. `source` is the
// archive.org item page where that license is stated.

export const FIELD_RECORDINGS = Object.freeze([
  {
    id: 'nightingale',
    title: 'NIGHTINGALE, MIDNIGHT',
    place: 'English hedgerow',
    kind: 'BIRDS',
    dur: '4:00',
    url: 'https://archive.org/download/NightingaleSongMay2012/NightingaleMay12.mp3',
    source: 'https://archive.org/details/NightingaleSongMay2012',
    license: 'CC0',
  },
  {
    id: 'berlin-dawn',
    title: 'SONGBIRDS VS RUSH HOUR',
    place: 'Berlin, dawn',
    kind: 'EDGE',
    dur: '4:11',
    url: 'https://archive.org/download/aporee_63516_73093/2403220817rushhourroarsenseofspacedistsongbirdsjaywdpgncrowsgrnwdpkredit.mp3',
    source: 'https://archive.org/details/aporee_63516_73093',
    license: 'PD',
  },
  {
    id: 'pico-caves',
    title: 'WAVES IN LAVA CAVES',
    place: 'Pico Island, Azores',
    kind: 'SEA',
    dur: '3:50',
    url: 'https://archive.org/download/aporee_61033_70158/CAVERNWAVESCACHORROILHAPICO.mp3',
    source: 'https://archive.org/details/aporee_61033_70158',
    license: 'PD',
  },
  {
    id: 'coxs-bazar',
    title: 'SURF ON A LONG BEACH',
    place: "Cox's Bazar, Bangladesh",
    kind: 'SEA',
    dur: '5:35',
    url: 'https://archive.org/download/aporee_55131_63018/coxbazarsea.mp3',
    source: 'https://archive.org/details/aporee_55131_63018',
    license: 'PD',
  },
  {
    id: 'somerset-storm',
    title: 'THUNDERSTORM OVERHEAD',
    place: 'Wedmore, Somerset',
    kind: 'STORM',
    dur: '3:43',
    url: 'https://archive.org/download/aporee_19025_22067/THUNDERLIGHTNINGJULY2013SPHEREX4000011MAX.mp3',
    source: 'https://archive.org/details/aporee_19025_22067',
    license: 'PD',
  },
  {
    id: 'thunder-rain',
    title: 'THUNDER THROUGH RAIN',
    place: 'a porch in the rain',
    kind: 'STORM',
    dur: '2:31',
    url: 'https://archive.org/download/thunder-and-rain-sounds-18-d.-d.-teoli-jr.-a.-c./Thunder%20and%20Rain%20sounds%2018%20D.D.Teoli%20Jr.%20A.C..mp3',
    source: 'https://archive.org/details/thunder-and-rain-sounds-18-d.-d.-teoli-jr.-a.-c.',
    license: 'PD',
  },
  {
    id: 'marsh-brook',
    title: 'A SMALL BROOK',
    place: 'Constitution Marsh, NY',
    kind: 'WATER',
    dur: '2:08',
    url: 'https://archive.org/download/smallbrookconstitutionmarsh/Small%20brook%2C%20Constitution%20Marsh.mp3',
    source: 'https://archive.org/details/smallbrookconstitutionmarsh',
    license: 'PD',
  },
  {
    id: 'spring-peepers',
    title: 'SPRING PEEPERS, DARK',
    place: 'a wetland at night',
    kind: 'NIGHT',
    dur: '8:29',
    url: 'https://archive.org/download/frogs-toads-spring-peepers-crickets-sound-effects/2014-spring-peepers-edit-19426.mp3',
    source: 'https://archive.org/details/frogs-toads-spring-peepers-crickets-sound-effects',
    license: 'CC0',
  },
  {
    id: 'sevilla-street',
    title: 'MARATHON AND CHURCH BELLS',
    place: 'Sevilla, Spain',
    kind: 'CITY',
    dur: '3:07',
    url: 'https://archive.org/download/aporee_33774_38854/SevillaMacarenaMarathonundGlocken.mp3',
    source: 'https://archive.org/details/aporee_33774_38854',
    license: 'PD',
  },
]);

const LICENSE_URLS = Object.freeze({
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  PD: 'https://creativecommons.org/publicdomain/mark/1.0/',
});

export function fieldLicenseUrl(tag) {
  return LICENSE_URLS[tag] || null;
}

export function initFieldLibrary(ctx) {
  const { $ } = ctx;
  const host = $('fieldLibrary');
  if (!host) return;

  const grid = document.createElement('div');
  grid.className = 'yj-field-grid';
  for (const rec of FIELD_RECORDINGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yj-field-btn';
    btn.dataset.fieldId = rec.id;
    btn.title = rec.title + ' · ' + rec.place + ' · ' + rec.dur;

    const kind = document.createElement('span');
    kind.className = 'yj-field-kind';
    kind.textContent = rec.kind;
    const title = document.createElement('span');
    title.className = 'yj-field-title';
    title.textContent = rec.title;
    const meta = document.createElement('span');
    meta.className = 'yj-field-meta';
    meta.textContent = rec.place + ' · ' + rec.dur;

    btn.append(kind, title, meta);
    btn.addEventListener('click', () => {
      if (!ctx.api.loadFromUrl) return;
      // The bench name carries the place, not the archive's raw filename.
      ctx.api.loadFromUrl(rec.url, rec.title + ' — ' + rec.place + '.mp3');
    });
    grid.appendChild(btn);
  }
  host.appendChild(grid);
}
