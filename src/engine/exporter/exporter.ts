/**
 * Export engine entry point.
 *
 * `exportSequence` renders the *edited* sequence (tracks, trims, transforms,
 * gaps, durations, audio mix) into a real H.264/AAC MP4 via WebCodecs +
 * mp4-muxer, falling back to a VP9 MP4, then to a real-time MediaRecorder WebM
 * capture when WebCodecs is unavailable.
 */
import type { ExportProgress, ExportSettings, Project, Sequence } from '@/types';
import { ExportCancelledError, ExportCapabilityError, ExportValidationError, toExportError, type ExportCallbacks, type ExportResult, type ExportRange } from './types';
import {
  getExportCapabilities,
  pickAudioEncoder,
  pickH264Encoder,
  pickVp9Encoder,
  type VideoEncoderSelection,
} from './capabilities';
import { normalizeExportSettings, outputFrameCount, resolveExportRange } from './settings';
import { ExportMediaResolver, WarningCollector } from './media-sources';
import { MediaElementCache, TimelineFrameRenderer } from './video-renderer';
import { mixSequenceAudio } from './audio-mixer';
import { runWebCodecsExport, type AudioEncodePlan } from './webcodecs-exporter';
import { runMediaRecorderExport } from './fallback-recorder';
import { clipEnd } from '@/engine/timeline/operations';

export interface ExportSequenceOptions {
  project: Project;
  sequence: Sequence;
  settings: ExportSettings;
  callbacks?: ExportCallbacks;
}

/** Media ids referenced by clips that intersect the requested range. */
function collectMediaIds(sequence: Sequence, range: ExportRange): string[] {
  const ids = new Set<string>();
  for (const clip of sequence.clips) {
    if (clip.startFrame < range.endFrameExclusive && clipEnd(clip) > range.startFrame) {
      ids.add(clip.mediaId);
    }
  }
  return [...ids];
}

async function selectVideoEncoder(
  settings: ExportSettings,
  warnings: WarningCollector,
): Promise<VideoEncoderSelection | null> {
  const request = {
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    bitrate: settings.videoBitrate,
  };
  const wanted = settings.videoCodec === 'vp9' ? 'VP9' : 'H.264';
  if (settings.videoCodec === 'vp9') {
    const vp9 = await pickVp9Encoder(request);
    if (vp9) return vp9;
    const h264 = await pickH264Encoder(request);
    if (h264) {
      warnings.add(`${wanted} encoding is unavailable at ${settings.width}×${settings.height}; using ${h264.codec} instead.`);
      return h264;
    }
  } else {
    const h264 = await pickH264Encoder(request);
    if (h264) return h264;
    const vp9 = await pickVp9Encoder(request);
    if (vp9) {
      warnings.add(`${wanted} encoding is unavailable at ${settings.width}×${settings.height}; using ${vp9.codec} instead.`);
      return vp9;
    }
  }
  return null;
}

