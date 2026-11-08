/**
 * Timeline composite rendering for export.
 *
 * Each output frame is drawn onto a single canvas by walking the sequence's
 * video tracks from bottom (V1) to top, finding the clip active at that frame,
 * seeking the source `HTMLVideoElement` / decoding an image, and applying the
 * clip transform with `drawTransformedFrame`. Gaps intentionally render black,
 * exactly like the program monitor.
 */
import type { FrameRate, MediaAsset, Sequence, TimelineClip, Track } from '@/types';
import { getVideoTracks } from '@/engine/timeline/operations';
import { clampMediaTime } from '@/utils/audio';
import { sourceSecondsForTimelineFrame } from '@/utils/media-frames';
import { drawTransformedFrame } from '@/utils/render';
import { fpsOf } from '@/utils/time';
import type { ExportRange } from './types';
import type { ExportMediaResolver, WarningCollector } from './media-sources';

const SEEK_TIMEOUT_MS = 5_000;
const MEDIA_LOAD_TIMEOUT_MS = 12_000;
const BACKWARD_SEARCH_LIMIT = 256;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* frame sampling                                                      */
/* ------------------------------------------------------------------ */

interface TrackSampler {
  track: Track;
  /** enabled clips of this track sorted by start frame */
  clips: TimelineClip[];
  cursor: number;
}

/**
 * Finds the active clip per video track for monotonically increasing frames
 * (the export renders frames 0..N in order). Overlapping clips resolve to the
 * one with the highest start frame, matching the program monitor semantics.
 */
export class VideoFrameSampler {
  private readonly samplers: TrackSampler[] = [];

  constructor(sequence: Sequence) {
    const tracks = getVideoTracks(sequence).filter((track) => track.enabled && !track.hidden);
    for (const track of tracks) {
      const clips = sequence.clips
        .filter((clip) => clip.trackId === track.id && clip.enabled)
        .sort((a, b) => a.startFrame - b.startFrame);
      if (clips.length) this.samplers.push({ track, clips, cursor: -1 });
    }
  }

  activeAt(frame: number): { track: Track; clip: TimelineClip }[] {
    const result: { track: Track; clip: TimelineClip }[] = [];
    for (const sampler of this.samplers) {
      const clip = this.findClip(sampler, frame);
      if (clip) result.push({ track: sampler.track, clip });
    }
    return result;
  }

  private findClip(sampler: TrackSampler, frame: number): TimelineClip | undefined {
    const { clips } = sampler;
    if (!clips.length) return undefined;
    if (sampler.cursor < 0) {
      let index = 0;
      while (index < clips.length && clips[index].startFrame <= frame) index += 1;
      sampler.cursor = Math.max(0, index - 1);
    } else {
      while (sampler.cursor + 1 < clips.length && clips[sampler.cursor + 1].startFrame <= frame) {
        sampler.cursor += 1;
      }
    }
    // Walk backwards to honour overlapping clips (highest start wins) and to
    // survive range starts in the middle of a clip.
    let index = sampler.cursor;
    let guard = 0;
    while (index >= 0 && guard < BACKWARD_SEARCH_LIMIT) {
      const candidate = clips[index];
      if (candidate.startFrame <= frame && frame < candidate.startFrame + candidate.durationFrames) {
        return candidate;
      }
      if (candidate.startFrame > frame) {
        index -= 1;
        guard += 1;
        continue;
      }
      // candidate starts before the frame but has already ended: an earlier
      // clip may still be active when clips overlap, keep checking.
      index -= 1;
      guard += 1;
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* media element cache                                                 */
/* ------------------------------------------------------------------ */

interface CachedVideo {
  element: HTMLVideoElement;
  ready: Promise<boolean>;
  lastTarget: number;
  seekWarned: boolean;
  seekErrorWarned: boolean;
}

/**
 * Caches one `HTMLVideoElement` per source media so consecutive frames reuse
 * the same decoder instead of recreating elements (creation is expensive and
 * browsers cap concurrent media elements).
 */
export class MediaElementCache {
  private readonly videos = new Map<string, CachedVideo>();
  private readonly images = new Map<string, Promise<HTMLImageElement | null>>();
  private disposed = false;

  constructor(
    private readonly resolver: ExportMediaResolver,
    private readonly warnings: WarningCollector,
  ) {}

  async ensureVideo(mediaId: string): Promise<HTMLVideoElement | null> {
    const entry = this.getOrCreateVideo(mediaId);
    if (!entry) return null;
    const ready = await entry.ready;
    return ready && !this.disposed ? entry.element : null;
  }

  private getOrCreateVideo(mediaId: string): CachedVideo | null {
    const existing = this.videos.get(mediaId);
    if (existing) return existing;
    const url = this.resolver.url(mediaId);
    const asset = this.resolver.asset(mediaId);
    if (!url || !asset) return null;

    const element = document.createElement('video');
    element.preload = 'auto';
    element.muted = true;
    element.playsInline = true;
    element.setAttribute('playsinline', '');

    const ready = new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        element.removeEventListener('loadeddata', onLoaded);
        element.removeEventListener('canplay', onLoaded);
        element.removeEventListener('error', onError);
      };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      };
      const onLoaded = () => {
        if (element.videoWidth > 0 && element.readyState >= 2) finish(true);
      };
      const onError = () => finish(false);
      timer = setTimeout(() => finish(element.videoWidth > 0 && element.readyState >= 2), MEDIA_LOAD_TIMEOUT_MS);
      element.addEventListener('loadeddata', onLoaded);
      element.addEventListener('canplay', onLoaded);
      element.addEventListener('error', onError);
    });

