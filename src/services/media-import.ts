/**
 * Media import pipeline.
 *
 * Responsibilities:
 *  - validate dropped/selected files against the formats the browser can
 *    actually preview,
 *  - probe real metadata (duration, dimensions, native frame rate, audio
 *    presence) with HTML media/image elements,
 *  - produce a persisted thumbnail and display waveform peaks,
 *  - persist the original blob through the media storage layer and publish a
 *    runtime object URL (never persisted) for preview/playback,
 *  - create the MediaAsset in the project store,
 *  - relink offline media to a newly chosen file while keeping the media id.
 *
 * The pipeline is async and yields between stages so the UI stays responsive
 * even when a folder of large files is imported. Failures are per file: the
 * good files import and the failures are surfaced through notifications.
 */
import type { FrameRate, MediaAsset, MediaKind } from '@/types';
import { FRAME_RATE_PRESETS } from '@/utils/presets';
import { formatBytes } from '@/utils/format';
import { createId } from '@/utils/id';
import { mediaStorage } from '@/services/storage/media-storage';
import { useMediaStore } from '@/stores/media-store';
import { useProjectStore } from '@/stores/project-store';
import { notify } from '@/stores/workspace-store';
import {
  MAX_WAVEFORM_PEAKS,
  captureVideoThumbnail,
  createPlaceholderThumbnail,
  createWaveformTile,
  describeMediaError,
  extractWaveformPeaks,
  loadImageElement,
  seekMediaElement,
  thumbnailFromImageElement,
  waitForMediaEvent,
} from './thumbnail-service';

/* ------------------------------------------------------------------ */
/* Supported formats                                                   */
/* ------------------------------------------------------------------ */

export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const;
export const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'] as const;
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] as const;

const ALL_SUPPORTED_EXTENSIONS: string[] = [
  ...SUPPORTED_VIDEO_EXTENSIONS,
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_IMAGE_EXTENSIONS,
];

/** Value for an `<input type="file" accept>` attribute. */
export const MEDIA_FILE_ACCEPT = ALL_SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** Per-kind accept attribute used by the relink picker. */
export const MEDIA_ACCEPT_BY_KIND: Record<MediaKind, string> = {
  video: SUPPORTED_VIDEO_EXTENSIONS.map((ext) => `.${ext}`).join(','),
  audio: SUPPORTED_AUDIO_EXTENSIONS.map((ext) => `.${ext}`).join(','),
  image: SUPPORTED_IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(','),
};

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

