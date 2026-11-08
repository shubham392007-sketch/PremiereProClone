/**
 * Program playback engine.
 *
 * The authoritative playback clock is `performance.now()` at the sequence
 * frame rate — never React render cadence. Every animation frame the engine
 * derives the current frame from the clock, publishes it to
 * `usePlaybackStore` only when the integer frame changes (so the UI timecode
 * updates at frame rate, not rAF rate), keeps the media elements in sync and
 * composites the sequence into the Program Monitor canvas.
 *
 * Responsibilities:
 *  - playback transport: play/pause/toggle/seek/step/jump/rate/loop
 *  - compose V1..Vn bottom-to-top with transforms, opacity, images and gaps
 *  - synchronize one hidden media element per active clip, with drift repair
 *  - audio gain through Web Audio (clip gain/fades/track mute/solo)
 *  - frame-stepped reverse playback (browsers cannot play media backwards)
 *  - surface offline / decode / autoplay-blocked status to the UI
 *  - dispose every element, listener, timer and store subscription
 */

import type { MediaAsset, Sequence, TimelineClip } from '@/types';
import { getActiveSequence, useProjectStore } from '@/stores/project-store';
import { useMediaStore } from '@/stores/media-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { clamp, frameDurationMs, sequenceDurationFrames } from '@/utils/time';
import { activeClipsAt, clipAtFrame, getAudioTracks, getVideoTracks } from '@/engine/timeline/operations';
import {
  anyAudioTrackSoloed,
  clampMediaTime,
  clipGainAtLocalFrame,
  effectiveTrackGain,
} from '@/utils/audio';
import { sourceSecondsForTimelineFrame } from '@/utils/media-frames';
import {
  compositeSequenceFrame,
  previewQualityDivisor,
  type CompositeFrameProvider,
  type CompositeFrameReport,
} from '@/engine/compositor/composite-frame';
import { MediaAudioGraph } from '@/engine/audio/media-audio-graph';
import { MediaElementCache } from './media-element-cache';
import { frameAtElapsedMs, integerFrameAtElapsedMs } from './playback-clock';

/** Drift further than this (seconds) is corrected by seeking the element. */
const MAX_DRIFT_SECONDS = 0.12;
/** Ignore sub-frame seek noise when parking a paused element. */
const PAUSED_SEEK_EPSILON = 0.004;
/** In reverse mode, re-seek when the element is more than this behind. */
const REVERSE_SEEK_EPSILON = 0.02;

export interface ProgramEngineStatus {
  hasSequence: boolean;
  canvasReady: boolean;
  playing: boolean;
  rate: number;
  loop: boolean;
  durationFrames: number;
  hasClips: boolean;
  /** Names of active clips whose media is offline at the playhead. */
  offlineNames: string[];
  /** Human readable decode errors (deduplicated). */
  decodeErrors: string[];
  /** Active clips still waiting for their first decoded frame. */
  unreadyClips: number;
  autoplayBlocked: boolean;
}

export type ProgramStatusListener = (status: ProgramEngineStatus) => void;

const RATE_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, -1, -2, -4];

function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate === 0) return 1;
  const clamped = clamp(rate, -16, 16);
  // Snap near-standard NLE speeds so J/K/L and speed menus never leave
  // the timeline at a fractional rate like 1.0000001.
  let best = clamped;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const preset of RATE_PRESETS) {
    const distance = Math.abs(preset - clamped);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = preset;
    }
  }
  return bestDistance <= 0.02 ? best : Math.round(clamped * 1000) / 1000;
}

export class ProgramPlaybackEngine {
  private readonly audioGraph = new MediaAudioGraph();
  private readonly mediaCache: MediaElementCache;
  private readonly listeners = new Set<ProgramStatusListener>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly decodeErrors = new Map<string, string>();
  private readonly provider: CompositeFrameProvider;

  private mediaMap = new Map<string, MediaAsset>();
  private projectMediaIds = new Set<string>();

  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;

  private rafId: number | null = null;
  private drawRafId: number | null = null;
  private running = false;
  private disposed = false;

  private rate = 1;
  private anchorFrame = 0;
  private anchorTime = 0;
  private lastTickFrame = -1;

  private internalFrameWrites = 0;
  private internalRateWrites = 0;
  private autoplayBlocked = false;
  private lastStatusSignature = '';
  private lastReport: CompositeFrameReport | null = null;

