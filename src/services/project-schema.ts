/**
 * Project document validation / normalisation / migration.
 *
 * Every project stored in IndexedDB is validated on read. Missing optional
 * fields are backfilled with defaults (so older schema versions keep opening)
 * while structurally invalid data throws a descriptive error instead of
 * silently corrupting the editor.
 */
import type {
  FrameRate,
  MediaAsset,
  MediaKind,
  Project,
  ProjectSummary,
  Sequence,
  TimelineClip,
  Track,
  WorkspaceState,
} from '@/types';
import { PROJECT_SCHEMA_VERSION } from '@/types';
import { createId } from '@/utils/id';
import { makeFrameRate } from '@/engine/timeline/factory';

const DEFAULT_FRAME_RATE: FrameRate = makeFrameRate(30, 1, '30');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = numberOr(value, fallback);
  return Math.max(1, Math.round(n));
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.round(numberOr(value, fallback)));
}

function normalizeFrameRate(value: unknown): FrameRate {
  if (isObject(value) && typeof value.num === 'number' && typeof value.den === 'number' && value.num > 0 && value.den > 0) {
    const num = Math.round(value.num);
    const den = Math.round(value.den);
    const label = typeof value.label === 'string' ? value.label : (num / den).toFixed(2).replace(/\.00$/, '');
    return { num, den, label };
  }
  return { ...DEFAULT_FRAME_RATE };
}

function normalizeWorkspace(value: unknown): WorkspaceState {
  const w = isObject(value) ? value : {};
  const validTabs = ['project', 'media', 'effects', 'history'];
  return {
    timelinePixelsPerSecond: Math.min(4000, Math.max(2, numberOr(w.timelinePixelsPerSecond, 60))),
    timelineScrollLeft: Math.max(0, numberOr(w.timelineScrollLeft, 0)),
    timelineScrollTop: Math.max(0, numberOr(w.timelineScrollTop, 0)),
    leftTab: validTabs.includes(String(w.leftTab)) ? (w.leftTab as WorkspaceState['leftTab']) : 'project',
    timelineHeightPct: Math.min(75, Math.max(20, numberOr(w.timelineHeightPct, 40))),
    leftPanelWidthPct: Math.min(40, Math.max(14, numberOr(w.leftPanelWidthPct, 22))),
  };
}

function normalizeTransform(value: unknown) {
  const t = isObject(value) ? value : {};
  return {
    x: numberOr(t.x, 0),
    y: numberOr(t.y, 0),
    scale: Math.max(0.01, numberOr(t.scale, 1)),
    rotation: numberOr(t.rotation, 0),
    opacity: Math.min(1, Math.max(0, numberOr(t.opacity, 1))),
  };
}

function normalizeAudio(value: unknown) {
  const a = isObject(value) ? value : {};
  return {
    gain: Math.min(2, Math.max(0, numberOr(a.gain, 1))),
    muted: Boolean(a.muted ?? false),
    fadeInFrames: nonNegativeInt(a.fadeInFrames, 0),
    fadeOutFrames: nonNegativeInt(a.fadeOutFrames, 0),
  };
}

function normalizeMedia(value: unknown): MediaAsset | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  if (kind !== 'video' && kind !== 'audio' && kind !== 'image') return null;
  const id = typeof value.id === 'string' ? value.id : createId('media');
  return {
    id,
    name: typeof value.name === 'string' && value.name ? value.name : 'Untitled media',
    fileName: typeof value.fileName === 'string' ? value.fileName : '',
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : '',
    kind: kind as MediaKind,
    sizeBytes: nonNegativeInt(value.sizeBytes, 0),
    durationSec: Math.max(0, numberOr(value.durationSec, 0)),
    width: nonNegativeInt(value.width, 0),
    height: nonNegativeInt(value.height, 0),
    fps: value.fps ? normalizeFrameRate(value.fps) : null,
    hasAudio: Boolean(value.hasAudio),
    thumbnailDataUrl: typeof value.thumbnailDataUrl === 'string' ? value.thumbnailDataUrl : undefined,
    waveformPeaks: Array.isArray(value.waveformPeaks)
      ? value.waveformPeaks.filter((p): p is number => typeof p === 'number').slice(0, 4000)
      : undefined,
    storageKey: typeof value.storageKey === 'string' ? value.storageKey : '',
    importedAt: numberOr(value.importedAt, Date.now()),
    missing: Boolean(value.missing),
    binId: typeof value.binId === 'string' ? value.binId : null,
  };
}

function normalizeTrack(value: unknown, kind: 'video' | 'audio', fallbackIndex: number): Track | null {
  if (!isObject(value)) return null;
  const trackKind = value.kind === 'audio' || value.kind === 'video' ? value.kind : kind;
  return {
    id: typeof value.id === 'string' ? value.id : createId('track'),
    kind: trackKind,
    name: typeof value.name === 'string' ? value.name : `${trackKind === 'video' ? 'V' : 'A'}${fallbackIndex + 1}`,
    index: nonNegativeInt(value.index, fallbackIndex),
    height: Math.min(200, Math.max(28, numberOr(value.height, trackKind === 'video' ? 62 : 52))),
    locked: Boolean(value.locked),
    muted: Boolean(value.muted),
    hidden: Boolean(value.hidden),
    solo: Boolean(value.solo),
    enabled: value.enabled !== false,
  };
}