export function mediaKindForFile(file: File): MediaKind | null {
  const ext = fileExtension(file.name);
  if ((SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  if ((SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return 'audio';
  if ((SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if (!ext) {
    // Extensionless files: fall back to the MIME type reported by the OS.
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('image/')) return 'image';
  }
  return null;
}

export interface FileValidation {
  ok: boolean;
  kind: MediaKind | null;
  reason?: string;
}

export function validateMediaFile(file: File): FileValidation {
  if (!file || !file.name) {
    return { ok: false, kind: null, reason: 'The dropped item is not a file.' };
  }
  if (file.size === 0) {
    return { ok: false, kind: null, reason: `"${file.name}" is empty (0 bytes).` };
  }
  const kind = mediaKindForFile(file);
  if (!kind) {
    const ext = fileExtension(file.name);
    return {
      ok: false,
      kind: null,
      reason: `Unsupported file type${ext ? ` ".${ext}"` : ''}. Supported: MP4, WebM, MOV, M4V, MP3, WAV, AAC, M4A, OGG, FLAC, PNG, JPG, JPEG, WebP, GIF, BMP, AVIF.`,
    };
  }
  return { ok: true, kind };
}

/* ------------------------------------------------------------------ */
/* Progress reporting                                                  */
/* ------------------------------------------------------------------ */

export type ImportStage =
  | 'queued'
  | 'probing'
  | 'thumbnail'
  | 'waveform'
  | 'saving'
  | 'done'
  | 'error'
  | 'skipped';

export interface ImportProgressItem {
  id: string;
  fileName: string;
  kind: MediaKind | null;
  stage: ImportStage;
  /** 0..100 */
  percent: number;
  detail?: string;
  error?: string;
  mediaId?: string;
}

export interface ImportProgressSnapshot {
  running: boolean;
  items: ImportProgressItem[];
}

export interface ImportOptions {
  /** Bin the new assets are filed into (null = no bin). */
  binId?: string | null;
  onProgress?: (snapshot: ImportProgressSnapshot) => void;
}

export interface ImportFailure {
  fileName: string;
  reason: string;
}

export interface ImportBatchResult {
  imported: MediaAsset[];
  failed: ImportFailure[];
  skipped: ImportFailure[];
}

let importRunning = false;

/* ------------------------------------------------------------------ */
/* Frame rate helpers                                                  */
/* ------------------------------------------------------------------ */

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/**
 * Convert a measured float frame rate into the editor's rational FrameRate,
 * snapping to professional presets when the measurement is close.
 */
export function frameRateFromFps(rawFps: number | null | undefined): FrameRate | null {
  if (!rawFps || !Number.isFinite(rawFps) || rawFps <= 0.5 || rawFps > 481) return null;
  let best: FrameRate | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const preset of FRAME_RATE_PRESETS) {
    const value = preset.num / preset.den;
    const delta = Math.abs(value - rawFps);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = preset;
    }
  }
  if (best && bestDelta / rawFps <= 0.02) return { ...best };
  const rounded = Math.round(rawFps * 1000);
  const divisor = gcd(rounded, 1000);
  const num = rounded / divisor;
  const den = 1000 / divisor;
  if (den > 1001) return null;
  return { num, den, label: String(Number(rawFps.toFixed(2))) };
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

type ProbeMediaKind = 'video' | 'audio';

interface VideoFrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

interface VideoFrameCallbackCapable {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ) => number;
}

function createProbeMediaElement(kind: ProbeMediaKind): HTMLMediaElement {
  const element = document.createElement(kind);
  element.preload = 'auto';
  element.muted = true;
  // 2x2, essentially transparent but still rendered: hidden display:none media
  // can be throttled by the compositor, which weakens frame-rate sampling.
  element.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
  element.setAttribute('aria-hidden', 'true');
  if (element instanceof HTMLVideoElement) {
    element.playsInline = true;
  }
  document.body.appendChild(element);
  return element;
}

function disposeProbeMediaElement(element: HTMLMediaElement): void {
  try {
    element.pause();
  } catch {
    /* not playing */
  }
  try {
    element.removeAttribute('src');
    element.load();
  } catch {
    /* ignore */
  }
  try {
    element.remove();
  } catch {
    /* ignore */
  }
}

/** Some WebM files report Infinity duration until seeked far ahead once. */
async function resolveMediaDuration(element: HTMLMediaElement): Promise<number> {
  const read = () => (Number.isFinite(element.duration) ? element.duration : Number.NaN);
  let duration = read();
  if (Number.isFinite(duration) && duration > 0.01) return duration;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      element.removeEventListener('durationchange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      const value = read();
      if (Number.isFinite(value) && value > 0.01) finish();
    };
    const timer = window.setTimeout(finish, 3000);
    element.addEventListener('durationchange', onChange);
    try {
      element.currentTime = 1e6;
    } catch {
      finish();
    }
  });
  duration = read();
  try {
    element.currentTime = 0;
  } catch {
    /* ignore */
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('The media duration could not be determined. The file may be corrupt or streamed.');
  }
  return duration;
}

/**
 * Best-effort audio track detection for a video element. Browsers do not
 * expose a reliable API, so several heuristics are combined.
 */
function detectVideoHasAudio(video: HTMLVideoElement): boolean {
  const extended = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length?: number };
  };
  let hasAudio = false;
  let hasSignal = false;
  if (typeof extended.mozHasAudio === 'boolean') {
    hasSignal = true;
    hasAudio = hasAudio || extended.mozHasAudio;
  }
  if (extended.audioTracks && typeof extended.audioTracks.length === 'number') {
    hasSignal = true;
    hasAudio = hasAudio || extended.audioTracks.length > 0;
  }
  if (typeof extended.webkitAudioDecodedByteCount === 'number') {
    hasSignal = true;
    hasAudio = hasAudio || extended.webkitAudioDecodedByteCount > 0;
  }
  try {
    const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
    if (typeof capture === 'function') {
      const stream = capture.call(video);
      hasSignal = true;
      hasAudio = hasAudio || stream.getAudioTracks().length > 0;
      for (const track of stream.getTracks()) track.stop();
    }
  } catch {
    /* captureStream can throw before the media is ready */
  }
  return hasSignal ? hasAudio : false;
}

