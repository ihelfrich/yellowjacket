#!/usr/bin/env node
// Scan the shortwave spectrum through public receivers, on more than one ear
// at a time, and write down only what survives corroboration.
//
//   node tools/scan.mjs --kinds time,marker --ears 2
//   node tools/scan.mjs --hz 4625000 --ears 3 --seconds 40
//   node tools/scan.mjs --discover --ears 2      energy nothing explains
//
// Two stages, and they answer different questions.
//
// WIDE: one grab of a receiver's whole 0-30 MHz spectrum, 29.3 kHz per bin.
// Cheap, covers everything, and far too coarse to conclude with — it flagged
// 13.380 MHz as a possible hit on a station silent since 2009, which turned
// out to be a neighbour inside the same bin.
//
// NARROW: an audio grab on one channel through the same receivers, at full
// resolution, measured and decoded by the bench's own code. This is what
// settles anything, and it is the only thing that can be decoded.
//
// So the survey proposes and the audio disposes. The survey is never allowed
// to conclude alone.
//
// Every decode carries the corroboration verdict with it. That is the whole
// point of the exercise. A decode from a channel that only one receiver could
// hear is labelled as such, and this morning that label alone would have been
// enough to throw out a confident and entirely false ALE read.
//
// On being a good guest: these receivers are volunteers' hardware with a
// handful of slots each. This identifies itself, holds one slot at a time per
// host, releases it, and waits between visits.

import fs from 'node:fs';
import path from 'node:path';
import { receivers, spread, cluster } from './kiwi-net.mjs';
import { surveyBand } from './kiwi-wf.mjs';
import { recordAudio } from './kiwi-record.mjs';
import { corroborate } from '../js/sigint/corroborate.js';
import { byKind, explain, KINDS } from '../js/sigint/catalog.js';
import { runTask } from '../workers/sigint-worker.js';

const LOOK_SECONDS = 12;     // long enough for measure() to have frames to work with
const HEARD_DB = 8;          // dB over the channel's own floor before it counts as busy
const POLITE_MS = 1500;      // between finishing with a host and touching another

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * How busy this receiver's whole spectrum is, measured once and reused.
 *
 * It is the prior for every later question: if 40% of this receiver's HF is
 * occupied, then "it heard something on the target channel too" is a cheap
 * coincidence and corroboration has to say so. One zoom-0 grab per receiver
 * per scan, which is the only waterfall window a receiver serves honestly.
 */
export async function receiverContext(rx) {
  const s = await surveyBand(rx.host, { frames: 12 });
  if (!s.ok) return { rx, ok: false, error: s.error };
  return { rx, ok: true, floorDb: s.floorDb, occupancy: s.occupancy, emissions: s.emissions.length };
}

/**
 * Measure a receiver's band occupancy the first time it is actually used, and
 * remember it for the rest of the pass.
 *
 * Measuring up-front looked tidier and was much slower: a five-channel watch
 * with two ears and two spares each nominates up to twenty receivers, and a
 * whole-band grab from every one of them costs several minutes before a single
 * channel has been listened to — most of them spares that are never touched.
 */
export function contextCache() {
  const map = new Map();
  return {
    map,
    async get(rx) {
      if (map.has(rx.host)) return map.get(rx.host);
      const ctx = await receiverContext(rx);
      const v = ctx.ok ? ctx : null;
      map.set(rx.host, v);
      return v;
    },
    get size() { return [...map.values()].filter(Boolean).length; },
  };
}

/**
 * Listen to one frequency through one receiver and decide whether anything is
 * there — using the audio path and the bench's own measure(), not the
 * waterfall. Audio gives the real resolution, the real signal-to-noise, and
 * the same samples a decoder would get, so a "heard" here means the same thing
 * the decoders mean by it.
 *
 * The frequency compared across receivers is the AUDIO centre, not an RF
 * figure. Every receiver is tuned to the same nominal channel in the same
 * mode, so a real transmitter lands at the same audio frequency on all of
 * them; converting to RF first would only add each receiver's own clock error.
 */
