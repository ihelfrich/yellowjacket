// Yellowjacket MACHINE — ClipRef model + clip audition path (BEATMAP slice).
// ClipRefs are immutable spans into the ORIGINAL source timeline; edits create
// new ClipRefs. No PCM is ever copied here: audition plays the source buffer
// through offset/duration on an AudioBufferSourceNode.

// Keep the public page's static preload graph stable until Task 12 activates
// these primitives. The allocator is still the one canonical project-store
// implementation; this inactive module resolves it before exposing behavior.
const [{ allocateProjectId }, { SOURCE_ID_RE }] = await Promise.all([
  import('../app/project-store.js'),
  import('../app/source-registry.js'),
]);

const LABEL_MAX = 24;        // chars before the label is cut and ellipsized
const FADE = 0.003;          // s, equal-power fade at clip edges (click guard)
const CURVE_N = 32;          // samples per fade curve
const START_DELAY = 0.005;   // s, scheduling headroom so automation lands cleanly

let clipCounter = 0;

// Equal-power crossfade shape: sin/cos quarter-cycle, in^2 + out^2 = 1.
// Built once at unity: auditions play at unity, so there is no second shape.
const FADE_IN_UNIT = buildCurve(false);
const FADE_OUT_UNIT = buildCurve(true);

function buildCurve(out) {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) {
    const x = (i / (CURVE_N - 1)) * (Math.PI / 2);
    c[i] = out ? Math.cos(x) : Math.sin(x);
  }
  return c;
}

function nextId() {
  clipCounter += 1;
  return 'c' + clipCounter;
}

// After a RESUME the counter restarts at zero while restored clips keep their
// saved ids; advance past them so a new clip cannot collide (clipdelete filters
// by id and would silently drop both).
export function advanceClipCounter(clips) {
  for (const clip of clips || []) {
    const m = /^c(\d+)$/.exec(clip && clip.id ? clip.id : '');
    if (m) clipCounter = Math.max(clipCounter, Number(m[1]));
  }
}

export function makeClip(start, end, tag, label) {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  return { id: nextId(), start: a, end: b, tag, label };
}

function jsonCopy(value, label = 'value') {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError();
    return JSON.parse(encoded);
  } catch {
    throw new TypeError(`Clip ${label} is not JSON-safe`);
  }
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function knownSource(project, sourceId) {
  return project && typeof project === 'object' && project.sources
    && typeof project.sources === 'object' && !Array.isArray(project.sources)
    && typeof sourceId === 'string' && SOURCE_ID_RE.test(sourceId)
    && Object.prototype.hasOwnProperty.call(project.sources, sourceId)
    && project.sources[sourceId] && typeof project.sources[sourceId] === 'object'
    && !Array.isArray(project.sources[sourceId]) && project.sources[sourceId].id === sourceId;
}

function validateSpan(start, end) {
  if (!validTime(start) || !validTime(end) || end <= start) {
    throw new RangeError('Clip span is invalid');
  }
}

function generatorCopy(generator) {
  if (generator === undefined) return undefined;
  const copy = jsonCopy(generator, 'generator');
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)
      || typeof copy.kind !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(copy.kind)
      || !Number.isSafeInteger(copy.version) || copy.version <= 0
      || typeof copy.runId !== 'string' || !copy.runId.length
      || new TextEncoder().encode(copy.runId).byteLength > 255
      || Object.keys(copy).some((key) => !['kind', 'version', 'runId'].includes(key))) {
    throw new TypeError('Clip generator is invalid');
  }
  return copy;
}

function snapshotClipInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Clip input is invalid');
  }
  const snapshot = {
    sourceId: input.sourceId,
    start: input.start,
    end: input.end,
  };
  for (const key of ['tag', 'label', 'score', 'features', 'createdAt', 'generator']) {
    const value = input[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function finalizeClipInput(project, input) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.clips)) {
    throw new TypeError('Clip project is invalid');
  }
  const snapshot = snapshotClipInput(input);
  if (!knownSource(project, snapshot.sourceId)) throw new TypeError('Clip source is unknown');
  validateSpan(snapshot.start, snapshot.end);
  const clip = { sourceId: snapshot.sourceId, start: snapshot.start, end: snapshot.end };
  for (const key of ['tag', 'label']) {
    if (snapshot[key] !== undefined) {
      if (typeof snapshot[key] !== 'string') throw new TypeError(`Clip ${key} is invalid`);
      clip[key] = snapshot[key];
    }
  }
  if (snapshot.score !== undefined) {
    if (!Number.isFinite(snapshot.score)) throw new TypeError('Clip score is invalid');
    clip.score = snapshot.score;
  }
  if (snapshot.features !== undefined) clip.features = jsonCopy(snapshot.features, 'features');
  if (snapshot.createdAt !== undefined) {
    if (!(snapshot.createdAt === null || (Number.isSafeInteger(snapshot.createdAt)
        && Math.abs(snapshot.createdAt) <= 8.64e15))) {
      throw new TypeError('Clip createdAt is invalid');
    }
    clip.createdAt = snapshot.createdAt;
  }
  const generator = generatorCopy(snapshot.generator);
  if (generator) clip.generator = generator;
  return clip;
}