    element.src = url;
    try {
      element.load();
    } catch {
      /* the error handler above reports the failure */
    }

    const entry: CachedVideo = { element, ready, lastTarget: -1, seekWarned: false, seekErrorWarned: false };
    this.videos.set(mediaId, entry);
    void ready.then((ok) => {
      if (!ok) {
        this.warnings.add(`"${asset.name}" could not be decoded for export (unsupported codec or unreadable file); its clips render as black.`);
      }
    });
    return entry;
  }

  /**
   * Seek a cached video element to the source time for one output frame.
   * Resolves true when a frame is drawable. Uses a timeout so a stuck decoder
   * can never hang the export.
   */
  async seekVideo(mediaId: string, seconds: number): Promise<boolean> {
    const entry = this.videos.get(mediaId);
    if (!entry || this.disposed) return false;
    const ready = await entry.ready;
    if (!ready) return false;
    const element = entry.element;
    const asset = this.resolver.asset(mediaId);
    const duration =
      Number.isFinite(element.duration) && element.duration > 0 ? element.duration : asset?.durationSec ?? 0;
    const target = clampMediaTime(seconds, duration);

    if (Math.abs(element.currentTime - target) < 1e-4 && element.readyState >= 2) {
      entry.lastTarget = target;
      return true;
    }

    let timedOut = false;
    const seeked = await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        element.removeEventListener('seeked', onSeeked);
        element.removeEventListener('error', onError);
      };
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onSeeked = () => finish(true);
      const onError = () => finish(false);
      timer = setTimeout(() => {
        timedOut = element.readyState >= 2;
        finish(timedOut);
      }, SEEK_TIMEOUT_MS);
      element.addEventListener('seeked', onSeeked);
      element.addEventListener('error', onError);
      try {
        element.currentTime = target;
      } catch {
        finish(false);
      }
    });

    if (!seeked) {
      if (!entry.seekErrorWarned) {
        entry.seekErrorWarned = true;
        this.warnings.add(`Could not seek "${asset?.name ?? 'media'}" during export; its frames were skipped.`);
      }
      return false;
    }
    if (timedOut && !entry.seekWarned) {
      entry.seekWarned = true;
      this.warnings.add(`Timed out seeking "${asset?.name ?? 'media'}"; some exported frames may be approximate.`);
    }
    // Give the compositor one task to settle before the caller draws.
    await delay(0);
    entry.lastTarget = target;
    return true;
  }

  getImage(mediaId: string): Promise<HTMLImageElement | null> {
    const existing = this.images.get(mediaId);
    if (existing) return existing;
    const url = this.resolver.url(mediaId);
    if (!url) return Promise.resolve(null);
    const asset = this.resolver.asset(mediaId);
    const promise = new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: HTMLImageElement | null) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        resolve(value);
      };
      image.onload = () => finish(image.naturalWidth > 0 ? image : null);
      image.onerror = () => {
        this.warnings.add(`"${asset?.name ?? 'Image'}" could not be decoded for export; it renders as transparent.`);
        finish(null);
      };
      timer = setTimeout(() => finish(image.complete && image.naturalWidth > 0 ? image : null), MEDIA_LOAD_TIMEOUT_MS);
      image.src = url;
    });
    this.images.set(mediaId, promise);
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.videos.values()) {
      try {
        entry.element.pause();
        entry.element.removeAttribute('src');
        entry.element.load();
      } catch {
        /* element already released */
      }
    }
    this.videos.clear();
    this.images.clear();
  }
}

