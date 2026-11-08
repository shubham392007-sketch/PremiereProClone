/**
 * Core domain types for the editor.
 *
 * Timing policy: every timeline position and duration is an integer number of
 * frames in the sequence's frame-rate. Source media durations are probe results
 * in seconds but are converted to sequence frames when a clip is created.
 * Nothing in the authoritative editing model is stored as floating seconds.
 */

export const PROJECT_SCHEMA_VERSION = 1;

export interface FrameRate {
  /** frames per second numerator, e.g. 30000 for 29.97 */
  num: number;
  /** frames per second denominator, e.g. 1001 for 29.97 */
  den: number;
  /** display label, e.g. "29.97" */
  label: string;
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  kind: MediaKind;
  sizeBytes: number;
  /** probe duration in seconds; images use 0 */
  durationSec: number;
  width: number;
  height: number;
  /** native frame rate when known */
  fps: FrameRate | null;
  hasAudio: boolean;
  /** small JPEG data URL captured at import time */
  thumbnailDataUrl?: string;
  /** normalized peaks 0..1 for waveform display */
  waveformPeaks?: number[];
  /** key into the media storage layer (OPFS or IndexedDB) */
  storageKey: string;
  importedAt: number;
  /** true when the backing blob could not be found while rehydrating */
  missing?: boolean;
  binId: string | null;
}

export interface Bin {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface VideoTransform {
  /** pixels relative to sequence center, in sequence coordinates */
  x: number;
  y: number;
  /** 1 = 100% */
  scale: number;
  /** degrees, clockwise */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

export interface AudioProperties {
  /** linear gain 0..2 */
  gain: number;
  muted: boolean;
  /** fade lengths in sequence frames */
  fadeInFrames: number;
  fadeOutFrames: number;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** 0-based index within its kind; video index 0 is V1 (bottom-most) */
  index: number;
  /** pixels */
  height: number;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  solo: boolean;
  enabled: boolean;
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  trackId: string;
  /** timeline start, inclusive, in sequence frames */
  startFrame: number;
  /** length in sequence frames */
  durationFrames: number;
  /** offset into the source media, in sequence frames */
  sourceInFrame: number;
  /** 1 = normal speed */
  playbackRate: number;
  enabled: boolean;
  transform: VideoTransform;
  audio: AudioProperties;
  color: string;
  /** optional override label; falls back to media name */
  name?: string;
  /** linked companion clip id (video/audio pairing) */
  linkedClipId?: string | null;
}

export interface Marker {
  id: string;
  frame: number;
  name: string;
  color: string;
}

export type PreviewQuality = 'full' | 'half' | 'quarter';
export type ColorSpace = 'sRGB' | 'Rec.709';

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  audioSampleRate: number;
  colorSpace: ColorSpace;
  previewQuality: PreviewQuality;
  tracks: Track[];
  clips: TimelineClip[];
  markers: Marker[];
}

export interface WorkspaceState {
  timelinePixelsPerSecond: number;
  timelineScrollLeft: number;
  timelineScrollTop: number;
  leftTab: 'project' | 'media' | 'effects' | 'history';
  timelineHeightPct: number;
  leftPanelWidthPct: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sequences: Sequence[];
  activeSequenceId: string;
  bins: Bin[];
  media: MediaAsset[];
  workspace: WorkspaceState;
  /** project-level preview quality selected at creation */
  previewQuality: PreviewQuality;
}

/** configuration produced by the New Project dialog */
export interface NewProjectConfig {
  name: string;
  sequenceName: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  audioSampleRate: number;
  colorSpace: ColorSpace;
  previewQuality: PreviewQuality;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'unsaved' | 'error';

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  width: number;
  height: number;
  frameRate: FrameRate;
  thumbnailDataUrl?: string;
  mediaCount: number;
}

export type EditorTool = 'select' | 'razor' | 'hand' | 'zoom';

export interface ExportSettings {
  fileName: string;
  width: number;
  height: number;
  frameRate: FrameRate;
  videoCodec: 'h264' | 'vp9';
  videoBitrate: number;
  audioEnabled: boolean;
  audioSampleRate: number;
  audioBitrate: number;
  range: 'entire' | 'in-out';
  rangeInFrame?: number;
  rangeOutFrame?: number;
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'encoding' | 'muxing' | 'done' | 'error' | 'cancelled';
  framesDone: number;
  totalFrames: number;
  message: string;
}

export interface NotificationItem {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
  createdAt: number;
}
