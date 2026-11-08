/**
 * Media element cache for the program monitor.
 *
 * One hidden `<video>` per clip and one hidden `<audio>` per audio clip are
 * kept alive (pooled by clip id) so playback never re-creates decoders while
 * scrubbing or crossing clip boundaries. Elements live in a visually hidden
 * container appended to the document: detached elements are not reliably
 * decoded by every browser, but the container is 2px, transparent and
 * pointer-events: none.
 *
 * Stills are cached per media asset. Every element gets its own audio routing
 * through `MediaAudioGraph` so gains above 100% work.
 */

import type { MediaAsset, Sequence, TimelineClip } from '@/types';
import type { CompositeSource } from '@/engine/compositor/composite-frame';
import type { MediaAudioGraph } from '@/engine/audio/media-audio-graph';

export interface MediaElementCacheHandlers {
  getUrl: (mediaId: string) => string | undefined;
  onNeedsRedraw: () => void;
  onElementError: (mediaId: string, message: string) => void;
}

interface CachedMedia {
  clipId: string;
  mediaId: string;
  url: string;
  kind: 'video' | 'audio';
  element: HTMLMediaElement;
  teardown: () => void;
}

interface CachedImage {
  mediaId: string;
  url: string;
  image: HTMLImageElement;
  teardown: () => void;
}

function mediaErrorLabel(element: HTMLMediaElement): string {
  const code = element.error?.code;
  switch (code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'playback aborted';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'network error while loading media';
    case MediaError.MEDIA_ERR_DECODE:
      return 'the media could not be decoded';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'the media format is not supported by this browser';
    default:
      return 'media failed to load';
  }
}

export class MediaElementCache {
  private readonly videos = new Map<string, CachedMedia>();
  private readonly audios = new Map<string, CachedMedia>();
  private readonly images = new Map<string, CachedImage>();
  private root: HTMLElement | null = null;

  constructor(
    private readonly handlers: MediaElementCacheHandlers,
    private readonly audioGraph: MediaAudioGraph,
  ) {}

  /* ------------------------------------------------------------------ */
  /* container                                                           */
  /* ------------------------------------------------------------------ */

  private ensureRoot(): HTMLElement | null {
    if (this.root) return this.root;
    if (typeof document === 'undefined' || !document.body) return null;
    const root = document.createElement('div');
    root.setAttribute('aria-hidden', 'true');
    root.dataset.premiereMediaCache = 'true';
    root.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
    document.body.appendChild(root);
    this.root = root;
    return root;
  }

  /* ------------------------------------------------------------------ */
  /* elements                                                            */
  /* ------------------------------------------------------------------ */

  /** Ensure (and return) the hidden video element responsible for a clip. */
  ensureVideo(clip: TimelineClip, asset: MediaAsset): HTMLVideoElement | null {
    if (asset.kind !== 'video') return null;
    return this.ensureElement(clip, asset, 'video') as HTMLVideoElement | null;
  }

  /** Ensure (and return) the hidden audio element responsible for a clip. */
  ensureAudio(clip: TimelineClip, asset: MediaAsset): HTMLAudioElement | null {
    if (asset.kind !== 'audio') return null;
    return this.ensureElement(clip, asset, 'audio') as HTMLAudioElement | null;
  }

  private ensureElement(
    clip: TimelineClip,
    asset: MediaAsset,
    kind: 'video' | 'audio',
  ): HTMLMediaElement | null {
    const url = this.handlers.getUrl(asset.id);
    if (!url) return null;
    const bucket = kind === 'video' ? this.videos : this.audios;
    const existing = bucket.get(clip.id);
    if (existing) {
      if (existing.url === url && existing.mediaId === asset.id) return existing.element;
      this.release(clip.id, kind);
    }

    const root = this.ensureRoot();
    if (!root) return null;

    const element: HTMLMediaElement =
      kind === 'video' ? document.createElement('video') : document.createElement('audio');
    element.preload = 'auto';
    element.volume = 1;
    element.muted = false;
    if (element instanceof HTMLVideoElement) {
      element.playsInline = true;
      element.setAttribute('playsinline', '');
      element.disablePictureInPicture = true;
    }
    element.src = url;

    const requestRedraw = () => this.handlers.onNeedsRedraw();
    const onError = () => this.handlers.onElementError(asset.id, mediaErrorLabel(element));

    const listeners: { type: string; fn: EventListener }[] = [];
    const listen = (type: string, fn: EventListener) => {
      element.addEventListener(type, fn);
      listeners.push({ type, fn });
    };
    listen('loadeddata', requestRedraw);
    listen('canplay', requestRedraw);
    listen('seeked', requestRedraw);
    listen('error', onError);

    const teardown = () => {
      for (const { type, fn } of listeners) element.removeEventListener(type, fn);
    };

    this.audioGraph.connect(element);
    root.appendChild(element);

    bucket.set(clip.id, { clipId: clip.id, mediaId: asset.id, url, kind, element, teardown });
    return element;
  }

