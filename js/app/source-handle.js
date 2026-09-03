// The encoded source as loaded. Size and SHA-256 are plain fields, because
// that is all identity needs (LOOM and MACHINE match plans by hash, name,
// size). The bytes themselves are released from memory once a durable copy
// exists — autosave's source.bin in OPFS — and read back on demand by the
// few consumers that need them: KEEP, PROJECT OUT, RESTORE. Before the spill
// (or on a browser without OPFS writes) the bytes stay resident and bytes()
// returns them directly. Codex review 2026-09-03: the encoded copy was one
// of three at peak and the only one that never had a reason to stay.

export class SourceHandle {
  constructor(bytes, { hash = null, generation = 0 } = {}) {
    if (!(bytes instanceof ArrayBuffer)) throw new TypeError('SourceHandle needs an ArrayBuffer');
    this._bytes = bytes;
    this._reader = null;
    this.size = bytes.byteLength;
    this.hash = hash;
    this.generation = generation;
  }

  // Legacy readers ask for byteLength; keep answering.
  get byteLength() { return this.size; }
  get resident() { return !!this._bytes; }
  get spilled() { return !this._bytes && !!this._reader; }

  // Release the memory copy. `reader` must return a fresh ArrayBuffer of the
  // same bytes; call it only once the durable write has completed.
  spill(reader) {
    if (typeof reader !== 'function') return false;
    this._reader = reader;
    this._bytes = null;
    return true;
  }

  async bytes() {
    if (this._bytes) return this._bytes;
    if (!this._reader) throw new Error('the source bytes are no longer available in this session');
    const back = await this._reader();
    if (!(back instanceof ArrayBuffer)) throw new Error('the stored source could not be read back');
    if (back.byteLength !== this.size) {
      throw new Error('the stored source does not match this session (' + back.byteLength + ' bytes on disk, ' + this.size + ' expected)');
    }
    return back;
  }
}