  constructor() {
    this.mediaCache = new MediaElementCache(
      {
        getUrl: (mediaId) => useMediaStore.getState().urls[mediaId],
        onNeedsRedraw: () => this.requestDraw(),
        onElementError: (mediaId, message) => this.handleElementError(mediaId, message),
      },
      this.audioGraph,
    );
    this.provider = {
      getMediaAsset: (mediaId) => this.mediaMap.get(mediaId),
      hasMediaSource: (mediaId) => Boolean(useMediaStore.getState().urls[mediaId]),
      getFrameSource: (clip, asset) => this.mediaCache.getFrameSource(clip, asset),
    };
    this.refreshProjectCache();
    this.subscribeStores();
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  private subscribeStores(): void {
    this.unsubscribers.push(
      useProjectStore.subscribe((state, previous) => {
        if (state.project !== previous.project) this.handleProjectChange();
      }),
    );
    this.unsubscribers.push(
      useMediaStore.subscribe((state, previous) => {
        if (state.urls !== previous.urls) this.handleMediaUrlsChange();
      }),
    );
    this.unsubscribers.push(
      usePlaybackStore.subscribe((state, previous) => {
        if (state.programQuality !== previous.programQuality) {
          this.syncCanvasSize();
          this.requestDraw();
        }
        if (state.rate !== previous.rate && this.internalRateWrites === 0) {
          this.applyRate(state.rate, false);
        }
        if (state.currentFrame !== previous.currentFrame && this.internalFrameWrites === 0) {
          this.handleExternalFrameChange(state.currentFrame);
        }
      }),
    );
  }

  private refreshProjectCache(): void {
    const project = useProjectStore.getState().project;
    this.mediaMap = new Map((project?.media ?? []).map((asset) => [asset.id, asset]));
    this.projectMediaIds = new Set(this.mediaMap.keys());
  }

  private handleProjectChange(): void {
    if (this.disposed) return;
    this.refreshProjectCache();
    const sequence = getActiveSequence();
    this.mediaCache.sync(sequence, this.projectMediaIds);
    this.decodeErrors.clear();

    if (!sequence) {
      this.stopInternal();
      this.clearCanvas();
      this.lastReport = null;
      this.emitStatus();
      return;
    }

    this.syncCanvasSize();
    const duration = sequenceDurationFrames(sequence);
    const playback = usePlaybackStore.getState();

    if (duration <= 0) {
      if (playback.currentFrame !== 0) this.setStoreFrame(0);
    } else if (playback.currentFrame > duration - 1) {
      this.setStoreFrame(duration - 1);
    }

    const frame = usePlaybackStore.getState().currentFrame;
    if (this.running) {
      this.anchorFrame = frame;
      this.anchorTime = performance.now();
      this.lastTickFrame = -1;
      this.syncActiveMedia(frame, true);
    } else {
      this.pausedSyncAt(frame);
    }
    this.requestDraw();
    this.emitStatus();
  }

  private handleMediaUrlsChange(): void {
    if (this.disposed) return;
    const sequence = getActiveSequence();
    this.mediaCache.sync(sequence, this.projectMediaIds);
    this.decodeErrors.clear();
    const frame = usePlaybackStore.getState().currentFrame;
    if (this.running) this.syncActiveMedia(frame, true);
    else this.pausedSyncAt(frame);
    this.requestDraw();
    this.emitStatus();
  }

  private handleExternalFrameChange(frame: number): void {
    if (this.disposed) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    if (this.running) {
      this.anchorFrame = frame;
      this.anchorTime = performance.now();
      this.lastTickFrame = -1;
      this.syncActiveMedia(frame, true);
    } else {
      this.pausedSyncAt(frame);
    }
    this.requestDraw();
    this.emitStatus();
  }

  private handleElementError(mediaId: string, message: string): void {
    if (this.decodeErrors.get(mediaId) === message) return;
    this.decodeErrors.set(mediaId, message);
    this.emitStatus();
    this.requestDraw();
  }

  /* ------------------------------------------------------------------ */
  /* public api                                                          */
  /* ------------------------------------------------------------------ */

  attach(canvas: HTMLCanvasElement): void {
    if (this.disposed) return;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.syncCanvasSize();
    this.pausedSyncAt(usePlaybackStore.getState().currentFrame);
    this.requestDraw();
    this.emitStatus();
  }

  detach(): void {
    this.stopInternal();
    this.cancelDraw();
    this.canvas = null;
    this.context = null;
    this.emitStatus();
  }

  isReady(): boolean {
    return Boolean(this.canvas && this.context && getActiveSequence());
  }

  play(): void {
    if (this.disposed || this.running) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const duration = sequenceDurationFrames(sequence);
    const playback = usePlaybackStore.getState();
    if (duration <= 0) {
      playback.setIsPlaying(false);
      this.emitStatus();
      return;
    }
    let frame = Number.isFinite(playback.currentFrame) ? Math.round(playback.currentFrame) : 0;
    if (frame < 0 || frame >= duration - 1) frame = 0;
    this.autoplayBlocked = false;
    this.startLoopAt(frame);
    this.emitStatus();
  }

  pause(): void {
    if (this.disposed) return;
    this.stopInternal();
    this.emitStatus();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  seek(frame: number, options?: { keepPlaying?: boolean }): void {
    if (this.disposed) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const duration = sequenceDurationFrames(sequence);
    if (duration <= 0) {
      this.setStoreFrame(0);
      this.requestDraw();
      return;
    }
    const target = clamp(Math.round(frame), 0, duration - 1);
    const keepPlaying = options?.keepPlaying ?? this.running;
    this.autoplayBlocked = false;
    if (keepPlaying) {
      this.startLoopAt(target);
    } else {
      this.stopInternal();
      this.setStoreFrame(target);
      this.pausedSyncAt(target);
      this.requestDraw();
    }
    this.emitStatus();
  }

  step(deltaFrames: number): void {
    if (this.disposed) return;
    if (this.running) this.stopInternal();
    const current = usePlaybackStore.getState().currentFrame;
    this.seek(current + Math.trunc(deltaFrames), { keepPlaying: false });
  }

  jumpToStart(): void {
    this.seek(0);
  }

  jumpToEnd(): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    this.seek(Math.max(0, sequenceDurationFrames(sequence) - 1), { keepPlaying: false });
  }

  setRate(rate: number): void {
    if (this.disposed) return;
    const normalized = normalizePlaybackRate(rate);
    this.applyRate(normalized, true);
    // J/K/L semantics: picking a speed while parked starts playback in that
    // direction (J = reverse, L = forward, K = pause is the play/pause button).
    if (!this.running) {
      const sequence = getActiveSequence();
      if (sequence && sequenceDurationFrames(sequence) > 0 && normalized !== 0) {
        this.play();
      }
    }
  }

  /** Force a repaint (canvas resize, relink, manual refresh). */
  redraw(): void {
    this.requestDraw();
  }

  /**
   * Recover from a blocked autoplay: unmute elements and retry playback.
   * Called from a real user gesture (the "Enable audio" prompt).
   */
  resumeAudio(): void {
    if (this.disposed) return;
    this.autoplayBlocked = false;
    void this.audioGraph.resume();
    this.mediaCache.forEachElement((element) => {
      if (element.muted) element.muted = false;
    });
    const frame = usePlaybackStore.getState().currentFrame;
    if (this.running) this.syncActiveMedia(frame, true);
    this.emitStatus();
  }

  /** Drop cached elements + decode errors and try loading media again. */
  refresh(): void {
    if (this.disposed) return;
    this.decodeErrors.clear();
    this.mediaCache.releaseAllClipElements();
    const frame = usePlaybackStore.getState().currentFrame;
    if (this.running) this.syncActiveMedia(frame, true);
    else this.pausedSyncAt(frame);
    this.requestDraw();
    this.emitStatus();
  }

  getStatus(): ProgramEngineStatus {
    return this.buildStatus();
  }

  subscribeStatus(listener: ProgramStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.buildStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopInternal();
    this.cancelDraw();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.mediaCache.dispose();
    this.audioGraph.dispose();
    this.listeners.clear();
    this.canvas = null;
    this.context = null;
    this.lastReport = null;
    usePlaybackStore.getState().setIsPlaying(false);
  }

  /* ------------------------------------------------------------------ */
  /* playback clock                                                      */
  /* ------------------------------------------------------------------ */

  private startLoopAt(frame: number): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const duration = sequenceDurationFrames(sequence);
    if (duration <= 0) return;
    this.anchorFrame = clamp(Math.round(frame), 0, duration - 1);
    this.anchorTime = performance.now();
    this.lastTickFrame = -1;
    this.running = true;
    usePlaybackStore.getState().setIsPlaying(true);
    this.setStoreFrame(this.anchorFrame);
    void this.audioGraph.resume();
    // A fresh play gesture is allowed to unmute elements that the previous
    // attempt had to silence because of the autoplay policy.
    if (!this.autoplayBlocked) {
      this.mediaCache.forEachElement((element) => {
        if (element.muted) element.muted = false;
      });
    }
    this.syncActiveMedia(this.anchorFrame, true);
    this.requestDraw();
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  }

