// What is supposed to be on the air, so that the scanner can tell you when
// something is not.
//
// Three kinds of entry and the difference matters:
//
//   confidence 'fixed'    a transmitter that is always there on that frequency.
//                         WWV has been on 10 MHz since 1943. A miss is news.
//   confidence 'reported' a schedule the monitoring community maintains by
//                         listening. Numbers stations move, and these lists go
//                         stale between one month and the next. A miss is
//                         ordinary; a hit is worth keeping.
//   confidence 'historic' it used to be here and is believed gone. A hit on one
//                         of these is the single most interesting thing this
//                         tool can find, which is exactly why they are listed.
//
// Frequencies are in Hz. Nothing here is secret: every entry is in published
// monitoring references, and the transmitters are on shortwave precisely
// because they want to reach a receiver that is not theirs.
//
// `near` is the approximate transmitter site, and it earns its place: a first
// watch of the five marker channels heard none of them, because the picker had
// chosen the quietest receivers on the whole network and they were all in
// North America while four of the five transmitters are in Russia. Good ears
// in the wrong hemisphere hear nothing. Where the site is publicly documented
// it is given here so the picker can choose receivers that are plausibly in
// range; where a station uses many sites, or the site is not public, it is
// left off and the picker falls back to ranking by quality alone.

export const CATALOG = Object.freeze([
  // ---- time standards: verifiable against a wall clock, which makes them the
  // calibration signals for everything else the bench claims ----
  { hz: 2_500_000, name: 'WWV / WWVH', kind: 'time', mode: 'am', confidence: 'fixed', note: 'Colorado and Hawaii on one channel; the pair the arrival-difference test uses', near: [40.68, -105.04] },
  { hz: 5_000_000, name: 'WWV / WWVH', kind: 'time', mode: 'am', confidence: 'fixed', near: [40.68, -105.04] },
  { hz: 10_000_000, name: 'WWV / WWVH', kind: 'time', mode: 'am', confidence: 'fixed', note: 'decoded live 2026-09-13 and matched the wall clock', near: [40.68, -105.04] },
  { hz: 15_000_000, name: 'WWV / WWVH', kind: 'time', mode: 'am', confidence: 'fixed', near: [40.68, -105.04] },
  { hz: 20_000_000, name: 'WWV', kind: 'time', mode: 'am', confidence: 'fixed', near: [40.68, -105.04] },
  { hz: 25_000_000, name: 'WWV', kind: 'time', mode: 'am', confidence: 'fixed', note: 'experimental; off the air for decades, back since 2014', near: [40.68, -105.04] },
  { hz: 3_330_000, name: 'CHU Canada', kind: 'time', mode: 'usb', confidence: 'fixed', near: [45.29, -75.76] },
  { hz: 7_850_000, name: 'CHU Canada', kind: 'time', mode: 'usb', confidence: 'fixed', near: [45.29, -75.76] },
  { hz: 14_670_000, name: 'CHU Canada', kind: 'time', mode: 'usb', confidence: 'fixed', near: [45.29, -75.76] },
  { hz: 4_996_000, name: 'RWM Moscow', kind: 'time', mode: 'cw', confidence: 'fixed', note: 'Russian standard; unmodulated carrier, then CW marks', near: [55.73, 38.20] },
  { hz: 9_996_000, name: 'RWM Moscow', kind: 'time', mode: 'cw', confidence: 'fixed', near: [55.73, 38.20] },
  { hz: 14_996_000, name: 'RWM Moscow', kind: 'time', mode: 'cw', confidence: 'fixed', near: [55.73, 38.20] },
  { hz: 5_000_000, name: 'BPM China', kind: 'time', mode: 'am', confidence: 'fixed', note: 'shares 5 MHz with WWV; two time standards interleaved', near: [34.95, 109.55] },
  { hz: 68_500, name: 'BPC China', kind: 'time', mode: 'am', confidence: 'fixed', note: 'longwave; only receivers that reach below 100 kHz', near: [34.46, 115.84] },

  // ---- markers: channels held open for the sake of being held ----
  { hz: 4_625_000, name: 'UVB-76 "The Buzzer"', kind: 'marker', mode: 'usb', confidence: 'fixed', note: 'buzzing since the 1970s; the interruptions are the message, which is what MARKER WATCH exists for', near: [56.08, 37.10] },
  { hz: 5_448_000, name: '"The Pip"', kind: 'marker', mode: 'usb', confidence: 'reported', note: 'daytime frequency; 3756 kHz at night', near: [55.75, 37.62] },
  { hz: 3_756_000, name: '"The Pip" (night)', kind: 'marker', mode: 'usb', confidence: 'reported', near: [55.75, 37.62] },
  { hz: 5_473_000, name: '"The Squeaky Wheel"', kind: 'marker', mode: 'usb', confidence: 'reported', note: 'daytime; 3828 kHz at night', near: [55.75, 37.62] },
  { hz: 3_828_000, name: '"The Squeaky Wheel" (night)', kind: 'marker', mode: 'usb', confidence: 'reported', near: [55.75, 37.62] },

  // ---- numbers: the genuinely strange end, and the one where a decode is
  // usually provably impossible. XPA2 was read perfectly and is unreadable:
  // a one-time pad is not a cipher you break, it is a cipher you confirm ----
  { hz: 11_635_000, name: 'HM01 (Cuban)', kind: 'numbers', mode: 'am', confidence: 'reported', note: 'voice numbers alternating with RDFT digital bursts', near: [23.02, -82.38] },
  { hz: 10_345_000, name: 'HM01 (Cuban)', kind: 'numbers', mode: 'am', confidence: 'reported', near: [23.02, -82.38] },
  { hz: 9_330_000, name: 'HM01 (Cuban)', kind: 'numbers', mode: 'am', confidence: 'reported', near: [23.02, -82.38] },
  { hz: 5_855_000, name: 'HM01 (Cuban)', kind: 'numbers', mode: 'am', confidence: 'reported', near: [23.02, -82.38] },
  { hz: 6_855_000, name: 'V02a (Cuban)', kind: 'numbers', mode: 'am', confidence: 'reported', note: 'Spanish female voice, five-figure groups', near: [23.02, -82.38] },
  { hz: 9_236_000, name: 'XPA2 (Russian SVR)', kind: 'numbers', mode: 'usb', confidence: 'reported', note: '11-tone MFSK at 7.8125 baud; decodes cleanly and is a one-time pad, so the plaintext is not recoverable and the bench says so', near: [55.75, 37.62] },
  { hz: 11_116_000, name: 'XPA2 (Russian SVR)', kind: 'numbers', mode: 'usb', confidence: 'reported', near: [55.75, 37.62] },
  { hz: 13_416_000, name: 'XPA2 (Russian SVR)', kind: 'numbers', mode: 'usb', confidence: 'reported', near: [55.75, 37.62] },
  { hz: 5_745_000, name: 'E11 "Oblique"', kind: 'numbers', mode: 'usb', confidence: 'reported' },
  { hz: 6_930_000, name: 'S06 "Russian Man"', kind: 'numbers', mode: 'usb', confidence: 'reported', near: [55.75, 37.62] },
  { hz: 8_190_000, name: 'M12 (Russian CW)', kind: 'numbers', mode: 'cw', confidence: 'reported', note: 'hand-sent-sounding machine CW; the Morse decoder has a real target here', near: [55.75, 37.62] },

  // ---- historic: believed gone. A hit here is the headline ----
  { hz: 11_545_000, name: 'E03 "Lincolnshire Poacher"', kind: 'numbers', mode: 'usb', confidence: 'historic', note: 'British, off the air since 2008. If this channel is ever busy again, stop and look properly', near: [34.58, 32.99] },
  { hz: 13_375_000, name: 'E03a "Cherry Ripe"', kind: 'numbers', mode: 'usb', confidence: 'historic', note: 'the Australian relay, silent since 2009', near: [-31.95, 115.86] },

  // ---- military and government: the clear-text end of secure traffic ----
  { hz: 4_724_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed', note: 'the channel that produced a false ALE decode on 2026-09-13 and three new gates' },
  { hz: 6_739_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed' },
  { hz: 8_992_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed', note: 'the busiest of the six; EAM broadcasts read as phonetic letter groups' },
  { hz: 11_175_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed', note: 'primary daytime' },
  { hz: 13_200_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed' },
  { hz: 15_016_000, name: 'HFGCS (USAF)', kind: 'military', mode: 'usb', confidence: 'fixed' },
  { hz: 8_112_000, name: 'Russian Air Force', kind: 'military', mode: 'usb', confidence: 'reported', note: 'voice net, Russian, callsign-and-number format', near: [55.75, 37.62] },
  { hz: 5_732_000, name: 'ALE 2G net', kind: 'military', mode: 'usb', confidence: 'reported', note: 'MIL-STD-188-141 sounding; the ALE decoder reads these at -9 dB' },
  { hz: 10_242_000, name: 'ALE 2G net', kind: 'military', mode: 'usb', confidence: 'reported' },
  { hz: 14_350_000, name: 'ALE 2G net', kind: 'military', mode: 'usb', confidence: 'reported' },

  // ---- utility and weather: unglamorous, decodable, and verifiable ----
  { hz: 10_100_800, name: 'DWD Pinneberg RTTY', kind: 'utility', mode: 'usb', confidence: 'fixed', note: 'German weather service; measured at 449 Hz shift and 26.5 dB SNR, baud not yet pinned', near: [53.66, 9.80] },
  { hz: 11_039_000, name: 'DWD Pinneberg RTTY', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [53.66, 9.80] },
  { hz: 14_467_300, name: 'DWD Pinneberg RTTY', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [53.66, 9.80] },
  { hz: 3_855_000, name: 'DWD weather fax', kind: 'utility', mode: 'usb', confidence: 'fixed', note: 'the SSTV renderer is the nearest thing the bench has to a fax decoder', near: [53.66, 9.80] },
  { hz: 7_880_000, name: 'DWD weather fax', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [53.66, 9.80] },
  { hz: 13_882_500, name: 'DWD weather fax', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [53.66, 9.80] },
  { hz: 8_040_000, name: 'Northwood fax (UK Navy)', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [51.61, -0.42] },
  { hz: 8_459_000, name: 'Kodiak fax (US Coast Guard)', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [57.79, -152.41] },
  { hz: 518_000, name: 'NAVTEX international', kind: 'utility', mode: 'usb', confidence: 'fixed', note: '100 baud FSK, 170 Hz shift; navigational warnings in plain English' },
  { hz: 490_000, name: 'NAVTEX national', kind: 'utility', mode: 'usb', confidence: 'fixed' },
  { hz: 8_957_000, name: 'Shannon VOLMET', kind: 'utility', mode: 'usb', confidence: 'fixed', note: 'aviation weather read aloud on a loop', near: [52.70, -8.92] },
  { hz: 13_270_000, name: 'Shannon VOLMET', kind: 'utility', mode: 'usb', confidence: 'fixed', near: [52.70, -8.92] },

  // ---- amateur and broadcast: the friendly end, and where the music is ----
  { hz: 7_074_000, name: 'FT8 (40m)', kind: 'amateur', mode: 'usb', confidence: 'fixed', note: 'dense 8-FSK; always busy, which makes it a good liveness check for a receiver' },
  { hz: 14_074_000, name: 'FT8 (20m)', kind: 'amateur', mode: 'usb', confidence: 'fixed' },
  { hz: 10_136_000, name: 'FT8 (30m)', kind: 'amateur', mode: 'usb', confidence: 'fixed' },
  { hz: 14_230_000, name: 'SSTV calling (20m)', kind: 'amateur', mode: 'usb', confidence: 'fixed', note: 'Martin and Scottie pictures; the SSTV decoder reads both' },
  { hz: 7_171_000, name: 'SSTV calling (40m)', kind: 'amateur', mode: 'usb', confidence: 'reported' },
  { hz: 14_070_000, name: 'PSK31 (20m)', kind: 'amateur', mode: 'usb', confidence: 'fixed' },
  { hz: 7_030_000, name: 'CW calling (40m)', kind: 'amateur', mode: 'cw', confidence: 'fixed', note: 'real fists, not machine Morse; the merge-floor work was built for this' },
  { hz: 14_030_000, name: 'CW calling (20m)', kind: 'amateur', mode: 'cw', confidence: 'fixed' },
  { hz: 6_070_000, name: '49m broadcast', kind: 'broadcast', mode: 'am', confidence: 'fixed', note: 'music and speech; the harmony analyser has something to do here' },
  { hz: 9_650_000, name: '31m broadcast', kind: 'broadcast', mode: 'am', confidence: 'fixed' },
  { hz: 15_400_000, name: '19m broadcast', kind: 'broadcast', mode: 'am', confidence: 'fixed' },

  // ---- oddities: the ones without a tidy explanation ----
  { hz: 7_039_000, name: 'Russian cluster beacons', kind: 'oddity', mode: 'cw', confidence: 'reported', note: 'single letters in Morse, forever, from Severomorsk, Odessa, Kaliningrad and others sharing one channel. Nobody outside has published what they are for', near: [69.07, 33.42] },
  { hz: 8_495_000, name: 'Russian cluster beacons', kind: 'oddity', mode: 'cw', confidence: 'reported', near: [69.07, 33.42] },
  { hz: 10_872_000, name: 'Russian cluster beacons', kind: 'oddity', mode: 'cw', confidence: 'reported', near: [69.07, 33.42] },
  { hz: 13_528_000, name: 'Russian cluster beacons', kind: 'oddity', mode: 'cw', confidence: 'reported', near: [69.07, 33.42] },
  { hz: 16_332_000, name: 'Russian cluster beacons', kind: 'oddity', mode: 'cw', confidence: 'reported', near: [69.07, 33.42] },
  { hz: 8_312_000, name: 'XSL "Slot Machine"', kind: 'oddity', mode: 'usb', confidence: 'reported', note: 'Japanese Navy; a burst that sounds like coins falling. Purpose unpublished', near: [35.44, 139.64] },
  { hz: 12_592_000, name: 'XSL "Slot Machine"', kind: 'oddity', mode: 'usb', confidence: 'reported', near: [35.44, 139.64] },
  { hz: 16_165_000, name: 'XSL "Slot Machine"', kind: 'oddity', mode: 'usb', confidence: 'reported', near: [35.44, 139.64] },
  { hz: 9_000_000, name: 'Firedrake jammer', kind: 'oddity', mode: 'am', confidence: 'reported', note: 'Chinese jamming that plays folk music over the station it is covering; it moves, so this frequency is only where it is often found' },
  { hz: 4_900_000, name: 'CODAR ocean radar', kind: 'oddity', mode: 'am', confidence: 'reported', note: 'a chirp that sweeps a few hundred kHz, several times a second. Reads as broadband to any decoder' },
  { hz: 14_000_000, name: 'CODAR / chirp sounders', kind: 'oddity', mode: 'am', confidence: 'reported', note: 'ionosondes sweep the whole of HF on a schedule; they cross every channel in this catalogue' },
]);

/** Every distinct kind present, for building a watchlist by category. */
export const KINDS = Object.freeze([...new Set(CATALOG.map(e => e.kind))]);

/** The catalogue filtered to one or more kinds. */
export function byKind(kinds) {
  const want = new Set([].concat(kinds));
  return CATALOG.filter(e => want.has(e.kind));
}

/**
 * The catalogue entry nearest a frequency, if anything is near enough.
 *
 * `toleranceHz` has to be wide enough to cover a receiver's clock error and
 * the width of the signal itself, and narrow enough that a busy broadcast band
 * does not swallow everything. 2 kHz is about one AM channel.
 */
export function nearest(hz, { toleranceHz = 2000 } = {}) {
  let best = null, bestD = Infinity;
  for (const e of CATALOG) {
    const d = Math.abs(e.hz - hz);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best || bestD > toleranceHz) return null;
  return { ...best, offHz: Math.round(hz - best.hz) };
}

/**
 * Is there energy here that the catalogue does not explain?
 *
 * This is the half of the scanner that a watchlist cannot do. A watchlist only
 * ever finds what someone already wrote down; the interesting signals are the
 * ones nobody did. Amateur and broadcast allocations are treated as explained
 * en masse, because "there is a signal in the 40-metre band" is not a finding.
 */
const ALLOCATIONS = Object.freeze([
  [1_800_000, 2_000_000, 'amateur 160m'], [3_500_000, 4_000_000, 'amateur 80m'],
  [5_351_500, 5_366_500, 'amateur 60m'], [7_000_000, 7_300_000, 'amateur 40m'],
  [10_100_000, 10_150_000, 'amateur 30m'], [14_000_000, 14_350_000, 'amateur 20m'],
  [18_068_000, 18_168_000, 'amateur 17m'], [21_000_000, 21_450_000, 'amateur 15m'],
  [24_890_000, 24_990_000, 'amateur 12m'], [28_000_000, 29_700_000, 'amateur 10m'],
  [531_000, 1_710_000, 'medium wave broadcast'],
  [2_300_000, 2_495_000, '120m broadcast'], [3_200_000, 3_400_000, '90m broadcast'],
  [4_750_000, 5_060_000, '60m broadcast'], [5_900_000, 6_200_000, '49m broadcast'],
  [7_200_000, 7_450_000, '41m broadcast'], [9_400_000, 9_900_000, '31m broadcast'],
  [11_600_000, 12_100_000, '25m broadcast'], [13_570_000, 13_870_000, '22m broadcast'],
  [15_100_000, 15_830_000, '19m broadcast'], [17_480_000, 17_900_000, '16m broadcast'],
  [21_450_000, 21_850_000, '13m broadcast'], [25_670_000, 26_100_000, '11m broadcast'],
]);

export function allocationAt(hz) {
  for (const [lo, hi, name] of ALLOCATIONS) if (hz >= lo && hz <= hi) return name;
  return null;
}

/**
 * Classify a measured emission against everything known.
 * `unknown` means: not in the catalogue and not inside a general allocation —
 * energy on a piece of spectrum where nothing is supposed to live.
 */
export function explain(hz, { toleranceHz = 2000 } = {}) {
  const cat = nearest(hz, { toleranceHz });
  if (cat) return { status: cat.confidence === 'historic' ? 'historic-hit' : 'catalogued', entry: cat };
  const alloc = allocationAt(hz);
  if (alloc) return { status: 'allocated', allocation: alloc };
  return { status: 'unknown' };
}
