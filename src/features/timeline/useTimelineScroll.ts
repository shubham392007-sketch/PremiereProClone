import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { FrameRate, Sequence } from '@/types';
import { frameToPixels, pixelsToFrame } from '@/utils/timeline-geometry';
import { clamp } from '@/utils/time';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { BOTTOM_PADDING, MAX_ZOOM, MIN_ZOOM } from './timeline-constants';
import { computeContentWidth, rowsTotalHeight, type TrackRow } from './timeline-helpers';

export interface TimelineScrollApi {
  viewportRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  headersInnerRef: RefObject<HTMLDivElement>;
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  /** must be wired to the viewport's scroll event */
  onViewportScroll: () => void;
  zoomBy: (factor: number, anchorClientX?: number) => void;
  zoomToFit: () => void;
  scrollToFrame: (frame: number, mode?: 'center' | 'left' | 'nearest') => void;
  clientXToFrame: (clientX: number) => number;
  contentXToFrame: (contentX: number) => number;
}

const FALLBACK_FPS: FrameRate = { num: 30, den: 1, label: '30' };

/**
 * Owns the timeline scroll surface: DOM scroll position, header sync, zoom
 * anchoring around the pointer/viewport centre, external scroll-store sync and
 * playhead auto-follow during playback.
 *
 * Scroll positions are written straight to the DOM (no React state) so
 * scrolling never re-renders the clip tree; the shared store is updated in a
 * rAF-throttled way for persistence and cross-panel zoom actions.
 */
