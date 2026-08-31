// Persistence core, per docs/CONTRACT-PERSIST.md: pure serializeProject +
// applySnapshot (in-place restore) and the OpfsStore adapter. The pure pair is
// node-testable (scratch/test_persist.mjs); only OpfsStore touches the browser.
// Autosave scheduling and restore orchestration live in persist-controller.js.

import { normalizeVoice } from '../machine/compile.js';
import { applyStudioSnapshot, studioHasContent } from '../studio/model.js';
import { reidentifyLoomPlan, sameLoomPlanContent } from '../loom/identity.js';

export const FORMAT_VERSION = 2;

const DIR_NAME = 'yellowjacket-v1';
const MAX_STEPS = 64;

// A project can be real without a source recording: SYNTH and CRATE both make
// instruments directly. Keep this pure so the controller and test harness use
// the same definition when deciding whether there is anything worth saving.
export function projectHasContent(project, runtime = {}) {
  if (!project || typeof project !== 'object') return false;
  const source = runtime.sourceBytes || project.sourceBytes;
  if (source && ((Number(source.byteLength) || 0) > 0 || (Number(source.size) || 0) > 0)) return true;
  if (Array.isArray(project.words) && project.words.length) return true;
  if (Array.isArray(project.clips) && project.clips.length) return true;
  if (runtime.repairs && runtime.repairs.length) return true;
  if (project.repairs && project.repairs.length) return true;
  if (project.assets && Object.keys(project.assets).length) return true;
  if (studioHasContent(project.studio)) return true;
  if (project.loom && (project.loom.plan
    || (project.loom.plans && Object.keys(project.loom.plans).length))) return true;

  const machine = project.machine;
  const scenes = machine && Array.isArray(machine.scenes) ? machine.scenes : [];
  for (const scene of scenes) {
    const tracks = scene && Array.isArray(scene.tracks) ? scene.tracks : [];
    for (const track of tracks) {
      if (!track) continue;
      if (track.sampleId) return true;
      if (track.steps && Array.from(track.steps).some(Boolean)) return true;
      if (track.stepData && Object.keys(track.stepData).length) return true;
    }
  }
  const song = machine && machine.song;
  return !!(song && Array.isArray(song.chain) && song.chain.length);
}

export class FormatVersionError extends Error {
  constructor(version) {
    super('unsupported project formatVersion ' + String(version)
      + ' (this bench reads formatVersion ' + FORMAT_VERSION + ')');
    this.name = 'FormatVersionError';
    this.formatVersion = version;
  }
}

// JSON-safe deep copy; typed arrays become plain arrays. Copies every key it
// finds, so unknown stepData/repair fields ride through untouched (forward
// tolerance both directions).
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clone(value[i]);
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

// samples/<assetId>.f32 layout: header-less per-channel concatenated Float32;
// channelCount/frames/sampleRate live in json.assets.
function sampleBytes(sample) {
  let total = 0;
  for (const ch of sample.channels) total += ch.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const ch of sample.channels) {
    out.set(ch, offset);
    offset += ch.length;
  }
  return out.buffer;
}

function serializeTrack(track) {
  const steps = new Array(MAX_STEPS).fill(0);
  const src = track.steps || [];
  const n = Math.min(MAX_STEPS, src.length);
  for (let i = 0; i < n; i++) steps[i] = src[i];
  return {
    sampleId: typeof track.sampleId === 'string' ? track.sampleId : null,
    voice: clone(track.voice || {}),
    steps,
    stepData: clone(track.stepData || {}),
    len: track.len,
    gainDb: track.gainDb,
    pan: track.pan,
    mute: !!track.mute,
    solo: !!track.solo,
    duckSource: track.duckSource,
    duckDb: track.duckDb,
    choke: !!track.choke,
    chokeGroup: track.chokeGroup,
    sendVerb: track.sendVerb,
    sendDelay: track.sendDelay,
  };
}

function serializeScene(scene) {
  return {
    id: scene.id,
    name: scene.name,
    bpm: scene.bpm,
    swing: scene.swing,
    seed: scene.seed,
    drums: scene.drums ? clone(scene.drums) : null,
    loomLane: scene.loomLane ? clone(scene.loomLane) : null,
    tracks: scene.tracks.map(serializeTrack),
  };
}

function serializeTranscript(project) {
  const count = Array.isArray(project.words) ? project.words.length : 0;
  const source = project.transcript && Array.isArray(project.transcript.gapCuts)
    ? project.transcript.gapCuts : [];
  return { gapCuts: Array.from({ length: count }, (_, index) => !!source[index]) };
}

