/**
 * Export settings validation, defaults, filename handling and range resolution.
 *
 * Nothing here touches the DOM/WebCodecs so it can be used by the dialog for
 * live estimates and by the engine for authoritative validation.
 */
import type { ExportSettings, FrameRate, Sequence } from '@/types';
import { sequenceDurationFrames, frameToSeconds } from '@/utils/time';
import { fpsOf, isDropFrame } from '@/utils/time';
import { ExportValidationError, type ExportContainer, type ExportRange } from './types';

export const MIN_EXPORT_BITRATE = 200_000;
export const MAX_EXPORT_BITRATE = 120_000_000;
export const MIN_AUDIO_BITRATE = 32_000;
export const MAX_AUDIO_BITRATE = 512_000;
export const MIN_EXPORT_WIDTH = 32;
export const MAX_EXPORT_WIDTH = 7680;
export const MIN_EXPORT_HEIGHT = 32;
export const MAX_EXPORT_HEIGHT = 4320;
export const MAX_FILE_NAME_LENGTH = 120;

export const DEFAULT_AUDIO_SAMPLE_RATE = 48_000;

/** H.264 / most players require even dimensions; MP4 also wants >= 2. */
export function evenDimension(value: number, min: number, max: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  const clamped = Math.min(max, Math.max(min, rounded));
  return clamped % 2 === 0 ? clamped : clamped + 1 > max ? clamped - 1 : clamped + 1;
}

export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Suggested bitrate for a resolution/frame rate pair (bits per second). */
export function suggestedVideoBitrate(width: number, height: number, frameRate: FrameRate, factor = 0.15): number {
  const fps = Math.max(1, fpsOf(frameRate));
  const raw = width * height * fps * factor;
  return Math.round(clampNumber(raw, MIN_EXPORT_BITRATE, MAX_EXPORT_BITRATE, 8_000_000));
}

/** The frame-rate presets the dialog offers, seeded with the sequence value. */
export function createDefaultExportSettings(sequence: Sequence): ExportSettings {
  const width = evenDimension(sequence.width, MIN_EXPORT_WIDTH, MAX_EXPORT_WIDTH);
  const height = evenDimension(sequence.height, MIN_EXPORT_HEIGHT, MAX_EXPORT_HEIGHT);
  const frameRate: FrameRate = { ...sequence.frameRate };
  const audioSampleRate = [44100, 48000, 96000].includes(sequence.audioSampleRate)
    ? sequence.audioSampleRate
    : DEFAULT_AUDIO_SAMPLE_RATE;
  return {
    fileName: `${(sequence.name || 'Sequence').trim()} export`,
    width,
    height,
    frameRate,
    videoCodec: 'h264',
    videoBitrate: suggestedVideoBitrate(width, height, frameRate),
    audioEnabled: true,
    audioSampleRate,
    audioBitrate: 192_000,
    range: 'entire',
  };
}

/** Strip characters that are invalid in file names on common platforms. */
export function sanitizeBaseName(name: string, fallback = 'Sequence export'): string {
  const cleaned = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  const safe = cleaned.slice(0, MAX_FILE_NAME_LENGTH).trim();
  return safe || fallback;
}

export function fileExtensionFor(container: ExportContainer): '.mp4' | '.webm' {
  return container === 'webm' ? '.webm' : '.mp4';
}

/** Append the correct container extension (replacing a wrong/stale one). */
export function buildExportFileName(baseName: string, container: ExportContainer, fallback?: string): string {
  let base = sanitizeBaseName(baseName, fallback);
  // Strip any known media extension the user typed so the container wins.
  base = base.replace(/\.(mp4|m4v|mov|webm)$/i, '').trim() || sanitizeBaseName(fallback ?? 'Sequence export');
  return `${base}${fileExtensionFor(container)}`;
}

function isFrameRateValid(frameRate: FrameRate): boolean {
  return (
    Number.isFinite(frameRate.num) &&
    Number.isFinite(frameRate.den) &&
    frameRate.num > 0 &&
    frameRate.den > 0 &&
    frameRate.num / frameRate.den >= 1 &&
    frameRate.num / frameRate.den <= 240
  );
}

/**
 * Validate and normalize user settings. Throws {@link ExportValidationError}
 * for problems that cannot be repaired (e.g. invalid frame rate).
 */
