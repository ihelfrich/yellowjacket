// Content identity for source lineage. Hashing is local: encoded source bytes
// never leave the browser, and filename/length are never treated as identity.

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('source fingerprint needs bytes');
}

export async function sha256Hex(value) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('SHA-256 is unavailable in this browser');
  }
  const bytes = bytesOf(value);
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fingerprintId(hex) {
  const clean = String(hex || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? 'sha256:' + clean : null;
}