  private stopInternal(): void {
    const wasRunning = this.running;
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.mediaCache.pauseAll();
    this.autoplayBlocked = false;
    this.lastTickFrame = -1;
    usePlaybackStore.getState().setIsPlaying(false);
    if (wasRunning) {
      const frame = usePlaybackStore.getState().currentFrame;
      this.pausedSyncAt(frame);
      this.requestDraw();
    }
  }

  private applyRate(rate: number, writeStore: boolean): void {
    const normalized = normalizePlaybackRate(rate);
    if (this.rate === normalized) {
      if (writeStore) this.writeStoreRate(normalized);
      return;
    }
    this.rate = normalized;
    if (writeStore) this.writeStoreRate(normalized);
    if (this.running) {
      this.anchorFrame = usePlaybackStore.getState().currentFrame;
      this.anchorTime = performance.now();
      this.lastTickFrame = -1;
      this.syncActiveMedia(this.anchorFrame, true);
    }
    this.emitStatus();
  }

  private tick = (): void => {
    this.rafId = null;
    if (!this.running || this.disposed) return;
    const sequence = getActiveSequence();
    if (!sequence) {
      this.stopInternal();
      this.requestDraw();
      return;
    }
    const duration = sequenceDurationFrames(sequence);
    if (duration <= 0) {
      this.stopInternal();
      this.requestDraw();
      return;
    }

    const now = performance.now();
    const msPerFrame = frameDurationMs(sequence.frameRate);
    const elapsed = now - this.anchorTime;
    const raw = frameAtElapsedMs(this.anchorFrame, elapsed, this.rate, msPerFrame);
    const lastFrame = Math.max(0, duration - 1);
    const loop = usePlaybackStore.getState().loop;

    const reachedEnd = this.rate > 0 && raw >= duration - 0.0001;
    const reachedStart = this.rate < 0 && raw <= 0;

    if (reachedEnd) {
      if (loop) {
        this.anchorFrame = 0;
        this.anchorTime = now;
        this.lastTickFrame = -1;
        this.setStoreFrame(0);
        this.syncActiveMedia(0, true);
        this.requestDraw();
        this.emitStatus();
        this.rafId = requestAnimationFrame(this.tick);
        return;
      }
      this.setStoreFrame(lastFrame);
      this.stopInternal();
      this.pausedSyncAt(lastFrame);
      this.requestDraw();
      this.emitStatus();
      return;
    }

    if (reachedStart) {
      if (loop) {
        this.anchorFrame = lastFrame;
        this.anchorTime = now;
        this.lastTickFrame = -1;
        this.setStoreFrame(lastFrame);
        this.syncActiveMedia(lastFrame, true);
        this.requestDraw();
        this.emitStatus();
        this.rafId = requestAnimationFrame(this.tick);
        return;
      }
      this.setStoreFrame(0);
      this.stopInternal();
      this.pausedSyncAt(0);
      this.requestDraw();
      this.emitStatus();
      return;
    }

    const frame = clamp(integerFrameAtElapsedMs(this.anchorFrame, elapsed, this.rate, msPerFrame), 0, lastFrame);
    if (frame !== this.lastTickFrame) {
      this.lastTickFrame = frame;
      this.setStoreFrame(frame);
      this.syncActiveMedia(frame, true);
    }
    this.draw();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /* ------------------------------------------------------------------ */
  /* media synchronization                                               */
  /* ------------------------------------------------------------------ */

  private syncActiveMedia(frame: number, playing: boolean): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const safeFrame = Math.max(0, Math.round(frame));
    const activeIds = new Set<string>();
    const hasAudioSolo = anyAudioTrackSoloed(sequence);

    for (const track of getVideoTracks(sequence)) {
      if (track.hidden || !track.enabled) continue;
      const clip = clipAtFrame(sequence, track.id, safeFrame);
      if (!clip || !clip.enabled) continue;
      const asset = this.mediaMap.get(clip.mediaId);
      if (!asset || asset.missing) continue;
      const element = this.mediaCache.ensureVideo(clip, asset);
      if (!element) continue;
      activeIds.add(clip.id);
      const localFrame = safeFrame - clip.startFrame;
      // Video clips carry their own audio. Soloing an audio track mutes it.
      // (We do not gate on `asset.hasAudio`: that probe is best-effort, and a
      // silent video simply produces silence when played.)
      const gain = clipGainAtLocalFrame(clip, localFrame) * (hasAudioSolo ? 0 : 1);
      this.driveElement(element, clip, asset, safeFrame, playing, gain);
    }

    for (const track of getAudioTracks(sequence)) {
      if (track.hidden || !track.enabled) continue;
      const clip = clipAtFrame(sequence, track.id, safeFrame);
      if (!clip || !clip.enabled) continue;
      const asset = this.mediaMap.get(clip.mediaId);
      if (!asset || asset.missing) continue;
      const element = this.mediaCache.ensureAudio(clip, asset);
      if (!element) continue;
      activeIds.add(clip.id);
      const localFrame = safeFrame - clip.startFrame;
      const gain = clipGainAtLocalFrame(clip, localFrame) * effectiveTrackGain(sequence, track);
      this.driveElement(element, clip, asset, safeFrame, playing, gain);
    }

    this.mediaCache.pauseInactive(activeIds);
  }