function clipWithId(id, finalized) {
  return { id, ...finalized };
}

function rollbackClipCounter(project, before, issued) {
  if (!issued) return;
  if (!project.allocators || project.allocators.clip !== before + issued) {
    throw new Error('Clip allocator changed during rollback');
  }
  project.allocators.clip = before;
}

function rollbackAppends(atlas, beforeLength, count, lengthDescriptor) {
  for (let index = beforeLength; index < beforeLength + count; index++) {
    if (!Reflect.deleteProperty(atlas, String(index))) {
      throw new Error('Clip Atlas append rollback failed');
    }
  }
  if (atlas.length !== beforeLength
      && !Reflect.defineProperty(atlas, 'length', { ...lengthDescriptor, value: beforeLength })) {
    throw new Error('Clip Atlas length rollback failed');
  }
}

function appendFinalizedClips(project, finalizedClips, expectedIds = null) {
  const atlas = project && project.clips;
  if (!Array.isArray(atlas) || !Array.isArray(finalizedClips)) {
    throw new TypeError('Clip Atlas append is invalid');
  }
  if (!finalizedClips.length) return [];
  const beforeLength = atlas.length;
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(atlas, 'length');
  if (!lengthDescriptor || lengthDescriptor.writable === false || !Reflect.isExtensible(atlas)) {
    throw new TypeError('Clip Atlas cannot append');
  }
  const beforeCounter = project.allocators && project.allocators.clip;
  const clips = [];
  let issued = 0;
  try {
    for (const finalized of finalizedClips) {
      const id = allocateProjectId(project, 'clip');
      issued++;
      clips.push(clipWithId(id, finalized));
    }
    if (expectedIds && clips.some((clip, index) => clip.id !== expectedIds[index])) {
      throw new Error('Clip allocation changed during preparation');
    }
    for (const clip of clips) atlas.push(clip);
    return clips;
  } catch (error) {
    let rollbackError = null;
    try {
      rollbackAppends(atlas, beforeLength, clips.length, lengthDescriptor);
      rollbackClipCounter(project, beforeCounter, issued);
    } catch (caught) {
      rollbackError = caught;
    }
    if (rollbackError) throw new AggregateError([error, rollbackError], 'Clip append and rollback failed');
    throw error;
  }
}

export function createClipRef(project, input) {
  const finalized = finalizeClipInput(project, input);
  return appendFinalizedClips(project, [finalized])[0];
}

export function wordsToClip(project, sourceId, words, i0, i1) {
  if (!knownSource(project, sourceId) || !Array.isArray(words) || !words.length
      || !Number.isSafeInteger(i0) || !Number.isSafeInteger(i1)) {
    throw new TypeError('Clip word selection is invalid');
  }
  const lo = Math.max(0, Math.min(i0, i1));
  const hi = Math.min(words.length - 1, Math.max(i0, i1));
  if (lo > hi) throw new RangeError('Clip word selection is empty');
  const parts = [];
  for (let i = lo; i <= hi; i++) {
    const word = words[i];
    if (!word || typeof word !== 'object' || typeof word.text !== 'string'
        || !validTime(word.start) || !validTime(word.end) || word.end <= word.start) {
      throw new TypeError('Clip word is invalid');
    }
    parts.push(word.text);
  }
  let label = parts.join(' ');
  if (label.length > LABEL_MAX) {
    label = label.slice(0, LABEL_MAX).replace(/\s+$/, '') + '…';
  }
  return createClipRef(project, {
    sourceId, start: words[lo].start, end: words[hi].end, tag: 'word', label,
  });
}