  private getImage(asset: MediaAsset): HTMLImageElement | null {
    const url = this.handlers.getUrl(asset.id);
    if (!url) return null;
    const existing = this.images.get(asset.id);
    if (existing) {
      if (existing.url === url) return existing.image;
      this.releaseImage(asset.id);
    }

    const image = new Image();
    image.decoding = 'async';
    const requestRedraw = () => this.handlers.onNeedsRedraw();
    const onError = () => this.handlers.onElementError(asset.id, 'the image could not be loaded');
    image.addEventListener('load', requestRedraw);
    image.addEventListener('error', onError);
    image.src = url;

    const teardown = () => {
      image.removeEventListener('load', requestRedraw);
      image.removeEventListener('error', onError);
    };
    this.images.set(asset.id, { mediaId: asset.id, url, image, teardown });
    return image;
  }

  /* ------------------------------------------------------------------ */
  /* drawing source                                                      */
  /* ------------------------------------------------------------------ */

  /** Ready-to-draw picture for a clip, or null while decoding/loading. */
  getFrameSource(clip: TimelineClip, asset: MediaAsset): CompositeSource | null {
    if (asset.kind === 'image') {
      const image = this.getImage(asset);
      if (!image || !image.complete || image.naturalWidth === 0) return null;
      return { image, width: image.naturalWidth, height: image.naturalHeight };
    }
    const video = this.ensureVideo(clip, asset);
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    return { image: video, width: video.videoWidth, height: video.videoHeight };
  }

  /* ------------------------------------------------------------------ */
  /* gain / playback helpers                                             */
  /* ------------------------------------------------------------------ */

  setElementGain(element: HTMLMediaElement, gain: number): void {
    this.audioGraph.setGain(element, gain);
  }

  forEachElement(callback: (element: HTMLMediaElement, clipId: string) => void): void {
    for (const entry of this.videos.values()) callback(entry.element, entry.clipId);
    for (const entry of this.audios.values()) callback(entry.element, entry.clipId);
  }

  pauseAll(): void {
    this.forEachElement((element) => {
      if (!element.paused) element.pause();
    });
  }

  pauseInactive(activeClipIds: ReadonlySet<string>): void {
    this.forEachElement((element, clipId) => {
      if (!activeClipIds.has(clipId) && !element.paused) element.pause();
    });
  }

  hasElementFor(clipId: string): boolean {
    return this.videos.has(clipId) || this.audios.has(clipId);
  }

  /** Drop every per-clip element (used by "retry media" after errors). */
  releaseAllClipElements(): void {
    for (const clipId of [...this.videos.keys()]) this.release(clipId, 'video');
    for (const clipId of [...this.audios.keys()]) this.release(clipId, 'audio');
  }

  /* ------------------------------------------------------------------ */
  /* cleanup                                                             */
  /* ------------------------------------------------------------------ */

  /** Release elements whose clips are gone or whose media URL disappeared. */
  sync(sequence: Sequence | null, projectMediaIds: ReadonlySet<string>): void {
    const clipIds = new Set(sequence?.clips.map((clip) => clip.id) ?? []);
    for (const clipId of [...this.videos.keys()]) {
      if (!clipIds.has(clipId)) this.release(clipId, 'video');
    }
    for (const clipId of [...this.audios.keys()]) {
      if (!clipIds.has(clipId)) this.release(clipId, 'audio');
    }
    for (const [clipId, entry] of [...this.videos.entries()]) {
      if (!projectMediaIds.has(entry.mediaId) || !this.handlers.getUrl(entry.mediaId)) {
        this.release(clipId, 'video');
      }
    }
    for (const [clipId, entry] of [...this.audios.entries()]) {
      if (!projectMediaIds.has(entry.mediaId) || !this.handlers.getUrl(entry.mediaId)) {
        this.release(clipId, 'audio');
      }
    }
    for (const [mediaId, entry] of [...this.images.entries()]) {
      if (!projectMediaIds.has(mediaId) || !this.handlers.getUrl(mediaId)) {
        this.releaseImage(entry.mediaId);
        this.images.delete(mediaId);
      }
    }
  }

  release(clipId: string, kind: 'video' | 'audio'): void {
    const bucket = kind === 'video' ? this.videos : this.audios;
    const entry = bucket.get(clipId);
    if (!entry) return;
    bucket.delete(clipId);
    this.destroyElement(entry);
  }

  releaseImage(mediaId: string): void {
    const entry = this.images.get(mediaId);
    if (!entry) return;
    this.images.delete(mediaId);
    entry.teardown();
    entry.image.removeAttribute('src');
  }

  private destroyElement(entry: CachedMedia): void {
    const { element } = entry;
    try {
      element.pause();
    } catch {
      /* ignore */
    }
    entry.teardown();
    this.audioGraph.disconnect(element);
    try {
      element.removeAttribute('src');
      element.load();
    } catch {
      /* ignore */
    }
    element.remove();
  }

  dispose(): void {
    for (const clipId of [...this.videos.keys()]) this.release(clipId, 'video');
    for (const clipId of [...this.audios.keys()]) this.release(clipId, 'audio');
    for (const mediaId of [...this.images.keys()]) this.releaseImage(mediaId);
    this.videos.clear();
    this.audios.clear();
    this.images.clear();
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
  }
}
