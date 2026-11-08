/**
 * Thumbnail and waveform helpers for the media import pipeline.
 *
 * Everything in this module runs in the browser using canvas + WebAudio and
 * produces small JPEG data URLs that are safe to persist in the project
 * document (they are a few KB each, unlike object URLs which die on reload).
 *
 * The exported drawing helpers are also reused by the Media panel and Source
 * monitor to render waveform previews from the persisted peak arrays.
 */
import type { MediaKind } from '@/types';

export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 180;
export const MAX_WAVEFORM_PEAKS = 1600;

const JPEG_QUALITY = 0.72;
const DEFAULT_MEDIA_TIMEOUT_MS = 20_000;
/** Skipping decode above these sizes keeps the import responsive. */
const MAX_AUDIO_DECODE_BYTES = 160 * 1024 * 1024;
const MAX_VIDEO_AUDIO_DECODE_BYTES = 96 * 1024 * 1024;

const WAVEFORM_TILE_BG = '#1b2924';
const WAVEFORM_TILE_COLOR = '#5fd0a0';
const PLACEHOLDER_BG = '#232323';

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  return ctx;
}

/** Draw a source image/bitmap letterboxed into a black canvas and return a JPEG data URL. */
function drawContainedThumbnail(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string {
  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const ctx = context2d(canvas);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  if (sourceWidth > 0 && sourceHeight > 0) {
    const scale = Math.min(THUMBNAIL_WIDTH / sourceWidth, THUMBNAIL_HEIGHT / sourceHeight);
    const drawWidth = Math.max(1, sourceWidth * scale);
    const drawHeight = Math.max(1, sourceHeight * scale);
    const dx = (THUMBNAIL_WIDTH - drawWidth) / 2;
    const dy = (THUMBNAIL_HEIGHT - drawHeight) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
  }
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/* ------------------------------------------------------------------ */
/* Media element loading / seeking (shared with the import probe)      */
/* ------------------------------------------------------------------ */

type MediaEventName = 'loadedmetadata' | 'loadeddata' | 'seeked' | 'error' | 'canplay';

/**
 * Wait for one media event. Rejects with a user-readable message on `error`
 * or when the timeout elapses (e.g. a file the browser cannot demux).
 */
export function waitForMediaEvent(
  element: HTMLMediaElement,
  eventName: MediaEventName,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      element.removeEventListener(eventName, onEvent);
      element.removeEventListener('error', onError);
      window.clearTimeout(timer);
    };
    const onEvent = () => {
      if (settled) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      cleanup();
      reject(new Error(describeMediaError(element)));
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Timed out while reading the media file. The codec may not be supported by this browser.'));
    }, timeoutMs);
    if (eventName !== 'error') element.addEventListener('error', onError);
    if (eventName === 'error') element.addEventListener('error', onEvent);
    else element.addEventListener(eventName, onEvent);
    // Metadata may already be available for cached/object URLs.
    if (eventName === 'loadedmetadata' && element.readyState >= HTMLMediaElement.HAVE_METADATA) {
      onEvent();
    } else if (eventName === 'loadeddata' && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onEvent();
    } else if (eventName === 'canplay' && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      onEvent();
    }
  });
}

export function describeMediaError(element: HTMLMediaElement): string {
  const error = element.error;
  if (!error) return 'The browser could not read this media file. Its codec may not be supported.';
  switch (error.code) {
    case 1:
      return 'Reading the file was aborted.';
    case 2:
      return 'A network or storage error occurred while reading the file.';
    case 3:
      return 'The file could not be decoded. Its video or audio codec is not supported by this browser.';
    case 4:
      return 'This container format or codec is not supported by this browser.';
    default:
      return 'The browser could not read this media file. Its codec may not be supported.';
  }
}

/** Seek a media element and resolve once the frame at `timeSec` is available. */
export async function seekMediaElement(
  element: HTMLMediaElement,
  timeSec: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const duration = Number.isFinite(element.duration) ? element.duration : 0;
  const target = Math.max(0, Math.min(timeSec, Math.max(0, duration - 0.001)));
  if (Math.abs(element.currentTime - target) < 0.001 && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return true;
  }
  const seeked = waitForMediaEvent(element, 'seeked', timeoutMs).then(() => true).catch(() => false);
  try {
    element.currentTime = target;
  } catch {
    return false;
  }
  const ok = await seeked;
  // Some browsers fire `seeked` before the decoded frame is drawable; give the
  // compositor a microtask tick so drawImage picks up the new frame.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  return ok && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

/** Load an image element from an object URL (rejects on decode failure). */
export function loadImageElement(url: string, timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Timed out while decoding the image file.'));
    }, timeoutMs);
    image.onload = () => {
      if (settled) return;
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('The image could not be decoded. The file may be corrupt or use an unsupported format.'));
    };
    image.decoding = 'async';
    image.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Thumbnail generation                                                */
