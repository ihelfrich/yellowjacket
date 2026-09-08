// "Thirteen Cards" as data the browser can read: which measured objects the
// piece is built from, and what each movement is. The movement modules
// themselves are imported on demand — four minutes of music is a lot of closed
// form to parse for a visitor who never opens the panel.
export const SYMPHONY_CARD_IDS = Object.freeze([
  'iowa-bells-brass-Cs5', 'iowa-bells-plastic-ff-Cs5', 'iowa-bells-plastic-ff-E5',
  'iowa-bells-plastic-ff-A5', 'carillon-bell', 'freesound-wineglass', 'hiawatha-vowel',
  'fdr-vowel', 'opz-thud', 'commons-bell-15cm', 'uvb76-buzz', 'wwv-tone', 'ory-chord',
]);

export const MOVEMENTS = Object.freeze([
  { n: 1, numeral: 'I', title: 'TWO METALS', seconds: 240,
    note: 'Tuned by the Iowa brass bell at 557.3 Hz · 96 bpm · the two metals disagree by 160 cents and the piece says so' },
  { n: 2, numeral: 'II', title: 'FIRESIDE', seconds: 180,
    note: 'Tuned by the LibriVox reader at 250.5 Hz · 48 bpm · the slow movement, vowels and a handbell' },
  { n: 3, numeral: 'III', title: 'BUZZER', seconds: 150,
    note: 'Tuned by the Iowa A5 bell at 442.5 Hz · 168 bpm · the scherzo climbs until it beats against WWV' },
  { n: 4, numeral: 'IV', title: 'SUNSHINE', seconds: 210,
    note: 'Tuned by the 1921 Kid Ory chord at 207.8 Hz · 120 bpm · a scale a real band actually played' },
]);