interface PlaybackQualityCapable {
  getVideoPlaybackQuality?: () => { totalVideoFrames: number };
}

function readVideoFrameCount(video: HTMLVideoElement): number | null {
  const getter = (video as VideoFrameCallbackCapable & PlaybackQualityCapable).getVideoPlaybackQuality;
  if (typeof getter !== 'function') return null;
  try {
    const quality = getter.call(video);
    return typeof quality?.totalVideoFrames === 'number' ? quality.totalVideoFrames : null;
  } catch {
    return null;
  }
}

/**
 * Sample frames with requestVideoFrameCallback to estimate native fps. When the
 * callback is unavailable (or does not deliver enough samples) fall back to the
 * decoded-frame counters from getVideoPlaybackQuality.
 */
async function estimateVideoFrameRate(video: HTMLVideoElement): Promise<number | null> {
  const rvfc = (video as VideoFrameCallbackCapable).requestVideoFrameCallback;
  const hasFrameCounter = readVideoFrameCount(video) !== null;
  if (typeof rvfc !== 'function' && !hasFrameCounter) return null;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const startTime = duration > 2 ? Math.min(duration * 0.2, Math.max(0, duration - 1)) : 0;
  try {
    if (startTime > 0.05) await seekMediaElement(video, startTime, 4000);
    await video.play();
  } catch {
    return null;
  }
  const sampleStartMediaTime = video.currentTime;
  const framesBefore = readVideoFrameCount(video);
  const samples = await new Promise<VideoFrameMetadata[]>((resolve) => {
    const collected: VideoFrameMetadata[] = [];
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(collected);
    };
    timer = window.setTimeout(finish, 900);
    if (typeof rvfc === 'function') {
      const onFrame = (_now: number, metadata: VideoFrameMetadata) => {
        if (settled) return;
        collected.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
        if (collected.length >= 12) finish();
        else rvfc.call(video, onFrame);
      };
      rvfc.call(video, onFrame);
    }
  });
  const mediaEndTime = video.currentTime;
  const framesAfter = readVideoFrameCount(video);
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  const validRate = (measured: number | null): number | null => {
    if (measured === null || !Number.isFinite(measured)) return null;
    return measured >= 1 && measured <= 480 ? measured : null;
  };

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first && last && samples.length >= 3) {
    const frames = last.presentedFrames - first.presentedFrames;
    const seconds = last.mediaTime - first.mediaTime;
    if (frames >= 2 && seconds >= 0.08) {
      const measured = validRate(frames / seconds);
      if (measured !== null) return measured;
    }
  }
  if (framesBefore !== null && framesAfter !== null) {
    const frames = framesAfter - framesBefore;
    const seconds = mediaEndTime - sampleStartMediaTime;
    if (frames >= 2 && seconds >= 0.15) {
      const measured = validRate(frames / seconds);
      if (measured !== null) return measured;
    }
  }
  return null;
}

interface AnalyzedMedia {
  durationSec: number;
  width: number;
  height: number;
  fps: FrameRate | null;
  hasAudio: boolean;
  thumbnailDataUrl: string;
  waveformPeaks?: number[];
}

