# CONTRACT-PROJECT — portable `.yjkt` sessions and the command deck

Locked 2026-08-04. This contract adds a portable project boundary around the
existing OPFS autosave and a single searchable doorway into the expanded bench.

## 1. `.yjkt` format

A `.yjkt` is a standards-compliant ZIP archive whose entries use method 0
(STORE). No dependency, compressor, server, or WASM module is required.

```text
project.json          serializeProject() document; formatVersion is authoritative
source.bin            exact encoded source bytes, omitted for source-free projects
samples/<id>.f32      flat channel-major Float32 PCM, one file per referenced asset
```

The reader is intentionally not a general unzipper. Before any live state
changes it must verify the end-of-central-directory record, central and local
headers, STORE method, entry count, entry and total sizes, safe relative UTF-8
paths, uniqueness, and CRC-32 for every entry. It then validates
`formatVersion`, exact `sourceBytes.size`, and exact sample byte lengths from
`frames * channelCount * 4`. A missing, compressed, encrypted, corrupt,
traversing, duplicated, or internally inconsistent entry refuses the whole
import. The status line must say that nothing changed.

Exports carry only project state. CRATE is a browser-level instrument library
and never rides in, or gets replaced by, a `.yjkt`.

## 2. Import transaction

Parse and preflight first. Ask before replacing a non-empty session second.
Only then decode the source (or clear to a true source-free state), apply the
snapshot in place, attach already-validated sample PCM, relight every view,
rebuild repairs, clear undo history, and resume autosave. An unsupported or
incomplete archive never calls the destructive half of this sequence.

## 3. Command deck

Command/Control-K opens one dialog containing a fresh projection of available
actions. It owns no application logic. Navigation calls the composition root;
tools activate their real controls; history and transport call public APIs.
Disabled actions remain visible and state the missing precondition. Search
matches label, note, group, and explicit keywords. Arrow keys move, Enter runs,
Escape closes, backdrop click closes. Context reports the current source or
source-free instrument, words, clips, assigned tracks, and available local
browser capabilities.

## 4. Acceptance

- Node: ZIP round-trip preserves arbitrary bytes; a real serialized source and
  sample hydrate correctly; checksum corruption, traversal, and duplicate
  names fail; output filenames are safe and bounded.
- Browser: Command/Control-K opens with no console error; search, arrows,
  Enter, Escape, and backdrop work; disabled actions explain themselves;
  visible Undo/Redo track `ProjectStore` history.
- Browser project: source-backed and source-free bundles restore with all
  referenced samples; an invalid bundle leaves the current session untouched.
- Offline: both new modules are pre-cached and the service-worker version is
  bumped for the release.