async function look(rx, hz, mode, ctx) {
  const rec = await recordAudio(rx.host, { freqKHz: hz / 1000, mode, seconds: LOOK_SECONDS });
  if (!rec.ok) return { rx, error: rec.error, heard: false };
  const m = runTask('measure', rec.samples, rec.sampleRate, {});
  if (!m || m.ok === false || !m.detection) {
    return { rx, error: (m && m.reason) || 'measure returned nothing', heard: false };
  }
  const snr = m.detection.peakBinSnrDb;
  return {
    rx,
    heard: !!m.detection.present && Number.isFinite(snr) && snr >= HEARD_DB,
    overDb: Number.isFinite(snr) ? +snr.toFixed(1) : 0,
    hz: Number.isFinite(m.centre) ? Math.round(m.centre) : null,   // audio centre
    bandwidthHz: m.bandwidth && Number.isFinite(m.bandwidth.value) ? Math.round(m.bandwidth.value) : null,
    floorDb: Number.isFinite(m.noiseFloor) ? +m.noiseFloor.toFixed(1) : (ctx?.floorDb ?? null),
    spanOccupancy: ctx?.occupancy ?? null,
    seconds: rec.seconds,
  };
}

/** Record and run the same decode chain the browser bench runs. */
async function listen(rx, hz, mode, seconds) {
  const rec = await recordAudio(rx.host, { freqKHz: hz / 1000, mode, seconds });
  if (!rec.ok) return { ok: false, error: rec.error };
  // A receiver that hangs up early hands back a few seconds of audio, and
  // every decoder then refuses it for want of material. That refusal reads
  // exactly like "the channel was empty" and means nothing of the kind, so
  // the shortfall is carried out to the reader rather than swallowed.
  const short = rec.seconds < seconds * 0.6;
  const decodes = runTask('decode', rec.samples, rec.sampleRate, {});
  const meas = runTask('measure', rec.samples, rec.sampleRate, {});
  return {
    ok: true, host: rx.host, seconds: rec.seconds, askedSeconds: seconds, short,
    cutShortBy: short ? `asked for ${seconds} s, the receiver gave ${rec.seconds} s and closed (${rec.why})` : null,
    sampleRate: rec.sampleRate, samples: rec.samples,
    read: decodes.filter(d => d.ok).map(d => ({ name: d.name, text: d.text, note: d.note })),
    refused: decodes.filter(d => !d.ok).map(d => ({ name: d.name, reason: d.reason })),
    snrDb: meas?.detection && Number.isFinite(meas.detection.peakBinSnrDb) ? +meas.detection.peakBinSnrDb.toFixed(1) : null,
  };
}

/**
 * One target, start to finish: look with several ears, corroborate, and listen
 * only if there was something there.
 */
