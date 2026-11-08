import { precisionSpectrum } from '../js/analysis/precision-spectrum.js';
self.onmessage = ({ data }) => {
  try {
    const result = precisionSpectrum(data.samples, data.sampleRate, data.options);
    self.postMessage({ result }, [result.db.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
