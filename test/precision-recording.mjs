import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { precisionSpectrum, spectrumCell } from '../js/analysis/precision-spectrum.js';
const path = 'test/fixtures/spectrogram/berlin-30s.wav';
const raw = execFileSync('ffmpeg', ['-v','error','-i',path,'-f','f32le','-ac','1','pipe:1'], { maxBuffer: 16e6 });
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const result = precisionSpectrum(x,48000,{fftSize:65536,lowHz:20,highHz:500});
const probes = [[10,100],[20,120]].map(([time,hz]) => {
  const p = spectrumCell(result,time,hz); let re=0,im=0,sum=0;
  // Independent direct DFT and window, no FFT or shared Hann implementation.
  for(let i=0;i<result.fftSize;i++) {
    const w=.5*(1-Math.cos(2*Math.PI*i/result.fftSize));
    const angle=2*Math.PI*(result.firstBin+p.b)*i/result.fftSize;
    sum+=w; re+=x[p.c*result.hop+i]*w*Math.cos(angle); im-=x[p.c*result.hop+i]*w*Math.sin(angle);
  }
  const db=20*Math.log10(2*Math.hypot(re,im)/sum), error=Math.abs(p.db-db);
  assert.ok(error<.0001);
  return {...p,directDftDb:db,absoluteErrorDb:error};
});
fs.writeFileSync('test/fixtures/spectrogram/recording-result.json',JSON.stringify({
  source:'https://archive.org/details/aporee_63516_73093',creator:'Peter Cusack',
  location:'Prenzlauerberg Volkspark, Berlin, Germany',latitude:52.537607761925,longitude:13.461569392697,
  sourceTime:'2024-03-22 08:17:00 Europe/Berlin',
  limits:['Source-published coordinates, not independently surveyed ground truth.','Source title says 8pm but structured date says 08:17; no precise-time flight matching attempted.','First 30 seconds, mono downmix of MP3.','No aircraft identification or location inference.'],
  sha256:createHash('sha256').update(fs.readFileSync(path)).digest('hex'),sampleRate:48000,fftSize:65536,cols:result.cols,probes
},null,2));
console.log(JSON.stringify(probes,null,2));