export function normalizeExportSettings(settings: ExportSettings, sequence: Sequence): ExportSettings {
  if (!settings) throw new ExportValidationError('Export settings are missing.');
  const width = evenDimension(settings.width, MIN_EXPORT_WIDTH, MAX_EXPORT_WIDTH);
  const height = evenDimension(settings.height, MIN_EXPORT_HEIGHT, MAX_EXPORT_HEIGHT);
  if (width < MIN_EXPORT_WIDTH || height < MIN_EXPORT_HEIGHT || width > MAX_EXPORT_WIDTH || height > MAX_EXPORT_HEIGHT) {
    throw new ExportValidationError(`Unsupported export resolution: ${settings.width} × ${settings.height}.`);
  }
  if (!isFrameRateValid(settings.frameRate)) {
    throw new ExportValidationError('Export frame rate is invalid.');
  }
  const audioSampleRate = clampNumber(
    Math.round(settings.audioSampleRate),
    8_000,
    192_000,
    sequence.audioSampleRate || DEFAULT_AUDIO_SAMPLE_RATE,
  );
  return {
    fileName: sanitizeBaseName(settings.fileName, `${sequence.name || 'Sequence'} export`),
    width,
    height,
    frameRate: { ...settings.frameRate },
    videoCodec: settings.videoCodec === 'vp9' ? 'vp9' : 'h264',
    videoBitrate: Math.round(
      clampNumber(settings.videoBitrate, MIN_EXPORT_BITRATE, MAX_EXPORT_BITRATE, suggestedVideoBitrate(width, height, settings.frameRate)),
    ),
    audioEnabled: Boolean(settings.audioEnabled),
    audioSampleRate,
    audioBitrate: Math.round(clampNumber(settings.audioBitrate, MIN_AUDIO_BITRATE, MAX_AUDIO_BITRATE, 192_000)),
    range: settings.range === 'in-out' ? 'in-out' : 'entire',
    rangeInFrame:
      settings.rangeInFrame === undefined || !Number.isFinite(settings.rangeInFrame)
        ? undefined
        : Math.max(0, Math.round(settings.rangeInFrame)),
    rangeOutFrame:
      settings.rangeOutFrame === undefined || !Number.isFinite(settings.rangeOutFrame)
        ? undefined
        : Math.max(0, Math.round(settings.rangeOutFrame)),
  };
}

/**
 * Resolve the user-selected range into integer sequence frames.
 *
 * `rangeInFrame` is inclusive, `rangeOutFrame` is exclusive — matching the
 * project-wide convention used by source-monitor in/out marks
 * (`timeline-store.insertSourceRange`).
 */
export function resolveExportRange(sequence: Sequence, settings: ExportSettings): ExportRange {
  const sequenceFrames = sequenceDurationFrames(sequence);
  if (sequenceFrames <= 0) {
    throw new ExportValidationError('The sequence is empty. Add clips to the timeline before exporting.');
  }
  const frameRate = sequence.frameRate;
  if (settings.range === 'in-out') {
    const inFrame = Math.round(settings.rangeInFrame ?? NaN);
    const outFrame = Math.round(settings.rangeOutFrame ?? NaN);
    if (!Number.isFinite(inFrame) || !Number.isFinite(outFrame)) {
      throw new ExportValidationError('The In–Out export range is incomplete. Set both In and Out marks.');
    }
    const startFrame = Math.min(Math.max(0, inFrame), sequenceFrames - 1);
    const endFrameExclusive = Math.min(sequenceFrames, Math.max(startFrame + 1, outFrame));
    const totalFrames = endFrameExclusive - startFrame;
    return {
      mode: 'in-out',
      startFrame,
      endFrameExclusive,
      totalFrames,
      durationSeconds: frameToSeconds(totalFrames, frameRate),
    };
  }
  return {
    mode: 'entire',
    startFrame: 0,
    endFrameExclusive: sequenceFrames,
    totalFrames: sequenceFrames,
    durationSeconds: frameToSeconds(sequenceFrames, frameRate),
  };
}

/** Number of output frames for a range at the chosen output frame rate. */
export function outputFrameCount(range: ExportRange, frameRate: FrameRate): number {
  const fps = Math.max(1, fpsOf(frameRate));
  return Math.max(1, Math.round(range.durationSeconds * fps));
}

/**
 * Approximate output size from configured bitrates and duration. This is
 * explicitly an estimate — containers and encoder rate control add overhead.
 */
export function estimateOutputBytes(
  settings: Pick<ExportSettings, 'videoBitrate' | 'audioBitrate' | 'audioEnabled'>,
  range: Pick<ExportRange, 'durationSeconds'>,
): number {
  const audioBits = settings.audioEnabled ? Math.max(0, settings.audioBitrate) : 0;
  const totalBits = (Math.max(0, settings.videoBitrate) + audioBits) * Math.max(0, range.durationSeconds);
  return Math.round(totalBits / 8);
}

/** Human readable export descriptor used by the dialog footer and toasts. */
export function describeExportFormat(width: number, height: number, frameRate: FrameRate): string {
  const fps = isDropFrame(frameRate) ? frameRate.label : `${Math.round(fpsOf(frameRate))}`;
  return `${width}×${height} · ${fps} fps`;
}
