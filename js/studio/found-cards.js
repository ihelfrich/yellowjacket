// Cards the lab has already made, offered in every STUDIO part's chooser.
// Files live under docs/lab/cards/ and are fetched on first use. Every entry
// is public domain, CC0, or (Iowa) released for any use; the CC BY bowl stays
// in the lab and off this list.

export const FOUND_CARDS = Object.freeze([
  { id: 'carillon-bell', name: 'CARILLON', excitation: 'strike', note: 'Eulenspiegel noon chime · PD' },
  { id: 'iowa-bells-plastic-ff-Cs5', name: 'ORCH BELLS', excitation: 'strike', note: 'Iowa orchestral bells C#5 · anechoic' },
  { id: 'freesound-wineglass', name: 'WINE GLASS', excitation: 'strike', note: 'Freesound 654156 · CC0' },
  { id: 'commons-bell-15cm', name: 'HANDBELL', excitation: 'strike', note: 'Wikimedia Commons · PD' },
  { id: 'opz-thud', name: 'THUD', excitation: 'strike', note: 'one mode at 182 Hz' },
  { id: 'fdr-vowel', name: 'FDR VOWEL', excitation: 'breath', note: 'fireside chat 1933 · PD' },
  { id: 'hiawatha-vowel', name: 'READER', excitation: 'breath', note: 'LibriVox · PD' },
  { id: 'uvb76-buzz', name: 'BUZZER', excitation: 'bow', note: 'UVB-76 · CC0' },
  { id: 'ory-chord', name: 'ORY BAND', excitation: 'bow', note: 'Kid Ory 1921 · PD' },
  { id: 'wwv-tone', name: 'WWV TONE', excitation: 'bow', note: 'NIST WWV 1991 · PD' },
]);

export function foundCardById(id) { return FOUND_CARDS.find((c) => c.id === id) || null; }
export function foundCardUrl(id, base) { return new URL('docs/lab/cards/' + id + '.json', base).href; }