/* ------------------------------------------------------------------ */

export function thumbnailFromImageElement(image: HTMLImageElement): string {
  return drawContainedThumbnail(image, image.naturalWidth || image.width, image.naturalHeight || image.height);
}

/**
 * Capture a frame of an already-loaded, probe-ready video element. Returns
 * null when the frame could not be drawn so callers can fall back to a
 * generated placeholder tile.
 */
export async function captureVideoThumbnail(video: HTMLVideoElement, timeSec: number): Promise<string | null> {
  try {
    const ok = await seekMediaElement(video, timeSec, 8_000);
    if (!ok || video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }
    return drawContainedThumbnail(video, video.videoWidth, video.videoHeight);
  } catch {
    return null;
  }
}

/** Native resolution of a probed video element (0 when not known). */
export function videoResolution(video: HTMLVideoElement): { width: number; height: number } {
  return { width: video.videoWidth || 0, height: video.videoHeight || 0 };
}

/* ------------------------------------------------------------------ */
/* Placeholder tiles                                                   */
/* ------------------------------------------------------------------ */

/** Generated tile used when a real frame/waveform cannot be produced. */
export function createPlaceholderThumbnail(kind: MediaKind): string {
  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const ctx = context2d(canvas);
  ctx.fillStyle = PLACEHOLDER_BG;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  const accent = kind === 'video' ? '#5b8fc9' : kind === 'audio' ? '#4cba91' : '#c99a5b';
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  for (let y = 24; y < THUMBNAIL_HEIGHT; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(THUMBNAIL_WIDTH, y);
    ctx.stroke();
  }

  const cx = THUMBNAIL_WIDTH / 2;
  const cy = THUMBNAIL_HEIGHT / 2;
  ctx.fillStyle = accent;
  if (kind === 'video') {
    // film frame + play triangle
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - 58, cy - 34, 116, 68);
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect(cx - 74, cy + i * 14 - 3, 8, 6);
      ctx.fillRect(cx + 66, cy + i * 14 - 3, 8, 6);
    }
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy - 16);
    ctx.lineTo(cx + 18, cy);
    ctx.lineTo(cx - 12, cy + 16);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'audio') {
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    for (let i = -12; i <= 12; i++) {
      const height = 8 + Math.abs(Math.sin(i * 0.7)) * 34;
      ctx.beginPath();
      ctx.moveTo(cx + i * 9, cy - height / 2);
      ctx.lineTo(cx + i * 9, cy + height / 2);
      ctx.stroke();
    }
  } else {
    // mountains + sun
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - 58, cy - 38, 116, 76);
    ctx.beginPath();
    ctx.arc(cx + 24, cy - 16, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 52, cy + 32);
    ctx.lineTo(cx - 16, cy - 6);
    ctx.lineTo(cx + 8, cy + 18);
    ctx.lineTo(cx + 24, cy + 2);
    ctx.lineTo(cx + 52, cy + 32);
    ctx.closePath();
    ctx.fill();
  }
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/* ------------------------------------------------------------------ */
/* Waveform extraction (WebAudio)                                      */
/* ------------------------------------------------------------------ */

/** Reduce raw channel data to `maxPeaks` normalized 0..1 magnitudes. */
export function computePeaksFromChannelData(channels: Float32Array[], maxPeaks: number): number[] {
  const sampleCount = channels[0]?.length ?? 0;
  if (!channels.length || sampleCount === 0) return [];
  const count = Math.max(1, Math.min(maxPeaks, sampleCount));
  const bucket = sampleCount / count;
  const peaks = new Array<number>(count).fill(0);
  for (let p = 0; p < count; p++) {
    const start = Math.floor(p * bucket);
    const end = Math.min(sampleCount, Math.max(start + 1, Math.floor((p + 1) * bucket)));
    const span = end - start;
    // Bound the work per bucket so very long files still import quickly.
    const stride = span > 512 ? Math.ceil(span / 256) : 1;
    let peak = 0;
    for (let channel = 0; channel < channels.length; channel++) {
      const data = channels[channel];
      for (let i = start; i < end; i += stride) {
        const value = data[i] < 0 ? -data[i] : data[i];
        if (value > peak) peak = value;
      }
    }
    peaks[p] = peak;
  }
  let max = 0;
  for (const value of peaks) if (value > max) max = value;
  if (max > 0.0001) {
    for (let p = 0; p < peaks.length; p++) peaks[p] = Math.min(1, peaks[p] / max);
  }
  return peaks;
}

