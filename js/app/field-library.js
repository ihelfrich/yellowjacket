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
// Wikimedia Commons serves its own originals, with CORS and byte ranges, so a
// file there needs no derivative: the URL is the file. The licence on each was
// read from the Commons API's extmetadata, not from the file page's rendering.
function commons(url, mb, format, rate = null, bits = null) {
  const out = { url, mb, format };
  if (rate) out.rate = rate;
  if (bits) out.bits = bits;
  return out;
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
  { id: 'wwv-1991', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'TIME STATION', title: 'WWV, FORT COLLINS', place: 'NIST · December 8, 1991, 02:18 UTC', dur: '13:10',
    license: 'PD', source: IA_ITEM + 'radio-station-wwv-1991-12-08-0218-utc',
    light: light('radio-station-wwv-1991-12-08-0218-utc', 'Radio%20Station%20WWV%20-%201991-12-08%20%280218%20UTC%29.mp3', 10.2),
    hi: hi('radio-station-wwv-1991-12-08-0218-utc', 'Radio%20Station%20WWV%20-%201991-12-08%20%280218%20UTC%29.flac', 79.2, 48000, 24) },
  { id: 'jjy-2001', shelf: 'SIGNAL', region: 'JAPAN', kind: 'TIME STATION', title: 'JJY SIGNS OFF, 8 MHz', place: 'Japan · March 31, 2001, 03:00 UTC', dur: '1:28',
    license: 'CC0', source: IA_ITEM + 'JapanTimeSignalRadioStationJjy8MhzCloses',
    light: light('JapanTimeSignalRadioStationJjy8MhzCloses', 'jjymono.mp3', 0.7) },
  { id: 'kossuth-540', shelf: 'SIGNAL', region: 'HUNGARY', kind: 'MEDIUMWAVE', title: 'KOSSUTH RADIO, 540 kHz', place: 'Hungary · time signal and identification, 2015', dur: '0:32',
    license: 'CC0', source: IA_ITEM + 'MR1KossuthRadio540KHzHungary',
    light: light('MR1KossuthRadio540KHzHungary', 'MR1%20Kossuth%20Radio%20-%20540%20KHz%20-%20Hungary.mp3', 0.4) },
  { id: 'uvb76-2010', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'THE BUZZER', title: 'UVB-76 WITH A VOICE MESSAGE', place: 'Russia, 4625 kHz · December 5, 2010, 12:22 UTC', dur: '2:40',
    license: 'CC0', source: IA_ITEM + 'UVB76activity',
    light: light('UVB76activity', 'UVB-76-05-12-2010-1222UTC.mp3', 0.6),
    hi: hi('UVB76activity', 'UVB-76-05-12-2010-1222UTC.flac', 1.6, 8000, 16) },
  { id: 'hm01-2019', shelf: 'SIGNAL', region: 'CUBA', kind: 'NUMBERS', title: 'HM01 AND A FAX BURST', place: 'Cuba, 9240 kHz · July 24, 2019, 09:03 UTC', dur: '2:54',
    license: 'PD', source: IA_ITEM + 'cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz',
    light: light('cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz', 'Cuban%20numbers%20station%20and%20SW%20fax.%202019-07-24T09_03_00Z_9240.0kHz.mp3', 0.6),
    hi: hi('cuban-numbers-station-and-sw-fax.-2019-07-24-t-09-03-00-z-9240.0k-hz', 'Cuban%20numbers%20station%20and%20SW%20fax.%202019-07-24T09_03_00Z_9240.0kHz.flac', 2.3, 8000, 16) },
  { id: 'm08-2009', shelf: 'SIGNAL', region: 'CUBA', kind: 'NUMBERS · MORSE', title: 'M08, CUBAN NUMBERS IN MORSE', place: 'Cuba, 11435 kHz CW · December 23, 2009, 17:59 UTC', dur: '1:25',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Cuba%20DGI%20-%20M08%2011435%20CW%201759z-1800z%2012-23-09.mp3', 1.3) },
  { id: 'sk01-2009', shelf: 'SIGNAL', region: 'CUBA', kind: 'NUMBERS · DIGITAL', title: 'SK01, DATA BURSTS', place: 'Cuba, 11435 kHz AM · December 23, 2009, 17:44 UTC', dur: '0:45',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Cuba%20DGI%20-%20SK01%2011435%20AM%201744z%2012-23-09.mp3', 0.7) },
  { id: 'g11-2010', shelf: 'SIGNAL', region: 'AUSTRIA', kind: 'NUMBERS', title: 'G11, A WOMAN COUNTING IN GERMAN', place: 'Austria, 8091 kHz USB · March 29, 2010, 09:35 UTC', dur: '3:17',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Austria%20HNA%20-%20G11%208091%20USB%200935z-0938z%2003-29-10.mp3', 3.0) },
  { id: 'code-1942', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'MORSE', title: 'SIGNAL CORPS CODE APTITUDE TEST', place: 'US War Department training record · c. 1942', dur: '4:05',
    license: 'PD', source: IA_ITEM + 'U.S._Armed_Forces_Institute_Basic_Radio_Code_ca1942',
    light: light('U.S._Armed_Forces_Institute_Basic_Radio_Code_ca1942', '01A_Signal_Corps_Code_Aptitude_Test.mp3', 3.7) },

  // ---------- LONG captures: loaded a window at a time ----------

  // ---------- SIGNAL: what the shortwave bands actually carry ----------
  // Added 2026-09-10 for the SIGINT work. Every licence below was read off the
  // item page or the Commons API this week, not inferred from a collection.
  // Two rules were settled while checking them, and both cost entries:
  //   · The Shortwave Radio Audio Archive (every `sraa-` item) is CC BY-NC 3.0
  //     as a class. It holds the obvious BPM and Firedrake recordings and it is
  //     closed to this shelf. So is the Conet Project (CC BY-NC-SA).
  //   · A Public Domain Mark applied by an uploader who is not the rightsholder
  //     clears a recording of a SIGNAL — a buzzer, a tone sequence, Morse
  //     digits, a time tick — because the only right in it is the recordist's
  //     own, and they dedicated it. It does NOT clear a recording of broadcast
  //     PROGRAMMING. Three otherwise-good candidates were dropped on that line.

  // Russia
  { id: 's06-2009', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'NUMBERS · VOICE', title: 'S06, THE RUSSIAN MAN', place: 'Russia, 6835 kHz USB · December 14, 2009, 21:15 UTC', dur: '3:59',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Russia%20GRU%20-%20S06%206835%20USB%202115z-2119z%2012-14-09.mp3', 3.6) },
  { id: 'm12-2010', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'NUMBERS · MORSE', title: 'M12, MACHINE-KEYED NUMBERS', place: 'Russia, 6795 kHz CW · November 29, 2010, 06:00 UTC', dur: '2:13',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Russia%20SVR%20-%20M12%206795%20CW%200600z-0602z%2011-29-10.mp3', 2.0) },
  { id: 'xpa-2009', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'NUMBERS · POLYTONE', title: 'XPA, A POLYTONE SEND', place: 'Russia, 8147 kHz USB · December 18, 2009, 07:00 UTC', dur: '7:46',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Russia%20SVR%20-%20XPA%208147%20USB%200700z-0707z%2012-18-09.mp3', 7.1) },
  // The only lossless polytone here, and the only SIGNAL entry with content
  // above 8 kHz: 44.1 kHz, 24-bit, read from the FLAC STREAMINFO block.
  { id: 'xpa2-2023', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'NUMBERS · POLYTONE', title: 'XPA2, POLYTONE, LOSSLESS', place: 'Russia, 14978 kHz USB · January 13, 2023, 12:00 UTC', dur: '4:04',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'XPA2%2014978%20USB%201200z-1204z%2001-13-23.mp3', 3.4),
    hi: hi('ShortwaveEspionageBroadcasts', 'XPA2%2014978%20USB%201200z-1204z%2001-13-23.flac', 7.2, 44100, 24) },
  { id: 'x06-2009', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'SELCALL · TONES', title: 'X06, SIX TONES IN SHIFTING ORDER', place: 'Russia, 6870 kHz · January 10, 2009, 23:31 UTC', dur: '13:32',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Russia%20Diplomatic%20Service%20-%20X06%206870%20AM_USB%202331z-2344z%2001-10-09.mp3', 12.4) },
  // Eight unbroken hours of the channel marker, part two of a 28-hour capture.
  // Load a window from anywhere in it. This is the recording the traffic survey
  // exists for: most of it is nothing, and the question is where the rest is.
  { id: 'uvb76-28h', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'THE BUZZER', title: 'UVB-76, EIGHT HOURS UNATTENDED', place: 'Russia, 4625 kHz · August 7, 2026', dur: '486:26',
    license: 'PD', source: IA_ITEM + '01-uvb-76-russian-military-shortwave-station-shortwave-sdr-4625-k-hz-28-hour-rec',
    light: light('01-uvb-76-russian-military-shortwave-station-shortwave-sdr-4625-k-hz-28-hour-rec', '02-UVB-76%20%28Russian%20Military%20Shortwave%20Station%20Shortwave%20SDR%204625%20kHz%29%2028%20Hour%20%20Recording%20Pt-02%208-07-2026.mp3', 115),
    long: { seconds: 29186, bytes: 120553057 } },
  { id: 'buzzer-4630-2025', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'THE BUZZER', title: 'THE BUZZER IN PARALLEL, 4630 kHz', place: 'Russia · February 24, 2025, 20:19 UTC', dur: '39:18',
    license: 'CC0', source: 'https://commons.wikimedia.org/wiki/File:The_Buzzer_transmitting_in_parallel_(%D0%A6%D0%96%D0%90%D0%9F,_TsZhAP)_2025-02-24T20_19_03Z_4630.0kHz.wav',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/3/3c/The_Buzzer_transmitting_in_parallel_%28%D0%A6%D0%96%D0%90%D0%9F%2C_TsZhAP%29_2025-02-24T20_19_03Z_4630.0kHz.wav', 64, 'WAV') },
  { id: 'rwm-2013', shelf: 'SIGNAL', region: 'RUSSIA', kind: 'TIME STATION', title: 'RWM, MOSCOW TIME SIGNAL', place: 'Russia, 9996 kHz CW · March 31, 2013, 19:48 UTC', dur: '0:31',
    license: 'CC0', source: 'https://commons.wikimedia.org/wiki/File:2013-03-31_1948z_RWM_Time_Signal.ogg',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/a/a5/2013-03-31_1948z_RWM_Time_Signal.ogg', 0.2, 'OGG', 12000) },

  // China and Taiwan. Thin, and the reason belongs on the record: the best-known
  // Chinese signals — the BPM time station, Firedrake jamming — exist on this
  // archive only under CC BY-NC, and a recording of CNR1 or of a co-channel
  // broadcast carries the station's own programme, which no uploader's mark can
  // release. What is left is what carries no authored work.
  // An over-the-horizon radar recording was carried here for a few hours and then
  // withdrawn: its Public Domain Mark was applied by an uploader whose own
  // description ends "Audio source unknown." Someone who does not know where a
  // recording came from cannot dedicate it, and a mark is not a dedication. It
  // is the closest thing to a Chinese OTH signal this shelf could find, and it
  // is not good enough.
  { id: 'v13-2023', shelf: 'SIGNAL', region: 'TAIWAN', kind: 'NUMBERS · VOICE', title: 'V13, NEW STAR BROADCASTING', place: 'Taiwan, 9276 kHz · February 14, 2023, 12:00 UTC', dur: '19:10',
    license: 'CC0', source: IA_ITEM + 'ShortwaveEspionageBroadcasts',
    light: light('ShortwaveEspionageBroadcasts', 'Taiwan%20NSB%20-%20V13%209276%20AM_USB%201200z-1219z%2002-14-23.mp3', 43.9) },

  // United States
  { id: 'hfgcs-8992-2023', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'MILITARY VOICE', title: 'HFGCS, NATO PHONETICS ON 8992 kHz', place: 'USAF · October 15, 2023, 10:44 UTC', dur: '2:19',
    license: 'PD', source: IA_ITEM + 'usaf-high-frequency-global-comm.-system.-reading-nato-phonetics.-early-sun.-2023',
    light: light('usaf-high-frequency-global-comm.-system.-reading-nato-phonetics.-early-sun.-2023', 'USAF--%20High%20Frequency%20Global%20Comm.%20System.%20Reading%20NATO%20phonetics.%20Early%20Sun.%202023-10-15T10_44_04Z_8992.0kHz.mp3', 0.5),
    hi: hi('usaf-high-frequency-global-comm.-system.-reading-nato-phonetics.-early-sun.-2023', 'USAF--%20High%20Frequency%20Global%20Comm.%20System.%20Reading%20NATO%20phonetics.%20Early%20Sun.%202023-10-15T10_44_04Z_8992.0kHz.flac', 2.7, 8000, 16) },
  { id: 'hfgcs-4724-2024', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'MILITARY VOICE', title: 'HFGCS, VOICE OVER A KLAXON', place: 'USAF, 4724 kHz USB · February 28, 2024, 06:11 UTC', dur: '5:32',
    license: 'PD', source: IA_ITEM + 'usaf.-poly-frequency-with-voice.-t.-2024-02-28-t-06-11-59-z-4724.0k-hz',
    light: light('usaf.-poly-frequency-with-voice.-t.-2024-02-28-t-06-11-59-z-4724.0k-hz', 'USAF.%20Poly-frequency%20with%20voice.%20T.%202024-02-28T06_11_59Z_4724.0kHz.mp3', 2.1),
    hi: hi('usaf.-poly-frequency-with-voice.-t.-2024-02-28-t-06-11-59-z-4724.0k-hz', 'USAF.%20Poly-frequency%20with%20voice.%20T.%202024-02-28T06_11_59Z_4724.0kHz.flac', 10.6, 8000, 16) },
  { id: 'hfgcs-4724-2026', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'MILITARY VOICE', title: 'HFGCS, LETTERS AND NUMBERS', place: 'USAF, 4724 kHz USB · March 23, 2026, 05:09 UTC', dur: '8:32',
    license: 'PD', source: IA_ITEM + 'usaf.-usb-reading-letters-and-numbers.-sun.-2026-03-23-t-05-09-44-z-4724.0k-hz',
    light: light('usaf.-usb-reading-letters-and-numbers.-sun.-2026-03-23-t-05-09-44-z-4724.0k-hz', 'USAF.%20USB%20reading%20letters%20and%20numbers.%20Sun.%202026-03-23T05_09_44Z_4724.0kHz.mp3', 1.7),
    hi: hi('usaf.-usb-reading-letters-and-numbers.-sun.-2026-03-23-t-05-09-44-z-4724.0k-hz', 'USAF.%20USB%20reading%20letters%20and%20numbers.%20Sun.%202026-03-23T05_09_44Z_4724.0kHz.flac', 8.4, 8000, 16) },
  // Both stations on one channel: Colorado and Kauai, a man and a woman, their
  // ticks a few milliseconds apart because the two paths are different lengths.
  // The hard case for a time-code decoder, and the only one on this shelf.
  { id: 'wwv-wwvh-2019', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'TIME STATION', title: 'WWV AND WWVH ON ONE CHANNEL', place: 'NIST, 5 MHz · February 6, 2019, 14:50 UTC', dur: '13:07',
    license: 'PD', source: 'https://commons.wikimedia.org/wiki/File:WWV_WWVH_2019-02-06T14_50_36Z_5000.00_am-mono.ogg',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/2/29/WWV_WWVH_2019-02-06T14_50_36Z_5000.00_am-mono.ogg', 3.9, 'OGG') },
  { id: 'wwvh-2015', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'TIME STATION', title: 'WWVH, KAUAI', place: 'NIST, 10 MHz · March 16, 2015, 04:58 UTC', dur: '4:28',
    license: 'PD', source: 'https://commons.wikimedia.org/wiki/File:WWVH_recording_-_20150316.ogg',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/5/55/WWVH_recording_-_20150316.ogg', 1.3, 'OGG') },
  { id: 'noaa-boulder-2008', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'WEATHER · VOICE', title: 'NOAA WEATHER RADIO', place: 'Boulder, Colorado · October 6, 2008', dur: '1:30',
    license: 'PD', source: 'https://commons.wikimedia.org/wiki/File:NOAA_Weather_Radio,_Boulder_2008.flac',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/e/e3/NOAA_Weather_Radio%2C_Boulder_2008.flac', 4.3, 'FLAC') },
  // The required weekly test carries a SAME header: three bursts of AFSK before
  // the alert tone, then the same three again to close it.
  { id: 'noaa-same-test', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'DATA · SAME', title: 'A SAME ALERT TEST', place: 'KEC60 Milwaukee · NOAA required weekly test', dur: '1:45',
    license: 'PD', source: 'https://commons.wikimedia.org/wiki/File:NOAA_Weather_Radio_MKE-KEC60_Weekly_Test.ogg',
    light: commons('https://upload.wikimedia.org/wikipedia/commons/0/08/NOAA_Weather_Radio_MKE-KEC60_Weekly_Test.ogg', 0.8, 'OGG') },
  { id: 'ndb-332-2025', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'BEACON · MORSE', title: 'A 25-WATT BEACON REPEATING ITS LETTERS', place: '332 kHz · November 27, 2025, 10:29 UTC', dur: '6:53',
    license: 'PD', source: IA_ITEM + 'longwave-beacon-east-coast.-thanksgiving-morn.-2025-11-27-t-10-29-07-z-332.0k-hz',
    light: light('longwave-beacon-east-coast.-thanksgiving-morn.-2025-11-27-t-10-29-07-z-332.0k-hz', 'Longwave%20beacon%2C%20East%20Coast.%20Thanksgiving%20morn.%202025-11-27T10_29_07Z_332.0kHz.mp3', 1.4),
    hi: hi('longwave-beacon-east-coast.-thanksgiving-morn.-2025-11-27-t-10-29-07-z-332.0k-hz', 'Longwave%20beacon%2C%20East%20Coast.%20Thanksgiving%20morn.%202025-11-27T10_29_07Z_332.0kHz.flac', 6.6, 8000, 16) },
  { id: 'offshore-13089-2024', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'WEATHER · VOICE', title: 'A SYNTHESISED VOICE READING THE SEA STATE', place: 'NHC Miami, tropical North Atlantic · 13089 kHz USB · March 1, 2024, 15:58 UTC', dur: '7:44',
    license: 'PD', source: IA_ITEM + 'robot-east-coast-sea-weather.-f.-2024-03-01-t-15-58-00-z-13089.0k-hz',
    light: light('robot-east-coast-sea-weather.-f.-2024-03-01-t-15-58-00-z-13089.0k-hz', 'Robot%20East%20Coast%20sea%20weather.%20F.%202024-03-01T15_58_00Z_13089.0kHz.mp3', 1.8),
    hi: hi('robot-east-coast-sea-weather.-f.-2024-03-01-t-15-58-00-z-13089.0k-hz', 'Robot%20East%20Coast%20sea%20weather.%20F.%202024-03-01T15_58_00Z_13089.0kHz.flac', 8.9, 8000, 16) },

  // `long` carries the file's total seconds and bytes so the card can offer a
  // window (2 / 5 / 10 minutes from any point). MP3 only: an MPEG stream
  // resyncs at any frame, so a byte range decodes wherever it is cut.
  { id: 'marine-electric-sos', shelf: 'SIGNAL', region: 'UNITED STATES', kind: 'DISTRESS · MORSE', title: 'SS MARINE ELECTRIC, SOS ON 500 kHz', place: 'USCG COMMSTA Boston · February 12, 1983', dur: '91:38',
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

// Only public-domain tags live here, and that is load-bearing rather than
// tidy: the shelf's own note says "all public domain", the README says it
// twice, and a commercial licensee of this tool cannot use a Non-Commercial
// recording. A tag outside this map has no deed URL and fails the manifest
// test, which is the point.
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
    // The shelf is folded behind one button on the intake now; a reveal from
    // anywhere unfolds it and brings it into view.
    host.hidden = false;
    host.scrollIntoView({ block: 'start' });
    const first = host.querySelector('.yj-field-btn');
    if (first) first.focus();
  }
  for (const id of ['btnField', 'btnShelf']) {
    const opener = $(id);
    if (opener) opener.addEventListener('click', reveal);
  }
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
    // The SIGNAL drawer is 28 entries. Grouped by where the transmitter is,
    // largest group first, so a person looking for Russian traffic is not
    // scanning a flat wall of cards for it.
    let records = FIELD_RECORDINGS.filter((r) => r.shelf === shelf);
    if (shelf === 'SIGNAL') {
      const order = [...new Set(records.map((r) => r.region || 'ELSEWHERE'))]
        .sort((a, b) => records.filter((r) => (r.region || 'ELSEWHERE') === b).length - records.filter((r) => (r.region || 'ELSEWHERE') === a).length || a.localeCompare(b));
      records = [...records].sort((a, b) => order.indexOf(a.region || 'ELSEWHERE') - order.indexOf(b.region || 'ELSEWHERE'));
    }
    let lastRegion = null;
    for (const rec of records) {
      const v = variantFor(rec, lossless);
      if (!v) continue;
      if (shelf === 'SIGNAL' && (rec.region || 'ELSEWHERE') !== lastRegion) {
        lastRegion = rec.region || 'ELSEWHERE';
        const head = document.createElement('div');
        head.className = 'yj-field-region yj-label';
        head.textContent = lastRegion.toLowerCase();
        grid.appendChild(head);
      }
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