async function analyzeVideoFile(
  file: File,
  url: string,
  reportStage: (stage: ImportStage, percent: number) => void,
): Promise<AnalyzedMedia> {
  const video = createProbeMediaElement('video') as HTMLVideoElement;
  try {
    video.src = url;
    reportStage('probing', 16);
    await waitForMediaEvent(video, 'loadedmetadata');
    const durationSec = await resolveMediaDuration(video);
    await waitForMediaEvent(video, 'loadeddata', 12_000).catch(() => undefined);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error(
        'The video track could not be decoded. Its codec (for example ProRes, DNxHD or HEVC) is not supported by this browser.',
      );
    }
    reportStage('probing', 30);
    let hasAudio = detectVideoHasAudio(video);
    const measuredFps = await estimateVideoFrameRate(video);
    if (!hasAudio) hasAudio = detectVideoHasAudio(video);
    const fps = frameRateFromFps(measuredFps);
    reportStage('thumbnail', 52);
    const thumbnailTime =
      durationSec > 0.4 ? Math.min(durationSec * 0.1, Math.max(0.1, durationSec - 0.1)) : 0;
    const captured = await captureVideoThumbnail(video, thumbnailTime);
    reportStage('waveform', 70);
    // Extracting the audio peaks of video is optional; decode failures are ignored.
    const peaks = await extractWaveformPeaks(file, {
      kind: 'video',
      maxPeaks: Math.round(MAX_WAVEFORM_PEAKS * 0.75),
    });
    const waveformPeaks = peaks && peaks.length ? peaks : undefined;
    if (waveformPeaks) hasAudio = true;
    return {
      durationSec,
      width: video.videoWidth,
      height: video.videoHeight,
      fps,
      hasAudio,
      thumbnailDataUrl: captured ?? createPlaceholderThumbnail('video'),
      waveformPeaks,
    };
  } catch (error) {
    if (video.error) throw new Error(describeMediaError(video));
    throw error instanceof Error ? error : new Error('The video file could not be read.');
  } finally {
    disposeProbeMediaElement(video);
  }
}

async function analyzeAudioFile(
  file: File,
  url: string,
  reportStage: (stage: ImportStage, percent: number) => void,
): Promise<AnalyzedMedia> {
  const audio = createProbeMediaElement('audio');
  try {
    audio.src = url;
    reportStage('probing', 16);
    await waitForMediaEvent(audio, 'loadedmetadata');
    const durationSec = await resolveMediaDuration(audio);
    reportStage('waveform', 55);
    const peaks = await extractWaveformPeaks(file, {
      kind: 'audio',
      maxPeaks: MAX_WAVEFORM_PEAKS,
    });
    reportStage('thumbnail', 78);
    const waveformPeaks = peaks && peaks.length ? peaks : undefined;
    return {
      durationSec,
      width: 0,
      height: 0,
      fps: null,
      hasAudio: true,
      thumbnailDataUrl: waveformPeaks ? createWaveformTile(waveformPeaks) : createPlaceholderThumbnail('audio'),
      waveformPeaks,
    };
  } catch (error) {
    if (audio.error) throw new Error(describeMediaError(audio));
    throw error instanceof Error ? error : new Error('The audio file could not be read.');
  } finally {
    disposeProbeMediaElement(audio);
  }
}

async function analyzeImageFile(
  url: string,
  reportStage: (stage: ImportStage, percent: number) => void,
): Promise<AnalyzedMedia> {
  reportStage('probing', 25);
  const image = await loadImageElement(url);
  reportStage('thumbnail', 60);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    throw new Error('The image dimensions could not be read. The file may be corrupt.');
  }
  return {
    durationSec: 0,
    width,
    height,
    fps: null,
    hasAudio: false,
    thumbnailDataUrl: thumbnailFromImageElement(image),
  };
}

async function analyzeFile(
  file: File,
  kind: MediaKind,
  url: string,
  reportStage: (stage: ImportStage, percent: number) => void,
): Promise<AnalyzedMedia> {
  if (kind === 'video') return analyzeVideoFile(file, url, reportStage);
  if (kind === 'audio') return analyzeAudioFile(file, url, reportStage);
  return analyzeImageFile(url, reportStage);
}

/* ------------------------------------------------------------------ */
/* Asset construction                                                  */
/* ------------------------------------------------------------------ */

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return fileName;
  return fileName.slice(0, dot);
}

function mimeTypeFor(file: File): string {
  if (file.type) return file.type;
  return MIME_BY_EXTENSION[fileExtension(file.name)] ?? 'application/octet-stream';
}