// Undo snapshots need the document only. Copying every referenced PCM buffer
// on each of the 29 mutation sites would cost megabytes per keystroke, so
// skipPcm builds the same JSON without touching sample audio.
export function snapshotDoc(project, runtime) {
  return serializeProject(project, runtime, true).json;
}

export function serializeProject(project, runtime, skipPcm = false) {
  const machine = project.machine;
  const assets = {};
  for (const id of Object.keys(project.assets || {})) assets[id] = clone(project.assets[id]);

  // PCM only for assets a track actually references, deduped: scenes share
  // sample refs by design, and one asset must become exactly one file.
  const sampleFiles = [];
  const seen = new Set();
  for (const scene of machine.scenes) {
    for (const track of scene.tracks) {
      const id = track.sampleId;
      if (!id || seen.has(id)) continue;
      if (!track.sample || !Array.isArray(track.sample.channels)) continue;
      seen.add(id);
      if (!skipPcm) sampleFiles.push({ id, bytes: sampleBytes(track.sample) });
      if (assets[id]) assets[id].channelCount = track.sample.channels.length;
    }
  }
  for (const id of Object.keys(assets)) {
    if (!Number.isFinite(assets[id].channelCount)) assets[id].channelCount = 1;
  }

  const src = runtime.sourceBytes;
  const anchors = runtime.analysis && runtime.analysis.anchors;
  const json = {
    formatVersion: FORMAT_VERSION,
    savedAt: Date.now(),
    fileName: project.fileName != null ? project.fileName : null,
    sourceBytes: src ? { size: src.byteLength } : null,
    words: clone(project.words),
    transcript: serializeTranscript(project),
    clips: clone(project.clips || []),
    chain: clone(project.chain || []),
    machine: {
      activeScene: machine.activeScene,
      scenes: machine.scenes.map(serializeScene),
      song: machine.song ? clone(machine.song) : null,
      space: machine.space ? clone(machine.space) : null,
      drums: machine.drums ? clone(machine.drums) : null,
    },
    studio: project.studio ? clone(project.studio) : null,
    loom: project.loom ? clone(project.loom) : null,
    assets,
    repairs: clone(runtime.repairs || []),
    anchors: anchors ? clone(anchors) : null,
    wire: project.wire ? clone(project.wire) : null,
  };
  return { json, sampleFiles };
}

// The inverse of the sample half of serializeProject: one asset's metadata plus
// its flat f32 file, back into the runtime {channels, sampleRate, label, role}
// shape a track holds. It lives here rather than inline in the restore loop so
// the harness can hold it to the round trip. It was inline, and it silently
// dropped `role`, which is the field that decides whether a fitted slice is
// stretched by WSOLA or by the phase vocoder: every restored drum came back
// tonal and smeared.
export function hydrateSample(meta, raw) {
  if (!meta || !raw) return null;
  const flat = raw instanceof Float32Array ? raw : new Float32Array(raw);
  const frames = Math.max(0, meta.frames | 0);
  const count = Math.max(1, meta.channelCount | 0);
  if (!frames || flat.length < frames * count) return null;
  const channels = [];
  for (let c = 0; c < count; c++) channels.push(flat.slice(c * frames, (c + 1) * frames));
  return { channels, sampleRate: meta.sampleRate, label: meta.label, role: meta.role };
}