async function decodeAudioBuffer(blob: Blob): Promise<AudioBuffer | null> {
  const AudioContextCtor =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!AudioContextCtor) return null;
  let context: AudioContext | null = null;
  try {
    context = new AudioContextCtor();
    const buffer = await blob.arrayBuffer();
    return await context.decodeAudioData(buffer);
  } catch {
    return null;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* already closed */
      }
    }
  }
}

export interface WaveformExtractionOptions {
  maxPeaks?: number;
  /** Skip decoding files above this size (defaults depend on the media kind). */
  maxBytes?: number;
  /** 'video' allows a smaller decode budget because the audio is a secondary track. */
  kind?: 'video' | 'audio';
}

/**
 * Decode a media file and extract display peaks. Returns null when the browser
 * cannot decode the audio (e.g. video-only file or unsupported codec). This is
 * best effort: failure must never fail the import.
 */
export async function extractWaveformPeaks(
  file: Blob,
  options: WaveformExtractionOptions = {},
): Promise<number[] | null> {
  const kind = options.kind ?? 'audio';
  const maxBytes = options.maxBytes ?? (kind === 'video' ? MAX_VIDEO_AUDIO_DECODE_BYTES : MAX_AUDIO_DECODE_BYTES);
  if (file.size <= 0 || file.size > maxBytes) return null;
  const decoded = await decodeAudioBuffer(file);
  if (!decoded || decoded.length === 0) return null;
  const channelCount = Math.max(1, decoded.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel++) {
    try {
      channels.push(decoded.getChannelData(channel));
    } catch {
      /* channel unavailable */
    }
  }
  if (!channels.length) return null;
  return computePeaksFromChannelData(channels, options.maxPeaks ?? MAX_WAVEFORM_PEAKS);
}

/** Generate the waveform tile used as the thumbnail for audio-only media. */
export function createWaveformTile(peaks: number[] | undefined): string {
  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const ctx = context2d(canvas);
  const gradient = ctx.createLinearGradient(0, 0, 0, THUMBNAIL_HEIGHT);
  gradient.addColorStop(0, '#20312a');
  gradient.addColorStop(1, '#151d1a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 40; x < THUMBNAIL_WIDTH; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, THUMBNAIL_HEIGHT);
    ctx.stroke();
  }
  drawWaveformBars(ctx, peaks ?? [], 12, 12, THUMBNAIL_WIDTH - 24, THUMBNAIL_HEIGHT - 24, WAVEFORM_TILE_COLOR);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function drawWaveformBars(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  const mid = y + height / 2;
  const amp = height / 2;
  if (!peaks.length) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, mid);
    ctx.lineTo(x + width, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  const columns = Math.min(peaks.length, Math.max(1, Math.floor(width)));
  const step = peaks.length / columns;
  ctx.fillStyle = color;
  for (let i = 0; i < columns; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let k = start; k < end; k++) {
      const value = peaks[k] ?? 0;
      if (value > peak) peak = value;
    }
    const barWidth = Math.max(1, width / columns - 0.5);
    const barHeight = Math.max(1, Math.min(1, peak) * amp);
    ctx.fillRect(x + (i * width) / columns, mid - barHeight, barWidth, barHeight * 2);
  }
}

export interface WaveformDrawOptions {
  color?: string;
  background?: string;
  /** 0..1 play progress; the unplayed part is dimmed. */
  progress?: number;
  gridLines?: boolean;
}

/**
 * Draw peaks into a canvas sized by its CSS box (handles devicePixelRatio).
 * Used by the compact previews in the Media panel and the Source monitor.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[] | undefined,
  options: WaveformDrawOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.width || 1));
  const height = Math.max(1, Math.round(rect.height || canvas.height || 1));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const color = options.color ?? WAVEFORM_TILE_COLOR;
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (options.gridLines) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((height * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }
  drawWaveformBars(ctx, peaks ?? [], 0, 2, width, height - 4, color);
  if (options.progress !== undefined) {
    const progress = Math.max(0, Math.min(1, options.progress));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(progress * width, 0, width - progress * width, height);
  }
}