function buildMediaAsset(params: {
  mediaId: string;
  file: File;
  kind: MediaKind;
  storageKey: string;
  analyzed: AnalyzedMedia;
  binId: string | null;
  importedAt?: number;
  name?: string;
}): MediaAsset {
  const { analyzed } = params;
  return {
    id: params.mediaId,
    name: params.name ?? (stripExtension(params.file.name) || params.file.name),
    fileName: params.file.name,
    mimeType: mimeTypeFor(params.file),
    kind: params.kind,
    sizeBytes: params.file.size,
    durationSec: analyzed.durationSec,
    width: analyzed.width,
    height: analyzed.height,
    fps: analyzed.fps,
    hasAudio: analyzed.hasAudio,
    thumbnailDataUrl: analyzed.thumbnailDataUrl,
    waveformPeaks: analyzed.waveformPeaks,
    storageKey: params.storageKey,
    importedAt: params.importedAt ?? Date.now(),
    missing: false,
    binId: params.binId,
  };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Import a single file. Throws a user-readable Error on validation/probe/save
 * failures. The caller owns the returned runtime URL reference stored in the
 * media store (created here, never revoked on success).
 */
async function importSingleFile(
  file: File,
  kind: MediaKind,
  binId: string | null,
  reportStage: (stage: ImportStage, percent: number) => void,
): Promise<MediaAsset> {
  const mediaId = createId('media');
  const url = URL.createObjectURL(file);
  let keepUrl = false;
  try {
    const analyzed = await analyzeFile(file, kind, url, reportStage);
    reportStage('saving', 88);
    const storageKey = await mediaStorage.saveFile(mediaId, file);
    const asset = buildMediaAsset({ mediaId, file, kind, storageKey, analyzed, binId });
    useMediaStore.getState().setMediaUrl(mediaId, url);
    keepUrl = true;
    reportStage('saving', 96);
    useProjectStore.getState().addMedia([asset]);
    reportStage('done', 100);
    return asset;
  } finally {
    if (!keepUrl) URL.revokeObjectURL(url);
  }
}

function failureSummary(failures: ImportFailure[], max = 3): string {
  const parts = failures.slice(0, max).map((failure) => `${failure.fileName} — ${failure.reason}`);
  if (failures.length > max) parts.push(`…and ${failures.length - max} more.`);
  return parts.join(' · ');
}

function reportBatchResult(result: ImportBatchResult): void {
  const importedCount = result.imported.length;
  const failureCount = result.failed.length;
  const skipCount = result.skipped.length;
  if (importedCount > 0 && failureCount === 0 && skipCount === 0) {
    notify('success', `Imported ${importedCount} media file${importedCount === 1 ? '' : 's'}`, undefined, 2600);
    return;
  }
  if (importedCount > 0) {
    const summary: string[] = [];
    if (failureCount) summary.push(failureSummary(result.failed));
    if (skipCount) summary.push(`${skipCount} duplicate file${skipCount === 1 ? '' : 's'} skipped.`);
    notify(
      'warning',
      `Imported ${importedCount} of ${importedCount + failureCount} file${importedCount + failureCount === 1 ? '' : 's'}`,
      summary.filter(Boolean).join(' '),
      7000,
    );
    return;
  }
  if (failureCount > 0) {
    notify(
      'error',
      failureCount === 1 ? 'The media file could not be imported' : `${failureCount} media files could not be imported`,
      failureSummary(result.failed),
      8000,
    );
    return;
  }
  if (skipCount > 0) {
    notify('info', 'No new media imported', 'The selected files are already in this import batch.', 4000);
  }
}

function fileSignature(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

/**
 * Import a batch of files. Sequential processing keeps memory use predictable
 * and lets the progress UI update per stage. Validation failures and probe
 * failures never abort the rest of the batch.
 */
export async function importMediaFiles(
  files: File[],
  options: ImportOptions = {},
): Promise<ImportBatchResult> {
  const result: ImportBatchResult = { imported: [], failed: [], skipped: [] };
  const project = useProjectStore.getState().project;
  if (!project) {
    notify('warning', 'Open a project first', 'Media can only be imported into an open project.');
    return result;
  }
  if (!files.length) return result;
  if (importRunning) {
    notify('info', 'Import already in progress', 'Wait for the current import to finish before adding more files.');
    return result;
  }

  importRunning = true;
  const binId = options.binId ?? null;
  const items: ImportProgressItem[] = files.map((file, index) => ({
    id: `import_${Date.now()}_${index}`,
    fileName: file.name,
    kind: null,
    stage: 'queued',
    percent: 0,
  }));
  const emit = (running: boolean) => {
    options.onProgress?.({
      running,
      items: items.map((item) => ({ ...item })),
    });
  };
  const updateItem = (index: number, patch: Partial<ImportProgressItem>) => {
    items[index] = { ...items[index], ...patch };
    emit(true);
  };
  emit(true);

  const seen = new Set<string>();
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const signature = fileSignature(file);
      if (seen.has(signature)) {
        result.skipped.push({ fileName: file.name, reason: 'Duplicate of another file in this batch.' });
        updateItem(index, { stage: 'skipped', percent: 100, detail: 'Duplicate file in this batch' });
        continue;
      }
      seen.add(signature);

      const validation = validateMediaFile(file);
      if (!validation.ok || !validation.kind) {
        const reason = validation.reason ?? 'Unsupported file type.';
        result.failed.push({ fileName: file.name, reason });
        updateItem(index, { stage: 'error', percent: 100, error: reason });
        continue;
      }
      const kind = validation.kind;
      updateItem(index, { kind, stage: 'probing', percent: 8 });
      try {
        const asset = await importSingleFile(file, kind, binId, (stage, percent) => {
          updateItem(index, { stage, percent });
        });
        result.imported.push(asset);
        updateItem(index, { stage: 'done', percent: 100, mediaId: asset.id, detail: `${formatBytes(file.size)}` });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The file could not be imported.';
        result.failed.push({ fileName: file.name, reason });
        updateItem(index, { stage: 'error', percent: 100, error: reason });
      }
      // Yield so drag/drop UI and store subscribers can paint between files.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    importRunning = false;
    emit(false);
    reportBatchResult(result);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Relink                                                              */
/* ------------------------------------------------------------------ */

export interface RelinkResult {
  ok: boolean;
  error?: string;
}

/**
 * Re-link an offline media asset to a file chosen by the user. The media id is
 * preserved so all timeline clips keep pointing at the same asset.
 */
export async function relinkMediaFile(mediaId: string, file: File): Promise<RelinkResult> {
  const project = useProjectStore.getState().project;
  const existing = project?.media.find((asset) => asset.id === mediaId);
  if (!existing) {
    return { ok: false, error: 'That media item is no longer part of the project.' };
  }
  const validation = validateMediaFile(file);
  if (!validation.ok || !validation.kind) {
    const reason = validation.reason ?? 'Unsupported file type.';
    notify('error', `Cannot relink "${existing.name}"`, reason);
    return { ok: false, error: reason };
  }
  if (validation.kind !== existing.kind) {
    const reason = `"${existing.name}" is ${existing.kind} media. Choose a ${existing.kind} file to relink it.`;
    notify('error', `Cannot relink "${existing.name}"`, reason);
    return { ok: false, error: reason };
  }

  const kind = validation.kind;
  const url = URL.createObjectURL(file);
  let keepUrl = false;
  try {
    const analyzed = await analyzeFile(file, kind, url, () => undefined);
    const storageKey = await mediaStorage.saveFile(mediaId, file);
    const asset = buildMediaAsset({
      mediaId,
      file,
      kind,
      storageKey,
      analyzed,
      binId: existing.binId,
      importedAt: existing.importedAt,
      name: existing.name,
    });
    useMediaStore.getState().setMediaUrl(mediaId, url);
    keepUrl = true;
    useProjectStore.getState().updateMedia(
      mediaId,
      {
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationSec: asset.durationSec,
        width: asset.width,
        height: asset.height,
        fps: asset.fps,
        hasAudio: asset.hasAudio,
        thumbnailDataUrl: asset.thumbnailDataUrl,
        waveformPeaks: asset.waveformPeaks,
        storageKey: asset.storageKey,
        missing: false,
      },
      `Relink "${existing.name}"`,
    );
    // Keep the runtime "missing" badge list (media store) in sync; the project
    // media asset is authoritative and was cleared above.
    const mediaStore = useMediaStore.getState();
    if (mediaStore.missingIds.includes(mediaId)) {
      useMediaStore.setState({ missingIds: mediaStore.missingIds.filter((id) => id !== mediaId) });
    }
    notify('success', `Relinked "${asset.name}"`, `Now using ${file.name} (${formatBytes(file.size)})`, 3200);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The replacement file could not be read.';
    notify('error', `Could not relink "${existing.name}"`, reason, 7000);
    return { ok: false, error: reason };
  } finally {
    if (!keepUrl) URL.revokeObjectURL(url);
  }
}
