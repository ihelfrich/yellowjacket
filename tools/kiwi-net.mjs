#!/usr/bin/env node
// The public receiver network: who is listening, where, and how well.
//
//   node tools/kiwi-net.mjs                    a summary of what is online
//   node tools/kiwi-net.mjs --pick 3 --mhz 10  three good receivers for 10 MHz
//   node tools/kiwi-net.mjs --spread 2 --mhz 5 two receivers far apart
//
// The list at rx.linkfanel.net is regenerated every few minutes from
// kiwisdr.com/public. Around 850 receivers are online at any hour, run by
// volunteers with a handful of slots each, so this module exists as much to
// be a good guest as to find a good ear:
//
//   never return a receiver with no free slot
//   prefer a GPS-disciplined clock, because a drifting one lies about frequency
//   spread picks across the map, because two ears in one town see one sky
//
// The list is cached for CACHE_MINUTES so that a scan of fifty frequencies
// fetches it once, not fifty times.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { greatCircleKm } from '../js/sigint/geo.js';
import { rank, spread, cluster } from '../js/sigint/receivers.js';

const LIST_URL = 'http://rx.linkfanel.net/kiwisdr_com.js';
const CACHE = path.join(os.tmpdir(), 'yj-kiwi-list.json');
const CACHE_MINUTES = 10;

// Distance lives in js/sigint/geo.js so the corroboration logic can use the
// same function without pulling in a node-only module.
export { greatCircleKm } from '../js/sigint/geo.js';

// Nearly half the public receivers publish a proxy.kiwisdr.com address with
// no port. That address 307-redirects to :8073, and a WebSocket does not
// follow redirects — it just fails to connect. Adding the port back recovers
// 398 of 865 receivers, which is most of North America.
function normalizeHost(url) {
  const bare = String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return /:\d+$/.test(bare) ? bare : bare + ':8073';
}

function parseGps(s) {
  const m = /\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?/.exec(s || '');
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;       // the null island default
  return [lat, lon];
}

export function parseList(text) {
  let s = text.slice(text.indexOf('['));
  s = s.slice(0, s.lastIndexOf(']') + 1).replace(/,\s*\]$/, ']');
  const raw = JSON.parse(s);
  const out = [];
  for (const r of raw) {
    if (!r.url || r.status !== 'active' || r.offline === 'yes') continue;
    const users = Number(r.users), max = Number(r.users_max);
    const free = Number.isFinite(users) && Number.isFinite(max) ? max - users : 0;
    const band = String(r.bands || '').split('-').map(Number);
    // "snr" is reported as "<hf>,<all>"; the first number is the one that
    // describes how quiet the shortwave spectrum looks from that antenna.
    const snr = Number(String(r.snr || '').split(',')[0]);
    out.push({
      id: r.id,
      host: normalizeHost(r.url),
      loc: r.loc || r.name || r.id,
      gps: parseGps(r.gps),
      gpsLocked: r.gps_good === '1',
      snrDb: Number.isFinite(snr) ? snr : null,
      free: Math.max(0, free),
      slots: Number.isFinite(max) ? max : 0,
      lowHz: Number.isFinite(band[0]) ? band[0] : 0,
      highHz: Number.isFinite(band[1]) ? band[1] : 30e6,
      antenna: r.antenna || '',
    });
  }
  return out;
}

export async function receivers({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const st = fs.statSync(CACHE);
      if ((Date.now() - st.mtimeMs) / 60000 < CACHE_MINUTES) {
        return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      }
    } catch { /* no cache yet */ }
  }
  const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`receiver list: HTTP ${res.status}`);
  const list = parseList(await res.text());
  fs.writeFileSync(CACHE, JSON.stringify(list));
  return list;
}

// Choosing which ears to use is pure logic and lives in js/sigint/receivers.js
// so it can be tested without a network. This module is the part that needs
// one: fetching the list, caching it, and normalising what it contains.
export { canHear, rank, spread, cluster } from '../js/sigint/receivers.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const list = await receivers({ fresh: process.argv.includes('--fresh') });
  const hz = Number(arg('--mhz', 10)) * 1e6;
  const n = Number(arg('--pick', arg('--spread', 0)));
  if (n > 0) {
    const picks = process.argv.includes('--cluster')
      ? cluster(list, hz, n, Number(arg('--minkm', 400)), Number(arg('--maxkm', 3000)))
      : process.argv.includes('--spread')
        ? spread(list, hz, n, Number(arg('--minkm', 1000)))
        : rank(list, hz).slice(0, n);
    for (const r of picks) {
      console.log(`${String(r.snrDb ?? '?').padStart(3)} dB  ${r.gpsLocked ? 'GPS' : '   '}  ${String(r.free).padStart(2)} free  ${r.host.padEnd(34)}  ${r.loc}`);
    }
  } else {
    const free = list.filter(r => r.free > 0);
    console.log(JSON.stringify({
      online: list.length,
      withFreeSlots: free.length,
      openSlots: free.reduce((a, r) => a + r.free, 0),
      gpsLocked: list.filter(r => r.gpsLocked).length,
      located: list.filter(r => r.gps).length,
    }, null, 1));
  }
}
