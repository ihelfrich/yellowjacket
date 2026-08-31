# CONTRACT-PROJECT — portable `.yjkt` sessions and the command deck

Locked 2026-08-04. This contract adds a portable project boundary around the
existing OPFS autosave and a single searchable doorway into the expanded bench.

## 1. `.yjkt` format

A `.yjkt` is a standards-compliant ZIP archive whose entries use method 0
(STORE). No dependency, compressor, server, or WASM module is required.

```text
project.json                         version 3 project document
sources/<64-lowercase-hex>.bin       exact encoded bytes for each referenced source
samples/a[1-9][0-9]*.f32             canonical channel-major Float32 PCM
```

The reader is intentionally not a general unzipper. Before any live state
changes it must verify the end-of-central-directory record, central and local
headers, STORE method, entry count, entry and total sizes, safe relative UTF-8
paths, uniqueness, and CRC-32 for every entry. ZIP64 sentinels and local or
central ZIP64 extra fields are unsupported and reject explicitly. The existing
limits remain 1,024 entries, 512 MiB per entry, and 768 MiB expanded in total.
`project.json` is limited to 16 MiB and is rejected before UTF-8 decoding or
`JSON.parse` when larger.

The manifest defines an exact allowlist. A version 3 archive contains exactly
one `project.json`, one canonical source path for every key in `sources`, and
one canonical sample path for every MACHINE-reachable asset. Missing payloads,
unreferenced payloads, legacy `source.bin`, arbitrary notes or metadata files,
uppercase or otherwise rewritten digest paths, and noncanonical sample IDs all
reject. Writer order is deterministic: manifest, lexically sorted source paths,
then numeric `aN` sample order. Reader order is irrelevant.

Archive mapping snapshots exact vanilla payload Maps and their bytes once.
`samplePayloads` supplies the authoritative sample bytes;
`serializeProjectV3().sampleFiles` is only the exact ordered
ID/byte-length/SHA-256 index. Parsing returns newly owned source and sample Maps.
The semantic mapper proves path identity and completeness; version 3 preflight
then recomputes each SHA-256, verifies declared byte lengths and canonical PCM,
and validates the source/ClipRef/project-bound-provenance graph before commit.
A missing, compressed, encrypted, corrupt, traversing, duplicated, unknown, or
internally inconsistent entry refuses the whole import. The status line must
say that nothing changed.

Exports carry only project state. CRATE is a browser-level instrument library
and never rides in, or gets replaced by, a `.yjkt`.

Task 11 exposes version 3 only through the explicit inactive
`projectEntriesV3()` and version-aware parsing contracts. The live
`projectEntries()` writer and `FORMAT_VERSION` remain version 2 until Task 12
switches persistence and archive orchestration atomically.

## 2. Import transaction

Parse and preflight first. Ask before replacing a non-empty session second.
Only then stage-decode the requested active source. No project, source registry,
engine buffer, PCM owner Map, history, or view changes until the archive,
document, every payload, and that decode are ready. Commit installs the complete
validated state in place, attaches verified sample owners, relights every view,
rebuilds repairs, clears undo history, and resumes autosave. An unsupported or
incomplete archive never calls the destructive half of this sequence.

Version 2 is read only through the explicit migration branch. It accepts only
its exact optional `source.bin` and MACHINE-reachable sample set; the legacy
single-segment sample-ID exception exists solely for migration. Migration
stages source decode, issues the version 3 source identity and graph, and
canonicalizes reachable PCM without mutating the input. A version 2 file is
never overwritten in place; a later export creates a new version 3 `.yjkt`.

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

- Node: ZIP round-trip preserves arbitrary bytes; exact three-source and
  three-sample archives have canonical order and owned payloads; missing,
  extra, mismatched, noncanonical, ZIP64, checksum, traversal, duplicate,
  compression, encryption, header, count, and size cases fail; output filenames
  are safe and bounded.
- Browser: Command/Control-K opens with no console error; search, arrows,
  Enter, Escape, and backdrop work; disabled actions explain themselves;
  visible Undo/Redo track `ProjectStore` history.
- Browser project after Task 12 activation: source-backed and source-free
  bundles restore every referenced source and sample; an invalid bundle or
  failed active-source stage decode leaves the current session untouched.
- Offline: both new modules are pre-cached and the service-worker version is
  bumped for the release.
