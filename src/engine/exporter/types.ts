/**
 * Public types for the timeline export engine.
 *
 * The exporter renders the *edited sequence composite* (tracks, trims,
 * transforms, gaps, audio mix) into a real encoded media file. Timing is
 * expressed in sequence frames everywhere except where the browser media APIs
 * require seconds or microseconds.
 */
import type { ExportProgress, FrameRate } from '@/types';

/** Callbacks supplied by the UI. All progress is derived from real work. */
export interface ExportCallbacks {
  /** Called with real processed frame counts / work phase. */
  onProgress?: (progress: ExportProgress) => void;
  /** Non-fatal problems (offline media, codec fallbacks, dropped frames...). */
  onWarning?: (message: string) => void;
  /** Polled frequently by the engine; return true to abort the export. */
  shouldCancel?: () => boolean;
}

export type ExportContainer = 'mp4' | 'webm';
export type ExportVideoCodec = 'h264' | 'vp9' | 'vp8';
export type ExportAudioCodec = 'aac' | 'opus';
export type ExportFallback = 'none' | 'webm-mediaRecorder';

/** Resolved export range: `endFrameExclusive` follows the project-wide convention. */
export interface ExportRange {
  mode: 'entire' | 'in-out';
  /** first sequence frame included in the export */
  startFrame: number;
  /** first sequence frame *not* included in the export */
  endFrameExclusive: number;
  totalFrames: number;
  durationSeconds: number;
}

/** Outcome of a successful export. `blob` contains the rendered media file. */
export interface ExportResult {
  blob: Blob;
  /** sanitized file name including the container extension */
  fileName: string;
  mimeType: string;
  container: ExportContainer;
  videoCodec: ExportVideoCodec;
  audioCodec: ExportAudioCodec | null;
  width: number;
  height: number;
  frameRate: FrameRate;
  /** number of frames actually rendered/encoded */
  totalFrames: number;
  durationSeconds: number;
  sizeBytes: number;
  fallback: ExportFallback;
  warnings: string[];
  usedRange: ExportRange;
}

/** Browser capability report used by the export dialog. */
export interface ExportCapabilities {
  /** true when WebCodecs VideoEncoder exists and at least one video codec config works */
  webCodecs: boolean;
  videoEncoder: boolean;
  audioEncoder: boolean;
  h264: boolean;
  vp9: boolean;
  aac: boolean;
  opus: boolean;
  mediaRecorder: boolean;
  /** selected H.264 codec string (e.g. avc1.4d0028), null when unsupported */
  h264Codec: string | null;
  /** selected VP9 codec string (e.g. vp09.00.10.08), null when unsupported */
  vp9Codec: string | null;
  /** set by an export run when it had to fall back to MediaRecorder */
  fallbackUsed?: ExportFallback;
  /** true when at least one export path (WebCodecs MP4 or MediaRecorder WebM) works */
  canExport: boolean;
  /** human readable capability warnings for the dialog */
  warnings: string[];
}

export type ExportErrorCode =
  | 'cancelled'
  | 'capability'
  | 'validation'
  | 'render'
  | 'encode'
  | 'muxer'
  | 'unknown';

/** Base class for all exporter failures. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(message: string, code: ExportErrorCode = 'unknown') {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

/** Thrown when the user cancels an in-flight export. */
export class ExportCancelledError extends ExportError {
  constructor(message = 'Export cancelled.') {
    super(message, 'cancelled');
    this.name = 'ExportCancelledError';
  }
}

/** Thrown when the browser cannot provide any usable export path. */
export class ExportCapabilityError extends ExportError {
  constructor(message: string) {
    super(message, 'capability');
    this.name = 'ExportCapabilityError';
  }
}

/** Thrown when export settings / range are invalid. */
export class ExportValidationError extends ExportError {
  constructor(message: string) {
    super(message, 'validation');
    this.name = 'ExportValidationError';
  }
}

export function toExportError(error: unknown, fallbackMessage: string, code: ExportErrorCode = 'unknown'): ExportError {
  if (error instanceof ExportError) return error;
  if (error instanceof Error) return new ExportError(`${fallbackMessage} ${error.message}`.trim(), code);
  return new ExportError(fallbackMessage, code);
}

export function isExportCancelledError(error: unknown): boolean {
  return error instanceof ExportCancelledError || (error instanceof ExportError && error.code === 'cancelled');
}

export function isExportCapabilityError(error: unknown): boolean {
  return error instanceof ExportCapabilityError || (error instanceof ExportError && error.code === 'capability');
}

export function isExportValidationError(error: unknown): boolean {
  return error instanceof ExportValidationError || (error instanceof ExportError && error.code === 'validation');
}