async function planAudioEncoding(settings: ExportSettings, warnings: WarningCollector): Promise<AudioEncodePlan | null> {
  const requestedRate = settings.audioSampleRate;
  const rates = requestedRate === 48_000 ? [requestedRate] : [requestedRate, 48_000];
  for (const rate of rates) {
    const aac = await pickAudioEncoder('aac', rate, 2, settings.audioBitrate);
    if (!aac) continue;
    if (aac.sampleRate !== requestedRate) {
      warnings.add(`AAC at ${requestedRate} Hz is unavailable; audio is encoded at ${aac.sampleRate} Hz instead.`);
    }
    return {
      codec: 'aac',
      codecString: aac.codecString,
      sampleRate: aac.sampleRate,
      numberOfChannels: aac.numberOfChannels,
      bitrate: aac.bitrate,
      config: aac.config,
    };
  }
  const opus = await pickAudioEncoder('opus', 48_000, 2, settings.audioBitrate);
  if (opus) {
    warnings.add('AAC encoding is unavailable; audio is encoded as Opus (48 kHz) in the MP4 container.');
    return {
      codec: 'opus',
      codecString: opus.codecString,
      sampleRate: opus.sampleRate,
      numberOfChannels: opus.numberOfChannels,
      bitrate: opus.bitrate,
      config: opus.config,
    };
  }
  return null;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Export a sequence to a downloadable media Blob.
 *
 * Throws {@link ExportCancelledError} when `callbacks.shouldCancel` flips true,
 * {@link ExportCapabilityError} when no export path exists, and
 * {@link ExportValidationError} for invalid settings/ranges.
 */
export async function exportSequence(
  project: Project,
  sequence: Sequence,
  settingsInput: ExportSettings,
  callbacks: ExportCallbacks = {},
): Promise<ExportResult> {
  if (!project) throw new ExportValidationError('There is no project to export.');
  if (!sequence) throw new ExportValidationError('There is no active sequence to export.');

  const settings = normalizeExportSettings(settingsInput, sequence);
  const range = resolveExportRange(sequence, settings);
  const totalOutputFrames = outputFrameCount(range, settings.frameRate);
  const warnings = new WarningCollector(callbacks.onWarning);
  const emit = (progress: ExportProgress): void => callbacks.onProgress?.(progress);
  const checkCancelled = (): void => {
    if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
  };

  emit({
    phase: 'preparing',
    framesDone: 0,
    totalFrames: totalOutputFrames,
    message: 'Checking browser encoder support…',
  });

  const caps = await getExportCapabilities();
  checkCancelled();

  let videoSelection: VideoEncoderSelection | null = null;
  let useFallback = false;
  if (caps.webCodecs) {
    videoSelection = await selectVideoEncoder(settings, warnings);
  }
  if (!videoSelection) {
    if (!caps.mediaRecorder) {
      const detail = caps.warnings.length ? ` ${caps.warnings.join(' ')}` : '';
      throw new ExportCapabilityError(
        `This browser cannot export video: no WebCodecs video encoder or MediaRecorder fallback is available.${detail}`,
      );
    }
    useFallback = true;
    warnings.add(
      'WebCodecs MP4 encoding is unavailable in this browser; exporting a real-time WebM (MediaRecorder) capture instead.',
    );
  }
  checkCancelled();

  // Audio: WebCodecs path uses AudioEncoder; fallback path records live audio.
  let audioPlan: AudioEncodePlan | null = null;
  if (settings.audioEnabled) {
    if (useFallback) {
      audioPlan = null;
    } else if (!caps.audioEncoder) {
      warnings.add('No audio encoder is available in this browser; the export will be video-only.');
    } else {
      audioPlan = await planAudioEncoding(settings, warnings);
      if (!audioPlan) {
        warnings.add('No usable audio encoder was found; the export will be video-only.');
      }
    }
  }
  checkCancelled();

  const resolver = new ExportMediaResolver(project, warnings);
  const elements = new MediaElementCache(resolver, warnings);
  const canvas = createCanvas(settings.width, settings.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new ExportCapabilityError('A 2D canvas context could not be created, so the render step cannot run.');
  }
  const renderer = new TimelineFrameRenderer({
    sequence,
    ctx,
    width: settings.width,
    height: settings.height,
    resolver,
    elements,
    warnings,
    range,
    outputFrameRate: settings.frameRate,
  });

  try {
    const mediaIds = collectMediaIds(sequence, range);
    emit({
      phase: 'preparing',
      framesDone: 0,
      totalFrames: totalOutputFrames,
      message: `Loading ${mediaIds.length} media source${mediaIds.length === 1 ? '' : 's'}…`,
    });
    await resolver.resolveAll(mediaIds);
    checkCancelled();

    let audioBuffer: AudioBuffer | null = null;
    let audioMixRate = settings.audioSampleRate;
    // Only mix when the chosen path can actually carry audio: MediaRecorder
    // records live audio, WebCodecs needs a planned AudioEncoder.
    if (settings.audioEnabled && (useFallback || audioPlan)) {
      const mixRate = useFallback ? 48_000 : audioPlan?.sampleRate ?? settings.audioSampleRate;
      audioMixRate = mixRate;
      emit({
        phase: 'preparing',
        framesDone: 0,
        totalFrames: totalOutputFrames,
        message: 'Mixing timeline audio…',
      });
      audioBuffer = await mixSequenceAudio({
        sequence,
        range,
        sampleRate: mixRate,
        resolver,
        warnings,
        shouldCancel: callbacks.shouldCancel,
        onDecodeProgress: (done, total) => {
          emit({
            phase: 'preparing',
            framesDone: 0,
            totalFrames: totalOutputFrames,
            message: `Decoding audio sources (${done}/${total})…`,
          });
        },
      });
      checkCancelled();
    }

    if (useFallback) {
      // The recorder attaches the canvas offscreen itself while capturing.
      return await runMediaRecorderExport({
        settings,
        range,
        canvas,
        renderer,
        audioBuffer,
        audioSampleRate: audioMixRate,
        callbacks,
        warnings,
      });
    }

    if (!videoSelection) {
      throw new ExportCapabilityError('No working video encoder was selected.');
    }
    return await runWebCodecsExport({
      settings,
      range,
      video: videoSelection,
      audio: audioPlan,
      audioBuffer,
      canvas,
      renderer,
      callbacks,
      warnings,
    });
  } catch (error) {
    throw toExportError(error, 'The sequence could not be exported.', 'unknown');
  } finally {
    elements.dispose();
    resolver.dispose();
    canvas.width = 1;
    canvas.height = 1;
  }
}