export function useTimelineScroll(sequence: Sequence | null, rows: TrackRow[]): TimelineScrollApi {
  const fps = sequence?.frameRate ?? FALLBACK_FPS;
  const zoom = useTimelineStore((state) => state.zoomPixelsPerSecond);
  const setZoom = useTimelineStore((state) => state.setZoom);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headersInnerRef = useRef<HTMLDivElement>(null);

  const [viewportWidth, setViewportWidth] = useState(0);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  const previousZoomRef = useRef(zoom);
  const pendingAnchorRef = useRef<{ frame: number; localX: number } | null>(null);
  const externalScrollRef = useRef(false);
  const storeRafRef = useRef(0);

  const contentWidth = useMemo(
    () => computeContentWidth(sequence, fps, zoom, viewportWidth),
    [sequence, fps, zoom, viewportWidth],
  );
  const contentHeight = useMemo(() => rowsTotalHeight(rows) + BOTTOM_PADDING, [rows]);

  const onViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const headers = headersInnerRef.current;
    if (headers) headers.style.transform = `translateY(${-viewport.scrollTop}px)`;
    if (storeRafRef.current) return;
    storeRafRef.current = requestAnimationFrame(() => {
      storeRafRef.current = 0;
      const element = viewportRef.current;
      if (!element) return;
      useTimelineStore.getState().setScroll(element.scrollLeft, element.scrollTop);
    });
  }, []);

  // Track viewport size so zoom-to-fit and content width stay accurate.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setViewportWidth(viewport.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(viewport.clientWidth));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // Restore the persisted scroll position once on mount.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const state = useTimelineStore.getState();
    viewport.scrollLeft = state.scrollLeft;
    viewport.scrollTop = state.scrollTop;
    onViewportScroll();
  }, [onViewportScroll]);

  // Apply scroll changes made outside the timeline (zoom-to-fit, zoom-to-selection, workspace restore).
  useEffect(() => {
    return useTimelineStore.subscribe((state) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      if (storeRafRef.current) return;
      if (Math.abs(viewport.scrollLeft - state.scrollLeft) > 0.5) {
        viewport.scrollLeft = state.scrollLeft;
        externalScrollRef.current = true;
      }
      if (Math.abs(viewport.scrollTop - state.scrollTop) > 0.5) {
        viewport.scrollTop = state.scrollTop;
      }
    });
  }, []);

  // Keep the frame under the pointer / viewport centre stable when zoom changes.
  useLayoutEffect(() => {
    const previousZoom = previousZoomRef.current;
    previousZoomRef.current = zoom;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (Math.abs(previousZoom - zoom) < 0.01) return;

    const pending = pendingAnchorRef.current;
    pendingAnchorRef.current = null;

    if (pending) {
      viewport.scrollLeft = Math.max(0, frameToPixels(pending.frame, fpsRef.current, zoom) - pending.localX);
    } else if (externalScrollRef.current) {
      externalScrollRef.current = false;
    } else {
      // Keyboard / menu zoom: anchor around the viewport centre.
      const centerLocal = viewport.clientWidth / 2;
      const centerFrame = pixelsToFrame(viewport.scrollLeft + centerLocal, fpsRef.current, previousZoom);
      viewport.scrollLeft = Math.max(0, frameToPixels(centerFrame, fpsRef.current, zoom) - centerLocal);
    }
    onViewportScroll();
  }, [zoom, onViewportScroll]);

  // Auto-scroll the timeline so the playhead stays visible while playing.
  useEffect(() => {
    let raf = 0;
    const ensureVisible = () => {
      raf = 0;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const playback = usePlaybackStore.getState();
      if (!playback.isPlaying) return;
      const pixelsPerSecond = useTimelineStore.getState().zoomPixelsPerSecond;
      const x = frameToPixels(playback.currentFrame, fpsRef.current, pixelsPerSecond);
      const left = viewport.scrollLeft;
      const right = left + viewport.clientWidth;
      if (x < left + 12 || x > right - 96) {
        viewport.scrollLeft = Math.max(0, x - Math.max(120, viewport.clientWidth * 0.18));
        onViewportScroll();
      }
    };
    const unsubscribe = usePlaybackStore.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(ensureVisible);
    });
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [onViewportScroll]);

  const contentXToFrame = useCallback((contentX: number) => {
    return Math.max(0, pixelsToFrame(contentX, fpsRef.current, useTimelineStore.getState().zoomPixelsPerSecond));
  }, []);

  const clientXToFrame = useCallback(
    (clientX: number) => {
      const content = contentRef.current;
      if (!content) return 0;
      const rect = content.getBoundingClientRect();
      return contentXToFrame(clientX - rect.left);
    },
    [contentXToFrame],
  );

  const zoomBy = useCallback(
    (factor: number, anchorClientX?: number) => {
      const viewport = viewportRef.current;
      const currentZoom = useTimelineStore.getState().zoomPixelsPerSecond;
      const nextZoom = clamp(currentZoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - currentZoom) < 0.05) return;
      if (viewport) {
        const rect = viewport.getBoundingClientRect();
        const localX =
          anchorClientX === undefined
            ? viewport.clientWidth / 2
            : clamp(anchorClientX - rect.left, 0, viewport.clientWidth);
        pendingAnchorRef.current = {
          frame: pixelsToFrame(viewport.scrollLeft + localX, fpsRef.current, currentZoom),
          localX,
        };
      }
      setZoom(nextZoom);
    },
    [setZoom],
  );

  const zoomToFit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The store resets scrollLeft to 0; anchor frame 0 at the left edge.
    pendingAnchorRef.current = { frame: 0, localX: 0 };
    useTimelineStore.getState().zoomToFit(viewport.clientWidth);
  }, []);

  const scrollToFrame = useCallback(
    (frame: number, mode: 'center' | 'left' | 'nearest' = 'nearest') => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const pixelsPerSecond = useTimelineStore.getState().zoomPixelsPerSecond;
      const x = frameToPixels(frame, fpsRef.current, pixelsPerSecond);
      let next = viewport.scrollLeft;
      if (mode === 'center') {
        next = x - viewport.clientWidth / 2;
      } else if (mode === 'left') {
        next = x - 16;
      } else {
        const left = viewport.scrollLeft;
        const right = left + viewport.clientWidth;
        if (x < left + 8) next = x - 24;
        else if (x > right - 16) next = x - viewport.clientWidth + 120;
      }
      viewport.scrollLeft = Math.max(0, next);
      onViewportScroll();
    },
    [onViewportScroll],
  );

  return {
    viewportRef,
    contentRef,
    headersInnerRef,
    contentWidth,
    contentHeight,
    viewportWidth,
    onViewportScroll,
    zoomBy,
    zoomToFit,
    scrollToFrame,
    clientXToFrame,
    contentXToFrame,
  };
}
