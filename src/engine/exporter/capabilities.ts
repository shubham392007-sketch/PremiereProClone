/**
 * WebCodecs capability probing for export.
 *
 * Encoder support depends on the exact codec string, resolution, frame rate and
 * bitrate, so registration helpers probe the actual candidate configs with
 * `isConfigSupported` instead of guessing from `'VideoEncoder' in window`.
 */
import type { FrameRate } from '@/types';
import { fpsOf } from '@/utils/time';
import type { ExportCapabilities } from './types';

/**
 * H.264 candidates ordered from the most capable profile/level down. The
 * exporter picks the first one the browser reports as supported for the actual
 * output resolution.
 */
const H264_CODEC_CANDIDATES = [
  'avc1.640034', // High 5.2 — 4K / high frame rates
  'avc1.640033', // High 5.1
  'avc1.64002a', // High 4.2
  'avc1.640028', // High 4.0 — 1080p
  'avc1.4d0028', // Main 4.0
  'avc1.4d002a', // Main 4.2
  'avc1.42001f', // Baseline 3.1
] as const;

/** VP9 candidates: profile 0, levels 1.0 → 5.1 (8-bit). */
const VP9_CODEC_CANDIDATES = [
  'vp09.00.10.08',
  'vp09.00.20.08',
  'vp09.00.31.08',
  'vp09.00.40.08',
  'vp09.00.50.08',
  'vp09.00.51.08',
] as const;

const AAC_CODEC = 'mp4a.40.2';
const OPUS_CODEC = 'opus';

export interface VideoEncoderSelection {
  /** lib.dom WebCodecs config for VideoEncoder.configure */
  config: VideoEncoderConfig;
  /** 'h264' | 'vp9' */
  family: 'h264' | 'vp9';
  /** codec string actually selected (e.g. avc1.4d0028) */
  codec: string;
}

export interface AudioEncoderSelection {
  codec: 'aac' | 'opus';
  /** codec string actually selected (mp4a.40.2 or opus) */
  codecString: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
  config: AudioEncoderConfig;
}

export function hasVideoEncoderApi(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoEncoder.isConfigSupported === 'function';
}

export function hasAudioEncoderApi(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioEncoder.isConfigSupported === 'function';
}