/* ------------------------------------------------------------------ */
/* composite renderer                                                  */
/* ------------------------------------------------------------------ */

export interface TimelineRendererOptions {
  sequence: Sequence;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  resolver: ExportMediaResolver;
  elements: MediaElementCache;
  warnings: WarningCollector;
  range: ExportRange;
  outputFrameRate: FrameRate;
}

/**
 * Maps output frames (at the chosen export frame rate) onto sequence frames and
 * draws the composited result.
 */
export class TimelineFrameRenderer {
  private readonly sampler: VideoFrameSampler;
  private readonly sequence: Sequence;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;
  private readonly resolver: ExportMediaResolver;
  private readonly elements: MediaElementCache;
  private readonly warnings: WarningCollector;
  private readonly range: ExportRange;
  /** true when output fps === sequence fps so frames map 1:1 */
  private readonly sameRate: boolean;
  private readonly sequenceFps: number;
  private readonly outputFps: number;

  constructor(options: TimelineRendererOptions) {
    this.sequence = options.sequence;
    this.ctx = options.ctx;
    this.width = options.width;
    this.height = options.height;
    this.resolver = options.resolver;
    this.elements = options.elements;
    this.warnings = options.warnings;
    this.range = options.range;
    this.sampler = new VideoFrameSampler(options.sequence);
    const sequenceRate = options.sequence.frameRate;
    const outputRate = options.outputFrameRate;
    this.sameRate = sequenceRate.num * outputRate.den === outputRate.num * sequenceRate.den;
    this.sequenceFps = fpsOf(sequenceRate);
    this.outputFps = fpsOf(outputRate);
  }

  /** Sequence frame (may be fractional when re-timing the output rate) for an output frame. */
  timelineFrameAt(outputIndex: number): number {
    if (this.sameRate) return this.range.startFrame + outputIndex;
    return this.range.startFrame + (outputIndex * this.sequenceFps) / this.outputFps;
  }

  private clearFrame(): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  /**
   * Render one composited output frame. Returns the mapped sequence frame so the
   * caller can log real progress.
   */
  async renderFrame(outputIndex: number): Promise<number> {
    const timelineFrame = this.timelineFrameAt(outputIndex);
    this.clearFrame();
    const active = this.sampler.activeAt(timelineFrame);
    for (const { clip } of active) {
      if (this.resolver.isMissing(clip.mediaId)) continue;
      const asset = this.resolver.asset(clip.mediaId);
      if (!asset) continue;
      if (asset.kind === 'image') {
        await this.drawImageClip(clip, asset);
        continue;
      }
      if (asset.kind === 'video') {
        await this.drawVideoClip(clip, asset, timelineFrame);
      }
      // Audio-only media placed on a video track has no picture to draw.
    }
    return timelineFrame;
  }

  private async drawImageClip(clip: TimelineClip, asset: MediaAsset): Promise<void> {
    const image = await this.elements.getImage(clip.mediaId);
    if (!image) return;
    const sourceWidth = image.naturalWidth || asset.width || this.width;
    const sourceHeight = image.naturalHeight || asset.height || this.height;
    this.drawSource(clip, image, sourceWidth, sourceHeight);
  }

  private async drawVideoClip(clip: TimelineClip, asset: MediaAsset, timelineFrame: number): Promise<void> {
    const element = await this.elements.ensureVideo(clip.mediaId);
    if (!element) return;
    const sourceSeconds = sourceSecondsForTimelineFrame(clip, timelineFrame, this.sequence);
    const seeked = await this.elements.seekVideo(clip.mediaId, sourceSeconds);
    if (!seeked) return;
    if (element.readyState < 2 || element.videoWidth <= 0) return;
    const sourceWidth = element.videoWidth || asset.width || this.width;
    const sourceHeight = element.videoHeight || asset.height || this.height;
    this.drawSource(clip, element, sourceWidth, sourceHeight);
  }

  private drawSource(
    clip: TimelineClip,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
  ): void {
    try {
      drawTransformedFrame(this.ctx, source, sourceWidth, sourceHeight, this.width, this.height, clip.transform);
    } catch {
      this.warnings.add(`A "${this.resolver.asset(clip.mediaId)?.name ?? 'timeline'}" frame could not be drawn during export.`);
    }
  }
}
