// Pure JSON-safe source registry. This module intentionally knows nothing about
// browser views, decoded audio, storage handles, or the active-session facade.

export const SOURCE_ID_RE = /^sha256:[0-9a-f]{64}$/;

export const VALIDATION_LIMITS = Object.freeze({
  projectJsonBytes: 16 * 1024 * 1024,
  sources: 256,
  clips: 65536,
  aliases: 16,
  zipEntries: 1024,
  expandedBytes: 768 * 1024 * 1024,
  sourceBytes: 250 * 1024 * 1024,
});

const MAX_DATE_MS = 8.64e15;
const ORIGIN_KINDS = new Set(['file', 'url', 'demo', 'field', 'generated']);
const RIGHTS_BASES = new Set([
  'unknown', 'original-recording', 'public-domain', 'licensed', 'permission', 'fair-use-review',
]);
const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const EXTENSION_RE = /^[a-z0-9]{1,16}$/;

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function jsonCopy(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function codePoints(value) {
  return Array.from(value).length;
}

function isBoundedName(value) {
  return typeof value === 'string' && value.length > 0
    && value === value.trim() && codePoints(value) <= 255 && utf8Bytes(value) <= 1024;
}

function isNullableBoundedText(value, maxBytes) {
  return value === null || (typeof value === 'string' && utf8Bytes(value) <= maxBytes);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isDateTimestamp(value) {
  return Number.isSafeInteger(value) && value >= -MAX_DATE_MS && value <= MAX_DATE_MS;
}

function issueList() {
  const issues = [];
  return { issues, add: (issue) => issues.push(issue) };
}

function normalizedHttpUrl(value) {
  if (typeof value !== 'string' || utf8Bytes(value) > 4096) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    url.hash = '';
    const href = url.href;
    return utf8Bytes(href) <= 4096 ? href : null;
  } catch {
    return null;
  }
}

function sourceIdFrom(value) {
  return isObject(value) && typeof value.id === 'string' ? value.id : null;
}

function validateDocument(document, add) {
  if (!isObject(document)) {
    add('document');
    return;
  }
  if (!(document.words === null || Array.isArray(document.words))) add('document.words');
  if (!isObject(document.transcript) || !Array.isArray(document.transcript.gapCuts)) add('document.transcript');
  if (!Array.isArray(document.chain)) add('document.chain');
  if (!Array.isArray(document.repairs)) add('document.repairs');
  if (!isObject(document.anchors)) add('document.anchors');
  else {
    for (const key of ['bpm', 'barOneTime']) {
      const value = document.anchors[key];
      if (!(value === null || (typeof value === 'number' && Number.isFinite(value)))) {
        add('document.anchors.' + key);
      }
    }
  }
}

function validateAliases(aliases, add) {
  if (!Array.isArray(aliases) || aliases.length > VALIDATION_LIMITS.aliases) {
    add('aliases');
    return;
  }
  const seen = new Set();
  for (const alias of aliases) {
    if (!isBoundedName(alias) || seen.has(alias)) add('aliases');
    seen.add(alias);
  }
}

function validateOrigin(origin, add) {
  if (!isObject(origin) || !ORIGIN_KINDS.has(origin.kind)) {
    add('origin.kind');
    return;
  }
  if (origin.kind === 'url') {
    const normalized = normalizedHttpUrl(origin.url);
    if (!normalized || normalized !== origin.url) add('origin.url');
  } else if (origin.url !== null) {
    add('origin.url');
  }
}

function validatePayload(payload, add) {
  if (!isObject(payload)) {
    add('payload');
    return;
  }
  if (!isPositiveSafeInteger(payload.byteLength) || payload.byteLength > VALIDATION_LIMITS.sourceBytes) {
    add('payload.byteLength');
  }
  if (!(payload.mediaType === null || (typeof payload.mediaType === 'string'
      && utf8Bytes(payload.mediaType) <= 127 && MIME_RE.test(payload.mediaType)))) {
    add('payload.mediaType');
  }
  if (!(payload.extension === null || (typeof payload.extension === 'string'
      && EXTENSION_RE.test(payload.extension)))) {
    add('payload.extension');
  }
}

function validateAudio(audio, add) {
  if (!isObject(audio)) {
    add('audio');
    return;
  }
  for (const key of ['sampleRate', 'channelCount', 'frames']) {
    if (!isPositiveSafeInteger(audio[key])) add('audio.' + key);
  }
}

function validateRights(rights, add) {
  if (!isObject(rights) || !RIGHTS_BASES.has(rights.basis)) {
    add('rights.basis');
    return;
  }
  if (!isNullableBoundedText(rights.license, 2048)) add('rights.license');
  if (!isNullableBoundedText(rights.attribution, 2048)) add('rights.attribution');
  if (!isNullableBoundedText(rights.notes, 8192)) add('rights.notes');
}

export function createSourceDocument(chainDefaults) {
  const chain = jsonCopy(Array.isArray(chainDefaults) ? chainDefaults : []);
  return {
    words: null,
    transcript: { gapCuts: [] },
    chain: chain || [],
    repairs: [],
    anchors: { bpm: null, barOneTime: null },
  };
}

export function validateSourceRecord(record) {
  const { issues, add } = issueList();
  if (!isObject(record)) return { ok: false, issues: ['record'] };
  if (!SOURCE_ID_RE.test(record.id)) add('id');
  if (!isBoundedName(record.displayName)) add('displayName');
  validateAliases(record.aliases, add);
  if (!isDateTimestamp(record.addedAt)) add('addedAt');
  validateOrigin(record.origin, add);
  validatePayload(record.payload, add);
  validateAudio(record.audio, add);
  validateRights(record.rights, add);
  validateDocument(record.document, add);
  return issues.length ? { ok: false, issues } : { ok: true };
}

export function createSourceRecord(input) {
  if (!isObject(input)) return null;
  const record = jsonCopy(input);
  if (!record) return null;
  if (typeof record.displayName === 'string') record.displayName = record.displayName.trim();
  if (Array.isArray(record.aliases)) {
    // Imported arrays are bounded before aliases are normalized. Otherwise an
    // untrusted 17-item array of repeated values could evade the import limit.
    if (record.aliases.length > VALIDATION_LIMITS.aliases) return null;
    const aliases = [];
    const seen = new Set();
    for (const rawAlias of record.aliases) {
      const alias = typeof rawAlias === 'string' ? rawAlias.trim() : rawAlias;
      if (!seen.has(alias)) aliases.push(alias);
      seen.add(alias);
    }
    record.aliases = aliases;
  }
  if (isObject(record.origin) && record.origin.kind === 'url') {
    const url = normalizedHttpUrl(record.origin.url);
    if (url) record.origin.url = url;
  }
  return validateSourceRecord(record).ok ? record : null;
}

export function sourceEntryName(sourceId) {
  return SOURCE_ID_RE.test(sourceId) ? 'sources/' + sourceId.slice('sha256:'.length) + '.bin' : null;
}

export function validateSourceGraph(project) {
  const { issues, add } = issueList();
  if (!isObject(project) || !isObject(project.sources)) return { ok: false, issues: ['sources'] };
  const entries = Object.entries(project.sources);
  if (entries.length > VALIDATION_LIMITS.sources) add('sources');
  if (entries.length === 0) {
    if (project.activeSourceId !== null) add('activeSourceId');
  } else if (!SOURCE_ID_RE.test(project.activeSourceId) || !project.sources[project.activeSourceId]) {
    add('activeSourceId');
  }
  for (const [id, record] of entries) {
    if (id !== sourceIdFrom(record)) add('sources.' + id + '.id');
    const validation = validateSourceRecord(record);
    if (!validation.ok) add('sources.' + id);
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}

function invalid(kind, sourceId, issues) {
  return { kind, sourceId: SOURCE_ID_RE.test(sourceId) ? sourceId : null, issues };
}

export function addSource(project, record) {
  const sourceId = sourceIdFrom(record);
  const graph = validateSourceGraph(project);
  const validation = validateSourceRecord(record);
  if (!graph.ok || !validation.ok) return invalid('invalid', sourceId, [
    ...(graph.ok ? [] : graph.issues), ...(validation.ok ? [] : validation.issues),
  ]);
  if (project.sources[record.id]) return { kind: 'duplicate', sourceId: record.id };
  if (Object.keys(project.sources).length >= VALIDATION_LIMITS.sources) {
    return invalid('invalid', record.id, ['sources']);
  }
  project.sources[record.id] = jsonCopy(record);
  if (project.activeSourceId === null) project.activeSourceId = record.id;
  return { kind: 'added', sourceId: record.id };
}

export function addSourceAlias(project, sourceId, displayName) {
  const graph = validateSourceGraph(project);
  if (!graph.ok) return invalid('invalid', sourceId, graph.issues);
  if (!SOURCE_ID_RE.test(sourceId) || !project.sources[sourceId]) {
    return invalid('invalid', sourceId, ['sourceId']);
  }
  const alias = typeof displayName === 'string' ? displayName.trim() : displayName;
  if (!isBoundedName(alias)) return invalid('invalid', sourceId, ['displayName']);
  const aliases = project.sources[sourceId].aliases;
  if (aliases.includes(alias)) return { kind: 'present', sourceId };
  if (aliases.length >= VALIDATION_LIMITS.aliases) return { kind: 'full', sourceId };
  aliases.push(alias);
  return { kind: 'added', sourceId };
}

export function sourceReferences(project, sourceId) {
  const references = { clips: [], assets: [], plans: [] };
  if (!isObject(project) || !SOURCE_ID_RE.test(sourceId)) return references;
  if (Array.isArray(project.clips)) {
    for (const clip of project.clips) {
      if (isObject(clip) && clip.sourceId === sourceId && typeof clip.id === 'string') references.clips.push(clip.id);
    }
  }
  if (isObject(project.assets)) {
    for (const [assetId, asset] of Object.entries(project.assets)) {
      if (isObject(asset) && isObject(asset.provenance) && asset.provenance.binding === 'project'
          && asset.provenance.sourceId === sourceId) {
        references.assets.push(typeof asset.id === 'string' ? asset.id : assetId);
      }
    }
  }
  const plans = isObject(project.loom) && isObject(project.loom.plans) ? project.loom.plans : {};
  for (const [planId, plan] of Object.entries(plans)) {
    const source = isObject(plan) && isObject(plan.source) ? plan.source : null;
    if (source && (source.id === sourceId || source.sha256 === sourceId || source.sourceId === sourceId)) {
      references.plans.push(typeof plan.id === 'string' ? plan.id : planId);
    }
  }
  return references;
}

export function removeSource(project, sourceId) {
  const graph = validateSourceGraph(project);
  if (!graph.ok) return invalid('invalid', sourceId, graph.issues);
  if (!SOURCE_ID_RE.test(sourceId)) return invalid('invalid', sourceId, ['sourceId']);
  if (!project.sources[sourceId]) return { kind: 'missing', sourceId };
  const references = sourceReferences(project, sourceId);
  if (references.clips.length || references.assets.length || references.plans.length) {
    return { kind: 'blocked', sourceId, references };
  }
  delete project.sources[sourceId];
  if (project.activeSourceId === sourceId) {
    const next = Object.values(project.sources).sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))[0];
    project.activeSourceId = next ? next.id : null;
  }
  return { kind: 'removed', sourceId };
}