function applyTrack(track, saved) {
  track.sampleId = typeof saved.sampleId === 'string' ? saved.sampleId : null;
  track.sample = null;   // PCM attaches after sample files load (RestorePlan)
  // Voice merges saved fields over the defaults, then hands the result to the
  // compiler's own normalizeVoice. This block used to re-implement all eleven
  // clamps by hand, and had already drifted: it truncated fitSteps with |0
  // where the compiler rounds, so a saved 2.6 played as 2 steps after a reload
  // and 3 before it. The ranges now have exactly one definition.
  if (saved.voice && typeof saved.voice === 'object' && track.voice) {
    Object.assign(track.voice, normalizeVoice({ ...track.voice, ...saved.voice }));
  }
  if (Number.isFinite(saved.sendVerb)) track.sendVerb = Math.max(0, Math.min(1, saved.sendVerb));
  if (Number.isFinite(saved.sendDelay)) track.sendDelay = Math.max(0, Math.min(1, saved.sendDelay));
  track.steps.fill(0);
  if (Array.isArray(saved.steps)) {
    const n = Math.min(MAX_STEPS, saved.steps.length);
    for (let i = 0; i < n; i++) track.steps[i] = saved.steps[i];
  }
  for (const key of Object.keys(track.stepData)) delete track.stepData[key];
  if (saved.stepData && typeof saved.stepData === 'object') {
    for (const key of Object.keys(saved.stepData)) {
      const step = Number(key);
      if (Number.isInteger(step) && step >= 0 && step < MAX_STEPS) {
        track.stepData[key] = clone(saved.stepData[key]);
      }
    }
  }
  if (Number.isFinite(saved.len)) track.len = saved.len | 0;
  if (Number.isFinite(saved.gainDb)) track.gainDb = saved.gainDb;
  if (Number.isFinite(saved.pan)) track.pan = saved.pan;
  if (typeof saved.mute === 'boolean') track.mute = saved.mute;
  if (typeof saved.solo === 'boolean') track.solo = saved.solo;
  if (Number.isFinite(saved.duckSource)) track.duckSource = saved.duckSource | 0;
  if (Number.isFinite(saved.duckDb)) track.duckDb = saved.duckDb;
  if (typeof saved.choke === 'boolean') track.choke = saved.choke;
  if (Number.isFinite(saved.chokeGroup)) {
    track.chokeGroup = Math.max(0, Math.min(4, saved.chokeGroup | 0));
  }
}

function applyScene(scene, saved) {
  if (typeof saved.id === 'string') scene.id = saved.id;
  if (typeof saved.name === 'string') scene.name = saved.name;
  // Written on the scene directly: machine.bpm/swing are active-scene aliases
  // and must never be the write path here.
  if (Number.isFinite(saved.bpm)) scene.bpm = saved.bpm;
  if (Number.isFinite(saved.swing)) scene.swing = saved.swing;
  if (Number.isFinite(saved.seed)) scene.seed = saved.seed >>> 0;
  if (scene.drums) {
    scene.drums.kitId = null;
    scene.drums.grooveId = null;
    scene.drums.variation = 0;
    if (saved.drums && typeof saved.drums === 'object') {
      scene.drums.kitId = typeof saved.drums.kitId === 'string' ? saved.drums.kitId : null;
      scene.drums.grooveId = typeof saved.drums.grooveId === 'string' ? saved.drums.grooveId : null;
      if (Number.isFinite(saved.drums.variation)) {
        scene.drums.variation = Math.max(0, saved.drums.variation | 0);
      }
    }
  }
  if (scene.loomLane) {
    const lane = saved.loomLane && typeof saved.loomLane === 'object' ? saved.loomLane : {};
    scene.loomLane.planId = typeof lane.planId === 'string' ? lane.planId : null;
    scene.loomLane.enabled = lane.enabled !== false;
    scene.loomLane.gainDb = Number.isFinite(lane.gainDb)
      ? Math.max(-48, Math.min(6, lane.gainDb)) : -9;
    scene.loomLane.pan = Number.isFinite(lane.pan)
      ? Math.max(-1, Math.min(1, lane.pan)) : 0;
    scene.loomLane.repeatSteps = Number.isFinite(lane.repeatSteps)
      ? Math.max(1, Math.min(64, lane.repeatSteps | 0)) : 16;
    scene.loomLane.startStep = Number.isFinite(lane.startStep)
      ? Math.max(0, Math.min(63, lane.startStep | 0)) : 0;
  }
  const savedTracks = Array.isArray(saved.tracks) ? saved.tracks : [];
  const n = Math.min(scene.tracks.length, savedTracks.length);
  for (let i = 0; i < n; i++) {
    if (savedTracks[i] && typeof savedTracks[i] === 'object') applyTrack(scene.tracks[i], savedTracks[i]);
  }
}

