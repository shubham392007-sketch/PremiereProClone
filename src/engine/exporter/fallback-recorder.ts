/**
 * MediaRecorder WebM fallback export.
 *
 * Used only when WebCodecs video encoding is unavailable. Because MediaRecorder
 * is a real-time capture API, this path renders the timeline in real time (the
 * progress reported is still actual rendered frame counts). Output is a WebM
 * file, which is the only container MediaRecorder reliably produces.
 */
import type { ExportSettings } from '@/types';
import { fpsOf } from '@/utils/time';
import { pickWebmMimeType } from './capabilities';
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
} from './types';
import type { TimelineFrameRenderer } from './video-renderer';

export interface MediaRecorderExportOptions {
  settings: ExportSettings;
  range: ExportRange;
  canvas: HTMLCanvasElement;
  renderer: TimelineFrameRenderer;
  audioBuffer: AudioBuffer | null;
  audioSampleRate: number;
  callbacks: ExportCallbacks;
  warnings: WarningCollector;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* stream already released */
  }
}

/** Render the timeline in real time and capture it with MediaRecorder. */
export async function runMediaRecorderExport(options: MediaRecorderExportOptions): Promise<ExportResult> {
  const { settings, range, canvas, renderer, audioBuffer, audioSampleRate, callbacks, warnings } = options;
  const mimeType = pickWebmMimeType();
  if (!mimeType) {
    throw new ExportCapabilityError(
      'WebCodecs MP4 encoding is unavailable and this browser cannot record WebM video. Use a recent Chromium-based browser.',
    );
  }
  if (typeof canvas.captureStream !== 'function') {
    throw new ExportCapabilityError('Canvas capture is not supported in this browser, so the WebM fallback cannot run.');
  }

  const frameRate = settings.frameRate;
  const fps = Math.max(1, fpsOf(frameRate));
  const totalFrames = outputFrameCount(range, frameRate);
  const frameDurationMs = 1000 / fps;
  const emit = (phase: 'rendering' | 'encoding' | 'muxing', framesDone: number, message: string): void => {
    callbacks.onProgress?.({ phase, framesDone, totalFrames, message });
  };
  const checkCancelled = (): void => {
    if (callbacks.shouldCancel?.()) throw new ExportCancelledError();
  };

  // The canvas is kept in the document (offscreen) during capture for maximum
  // browser compatibility; it is removed again in the finally block.
  let canvasAttached = false;
  if (!canvas.isConnected && typeof document !== 'undefined' && document.body) {
    canvas.style.position = 'fixed';
    canvas.style.left = '-100000px';
    canvas.style.top = '0px';
    canvas.style.width = `${settings.width}px`;
    canvas.style.height = `${settings.height}px`;
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    canvasAttached = true;
  }

  let audioContext: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let canvasStream: MediaStream | null = null;
  let combinedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let recorderStopped: Promise<void> | null = null;
  const chunks: BlobPart[] = [];
  let lateFrames = 0;
  let lastEmittedPercent = -1;

  try {
    canvasStream = canvas.captureStream(fps);
    if (!canvasStream.getVideoTracks().length) {
      throw new ExportCapabilityError('Canvas capture produced no video track.');
    }

    if (audioBuffer && settings.audioEnabled) {
      try {
        audioContext = new AudioContext({ sampleRate: audioSampleRate });
        if (audioContext.state === 'suspended') await audioContext.resume();
        if (audioContext.state !== 'running') {
          warnings.add('The browser blocked real-time audio playback; the WebM fallback is video-only.');
        } else {
          audioDestination = audioContext.createMediaStreamDestination();
          audioSource = audioContext.createBufferSource();
          audioSource.buffer = audioBuffer;
          audioSource.connect(audioDestination);
        }
      } catch {
        warnings.add('Real-time audio playback could not be started; the WebM fallback is video-only.');
        audioDestination = null;
        audioSource = null;
      }
    }

    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (audioDestination) tracks.push(...audioDestination.stream.getAudioTracks());
    combinedStream = new MediaStream(tracks);

    recorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: Math.max(100_000, Math.round(settings.videoBitrate)),
      audioBitsPerSecond: Math.max(32_000, Math.round(settings.audioBitrate)),
    });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      if (!recorder) {
        resolve();
        return;
      }
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new ExportError('MediaRecorder failed while capturing the timeline.', 'encode'));
    });
    recorderStopped = stopped;

    recorder.start(500);
    if (audioSource && audioContext) {
      // Start audio as capture begins; a large offset would desync A/V.
      try {
        audioSource.start();
      } catch {
        warnings.add('Real-time audio playback could not be started; the WebM fallback is video-only.');
      }
    }

    emit('rendering', 0, `Recording in real time (WebM fallback) — ${totalFrames} frames…`);
    const startedAt = performance.now();
    for (let index = 0; index < totalFrames; index += 1) {
      checkCancelled();
      const targetTime = startedAt + index * frameDurationMs;
      const now = performance.now();
      if (now < targetTime) await delay(targetTime - now);
      await renderer.renderFrame(index);
      const percent = Math.floor(((index + 1) / totalFrames) * 100);
      if (percent !== lastEmittedPercent) {
        lastEmittedPercent = percent;
        emit(
          'rendering',
          index + 1,
          `Recording in real time (WebM fallback) — frame ${index + 1} of ${totalFrames} (${percent}%)`,
        );
      }
      if (performance.now() > targetTime + frameDurationMs) lateFrames += 1;
    }

    // Let the last rendered frame(s) reach the recorder before stopping.
    await delay(250);
    emit('muxing', totalFrames, 'Finalizing WebM recording…');
    if (recorder.state !== 'inactive') recorder.stop();
    if (recorderStopped) await recorderStopped;
    recorderStopped = null;

    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
    if (blob.size === 0) {
      throw new ExportError('MediaRecorder produced an empty WebM file.', 'muxer');
    }

    warnings.add(
      'WebCodecs MP4 encoding was unavailable, so this export is a real-time WebM (MediaRecorder) capture of the composited timeline.',
    );
    if (lateFrames > 0) {
      warnings.add(
        `The real-time fallback could not keep up on ${lateFrames} frame${lateFrames === 1 ? '' : 's'}; the WebM may contain duplicated or dropped frames.`,
      );
    }

    const result: ExportResult = {
      blob,
      fileName: buildExportFileName(settings.fileName, 'webm'),
      mimeType: blob.type || mimeType,
      container: 'webm',
      videoCodec: mimeType.includes('vp9') ? 'vp9' : 'vp8',
      audioCodec: audioDestination && settings.audioEnabled ? 'opus' : null,
      width: settings.width,
      height: settings.height,
      frameRate: { ...frameRate },
      totalFrames,
      durationSeconds: range.durationSeconds,
      sizeBytes: blob.size,
      fallback: 'webm-mediaRecorder',
      warnings: warnings.list(),
      usedRange: range,
    };
    callbacks.onProgress?.({ phase: 'done', framesDone: totalFrames, totalFrames, message: 'Export complete.' });
    return result;
  } catch (error) {
    throw toExportError(error, 'The realtime WebM export failed.', 'encode');
  } finally {
    try {
      audioSource?.stop();
    } catch {
      /* not started / already stopped */
    }
    try {
      audioSource?.disconnect();
      audioDestination?.disconnect();
    } catch {
      /* graph already torn down */
    }
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* recorder already stopped */
    }
    stopTracks(combinedStream);
    stopTracks(canvasStream);
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }
    if (canvasAttached) {
      try {
        canvas.remove();
      } catch {
        /* already detached */
      }
    }
  }
}