  /** Park every active element at the paused playhead so stills draw correctly. */
  private pausedSyncAt(frame: number): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const safeFrame = Math.max(0, Math.round(frame));
    this.mediaCache.pauseAll();

    for (const track of getVideoTracks(sequence)) {
      if (track.hidden || !track.enabled) continue;
      const clip = clipAtFrame(sequence, track.id, safeFrame);
      if (!clip || !clip.enabled) continue;
      const asset = this.mediaMap.get(clip.mediaId);
      if (!asset || asset.missing) continue;
      const element = this.mediaCache.ensureVideo(clip, asset);
      if (!element) continue;
      this.mediaCache.setElementGain(element, 0);
      this.positionElement(element, clip, asset, safeFrame);
    }

    for (const track of getAudioTracks(sequence)) {
      if (track.hidden || !track.enabled) continue;
      const clip = clipAtFrame(sequence, track.id, safeFrame);
      if (!clip || !clip.enabled) continue;
      const asset = this.mediaMap.get(clip.mediaId);
      if (!asset || asset.missing) continue;
      const element = this.mediaCache.ensureAudio(clip, asset);
      if (!element) continue;
      this.mediaCache.setElementGain(element, 0);
      this.positionElement(element, clip, asset, safeFrame);
    }
  }

  private positionElement(
    element: HTMLMediaElement,
    clip: TimelineClip,
    asset: MediaAsset,
    frame: number,
  ): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const expected = sourceSecondsForTimelineFrame(clip, frame, sequence);
    const target = clampMediaTime(expected, asset.durationSec);
    if (!Number.isFinite(target)) return;
    if (Math.abs(element.currentTime - target) > PAUSED_SEEK_EPSILON) {
      try {
        element.currentTime = target;
      } catch {
        /* element may not be seekable yet; the next loadeddata/seeked repaints */
      }
    }
  }

  private driveElement(
    element: HTMLMediaElement,
    clip: TimelineClip,
    asset: MediaAsset,
    frame: number,
    playing: boolean,
    gain: number,
  ): void {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const expected = sourceSecondsForTimelineFrame(clip, frame, sequence);
    const target = clampMediaTime(expected, asset.durationSec);

    if (!playing) {
      element.pause();
      this.mediaCache.setElementGain(element, 0);
      return;
    }

    if (this.rate > 0) {
      this.mediaCache.setElementGain(element, gain);
      if (Math.abs(element.playbackRate - this.rate) > 0.001) {
        try {
          element.playbackRate = this.rate;
        } catch {
          /* unsupported rate for this media element */
        }
      }
      const drift = Math.abs(element.currentTime - target);
      if ((element.paused || element.ended || drift > MAX_DRIFT_SECONDS) && Number.isFinite(target)) {
        try {
          element.currentTime = target;
        } catch {
          /* ignore seek failures */
        }
      }
      this.safePlay(element);
      return;
    }

    // Reverse: browsers cannot play media backwards. Park the element and
    // seek it once per displayed frame (frame-stepped reverse).
    element.pause();
    this.mediaCache.setElementGain(element, 0);
    if (Math.abs(element.currentTime - target) > REVERSE_SEEK_EPSILON && Number.isFinite(target)) {
      try {
        element.currentTime = target;
      } catch {
        /* ignore */
      }
    }
  }

  private safePlay(element: HTMLMediaElement): void {
    if (!element.paused) return;
    try {
      const promise = element.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch((error: unknown) => {
          const name = error instanceof Error ? error.name : '';
          if (name === 'NotAllowedError') {
            this.handleAutoplayBlocked(element);
          }
          // AbortError is normal when a seek interrupts play(); ignore it.
        });
      }
    } catch {
      /* play() may throw synchronously in unusual states */
    }
  }

  /**
   * Autoplay policy rejected unmuted playback. Mute this element and retry so
   * the picture keeps advancing (silent), and surface a prompt to enable audio.
   */
  private handleAutoplayBlocked(element: HTMLMediaElement): void {
    if (this.disposed) return;
    const firstBlock = !this.autoplayBlocked;
    this.autoplayBlocked = true;
    try {
      element.muted = true;
    } catch {
      /* ignore */
    }
    if (element.paused) {
      try {
        const retry = element.play();
        if (retry && typeof retry.catch === 'function') retry.catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    if (firstBlock) this.emitStatus();
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  private syncCanvasSize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const divisor = previewQualityDivisor(usePlaybackStore.getState().programQuality);
    const width = Math.max(2, Math.round(sequence.width / divisor));
    const height = Math.max(2, Math.round(sequence.height / divisor));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      // Resizing resets context state.
      this.context = canvas.getContext('2d', { alpha: false });
    }
  }

  private requestDraw(): void {
    if (this.disposed || this.drawRafId !== null) return;
    this.drawRafId = requestAnimationFrame(() => {
      this.drawRafId = null;
      this.draw();
    });
  }

  private cancelDraw(): void {
    if (this.drawRafId !== null) {
      cancelAnimationFrame(this.drawRafId);
      this.drawRafId = null;
    }
  }

  private draw(): void {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context) return;
    this.syncCanvasSize();
    const sequence = getActiveSequence();
    const playback = usePlaybackStore.getState();
    if (!sequence) {
      this.clearCanvas();
      this.lastReport = null;
      this.emitStatus();
      return;
    }
    const divisor = previewQualityDivisor(playback.programQuality);
    const report = compositeSequenceFrame(context, sequence, playback.currentFrame, this.provider, divisor);
    this.lastReport = report;
    this.emitStatus();
  }

  private clearCanvas(): void {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  /* ------------------------------------------------------------------ */
  /* status                                                              */
  /* ------------------------------------------------------------------ */

  private buildStatus(): ProgramEngineStatus {
    const sequence = getActiveSequence();
    const playback = usePlaybackStore.getState();
    const duration = sequence ? sequenceDurationFrames(sequence) : 0;
    return {
      hasSequence: Boolean(sequence),
      canvasReady: Boolean(this.canvas && this.context),
      playing: this.running,
      rate: this.rate,
      loop: playback.loop,
      durationFrames: duration,
      hasClips: Boolean(sequence && sequence.clips.length > 0),
      offlineNames: this.currentOfflineNames(sequence, playback.currentFrame),
      decodeErrors: [...this.decodeErrors.values()],
      unreadyClips: this.lastReport?.unreadyClips ?? 0,
      autoplayBlocked: this.autoplayBlocked,
    };
  }

  private currentOfflineNames(sequence: Sequence | null, frame: number): string[] {
    if (!sequence) return [];
    const safeFrame = Math.max(0, Math.round(frame));
    const names = new Set<string>();
    for (const track of sequence.tracks) {
      if (!track.enabled || track.hidden) continue;
      const clip = clipAtFrame(sequence, track.id, safeFrame);
      if (!clip || !clip.enabled) continue;
      const asset = this.mediaMap.get(clip.mediaId);
      if (!asset || asset.missing || !useMediaStore.getState().urls[clip.mediaId]) {
        names.add(clip.name?.trim() || asset?.name || 'Missing media');
      }
    }
    return [...names];
  }

  private emitStatus(): void {
    if (this.disposed) return;
    const status = this.buildStatus();
    const signature = JSON.stringify(status);
    if (signature === this.lastStatusSignature) return;
    this.lastStatusSignature = signature;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        /* a broken UI listener must never stop playback */
      }
    }
  }

  private setStoreFrame(frame: number): void {
    this.internalFrameWrites += 1;
    try {
      usePlaybackStore.getState().setCurrentFrame(frame);
    } finally {
      this.internalFrameWrites -= 1;
    }
  }

  private writeStoreRate(rate: number): void {
    this.internalRateWrites += 1;
    try {
      usePlaybackStore.getState().setRate(rate);
    } finally {
      this.internalRateWrites -= 1;
    }
  }
}

/** Convenience re-export so UI code can format the clock without extra imports. */
export { sequenceDurationFrames, activeClipsAt };