export function clipsForSource(project, sourceId) {
  if (!project || !Array.isArray(project.clips)) return [];
  return project.clips.filter((clip) => clip && clip.sourceId === sourceId);
}

export function clipReferences(project, clipId) {
  if (!project || !project.assets || typeof project.assets !== 'object') return [];
  const references = [];
  const seen = new Set();
  for (const [key, asset] of Object.entries(project.assets)) {
    const provenance = asset && asset.provenance;
    if (!provenance || provenance.kind !== 'source-clip' || provenance.binding !== 'project'
        || provenance.clipId !== clipId) continue;
    const match = typeof asset.id === 'string' && /^a([1-9][0-9]*)$/.exec(asset.id);
    const id = match && Number.isSafeInteger(Number(match[1])) ? asset.id : key;
    if (!seen.has(id)) {
      seen.add(id);
      references.push(id);
    }
  }
  return references;
}

export function replaceClipBounds(project, oldId, nextBounds) {
  if (!project || !Array.isArray(project.clips) || typeof oldId !== 'string'
      || !nextBounds || typeof nextBounds !== 'object') {
    throw new TypeError('Clip replacement is invalid');
  }
  const matches = [];
  for (let index = 0; index < project.clips.length; index++) {
    if (project.clips[index] && project.clips[index].id === oldId) matches.push(index);
  }
  if (matches.length !== 1) throw new RangeError('Clip replacement target is not unique');
  validateSpan(nextBounds.start, nextBounds.end);
  const index = matches[0];
  const old = project.clips[index];
  if (!knownSource(project, old.sourceId)) throw new TypeError('Clip source is unknown');
  if (old.start === nextBounds.start && old.end === nextBounds.end) {
    return { kind: 'unchanged', clip: old };
  }
  const references = clipReferences(project, oldId);
  if (references.length) return { kind: 'blocked', clipId: oldId, references };
  const input = snapshotClipInput(old);
  input.start = nextBounds.start;
  input.end = nextBounds.end;
  const finalized = finalizeClipInput(project, input);
  const descriptor = Reflect.getOwnPropertyDescriptor(project.clips, String(index));
  if (!descriptor || descriptor.writable === false) throw new TypeError('Clip Atlas cannot replace');
  const beforeCounter = project.allocators && project.allocators.clip;
  let issued = 0;
  try {
    const replacement = clipWithId(allocateProjectId(project, 'clip'), finalized);
    issued = 1;
    if (!Reflect.set(project.clips, String(index), replacement)) {
      throw new TypeError('Clip Atlas cannot replace');
    }
    return { kind: 'replaced', oldId, clip: replacement };
  } catch (error) {
    let rollbackError = null;
    try {
      if (!Reflect.defineProperty(project.clips, String(index), descriptor)) {
        throw new Error('Clip Atlas replacement rollback failed');
      }
      rollbackClipCounter(project, beforeCounter, issued);
    } catch (caught) {
      rollbackError = caught;
    }
    if (rollbackError) throw new AggregateError([error, rollbackError], 'Clip replacement and rollback failed');
    throw error;
  }
}