function normalizeClip(value: unknown, validTracks: Set<string>): TimelineClip | null {
  if (!isObject(value)) return null;
  if (typeof value.mediaId !== 'string' || typeof value.trackId !== 'string') return null;
  if (!validTracks.has(value.trackId)) return null;
  return {
    id: typeof value.id === 'string' ? value.id : createId('clip'),
    mediaId: value.mediaId,
    trackId: value.trackId,
    startFrame: nonNegativeInt(value.startFrame, 0),
    durationFrames: positiveInt(value.durationFrames, 1),
    sourceInFrame: nonNegativeInt(value.sourceInFrame, 0),
    playbackRate: Math.min(8, Math.max(0.1, numberOr(value.playbackRate, 1))),
    enabled: value.enabled !== false,
    transform: normalizeTransform(value.transform),
    audio: normalizeAudio(value.audio),
    color: typeof value.color === 'string' ? value.color : '#33587f',
    name: typeof value.name === 'string' ? value.name : undefined,
    linkedClipId: typeof value.linkedClipId === 'string' ? value.linkedClipId : null,
  };
}

function normalizeSequence(value: unknown): Sequence {
  if (!isObject(value)) throw new Error('Sequence data is invalid.');
  const rawTracks = Array.isArray(value.tracks) ? value.tracks : [];
  const videoTracks: Track[] = [];
  const audioTracks: Track[] = [];
  rawTracks.forEach((raw, i) => {
    const t = normalizeTrack(raw, isObject(raw) && raw.kind === 'audio' ? 'audio' : 'video', i);
    if (!t) return;
    if (t.kind === 'video') {
      t.index = videoTracks.length;
      videoTracks.push(t);
    } else {
      t.index = audioTracks.length;
      audioTracks.push(t);
    }
  });
  // Guarantee the sequence always has at least one track of each kind.
  if (!videoTracks.length) {
    videoTracks.push({
      id: createId('vtrack'),
      kind: 'video',
      name: 'V1',
      index: 0,
      height: 62,
      locked: false,
      muted: false,
      hidden: false,
      solo: false,
      enabled: true,
    });
  }
  if (!audioTracks.length) {
    audioTracks.push({
      id: createId('atrack'),
      kind: 'audio',
      name: 'A1',
      index: 0,
      height: 52,
      locked: false,
      muted: false,
      hidden: false,
      solo: false,
      enabled: true,
    });
  }
  const tracks = [...videoTracks, ...audioTracks];
  const validTracks = new Set(tracks.map((t) => t.id));
  const rawClips = Array.isArray(value.clips) ? value.clips : [];
  const clips = rawClips
    .map((c) => normalizeClip(c, validTracks))
    .filter((c): c is TimelineClip => c !== null);
  const markers = Array.isArray(value.markers)
    ? value.markers
        .filter((m): m is Record<string, unknown> => isObject(m))
        .map((m) => ({
          id: typeof m.id === 'string' ? m.id : createId('marker'),
          frame: nonNegativeInt(m.frame, 0),
          name: typeof m.name === 'string' ? m.name : 'Marker',
          color: typeof m.color === 'string' ? m.color : '#d9a33a',
        }))
    : [];

  return {
    id: typeof value.id === 'string' ? value.id : createId('seq'),
    name: typeof value.name === 'string' && value.name ? value.name : 'Sequence 01',
    width: positiveInt(value.width, 1920),
    height: positiveInt(value.height, 1080),
    frameRate: normalizeFrameRate(value.frameRate),
    audioSampleRate: [44100, 48000, 96000].includes(numberOr(value.audioSampleRate, 48000))
      ? numberOr(value.audioSampleRate, 48000)
      : 48000,
    colorSpace: value.colorSpace === 'sRGB' ? 'sRGB' : 'Rec.709',
    previewQuality:
      value.previewQuality === 'half' || value.previewQuality === 'quarter' || value.previewQuality === 'full'
        ? value.previewQuality
        : 'full',
    tracks,
    clips,
    markers,
  };
}

/**
 * Validate and normalise an arbitrary stored document into a Project.
 * Throws an Error with a user-readable message when the document is unusable.
 */
