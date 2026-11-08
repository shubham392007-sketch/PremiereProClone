/**
 * WebCodecs MP4 export path.
 *
 * Frames are rendered by {@link TimelineFrameRenderer}, wrapped in `VideoFrame`s
 * and encoded with `VideoEncoder` (H.264 "avc" or VP9), while the pre-mixed
 * timeline audio is encoded with `AudioEncoder` (AAC, Opus fallback). Encoded
 * chunks are muxed into a real MP4 with `mp4-muxer` (fast-start, in-memory).
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { ExportSettings } from '@/types';
import { fpsOf } from '@/utils/time';
import type { VideoEncoderSelection } from './capabilities';
import type { WarningCollector } from './media-sources';
import { buildExportFileName, outputFrameCount } from './settings';
import {
  ExportCancelledError,
  ExportCapabilityError,
  ExportError,
  toExportError,
  type ExportCallbacks,
  type ExportRange,
  type ExportResult,
  type ExportVideoCodec,
} from './types';
import type { TimelineFrameRenderer } from './video-renderer';

export interface AudioEncodePlan {
  codec: 'aac' | 'opus';
  codecString: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
  config: AudioEncoderConfig;
}

export interface WebCodecsExportOptions {
  settings: ExportSettings;
  range: ExportRange;
  video: VideoEncoderSelection;
  audio: AudioEncodePlan | null;
  audioBuffer: AudioBuffer | null;
  canvas: HTMLCanvasElement;
  renderer: TimelineFrameRenderer;
  callbacks: ExportCallbacks;
  warnings: WarningCollector;
}

const MAX_ENCODE_QUEUE = 8;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function closeEncoder(encoder: VideoEncoder | AudioEncoder | null): void {
  if (!encoder) return;
  try {
    if (encoder.state !== 'closed') encoder.close();
  } catch {
    /* already closed by the browser after an error */
  }
}

/** VP9-in-MP4 requires a colour space in the decoder config; default to Rec.709. */
function sanitizeVideoMetadata(
  metadata: EncodedVideoChunkMetadata | undefined,
  family: 'h264' | 'vp9',
): EncodedVideoChunkMetadata | undefined {
  if (!metadata?.decoderConfig) return metadata;
  if (family === 'vp9' && !metadata.decoderConfig.colorSpace) {
    return {
      ...metadata,
      decoderConfig: {
        ...metadata.decoderConfig,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      },
    };
  }
  return metadata;
}

async function drainVideoEncoder(
  encoder: VideoEncoder,
  callbacks: ExportCallbacks,
  getFailure: () => Error | null,
): Promise<void> {
  let spins = 0;
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
    const failure = getFailure();
    if (failure) throw failure;
    await delay(2);
    spins += 1;
    if (spins > 15_000) {
      throw new ExportError('The video encoder stopped making progress.', 'encode');
    }
  }
}

interface EncodeAudioOptions {
  muxer: Muxer<ArrayBufferTarget>;
  audio: AudioEncodePlan;
  audioBuffer: AudioBuffer;
  totalFrames: number;
  callbacks: ExportCallbacks;
  emit: (phase: 'rendering' | 'encoding' | 'muxing', framesDone: number, message: string) => void;
}

/**
 * Encode the mixed timeline audio as AAC (or Opus) and add the chunks to the
 * muxer. Progress messages carry real encoded sample counts.
 */