// Mutates project/runtime IN PLACE: controllers hold references to the project,
// the machine, the scenes/tracks arrays, chain entries, clips, and repairs, so
// none of those objects are ever replaced, only their contents. Unknown
// top-level keys are ignored. Returns a RestorePlan (CONTRACT-PERSIST 3);
// note that both call sites currently discard it and re-derive what they need,
// so it is documentation and a test surface rather than a live dependency.
export function applySnapshot(json, { project, runtime }) {
  if (!json || typeof json !== 'object' || json.formatVersion !== FORMAT_VERSION) {
    throw new FormatVersionError(json && typeof json === 'object' ? json.formatVersion : json);
  }

  project.fileName = typeof json.fileName === 'string' ? json.fileName : null;

  if (Array.isArray(json.words)) {
    if (Array.isArray(project.words)) {
      project.words.length = 0;
      for (const word of json.words) project.words.push(clone(word));
    } else {
      project.words = json.words.map((word) => clone(word));
    }
  } else {
    project.words = null;
  }

  if (!project.transcript || typeof project.transcript !== 'object') {
    project.transcript = { gapCuts: [] };
  }
  if (!Array.isArray(project.transcript.gapCuts)) project.transcript.gapCuts = [];
  project.transcript.gapCuts.length = 0;
  const savedGaps = json.transcript && Array.isArray(json.transcript.gapCuts)
    ? json.transcript.gapCuts : [];
  const gapCount = Array.isArray(project.words) ? project.words.length : 0;
  for (let i = 0; i < gapCount; i++) project.transcript.gapCuts.push(!!savedGaps[i]);

  project.clips.length = 0;
  if (Array.isArray(json.clips)) {
    for (const clip of json.clips) project.clips.push(clone(clip));
  }

  // Chain entries are matched by id and merged: the rack UI closes over the
  // entry and params objects. Effects this bench does not know are skipped.
  if (Array.isArray(json.chain) && Array.isArray(project.chain)) {
    const byId = new Map(project.chain.map((fx) => [fx.id, fx]));
    for (const saved of json.chain) {
      const fx = saved && byId.get(saved.id);
      if (!fx) continue;
      if (typeof saved.on === 'boolean') fx.on = saved.on;
      if (saved.params && typeof saved.params === 'object') {
        for (const key of Object.keys(saved.params)) fx.params[key] = clone(saved.params[key]);
      }
    }
  }

  const machine = project.machine;
  const savedMachine = json.machine && typeof json.machine === 'object' ? json.machine : {};
  const savedScenes = Array.isArray(savedMachine.scenes) ? savedMachine.scenes : [];
  const nScenes = Math.min(machine.scenes.length, savedScenes.length);
  for (let i = 0; i < nScenes; i++) {
    if (savedScenes[i] && typeof savedScenes[i] === 'object') applyScene(machine.scenes[i], savedScenes[i]);
  }
  const active = savedMachine.activeScene;
  machine.activeScene = Number.isInteger(active) && active >= 0 && active < machine.scenes.length ? active : 0;

  // Song chain merges into the existing object; entries clamp to real scenes.
  if (machine.song) {
    machine.song.chain.length = 0;
    const savedSong = savedMachine.song;
    if (savedSong && typeof savedSong === 'object') {
      if (Array.isArray(savedSong.chain)) {
        for (const entry of savedSong.chain) {
          if (!entry || typeof entry !== 'object') continue;
          const scene = entry.scene | 0;
          if (scene < 0 || scene >= machine.scenes.length) continue;
          const reps = Math.max(1, Math.min(99, entry.reps | 0 || 1));
          machine.song.chain.push({ scene, reps });
        }
      }
      machine.song.loop = savedSong.loop !== false;
    }
  }

  // Space rack merges into the existing object (the bus graph closes over it).
  if (machine.space && savedMachine.space && typeof savedMachine.space === 'object') {
    const sp = machine.space;
    const sv = savedMachine.space;
    if (Number.isFinite(sv.verbSec)) sp.verbSec = Math.max(0.1, Math.min(8, sv.verbSec));
    if (Number.isFinite(sv.verbDecay)) sp.verbDecay = Math.max(0.5, Math.min(8, sv.verbDecay));
    if (Number.isFinite(sv.verbMix)) sp.verbMix = Math.max(0, Math.min(1, sv.verbMix));
    if (typeof sv.delayDivision === 'string') sp.delayDivision = sv.delayDivision;
    if (Number.isFinite(sv.delayFeedback)) sp.delayFeedback = Math.max(0, Math.min(0.95, sv.delayFeedback));
    if (Number.isFinite(sv.delayMix)) sp.delayMix = Math.max(0, Math.min(1, sv.delayMix));
  }

  // Factory-kit identity is lightweight UI provenance. The actual PCM remains
  // ordinary persisted assets, so old projects and custom kits need no special
  // restore path.
  if (machine.drums && !(savedScenes[machine.activeScene]
    && savedScenes[machine.activeScene].drums)) {
    const savedDrums = savedMachine.drums;
    if (savedDrums && typeof savedDrums === 'object') {
      machine.drums.kitId = typeof savedDrums.kitId === 'string' ? savedDrums.kitId : null;
      machine.drums.grooveId = typeof savedDrums.grooveId === 'string' ? savedDrums.grooveId : null;
      if (Number.isFinite(savedDrums.variation)) {
        machine.drums.variation = Math.max(0, savedDrums.variation | 0);
      }
    }
  }

  // Studio is optional in formatVersion 2 so projects from the sampler-only
  // era open with a fresh instrument rack. Existing objects stay in place for
  // the controller and audio engine.
  if (project.studio && json.studio && typeof json.studio === 'object') {
    applyStudioSnapshot(project.studio, json.studio);
  }

  // LOOM is optional in formatVersion 2. It is JSON-only and deliberately
  // mutates in place because its controller holds the live project object.
  if (project.loom) {
    project.loom.weaveCount = 0;
    project.loom.plan = null;
    project.loom.activePlanId = null;
    if (!project.loom.plans || typeof project.loom.plans !== 'object') project.loom.plans = {};
    for (const id of Object.keys(project.loom.plans)) delete project.loom.plans[id];
    const planAliases = new Map();
    const bindPlanAlias = (alias, canonicalId) => {
      if (typeof alias !== 'string') return;
      const existing = planAliases.get(alias);
      if (existing && existing !== canonicalId) {
        throw new Error('LOOM PLAN ALIAS COLLISION · PROJECT WAS NOT TRUSTED');
      }
      planAliases.set(alias, canonicalId);
    };
    if (json.loom && typeof json.loom === 'object') {
      const installPlan = (savedPlan, fallbackId) => {
        if (!savedPlan || typeof savedPlan !== 'object') return null;
        const staleId = typeof savedPlan.id === 'string' ? savedPlan.id : null;
        const plan = reidentifyLoomPlan(clone(savedPlan));
        if (!plan) return null;
        const existing = project.loom.plans[plan.id];
        if (existing && !sameLoomPlanContent(existing, plan)) {
          throw new Error('LOOM PLAN ID COLLISION · PROJECT WAS NOT TRUSTED');
        }
        if (!existing) project.loom.plans[plan.id] = plan;
        bindPlanAlias(fallbackId, plan.id);
        bindPlanAlias(staleId, plan.id);
        return project.loom.plans[plan.id];
      };
      if (Number.isFinite(json.loom.weaveCount)) {
        project.loom.weaveCount = Math.max(0, json.loom.weaveCount | 0);
      }
      if (json.loom.plans && typeof json.loom.plans === 'object') {
        for (const id of Object.keys(json.loom.plans)) {
          const savedPlan = json.loom.plans[id];
          installPlan(savedPlan, id);
        }
      }
      let activeId = typeof json.loom.activePlanId === 'string'
        ? json.loom.activePlanId : null;
      if (json.loom.plan && typeof json.loom.plan === 'object') {
        const legacyId = typeof json.loom.plan.id === 'string'
          ? json.loom.plan.id : 'loom-legacy-plan';
        installPlan(json.loom.plan, legacyId);
        if (!activeId) activeId = legacyId;
      }
      const canonicalActiveId = activeId
        ? (planAliases.get(activeId) || (project.loom.plans[activeId] ? activeId : null))
        : null;
      if (canonicalActiveId && project.loom.plans[canonicalActiveId]) {
        project.loom.activePlanId = canonicalActiveId;
        project.loom.plan = project.loom.plans[canonicalActiveId];
      }
    }
    // Scene lanes were restored before the registry. Rewrite every persisted
    // reference through the canonical-id map; a dangling/forged reference is
    // quarantined instead of being allowed to name unrelated content. This
    // also clears stale lane references when an old document has no Loom block.
    for (const scene of machine.scenes) {
      const lane = scene && scene.loomLane;
      if (!lane || typeof lane.planId !== 'string') continue;
      const canonicalId = planAliases.get(lane.planId)
        || (project.loom.plans[lane.planId] ? lane.planId : null);
      lane.planId = canonicalId;
    }
  }

  for (const key of Object.keys(project.assets)) delete project.assets[key];
  if (json.assets && typeof json.assets === 'object') {
    for (const id of Object.keys(json.assets)) {
      const meta = clone(json.assets[id]);
      if (meta && typeof meta === 'object') {
        if (typeof meta.id !== 'string') meta.id = id;
        project.assets[id] = meta;
      }
    }
  }
  // Format v2 has no persisted allocators, but the current legacy assignment
  // path already uses project-local asset IDs. Lift only a valid live counter
  // above restored aN keys; allocation itself still rejects stale documents.
  if (project.allocators && Number.isSafeInteger(project.allocators.asset)
      && project.allocators.asset >= 0) {
    let highest = 0;
    for (const id of Object.keys(project.assets)) {
      const match = /^a([1-9][0-9]*)$/.exec(id);
      if (!match) continue;
      const suffix = Number(match[1]);
      if (Number.isSafeInteger(suffix)) highest = Math.max(highest, suffix);
    }
    project.allocators.asset = Math.max(project.allocators.asset, highest);
  }

  runtime.repairs.length = 0;
  if (Array.isArray(json.repairs)) {
    for (const repair of json.repairs) runtime.repairs.push(clone(repair));
  }

  // WIRE settings merge into the existing object (the controller closes over
  // it). Saves from before the WIRE slice simply lack the key: defaults stay.
  if (json.wire && typeof json.wire === 'object' && project.wire) {
    const w = project.wire;
    w.inId = typeof json.wire.inId === 'string' ? json.wire.inId : null;
    w.outId = typeof json.wire.outId === 'string' ? json.wire.outId : null;
    w.clockOut = json.wire.clockOut === true;
    if (Number.isFinite(json.wire.noteBase)) w.noteBase = Math.max(0, Math.min(119, json.wire.noteBase | 0));
    for (const key of Object.keys(w.mappings)) delete w.mappings[key];
    if (json.wire.mappings && typeof json.wire.mappings === 'object') {
      for (const key of Object.keys(json.wire.mappings)) {
        const m = json.wire.mappings[key];
        if (m && typeof m === 'object') w.mappings[key] = clone(m);
      }
    }
  }

  const sampleAttachments = [];
  for (let s = 0; s < machine.scenes.length; s++) {
    const tracks = machine.scenes[s].tracks;
    for (let t = 0; t < tracks.length; t++) {
      const id = tracks[t].sampleId;
      if (id && project.assets[id]) sampleAttachments.push({ sceneIndex: s, trackIndex: t, assetId: id });
    }
  }

  return {
    fileName: project.fileName,
    needsAnalysis: !!(json.sourceBytes && json.sourceBytes.size > 0),
    anchors: json.anchors != null ? clone(json.anchors) : null,
    sampleAttachments,
  };
}