export function normalizeProject(raw: unknown): Project {
  if (!isObject(raw)) throw new Error('Project file is not a valid project document.');
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `This project was created by a newer version of the editor (schema ${raw.schemaVersion}). Update the application to open it.`,
    );
  }
  if (!Array.isArray(raw.sequences) || raw.sequences.length === 0) {
    throw new Error('Project has no sequences and cannot be opened.');
  }
  const sequences = raw.sequences.map(normalizeSequence);
  const sequenceIds = new Set(sequences.map((s) => s.id));
  const activeSequenceId =
    typeof raw.activeSequenceId === 'string' && sequenceIds.has(raw.activeSequenceId)
      ? raw.activeSequenceId
      : sequences[0].id;
  const media = Array.isArray(raw.media)
    ? raw.media.map(normalizeMedia).filter((m): m is MediaAsset => m !== null)
    : [];
  const mediaIds = new Set(media.map((m) => m.id));
  // Drop clips referencing missing media rather than crashing on playback.
  for (const seq of sequences) {
    seq.clips = seq.clips.filter((clip) => mediaIds.has(clip.mediaId));
  }
  const bins = Array.isArray(raw.bins)
    ? raw.bins
        .filter((b): b is Record<string, unknown> => isObject(b))
        .map((b) => ({
          id: typeof b.id === 'string' ? b.id : createId('bin'),
          name: typeof b.name === 'string' && b.name ? b.name : 'Bin',
          parentId: typeof b.parentId === 'string' ? b.parentId : null,
          createdAt: numberOr(b.createdAt, Date.now()),
        }))
    : [];
  const binIds = new Set(bins.map((b) => b.id));
  for (const m of media) {
    if (m.binId && !binIds.has(m.binId)) m.binId = null;
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId('proj'),
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled Project',
    createdAt: numberOr(raw.createdAt, Date.now()),
    updatedAt: numberOr(raw.updatedAt, Date.now()),
    sequences,
    activeSequenceId,
    bins,
    media,
    workspace: normalizeWorkspace(raw.workspace),
    previewQuality:
      raw.previewQuality === 'half' || raw.previewQuality === 'quarter' || raw.previewQuality === 'full'
        ? raw.previewQuality
        : 'full',
  };
}

export function projectSummary(project: Project): ProjectSummary {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0];
  const thumb = project.media.find((m) => m.thumbnailDataUrl)?.thumbnailDataUrl;
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    width: seq?.width ?? 1920,
    height: seq?.height ?? 1080,
    frameRate: seq?.frameRate ?? DEFAULT_FRAME_RATE,
    thumbnailDataUrl: thumb,
    mediaCount: project.media.length,
  };
}

/**
 * Deep duplicate of a project document with freshly generated identity for the
 * project, media entries, bins, sequences, tracks, clips and markers. Media
 * blobs are shared by storage key (not copied) to keep duplication cheap.
 */
export function duplicateProjectDocument(project: Project): Project {
  const copy = structuredClone(project);
  copy.id = createId('proj');
  copy.name = `${project.name} copy`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();

  const mediaMap = new Map<string, string>();
  copy.media = copy.media.map((asset) => {
    const next = { ...asset, id: createId('media') };
    mediaMap.set(asset.id, next.id);
    return next;
  });

  const binMap = new Map<string, string>();
  copy.bins = copy.bins.map((bin) => {
    const next = { ...bin, id: createId('bin') };
    binMap.set(bin.id, next.id);
    return next;
  });
  for (const bin of copy.bins) {
    if (bin.parentId && binMap.has(bin.parentId)) bin.parentId = binMap.get(bin.parentId)!;
  }
  for (const asset of copy.media) {
    if (asset.binId && binMap.has(asset.binId)) asset.binId = binMap.get(asset.binId)!;
    if (!asset.binId) asset.binId = null;
  }

  const sequenceMap = new Map<string, string>();
  copy.sequences = copy.sequences.map((sequence) => {
    const next: Sequence = structuredClone(sequence);
    next.id = createId('seq');
    next.name = `${sequence.name} copy`;
    sequenceMap.set(sequence.id, next.id);

    const trackMap = new Map<string, string>();
    next.tracks = next.tracks.map((track) => {
      const newTrack = { ...track, id: createId('track') };
      trackMap.set(track.id, newTrack.id);
      return newTrack;
    });

    const clipMap = new Map<string, string>();
    next.clips = next.clips.map((clip) => {
      const newClip: TimelineClip = {
        ...structuredClone(clip),
        id: createId('clip'),
        trackId: trackMap.get(clip.trackId) ?? clip.trackId,
        mediaId: mediaMap.get(clip.mediaId) ?? clip.mediaId,
        linkedClipId: null,
      };
      clipMap.set(clip.id, newClip.id);
      return newClip;
    });
    next.clips.forEach((clip, i) => {
      const sourceLinked = sequence.clips[i]?.linkedClipId;
      if (sourceLinked) clip.linkedClipId = clipMap.get(sourceLinked) ?? null;
    });
    next.markers = next.markers.map((marker) => ({ ...marker, id: createId('marker') }));
    return next;
  });

  copy.activeSequenceId = sequenceMap.get(project.activeSequenceId) ?? copy.sequences[0].id;
  copy.workspace = { ...copy.workspace, timelineScrollLeft: 0, timelineScrollTop: 0 };
  return copy;
}