async function encodeAudioTrack(options: EncodeAudioOptions): Promise<void> {
  const { muxer, audio, audioBuffer, totalFrames, callbacks, emit } = options;
  if (Math.abs(audioBuffer.sampleRate - audio.sampleRate) > 1) {
    throw new ExportError(
      `Audio mix sample rate (${audioBuffer.sampleRate} Hz) does not match the encoder target (${audio.sampleRate} Hz).`,
      'encode',
    );
  }
  let failure: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      try {
        muxer.addAudioChunk(chunk, metadata);
      } catch (error) {
        failure = failure ?? toExportError(error, 'Audio chunk could not be muxed.', 'muxer');
      }
    },
    error: (error) => {
      failure = failure ?? toExportError(error, 'Audio encoding failed.', 'encode');
    },
  });

  try {
    try {
      encoder.configure(audio.config);
    } catch (error) {
      throw new ExportCapabilityError(
        `The ${audio.codec.toUpperCase()} audio encoder could not be configured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const channelCount = Math.max(1, Math.min(2, audio.numberOfChannels));
    const totalSamples = audioBuffer.length;
    const channel0 = audioBuffer.getChannelData(0);
    const channel1 =
      audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : channel0;
    const frameSize = audio.codec === 'aac' ? 1024 : 960;
    let samplesEncoded = 0;

    for (let offset = 0; offset < totalSamples; offset += frameSize) {
      if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
      if (failure) throw failure;
      const framesInChunk = Math.min(frameSize, totalSamples - offset);
      const planar = new Float32Array(framesInChunk * channelCount);
      if (channelCount === 1) {
        planar.set(channel0.subarray(offset, offset + framesInChunk), 0);
      } else {
        planar.set(channel0.subarray(offset, offset + framesInChunk), 0);
        planar.set(channel1.subarray(offset, offset + framesInChunk), framesInChunk);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: audio.sampleRate,
        numberOfFrames: framesInChunk,
        numberOfChannels: channelCount,
        timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
        data: planar,
      });
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
      samplesEncoded += framesInChunk;
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
        if (failure) throw failure;
        await delay(2);
      }
      if (offset === 0 || offset % (frameSize * 16) === 0 || samplesEncoded >= totalSamples) {
        const percent = Math.min(100, Math.round((samplesEncoded / Math.max(1, totalSamples)) * 100));
        emit(
          'encoding',
          totalFrames,
          `Encoding audio ${percent}% (${samplesEncoded.toLocaleString()} / ${totalSamples.toLocaleString()} samples)`,
        );
      }
    }

    emit('encoding', totalFrames, 'Flushing audio encoder…');
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    closeEncoder(encoder);
  }
}

/** Render, encode and mux the edited sequence into an MP4 file. */
export async function runWebCodecsExport(options: WebCodecsExportOptions): Promise<ExportResult> {
  const { settings, range, video, audio, audioBuffer, canvas, renderer, callbacks, warnings } = options;
  const frameRate = settings.frameRate;
  const fps = fpsOf(frameRate);
  const totalFrames = outputFrameCount(range, frameRate);
  const keyFrameInterval = Math.max(1, Math.round(fps * 2));
  const videoCodec: ExportVideoCodec = video.family === 'h264' ? 'h264' : 'vp9';
  const emit = (phase: 'rendering' | 'encoding' | 'muxing', framesDone: number, message: string): void => {
    callbacks.onProgress?.({ phase, framesDone, totalFrames, message });
  };
  const checkCancelled = (): void => {
    if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
  };

  let videoEncoder: VideoEncoder | null = null;
  let encoderFailure: Error | null = null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: video.family === 'h264' ? 'avc' : 'vp9',
      width: settings.width,
      height: settings.height,
      frameRate: fps,
    },
    audio:
      audio && audioBuffer
        ? {
            codec: audio.codec,
            numberOfChannels: Math.max(1, Math.min(2, audio.numberOfChannels)),
            sampleRate: audio.sampleRate,
          }
        : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  try {
    videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        try {
          muxer.addVideoChunk(chunk, sanitizeVideoMetadata(metadata, video.family));
        } catch (error) {
          encoderFailure = encoderFailure ?? toExportError(error, 'Video chunk could not be muxed.', 'muxer');
        }
      },
      error: (error) => {
        encoderFailure = encoderFailure ?? toExportError(error, 'Video encoding failed.', 'encode');
      },
    });
    try {
      videoEncoder.configure(video.config);
    } catch (error) {
      throw new ExportCapabilityError(
        `The ${video.codec} video encoder could not be configured for ${settings.width}×${settings.height}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    emit('rendering', 0, `Rendering ${totalFrames} frame${totalFrames === 1 ? '' : 's'}…`);
    for (let index = 0; index < totalFrames; index += 1) {
      checkCancelled();
      if (encoderFailure) throw encoderFailure;
      await renderer.renderFrame(index);
      const timestamp = Math.round((index * 1_000_000 * frameRate.den) / frameRate.num);
      const duration = Math.max(1, Math.round((1_000_000 * frameRate.den) / frameRate.num));
      const videoFrame = new VideoFrame(canvas, { timestamp, duration });
      try {
        videoEncoder.encode(videoFrame, { keyFrame: index % keyFrameInterval === 0 });
      } finally {
        videoFrame.close();
      }
      const percent = Math.floor(((index + 1) / totalFrames) * 100);
      emit('rendering', index + 1, `Rendering frame ${index + 1} of ${totalFrames} (${percent}%)`);
      await drainVideoEncoder(videoEncoder, callbacks, () => encoderFailure);
    }

    emit('encoding', totalFrames, 'Flushing video encoder…');
    await videoEncoder.flush();
    if (encoderFailure) throw encoderFailure;
    closeEncoder(videoEncoder);
    videoEncoder = null;

    if (audio && audioBuffer) {
      await encodeAudioTrack({ muxer, audio, audioBuffer, totalFrames, callbacks, emit });
    } else if (settings.audioEnabled && !audio) {
      warnings.add('No audio encoder was available; the MP4 is video-only.');
    }

    emit('muxing', totalFrames, 'Writing MP4 container…');
    muxer.finalize();
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new ExportError('The muxer produced an empty media file.', 'muxer');
    }
    const blob = new Blob([buffer], { type: 'video/mp4' });
    if (blob.size === 0) {
      throw new ExportError('The encoded MP4 is empty.', 'muxer');
    }
    const result: ExportResult = {
      blob,
      fileName: buildExportFileName(settings.fileName, 'mp4'),
      mimeType: 'video/mp4',
      container: 'mp4',
      videoCodec,
      audioCodec: audio && audioBuffer ? audio.codec : null,
      width: settings.width,
      height: settings.height,
      frameRate: { ...frameRate },
      totalFrames,
      durationSeconds: range.durationSeconds,
      sizeBytes: blob.size,
      fallback: 'none',
      warnings: warnings.list(),
      usedRange: range,
    };
    callbacks.onProgress?.({ phase: 'done', framesDone: totalFrames, totalFrames, message: 'Export complete.' });
    return result;
  } catch (error) {
    throw toExportError(error, 'Video export failed.', 'encode');
  } finally {
    closeEncoder(videoEncoder);
  }
}