// OPFS adapter under 'yellowjacket-v1'. Names are at most one directory deep
// ('samples/a1.f32'); the subdirectory is created on write. open() returns null
// wherever the main-thread write path is missing — notably Safari before
// FileSystemFileHandle.createWritable (the sync-access-handle fallback is
// deliberately out of this slice; the bench just does not persist there).
export class OpfsStore {
  constructor(root, dir) {
    this._root = root;
    this._dir = dir;
  }

  static async open() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
      if (typeof FileSystemFileHandle === 'undefined'
        || typeof FileSystemFileHandle.prototype.createWritable !== 'function') return null;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR_NAME, { create: true });
      return new OpfsStore(root, dir);
    } catch (e) {
      return null;
    }
  }

  async _locate(name, create) {
    const parts = String(name).split('/');
    if (parts.length === 1 && parts[0]) return { dir: this._dir, base: parts[0] };
    if (parts.length === 2 && parts[0] && parts[1]) {
      const sub = await this._dir.getDirectoryHandle(parts[0], { create });
      return { dir: sub, base: parts[1] };
    }
    throw new Error('OpfsStore: bad name "' + name + '" (at most one "/", no empty segments)');
  }

  async writeBytes(name, arrayBuffer) {
    const { dir, base } = await this._locate(name, true);
    const handle = await dir.getFileHandle(base, { create: true });
    const writable = await handle.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();
  }

  async readBytes(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      const handle = await dir.getFileHandle(base);
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async writeJson(name, obj) {
    await this.writeBytes(name, new TextEncoder().encode(JSON.stringify(obj)));
  }

  async readJson(name) {
    const bytes = await this.readBytes(name);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async has(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      await dir.getFileHandle(base);
      return true;
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return false;
      throw e;
    }
  }

  async remove(name) {
    try {
      const { dir, base } = await this._locate(name, false);
      await dir.removeEntry(base);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;
      throw e;
    }
  }

  async wipe() {
    try {
      await this._root.removeEntry(DIR_NAME, { recursive: true });
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
    }
    this._dir = await this._root.getDirectoryHandle(DIR_NAME, { create: true });
  }
}