export async function scanTarget(target, list, { ears = 2, seconds = 30, minKm = 400, maxKm = 3000, decode = true, keepAudio = null, contexts = null, geometry = 'cluster', spares = 2 } = {}) {
  // Clustered by default: ears that share a sky can contradict each other,
  // ears on different continents can only shrug. `spread` is available for
  // the opposite question — is this signal reaching the whole world.
  //
  // Spares are picked alongside, because a receiver that refuses is common and
  // costs the whole pass: with two ears and one failure nothing can ever be
  // corroborated, and a first marker watch returned "only 1 receiver returned
  // usable audio" on all five channels for exactly that reason.
  const pick = (n) => geometry === 'spread'
    ? spread(list, target.hz, n, Math.max(minKm, 1500))
    : cluster(list, target.hz, n, minKm, maxKm, { near: target.near ?? null });
  const picks = pick(ears + spares);
  if (picks.length < 1) return { target, error: 'no receiver covers this frequency with a free slot' };

  const reports = [];
  const substituted = [];
  for (const rx of picks) {
    const usable = reports.filter(r => !r.error).length;
    if (usable >= ears) break;
    // A cache exposes get() as a promise; a plain Map is still accepted so the
    // function stays usable on its own.
    const ctx = contexts
      ? (typeof contexts.get === 'function' && contexts.map ? await contexts.get(rx) : contexts.get(rx.host) ?? null)
      : null;
    const r = await look(rx, target.hz, target.mode || 'usb', ctx);
    if (r.error && reports.length >= ears) substituted.push({ rx: rx.loc, why: r.error });
    reports.push(r);
    await sleep(POLITE_MS);
  }

  const verdict = corroborate(reports, { minKm });
  const out = {
    target, at: new Date().toISOString(),
    ears: reports.filter(r => !r.error).length, tried: reports.length,
    substituted: substituted.length ? substituted : undefined,
    verdict, reports: reports.map(({ rx, ...r }) => ({ rx: rx.loc, host: rx.host, gps: rx.gps, ...r })),
  };

  const loudest = reports.filter(r => r.heard).sort((a, b) => (b.overDb ?? 0) - (a.overDb ?? 0))[0];
  if (decode && loudest) {
    const heard = await listen(loudest.rx, target.hz, target.mode || 'usb', seconds);
    if (heard.ok) {
      const { samples, ...rest } = heard;
      out.decode = { ...rest, corroboration: verdict.verdict };
      if (keepAudio) {
        const f = path.join(keepAudio, `${Math.round(target.hz / 1000)}k-${loudest.rx.host.split(/[.:]/)[0]}-${Date.now()}.f32`);
        fs.writeFileSync(f, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
        out.decode.audio = f;
      }
    } else out.decode = { ok: false, error: heard.error };
  }
  return out;
}

/**
 * Discovery: survey wide, then ask the catalogue to explain every emission.
 * Whatever it cannot explain is the output. This is the half a watchlist
 * cannot do, because a watchlist only contains what somebody already knew.
 */
export async function discover(list, { ears = 3, minKm = 400, maxKm = 3000, minOverDb = 12 } = {}) {
  // Clustered, not spread. Receivers on three continents share almost no
  // propagation, so they cannot corroborate each other and a first attempt at
  // this returned "only one receiver heard it" for 47 of 49 findings. Ears
  // 400-3000 km apart are independent and still under the same sky.
  const picks = cluster(list, 15e6, ears, minKm, maxKm);
  const surveys = [];
  for (const rx of picks) {
    const s = await surveyBand(rx.host, { frames: 14, overDb: minOverDb });
    surveys.push({ rx, s });
    await sleep(POLITE_MS);
  }
  const good = surveys.filter(v => v.s.ok);
  if (!good.length) return { error: 'no receiver returned a spectrum', tried: picks.map(p => p.host) };

  // Everything anyone saw, bucketed by what the catalogue makes of it.
  const seen = new Map();
  for (const { rx, s } of good) {
    for (const e of s.emissions) {
      const key = Math.round(e.hz / 30000) * 30000;   // one bin's worth of slack
      if (!seen.has(key)) seen.set(key, []);
      // The resolution travels with the observation so corroboration cannot
      // claim a finer agreement than a 29.3 kHz bin can support.
      seen.get(key).push({ rx, ...e, floorDb: s.floorDb, spanOccupancy: s.occupancy, heard: true, resolutionHz: s.binHz });
    }
  }

  const findings = [];
  for (const [key, hits] of seen) {
    const what = explain(key, { toleranceHz: 30000 });
    if (what.status === 'allocated') continue;            // "a signal in the 40m band" is not news
    if (what.status === 'catalogued' && what.entry.confidence !== 'historic') continue;
    const quiet = good.filter(v => !hits.some(h => h.rx.host === v.rx.host))
      .map(v => ({ rx: v.rx, heard: false, floorDb: v.s.floorDb, spanOccupancy: v.s.occupancy }));
    const binHz = good[0].s.binHz;
    findings.push({
      hz: key, status: what.status, entry: what.entry || null,
      verdict: corroborate([...hits, ...quiet], { minKm }),
      loudestDb: Math.max(...hits.map(h => h.overDb)),
      // A whole-band survey resolves 29.3 kHz. Matching an emission to a
      // catalogued frequency at that resolution is a coincidence-prone claim,
      // and never more so than for a station believed off the air — so the
      // finding carries the check that would settle it.
      resolutionHz: Math.round(binHz),
      settleWith: what.status === 'historic-hit'
        ? `node tools/scan.mjs --hz ${what.entry.hz} --mode ${what.entry.mode} --ears 3 --seconds 60`
        : null,
    });
  }
  findings.sort((a, b) => (b.status === 'historic-hit' ? 1 : 0) - (a.status === 'historic-hit' ? 1 : 0) || b.loudestDb - a.loudestDb);
  return { at: new Date().toISOString(), receivers: good.map(v => ({ host: v.rx.host, loc: v.rx.loc, gps: v.rx.gps })), findings };
}

// ---------------------------------------------------------------- CLI

function arg(k, d) { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; }
const has = (k) => process.argv.includes(k);

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = await receivers();
  const ears = Number(arg('--ears', 2));
  const seconds = Number(arg('--seconds', 30));
  const outDir = arg('--out', null);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const log = outDir ? path.join(outDir, `scan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.ndjson`) : null;
  const write = (o) => { if (log) fs.appendFileSync(log, JSON.stringify(o) + '\n'); };

  if (has('--discover')) {
    const d = await discover(list, { ears });
    write(d);
    if (d.error) { console.log(d.error); process.exit(1); }
    console.log(`listened on ${d.receivers.length} receivers: ${d.receivers.map(r => r.loc.slice(0, 30)).join(' | ')}`);
    console.log(`${d.findings.length} emission${d.findings.length === 1 ? '' : 's'} the catalogue does not explain away\n`);
    for (const f of d.findings.slice(0, 30)) {
      const tag = f.status === 'historic-hit' ? `HISTORIC: ${f.entry.name}` : 'uncatalogued';
      console.log(`${(f.hz / 1e6).toFixed(3)} MHz  +${f.loudestDb} dB  [${tag}]  ${f.verdict.verdict}`);
      console.log(`    ${f.verdict.why}`);
      if (f.settleWith) {
        console.log(`    this survey resolves ${(f.resolutionHz / 1000).toFixed(1)} kHz, which is too coarse to claim a station believed off the air. To settle it:`);
        console.log(`    ${f.settleWith}`);
      }
    }
    if (log) console.log(`\nwritten to ${log}`);
    process.exit(0);
  }

  let targets;
  if (has('--hz')) targets = [{ hz: Number(arg('--hz')), name: 'ad hoc', mode: arg('--mode', 'usb'), kind: 'manual' }];
  else {
    const kinds = String(arg('--kinds', KINDS.join(','))).split(',').map(s => s.trim()).filter(Boolean);
    targets = byKind(kinds);
  }
  const limit = Number(arg('--limit', targets.length));
  targets = targets.slice(0, limit);

  console.log(`${targets.length} target${targets.length === 1 ? '' : 's'}, ${ears} ear${ears === 1 ? '' : 's'} each, from ${list.filter(r => r.free > 0).length} receivers with a free slot`);

  // Band occupancy is measured for each receiver the first time it is actually
  // used, not for every receiver that might be.
  const contexts = contextCache();
  console.log('');

  for (const t of targets) {
    const r = await scanTarget(t, list, { ears, seconds, decode: !has('--no-decode'), keepAudio: outDir, contexts });
    write(r);
    if (r.error) { console.log(`${(t.hz / 1e6).toFixed(4)} MHz  ${t.name}: ${r.error}`); continue; }
    const v = r.verdict;
    console.log(`${(t.hz / 1e6).toFixed(4)} MHz  ${t.name}  [${t.kind}]  ->  ${v.verdict.toUpperCase()}`);
    console.log(`    ${v.why}`);
    if (r.decode?.cutShortBy) console.log(`    ! ${r.decode.cutShortBy}`);
    if (r.decode?.read?.length) {
      for (const d of r.decode.read) console.log(`    READ ${d.name}: ${String(d.text).replace(/\n/g, ' / ').slice(0, 110)}`);
    } else if (r.decode?.ok) {
      console.log(`    nothing decoded in ${r.decode.seconds} s; every reader refused (SNR ${r.decode.snrDb} dB)`
        + (r.decode.short ? ' — but the span was too short to conclude anything' : ''));
    }
    await sleep(POLITE_MS);
  }
  if (log) console.log(`\nwritten to ${log}`);
}
