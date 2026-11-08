import { useCallback, useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from 'react';
import type { FrameRate, Sequence } from '@/types';
import { useTimelineStore } from '@/stores/timeline-store';
import { pixelsToFrame } from '@/utils/timeline-geometry';
import { MEDIA_DRAG_MIME, SNAP_THRESHOLD_PX } from './timeline-constants';
import { collectSnapFrames, findSnap } from './timeline-helpers';

export interface DropIndicator {
  trackId: string;
  frame: number;
}

/** True when the drag payload comes from the media library. */
export function isMediaDragEvent(event: { dataTransfer: DataTransfer | null }): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (const type of Array.from(types)) {
    if (type.toLowerCase() === MEDIA_DRAG_MIME) return true;
  }
  return false;
}

interface TimelineDropArgs {
  sequence: Sequence | null;
  fps: FrameRate;
  contentRef: RefObject<HTMLDivElement>;
}

/**
 * Drag-and-drop of media assets from the project panel onto timeline lanes.
 * DataTransfer is unreadable during dragover (browser security), so the drop
 * indicator tracks the hovered lane/frame and validation happens on drop.
 */
export function useTimelineDrop(args: TimelineDropArgs) {
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const dropRef = useRef<DropIndicator | null>(null);

  const updateIndicator = useCallback((next: DropIndicator | null) => {
    const previous = dropRef.current;
    if (previous === next) return;
    if (previous && next && previous.trackId === next.trackId && previous.frame === next.frame) return;
    dropRef.current = next;
    setDropIndicator(next);
  }, []);

  const frameFor = useCallback(
    (clientX: number) => {
      const content = args.contentRef.current;
      if (!content) return 0;
      const rect = content.getBoundingClientRect();
      const zoom = useTimelineStore.getState().zoomPixelsPerSecond;
      let frame = Math.max(0, pixelsToFrame(clientX - rect.left, args.fps, zoom));
      if (useTimelineStore.getState().snapping) {
        const snap = findSnap([frame], collectSnapFrames(args.sequence), args.fps, zoom, SNAP_THRESHOLD_PX);
        if (snap) frame = snap.snapFrame;
      }
      return frame;
    },
    [args.contentRef, args.fps, args.sequence],
  );

  const onLaneDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, trackId: string) => {
      if (!isMediaDragEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      updateIndicator({ trackId, frame: frameFor(event.clientX) });
    },
    [frameFor, updateIndicator],
  );

  const onLaneDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, trackId: string) => {
      if (!isMediaDragEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const mediaId = event.dataTransfer?.getData(MEDIA_DRAG_MIME) ?? '';
      const frame = frameFor(event.clientX);
      updateIndicator(null);
      if (!mediaId) return;
      useTimelineStore.getState().insertMediaAt(mediaId, trackId, frame);
    },
    [frameFor, updateIndicator],
  );

  const clearDropIndicator = useCallback(() => updateIndicator(null), [updateIndicator]);

  return { dropIndicator, onLaneDragOver, onLaneDrop, clearDropIndicator };
}