export function hasMediaRecorderApi(): boolean {
  if (typeof MediaRecorder === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined') return false;
  return typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

interface SupportResult {
  supported: boolean;
  config: VideoEncoderConfig;
}

async function probeVideoConfig(config: VideoEncoderConfig): Promise<SupportResult> {
  try {
    const support = await VideoEncoder.isConfigSupported(config);
    return { supported: Boolean(support.supported), config: support.config ?? config };
  } catch {
    return { supported: false, config };
  }
}

export interface VideoEncodeRequest {
  width: number;
  height: number;
  frameRate: FrameRate;
  bitrate: number;
}

/** Probe H.264 encoder configs for a concrete resolution/frame rate. */
export async function pickH264Encoder(request: VideoEncodeRequest): Promise<VideoEncoderSelection | null> {
  if (!hasVideoEncoderApi()) return null;
  const fps = fpsOf(request.frameRate);
  for (const codec of H264_CODEC_CANDIDATES) {
    const candidate: VideoEncoderConfig = {
      codec,
      width: request.width,
      height: request.height,
      bitrate: Math.max(1, Math.round(request.bitrate)),
      framerate: Math.round(fps * 1000) / 1000,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    const result = await probeVideoConfig(candidate);
    if (result.supported) {
      return { config: { ...result.config, codec }, family: 'h264', codec: result.config.codec || codec };
    }
  }
  return null;
}

/** Probe VP9 encoder configs for a concrete resolution/frame rate. */
export async function pickVp9Encoder(request: VideoEncodeRequest): Promise<VideoEncoderSelection | null> {
  if (!hasVideoEncoderApi()) return null;
  const fps = fpsOf(request.frameRate);
  for (const codec of VP9_CODEC_CANDIDATES) {
    const candidate: VideoEncoderConfig = {
      codec,
      width: request.width,
      height: request.height,
      bitrate: Math.max(1, Math.round(request.bitrate)),
      framerate: Math.round(fps * 1000) / 1000,
      latencyMode: 'quality',
    };
    const result = await probeVideoConfig(candidate);
    if (result.supported) {
      return { config: { ...result.config, codec }, family: 'vp9', codec: result.config.codec || codec };
    }
  }
  return null;
}

interface AudioSupportResult {
  supported: boolean;
  config: AudioEncoderConfig;
}

async function probeAudioConfig(config: AudioEncoderConfig): Promise<AudioSupportResult> {
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    return { supported: Boolean(support.supported), config: support.config ?? config };
  } catch {
    return { supported: false, config };
  }
}

/**
 * Probe one audio codec. `sampleRate` may be ignored/overridden by the browser
 * in the returned config; callers must use `selection.sampleRate`.
 */
export async function pickAudioEncoder(
  codec: 'aac' | 'opus',
  sampleRate: number,
  numberOfChannels: number,
  bitrate: number,
): Promise<AudioEncoderSelection | null> {
  if (!hasAudioEncoderApi()) return null;
  const effectiveRate = codec === 'opus' ? 48_000 : sampleRate;
  const config: AudioEncoderConfig = {
    codec: codec === 'aac' ? AAC_CODEC : OPUS_CODEC,
    sampleRate: effectiveRate,
    numberOfChannels: Math.max(1, Math.min(2, Math.round(numberOfChannels))),
    bitrate: Math.max(32_000, Math.round(bitrate)),
  };
  const result = await probeAudioConfig(config);
  if (!result.supported) return null;
  return {
    codec,
    codecString: codec === 'aac' ? AAC_CODEC : OPUS_CODEC,
    sampleRate: result.config.sampleRate ?? effectiveRate,
    numberOfChannels: result.config.numberOfChannels ?? config.numberOfChannels,
    bitrate: result.config.bitrate ?? bitrate,
    config: result.config,
  };
}

let capabilitiesPromise: Promise<ExportCapabilities> | null = null;

async function detect(): Promise<ExportCapabilities> {
  const videoEncoder = hasVideoEncoderApi();
  const audioEncoder = hasAudioEncoderApi();
  const mediaRecorder = hasMediaRecorderApi();

  const probeRate: FrameRate = { num: 30, den: 1, label: '30' };
  const [h264Selection, vp9Selection] = videoEncoder
    ? await Promise.all([
        pickH264Encoder({ width: 1920, height: 1080, frameRate: probeRate, bitrate: 10_000_000 }),
        pickVp9Encoder({ width: 1920, height: 1080, frameRate: probeRate, bitrate: 10_000_000 }),
      ])
    : [null, null];

  const [aacSelection, opusSelection] = audioEncoder
    ? await Promise.all([
        pickAudioEncoder('aac', 48_000, 2, 192_000),
        pickAudioEncoder('opus', 48_000, 2, 160_000),
      ])
    : [null, null];

  const h264 = Boolean(h264Selection);
  const vp9 = Boolean(vp9Selection);
  const aac = Boolean(aacSelection);
  const opus = Boolean(opusSelection);
  const webCodecs = videoEncoder && (h264 || vp9);
  const canExport = webCodecs || mediaRecorder;

  const warnings: string[] = [];
  if (!videoEncoder) {
    warnings.push('WebCodecs VideoEncoder is not available in this browser.');
  } else if (!h264 && !vp9) {
    warnings.push('No supported video encoder was found (H.264 and VP9 both unavailable).');
  }
  if (!audioEncoder) {
    warnings.push('WebCodecs AudioEncoder is not available — exports will be video-only.');
  } else if (!aac && !opus) {
    warnings.push('No supported audio encoder was found — exports will be video-only.');
  }
  if (!webCodecs && mediaRecorder) {
    warnings.push('MP4 export requires WebCodecs. This export will use a real-time WebM MediaRecorder capture instead.');
  }
  if (!mediaRecorder) {
    warnings.push('MediaRecorder fallback is not available either.');
  }
  if (!canExport) {
    warnings.push('This browser cannot export video. Use a recent Chromium-based browser with WebCodecs enabled.');
  } else if (webCodecs && !h264) {
    warnings.push('H.264 encoding is unavailable; MP4 export will use VP9.');
  }
  if (webCodecs && !aac && opus) {
    warnings.push('AAC encoding is unavailable; audio will be encoded as Opus in the MP4 container (48 kHz).');
  }

  return {
    webCodecs,
    videoEncoder,
    audioEncoder,
    h264,
    vp9,
    aac,
    opus,
    mediaRecorder,
    h264Codec: h264Selection?.codec ?? null,
    vp9Codec: vp9Selection?.codec ?? null,
    fallbackUsed: webCodecs ? 'none' : mediaRecorder ? 'webm-mediaRecorder' : undefined,
    canExport,
    warnings,
  };
}

/** Cached capability report (probing spins up encoder configs, so cache it). */
export function getExportCapabilities(force = false): Promise<ExportCapabilities> {
  if (!capabilitiesPromise || force) {
    capabilitiesPromise = detect();
  }
  return capabilitiesPromise;
}

/** Test helper / capability refresh hook. */
export function resetExportCapabilitiesCache(): void {
  capabilitiesPromise = null;
}

/** MediaRecorder container candidates, best first. */
export const WEBM_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** First WebM mime type the browser can actually record. */
export function pickWebmMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  for (const mimeType of WEBM_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    } catch {
      /* keep probing */
    }
  }
  return null;
}
