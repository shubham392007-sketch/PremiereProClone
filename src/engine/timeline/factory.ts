import type {
  AudioProperties,
  Bin,
  FrameRate,
  MediaAsset,
  NewProjectConfig,
  Project,
  Sequence,
  TimelineClip,
  Track,
  VideoTransform,
} from '@/types';
import { PROJECT_SCHEMA_VERSION } from '@/types';
import { createId } from '@/utils/id';
import { secondsToFrame } from '@/utils/time';

export const DEFAULT_VIDEO_TRACK_COUNT = 3;
export const DEFAULT_AUDIO_TRACK_COUNT = 3;
export const DEFAULT_VIDEO_TRACK_HEIGHT = 62;
export const DEFAULT_AUDIO_TRACK_HEIGHT = 52;
export const IMAGE_CLIP_SECONDS = 5;

export function makeFrameRate(num: number, den = 1, label?: string): FrameRate {
  return { num, den, label: label ?? (den === 1 ? String(num) : (num / den).toFixed(2)) };
}

export function defaultTransform(): VideoTransform {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
}

export function defaultAudioProps(): AudioProperties {
  return { gain: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0 };
}

export function makeVideoTrack(index: number, patch: Partial<Track> = {}): Track {
  return {
    id: createId('vtrack'),
    kind: 'video',
    name: `V${index + 1}`,
    index,
    height: DEFAULT_VIDEO_TRACK_HEIGHT,
    locked: false,
    muted: false,
    hidden: false,
    solo: false,
    enabled: true,
    ...patch,
  };
}

export function makeAudioTrack(index: number, patch: Partial<Track> = {}): Track {
  return {
    id: createId('atrack'),
    kind: 'audio',
    name: `A${index + 1}`,
    index,
    height: DEFAULT_AUDIO_TRACK_HEIGHT,
    locked: false,
    muted: false,
    hidden: false,
    solo: false,
    enabled: true,
    ...patch,
  };
}

export function createSequence(config: NewProjectConfig): Sequence {
  const tracks: Track[] = [];
  for (let i = 0; i < DEFAULT_VIDEO_TRACK_COUNT; i++) tracks.push(makeVideoTrack(i));
  for (let i = 0; i < DEFAULT_AUDIO_TRACK_COUNT; i++) tracks.push(makeAudioTrack(i));
  return {
    id: createId('seq'),
    name: config.sequenceName || 'Sequence 01',
    width: config.width,
    height: config.height,
    frameRate: config.frameRate,
    audioSampleRate: config.audioSampleRate,
    colorSpace: config.colorSpace,
    previewQuality: config.previewQuality,
    tracks,
    clips: [],
    markers: [],
  };
}

export function createProject(config: NewProjectConfig, seedBins: boolean = true): Project {
  const now = Date.now();
  const sequence = createSequence(config);
  const bins: Bin[] = seedBins
    ? [
        { id: createId('bin'), name: 'Video', parentId: null, createdAt: now },
        { id: createId('bin'), name: 'Audio', parentId: null, createdAt: now },
        { id: createId('bin'), name: 'Graphics', parentId: null, createdAt: now },
      ]
    : [];
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId('proj'),
    name: config.name || 'Untitled Project',
    createdAt: now,
    updatedAt: now,
    sequences: [sequence],
    activeSequenceId: sequence.id,
    bins,
    media: [],
    previewQuality: config.previewQuality,
    workspace: {
      timelinePixelsPerSecond: 60,
      timelineScrollLeft: 0,
      timelineScrollTop: 0,
      leftTab: 'project',
      timelineHeightPct: 40,
      leftPanelWidthPct: 22,
    },
  };
}

export function findSequence(project: Project, sequenceId?: string | null): Sequence | undefined {
  return project.sequences.find((s) => s.id === (sequenceId ?? project.activeSequenceId));
}

export function activeSequence(project: Project): Sequence {
  const seq = findSequence(project);
  if (!seq) return project.sequences[0];
  return seq;
}

/** Default clip length in sequence frames for a media asset. */
export function defaultClipDurationFrames(asset: MediaAsset, frameRate: FrameRate): number {
  if (asset.kind === 'image') {
    return Math.max(1, Math.round(IMAGE_CLIP_SECONDS * (frameRate.num / frameRate.den)));
  }
  return Math.max(1, secondsToFrame(asset.durationSec, frameRate));
}

/** Frame offset into the source media where a newly dropped clip should begin. */
export function defaultSourceInFrame(asset: MediaAsset, frameRate: FrameRate): number {
  if (asset.kind === 'image') return 0;
  return 0;
}

export function makeClip(params: {
  mediaId: string;
  trackId: string;
  startFrame: number;
  durationFrames: number;
  sourceInFrame?: number;
  color: string;
  name?: string;
  playbackRate?: number;
  linkedClipId?: string | null;
}): TimelineClip {
  return {
    id: createId('clip'),
    mediaId: params.mediaId,
    trackId: params.trackId,
    startFrame: Math.max(0, Math.round(params.startFrame)),
    durationFrames: Math.max(1, Math.round(params.durationFrames)),
    sourceInFrame: Math.max(0, Math.round(params.sourceInFrame ?? 0)),
    playbackRate: params.playbackRate ?? 1,
    enabled: true,
    transform: defaultTransform(),
    audio: defaultAudioProps(),
    color: params.color,
    name: params.name,
    linkedClipId: params.linkedClipId ?? null,
  };
}