function checkedProduct(a, b, label) {
  const value = a * b;
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} frame coordinate is unsafe`);
  }
  return value;
}

export function extractClipAsset(decoded, clip, { maxSeconds = 30, transforms = [] } = {}) {
  const buffer = decoded && decoded.buffer;
  if (!buffer || !Number.isSafeInteger(buffer.sampleRate) || buffer.sampleRate <= 0
      || !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels <= 0
      || !Number.isSafeInteger(buffer.length) || buffer.length < 0 || !clip || typeof clip !== 'object') {
    throw new TypeError('Decoded clip source is invalid');
  }
  validateSpan(clip.start, clip.end);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || Object.is(maxSeconds, -0)) {
    throw new RangeError('Clip extraction cap is invalid');
  }
  const naturalStart = Math.floor(checkedProduct(clip.start, buffer.sampleRate, 'start'));
  const naturalEnd = Math.ceil(checkedProduct(clip.end, buffer.sampleRate, 'end'));
  const capFrames = Math.floor(checkedProduct(maxSeconds, buffer.sampleRate, 'cap'));
  if (!Number.isSafeInteger(capFrames) || capFrames <= 0) throw new RangeError('Clip extraction cap is empty');
  const startFrame = Math.min(Math.max(naturalStart, 0), buffer.length);
  const endFrame0 = Math.min(Math.max(naturalEnd, startFrame), buffer.length);
  if (startFrame > Number.MAX_SAFE_INTEGER - capFrames) throw new RangeError('Clip extraction end is unsafe');
  const endFrame = Math.min(endFrame0, startFrame + capFrames);
  const frames = endFrame - startFrame;
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new RangeError('Clip extraction is empty');
  const channels = [];
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
    const source = buffer.getChannelData(channelIndex);
    if (!source || source.length !== buffer.length) throw new TypeError('Decoded channel is invalid');
    const channel = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) channel[frame] = source[startFrame + frame];
    channels.push(channel);
  }
  return {
    sample: {
      sampleRate: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
      frames,
      channels,
    },
    sourceSpan: { start: clip.start, end: clip.end },
    extraction: {
      startFrame, endFrame, sampleRate: buffer.sampleRate, channelCount: buffer.numberOfChannels,
    },
    transforms: jsonCopy(transforms, 'transforms'),
  };
}

function copiedSample(sample) {
  if (!sample || typeof sample !== 'object' || !Number.isSafeInteger(sample.sampleRate)
      || sample.sampleRate <= 0 || !Number.isSafeInteger(sample.channelCount) || sample.channelCount <= 0
      || !Number.isSafeInteger(sample.frames) || sample.frames < 0 || !Array.isArray(sample.channels)
      || sample.channels.length !== sample.channelCount) throw new TypeError('Prepared sample is invalid');
  return {
    sampleRate: sample.sampleRate,
    channelCount: sample.channelCount,
    frames: sample.frames,
    channels: sample.channels.map((source) => {
      if (!source || source.length !== sample.frames) throw new TypeError('Prepared channel is invalid');
      const channel = new Float32Array(sample.frames);
      for (let frame = 0; frame < sample.frames; frame++) channel[frame] = source[frame];
      return channel;
    }),
  };
}

function deepFreezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export async function prepareClipAsset(project, clip, extraction, options = {}) {
  if (!extraction || typeof extraction !== 'object' || !extraction.extraction
      || !extraction.sourceSpan || !Array.isArray(extraction.transforms)) {
    throw new TypeError('Clip extraction preparation is invalid');
  }
  // Everything caller-owned is detached before hashing yields. Metadata must
  // describe the same snapshot as the owned PCM even if the caller mutates its
  // clip, extraction, or options while the digest is pending.
  const clipSnapshot = jsonCopy(clip, 'clip');
  const sourceSpan = jsonCopy(extraction.sourceSpan, 'source span');
  const frameInfo = jsonCopy(extraction.extraction, 'extraction metadata');
  const extractionTransforms = jsonCopy(extraction.transforms, 'extraction transforms');
  const optionSnapshot = jsonCopy(options, 'options');
  if (!clipSnapshot || typeof clipSnapshot !== 'object' || Array.isArray(clipSnapshot)
      || !sourceSpan || typeof sourceSpan !== 'object' || Array.isArray(sourceSpan)
      || !frameInfo || typeof frameInfo !== 'object' || Array.isArray(frameInfo)
      || !Array.isArray(extractionTransforms) || !optionSnapshot
      || typeof optionSnapshot !== 'object' || Array.isArray(optionSnapshot)) {
    throw new TypeError('Clip extraction preparation is invalid');
  }
  const sample = copiedSample(extraction.sample);
  const matches = Array.isArray(project && project.clips)
    ? project.clips.filter((entry) => entry && entry.id === clipSnapshot.id) : [];
  if (matches.length !== 1 || matches[0].sourceId !== clipSnapshot.sourceId
      || matches[0].start !== clipSnapshot.start || matches[0].end !== clipSnapshot.end
      || !knownSource(project, clipSnapshot.sourceId)) throw new TypeError('Prepared clip is not project-bound');
  if (frameInfo.sampleRate !== sample.sampleRate || frameInfo.channelCount !== sample.channelCount
      || frameInfo.endFrame - frameInfo.startFrame !== sample.frames
      || sourceSpan.start !== clipSnapshot.start || sourceSpan.end !== clipSnapshot.end) {
    throw new TypeError('Clip extraction metadata is inconsistent');
  }
  const buffer = optionSnapshot.buffer === undefined ? 'original' : optionSnapshot.buffer;
  if (buffer !== 'original' && buffer !== 'repaired') throw new TypeError('Clip buffer selector is invalid');
  const optionTransforms = optionSnapshot.transforms === undefined
    ? [] : optionSnapshot.transforms;
  if (!Array.isArray(extractionTransforms) || !Array.isArray(optionTransforms)) {
    throw new TypeError('Clip transforms are invalid');
  }
  if (extractionTransforms.concat(optionTransforms)
    .some((transform) => transform && transform.kind === 'spectral-repair-stack')) {
    throw new TypeError('Spectral repair provenance must match the repaired buffer');
  }
  const transforms = [];
  if (buffer === 'repaired') {
    if (!Array.isArray(optionSnapshot.repairStack) || !optionSnapshot.repairStack.length
        || !optionSnapshot.repairStack.some((repair) => repair && repair.enabled === true)) {
      throw new TypeError('Repaired clip stack is invalid');
    }
    transforms.push({
      schemaVersion: 1,
      kind: 'spectral-repair-stack',
      repairs: optionSnapshot.repairStack,
    });
  }
  transforms.push(...extractionTransforms, ...optionTransforms);
  const { describeSamplePayload, validateAssetProvenance } = await import('../app/sample-payload.js');
  const described = await describeSamplePayload(sample);
  if (!described) throw new TypeError('Prepared PCM is invalid');
  const meta = {
    kind: 'sample',
    label: optionSnapshot.label === undefined
      ? (typeof clipSnapshot.label === 'string' ? clipSnapshot.label : 'SAMPLE') : optionSnapshot.label,
    sampleRate: sample.sampleRate,
    channelCount: sample.channelCount,
    frames: sample.frames,
    payload: { byteLength: described.byteLength, sha256: described.sha256 },
    provenance: {
      kind: 'source-clip',
      binding: 'project',
      sourceId: clipSnapshot.sourceId,
      clipId: clipSnapshot.id,
      sourceSpan: { start: clipSnapshot.start, end: clipSnapshot.end },
      extraction: {
        startFrame: frameInfo.startFrame,
        endFrame: frameInfo.endFrame,
        sampleRate: sample.sampleRate,
        channelCount: sample.channelCount,
        buffer,
      },
      transforms,
    },
  };
  if (typeof meta.label !== 'string') throw new TypeError('Prepared label is invalid');
  if (optionSnapshot.role !== undefined) {
    if (typeof optionSnapshot.role !== 'string') throw new TypeError('Prepared role is invalid');
    meta.role = optionSnapshot.role;
  }
  if (!validateAssetProvenance(project, meta).ok) {
    throw new TypeError('Prepared project provenance is invalid');
  }
  deepFreezeJson(meta);
  return { meta, sample, bytes: described.bytes.slice() };
}

export function planGeneratedClipReplacement(project, { sourceId, generator } = {}) {
  if (!knownSource(project, sourceId) || !Array.isArray(project.clips)) {
    throw new TypeError('Generated replacement source is invalid');
  }
  const next = generatorCopy(generator);
  const removeClipIds = [];
  for (const clip of project.clips) {
    const prior = clip && clip.generator;
    if (!prior || typeof clip.id !== 'string' || clip.sourceId !== sourceId
        || prior.kind !== next.kind || prior.version !== next.version || prior.runId === next.runId) continue;
    try {
      generatorCopy(prior);
    } catch {
      continue;
    }
    if (!clipReferences(project, clip.id).length) removeClipIds.push(clip.id);
  }
  return { removeClipIds };
}

function generatedInput(sourceId, pick, generator) {
  if (!pick || typeof pick !== 'object') throw new TypeError('HARVEST pick is invalid');
  const start = pick.t0 === undefined ? pick.start : pick.t0;
  const end = pick.t1 === undefined ? pick.end : pick.t1;
  const input = {
    sourceId, start, end, generator,
    tag: pick.role === undefined ? pick.tag : pick.role,
    label: pick.label,
    score: pick.score,
    features: pick.features,
  };
  for (const key of ['tag', 'label', 'score', 'features']) if (input[key] === undefined) delete input[key];
  return input;
}

function applyGain(sample, gain) {
  return {
    sampleRate: sample.sampleRate,
    channelCount: sample.channelCount,
    frames: sample.frames,
    channels: sample.channels.map((source) => {
      const channel = new Float32Array(source.length);
      for (let frame = 0; frame < source.length; frame++) channel[frame] = source[frame] * gain;
      return channel;
    }),
  };
}

export async function prepareHarvestRun(project, decoded, picks, options = {}) {
  const pickSnapshots = jsonCopy(picks, 'HARVEST picks');
  const optionSnapshot = jsonCopy(options, 'HARVEST options');
  if (!Array.isArray(pickSnapshots) || !optionSnapshot
      || typeof optionSnapshot !== 'object' || Array.isArray(optionSnapshot)) {
    throw new TypeError('HARVEST picks are invalid');
  }
  const sourceId = optionSnapshot.sourceId;
  const generator = generatorCopy({
    kind: 'harvest',
    version: optionSnapshot.generatorVersion === undefined ? 1 : optionSnapshot.generatorVersion,
    runId: optionSnapshot.runId,
  });
  if (generator.version !== 1 || !knownSource(project, sourceId)) {
    throw new TypeError('HARVEST generator is invalid');
  }
  const inputs = pickSnapshots.map((pick) => generatedInput(sourceId, pick, generator));
  const finalized = inputs.map((input) => finalizeClipInput(project, input));
  const extractions = finalized.map((clip) => extractClipAsset(decoded, clip));
  for (const extraction of extractions) {
    for (const channel of extraction.sample.channels) {
      for (const value of channel) if (!Number.isFinite(value)) throw new TypeError('HARVEST PCM is invalid');
    }
  }
  const removeClipIds = planGeneratedClipReplacement(project, { sourceId, generator }).removeClipIds;
  const startingAllocator = project.allocators.clip;
  const startingClips = project.clips.slice();
  const preview = {
    ...project,
    allocators: { ...project.allocators },
    clips: project.clips.slice(),
  };
  const previewClips = appendFinalizedClips(preview, finalized);
  const { peakOfChannels, kitGainFor } = await import('../analysis/harvest.js');
  const preparedAssets = [];
  for (let index = 0; index < previewClips.length; index++) {
    const extraction = extractions[index];
    const computedGain = optionSnapshot.level === false
      ? 1 : kitGainFor(peakOfChannels(extraction.sample.channels));
    // PCM is Float32. A multiplier which rounds to unity cannot change the
    // authoritative samples and therefore is not a truthful transform.
    const gain = Math.fround(computedGain) === 1 ? 1 : computedGain;
    const transformed = {
      ...extraction,
      sample: applyGain(extraction.sample, gain),
    };
    const gainTransforms = gain === 1 ? [] : [{ schemaVersion: 1, kind: 'linear-gain', gain }];
    preparedAssets.push(await prepareClipAsset(preview, previewClips[index], transformed, {
      label: previewClips[index].label,
      role: previewClips[index].tag,
      buffer: optionSnapshot.buffer === undefined ? 'original' : optionSnapshot.buffer,
      repairStack: optionSnapshot.repairStack === undefined ? [] : optionSnapshot.repairStack,
      transforms: gainTransforms,
    }));
  }
  if (project.allocators.clip !== startingAllocator || project.clips.length !== startingClips.length
      || project.clips.some((clip, index) => clip !== startingClips[index])) {
    throw new Error('Project clips changed during HARVEST preparation');
  }
  const clips = appendFinalizedClips(project, finalized, previewClips.map((clip) => clip.id));
  return { clips, preparedAssets, removeClipIds };
}

export function planAssetReachability(machine, { sceneIndex, trackIndex, nextSampleId } = {}) {
  if (!machine || !Array.isArray(machine.scenes) || !Number.isSafeInteger(sceneIndex)
      || !Number.isSafeInteger(trackIndex) || sceneIndex < 0 || trackIndex < 0
      || !machine.scenes[sceneIndex] || !Array.isArray(machine.scenes[sceneIndex].tracks)
      || !machine.scenes[sceneIndex].tracks[trackIndex]
      || !(nextSampleId === null || (typeof nextSampleId === 'string' && nextSampleId.length))) {
    throw new TypeError('Asset reachability change is invalid');
  }
  const beforeIds = [];
  const beforeSeen = new Set();
  for (const scene of machine.scenes) {
    if (!scene || !Array.isArray(scene.tracks)) continue;
    for (const track of scene.tracks) {
      const id = track && track.sampleId;
      if (typeof id === 'string' && id.length && !beforeSeen.has(id)) {
        beforeSeen.add(id);
        beforeIds.push(id);
      }
    }
  }
  const afterIds = [];
  const seen = new Set();
  for (let s = 0; s < machine.scenes.length; s++) {
    const scene = machine.scenes[s];
    if (!scene || !Array.isArray(scene.tracks)) continue;
    for (let t = 0; t < scene.tracks.length; t++) {
      const id = s === sceneIndex && t === trackIndex ? nextSampleId : scene.tracks[t] && scene.tracks[t].sampleId;
      if (typeof id === 'string' && id.length && !seen.has(id)) {
        seen.add(id);
        afterIds.push(id);
      }
    }
  }
  const afterSet = new Set(afterIds);
  return { beforeIds, afterIds, removeCurrentIds: beforeIds.filter((id) => !afterSet.has(id)) };
}

export function snapToBeat(t, beats, toleranceSec = 0.08) {
  if (!beats || !beats.length) return t;
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = t;
  let bestDist = Infinity;
  if (lo < beats.length && Math.abs(beats[lo] - t) < bestDist) {
    bestDist = Math.abs(beats[lo] - t);
    best = beats[lo];
  }
  if (lo > 0 && Math.abs(beats[lo - 1] - t) < bestDist) {
    bestDist = Math.abs(beats[lo - 1] - t);
    best = beats[lo - 1];
  }
  return bestDist <= toleranceSec ? best : t;
}


export class ClipAuditioner {
  // One-shot audition path riding the engine's context and master bus.
  // Does not own an AudioContext: before the engine's first user-gesture
  // play there is no context, and play() is a silent no-op.
  constructor(engine) {
    this._engine = engine;
    this._voice = null;   // { src, fadeGain, stopGain }
  }

  play(clip, { rate = 1 } = {}) {
    const ctx = this._engine.ctx;
    const master = this._engine.master;
    const buffer = this._engine.buffer;
    if (!clip || !ctx || !master || !buffer) return;

    this.stop();
    if (ctx.state === 'suspended') ctx.resume();

    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const start = Math.min(Math.max(clip.start, 0), buffer.duration);
    const end = Math.min(Math.max(clip.end, 0), buffer.duration);
    const span = end - start;
    if (span <= 0) return;

    const outDur = span / r;   // output-time length; automation runs in output time
    const fade = Math.min(FADE, Math.max(outDur / 2 - 0.0002, 0));
    // Audition plays a clip at unity. Per-instrument level lives on the
    // track (gainDb); a ClipRef is a span, not a mix setting.

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = r;

    // Inner gain carries the scheduled edge fades; outer gain stays free of
    // automation so a manual stop ramp can never overlap a value curve
    // (setValueCurveAtTime rejects events inside its interval).
    const fadeGain = ctx.createGain();
    const stopGain = ctx.createGain();
    src.connect(fadeGain);
    fadeGain.connect(stopGain);
    stopGain.connect(master);

    const t0 = ctx.currentTime + START_DELAY;
    if (fade > 0) {
      fadeGain.gain.value = 0;
      fadeGain.gain.setValueCurveAtTime(FADE_IN_UNIT, t0, fade);
      fadeGain.gain.setValueCurveAtTime(FADE_OUT_UNIT, t0 + outDur - fade, fade);
    } else {
      fadeGain.gain.value = 1;
    }

    const voice = { src, fadeGain, stopGain };
    src.onended = () => {
      releaseVoice(voice);
      if (this._voice === voice) this._voice = null;
    };
    src.start(t0, start, span);
    this._voice = voice;
  }

  stop() {
    const voice = this._voice;
    this._voice = null;
    if (!voice) return;
    const ctx = this._engine.ctx;
    voice.src.onended = () => releaseVoice(voice);
    if (ctx && ctx.state !== 'closed') {
      const now = ctx.currentTime;
      voice.stopGain.gain.setValueCurveAtTime(FADE_OUT_UNIT, now, FADE);
      try { voice.src.stop(now + FADE + 0.001); } catch (e) { /* not started or already stopped */ }
    } else {
      try { voice.src.stop(); } catch (e) { /* not started or already stopped */ }
      releaseVoice(voice);
    }
  }
}

function releaseVoice(voice) {
  voice.src.onended = null;
  try { voice.src.disconnect(); } catch (e) { /* already disconnected */ }
  try { voice.fadeGain.disconnect(); } catch (e) { /* already disconnected */ }
  try { voice.stopGain.disconnect(); } catch (e) { /* already disconnected */ }
}
