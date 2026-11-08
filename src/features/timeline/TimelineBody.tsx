import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Clapperboard, Film } from 'lucide-react';
import type { FrameRate, Marker, MediaAsset, Sequence, TimelineClip, Track } from '@/types';
import { ContextMenu } from '@/components/common/ContextMenu';
import { useTimelineStore } from '@/stores/timeline-store';
import { frameToPixels } from '@/utils/timeline-geometry';
import { cn } from '@/utils/format';
import { TimelineRuler } from './TimelineRuler';
import { TimelinePlayheadLine } from './TimelinePlayhead';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { useTimelineScroll } from './useTimelineScroll';
import { useTimelineGestures } from './useTimelineGestures';
import { isMediaDragEvent, useTimelineDrop } from './useTimelineDrop';
import { seekPlayhead } from './timeline-helpers';
import {
  buildClipMenuItems,
  buildMarkerMenuItems,
  buildTimelineMenuItems,
  buildTrackMenuItems,
} from './timeline-menus';
import {
  BOTTOM_PADDING,
  EMPTY_CLIPS,
  HEADER_WIDTH,
  RULER_HEIGHT,
  SNAP_COLOR,
} from './timeline-constants';
import { buildTrackRows, displayOrderTracks, groupClipsByTrack, rowsTotalHeight } from './timeline-helpers';

export interface TimelineBodyHandle {
  zoomBy: (factor: number, anchorClientX?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
  scrollToFrame: (frame: number, mode?: 'center' | 'left' | 'nearest') => void;
}

interface TimelineBodyProps {
  sequence: Sequence;
  mediaMap: Map<string, MediaAsset>;
}

type MenuState =
  | { kind: 'clip'; clipId: string; x: number; y: number }
  | { kind: 'track'; trackId: string; x: number; y: number }
  | { kind: 'timeline'; x: number; y: number }
  | { kind: 'marker'; markerId: string; x: number; y: number };

/**
 * The interactive timeline surface: ruler, fixed track-header column, synced
 * scrolling clip lanes, drag/trim/razor/marquee/drop gestures and context menus.
 */
export const TimelineBody = forwardRef<TimelineBodyHandle, TimelineBodyProps>(function TimelineBody(
  { sequence, mediaMap },
  ref,
) {
  const fps = sequence.frameRate;
  const tool = useTimelineStore((state) => state.tool);
  const zoom = useTimelineStore((state) => state.zoomPixelsPerSecond);
  const selectedIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedTrackId = useTimelineStore((state) => state.selectedTrackId);

  const displayTracks = useMemo(() => displayOrderTracks(sequence), [sequence]);
  const [heightOverrides, setHeightOverrides] = useState<Record<string, number>>({});
  const rows = useMemo(() => buildTrackRows(displayTracks, heightOverrides), [displayTracks, heightOverrides]);
  const clipsByTrack = useMemo(() => groupClipsByTrack(sequence), [sequence]);

  const setTrackHeightPreview = useCallback((trackId: string, height: number | null) => {
    setHeightOverrides((previous) => {
      if (height === null) {
        if (!(trackId in previous)) return previous;
        const next = { ...previous };
        delete next[trackId];
        return next;
      }
      if (previous[trackId] === height) return previous;
      return { ...previous, [trackId]: height };
    });
  }, []);

  const scroll = useTimelineScroll(sequence, rows);

  const gestures = useTimelineGestures({
    sequence,
    mediaMap,
    rows,
    fps,
    viewportRef: scroll.viewportRef,
    contentRef: scroll.contentRef,
    onScrollChanged: scroll.onViewportScroll,
    zoomByAt: scroll.zoomBy,
    setTrackHeightPreview,
  });

  const drop = useTimelineDrop({ sequence, fps, contentRef: scroll.contentRef });

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: scroll.zoomBy,
      zoomIn: () => scroll.zoomBy(1.4),
      zoomOut: () => scroll.zoomBy(1 / 1.4),
      zoomToFit: scroll.zoomToFit,
      scrollToFrame: scroll.scrollToFrame,
    }),
    [scroll.zoomBy, scroll.zoomToFit, scroll.scrollToFrame],
  );

  /* ------------------------------ wheel ------------------------------ */

  useEffect(() => {
    const viewport = scroll.viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0016);
        scroll.zoomBy(factor, event.clientX);
        return;
      }
      if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        viewport.scrollLeft = Math.max(0, viewport.scrollLeft + event.deltaY);
        scroll.onViewportScroll();
      }
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [scroll.zoomBy, scroll.onViewportScroll, scroll.viewportRef]);

  /* --------------------------- menu actions --------------------------- */

  const closeMenu = useCallback(() => setMenu(null), []);
  const handleStartRename = useCallback((trackId: string) => {
    setRenamingTrackId(trackId);
    setMenu(null);
  }, []);
  const handleRenameCommit = useCallback((trackId: string, name: string) => {
    useTimelineStore.getState().renameTrack(trackId, name);
    setRenamingTrackId(null);
  }, []);
  const handleRenameCancel = useCallback(() => setRenamingTrackId(null), []);

  const handleSelectTrack = useCallback((trackId: string) => {
    useTimelineStore.getState().selectTrack(trackId);
  }, []);

  const handleTrackToggle = useCallback((trackId: string, patch: Partial<Track>, label: string) => {
    useTimelineStore.getState().patchTrack(trackId, patch, label);
  }, []);

  const openTrackMenuAt = useCallback((trackId: string, x: number, y: number) => {
    useTimelineStore.getState().selectTrack(trackId);
    setMenu({ kind: 'track', trackId, x, y });
  }, []);

  const handleTrackContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, trackId: string) => {
      event.preventDefault();
      event.stopPropagation();
      openTrackMenuAt(trackId, event.clientX, event.clientY);
    },
    [openTrackMenuAt],
  );

  const handleLaneContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, trackId: string) => {
      event.preventDefault();
      event.stopPropagation();
      openTrackMenuAt(trackId, event.clientX, event.clientY);
    },
    [openTrackMenuAt],
  );

  const handleClipContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, clip: TimelineClip) => {
    event.preventDefault();
    event.stopPropagation();
    const store = useTimelineStore.getState();
    if (!store.selectedClipIds.includes(clip.id)) store.selectClips([clip.id], 'replace');
    setMenu({ kind: 'clip', clipId: clip.id, x: event.clientX, y: event.clientY });
  }, []);

  const handleMarkerContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, marker: Marker) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind: 'marker', markerId: marker.id, x: event.clientX, y: event.clientY });
  }, []);

  const handleMarkerActivate = useCallback(
    (marker: Marker) => {
      seekPlayhead(marker.frame);
      scroll.scrollToFrame(marker.frame, 'center');
    },
    [scroll.scrollToFrame],
  );

  const handleRulerContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenu({ kind: 'timeline', x: event.clientX, y: event.clientY });
  }, []);

  const handleEmptyAreaPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    useTimelineStore.getState().clearSelection();
    useTimelineStore.getState().selectTrack(null);
  }, []);

  const handleEmptyAreaContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenu({ kind: 'timeline', x: event.clientX, y: event.clientY });
  }, []);

  /* ---------------------------- drop target ---------------------------- */

  const handleViewportDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!isMediaDragEvent(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleViewportDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isMediaDragEvent(event)) return;
      event.preventDefault();
      drop.clearDropIndicator();
    },
    [drop.clearDropIndicator],
  );

  const handleViewportDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isMediaDragEvent(event)) return;
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && event.currentTarget.contains(nextTarget)) return;
      drop.clearDropIndicator();
    },
    [drop.clearDropIndicator],
  );

  const handleLanePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, trackId: string) => gestures.onLanePointerDown(event, trackId),
    [gestures.onLanePointerDown],
  );

  const handleLaneDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, trackId: string) => drop.onLaneDragOver(event, trackId),
    [drop.onLaneDragOver],
  );

  const handleLaneDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, trackId: string) => drop.onLaneDrop(event, trackId),
    [drop.onLaneDrop],
  );

  /* ----------------------------- menu items ----------------------------- */

  const handleSeekMarker = useCallback(
    (frame: number) => {
      seekPlayhead(frame);
      scroll.scrollToFrame(frame, 'center');
    },
    [scroll.scrollToFrame],
  );

  const menuItems = useMemo(() => {
    if (!menu) return [];
    if (menu.kind === 'clip') return buildClipMenuItems(menu.clipId);
    if (menu.kind === 'track') return buildTrackMenuItems(menu.trackId, { onRename: handleStartRename });
    if (menu.kind === 'marker') return buildMarkerMenuItems(menu.markerId, { onSeek: handleSeekMarker });
    return buildTimelineMenuItems({ onZoomToFit: scroll.zoomToFit });
  }, [menu, handleStartRename, handleSeekMarker, scroll.zoomToFit]);

  /* ------------------------------ render ------------------------------ */

  const rowHeightTotal = rowsTotalHeight(rows);
  const isEmpty = sequence.clips.length === 0;
  const cursorClass =
    gestures.gestureKind === 'hand'
      ? 'cursor-grabbing'
      : tool === 'hand'
        ? 'cursor-grab'
        : tool === 'razor' || gestures.gestureKind === 'marquee'
          ? 'cursor-crosshair'
          : tool === 'zoom'
            ? 'cursor-zoom-in'
            : 'cursor-default';

  const rulerCallbacks = {
    onSeekStart: gestures.onRulerPointerDown,
    onMarkerMenu: handleMarkerContextMenu,
    onMarkerActivate: handleMarkerActivate,
    onContextMenu: handleRulerContextMenu,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ruler row: fixed corner + scroll-synced ruler */}
      <div className="flex shrink-0 items-stretch border-b border-app-border bg-[#232323]" style={{ height: RULER_HEIGHT }}>
        <div
          className="flex shrink-0 items-center gap-1 overflow-hidden border-r border-app-border px-2"
          style={{ width: HEADER_WIDTH }}
        >
          <Clapperboard size={11} className="shrink-0 text-app-textFaint" />
          <span className="truncate text-[10px] text-app-textDim" title={sequence.name}>
            {sequence.name}
          </span>
        </div>
        <div className="relative min-w-0 flex-1">
          <TimelineRuler
            fps={fps}
            zoom={zoom}
            contentWidth={scroll.contentWidth}
            viewportWidth={scroll.viewportWidth}
            viewportRef={scroll.viewportRef}
            markers={sequence.markers}
            {...rulerCallbacks}
          />
        </div>
      </div>

      {/* track headers + scrollable lanes */}
      <div className="flex min-h-0 flex-1">
        <div
          className="shrink-0 overflow-hidden border-r border-app-border bg-[#202020]"
          style={{ width: HEADER_WIDTH }}
        >
          <div ref={scroll.headersInnerRef} className="will-change-transform">
            {rows.map((row) => (
              <TrackHeader
                key={row.track.id}
                trackId={row.track.id}
                kind={row.track.kind}
                name={row.track.name}
                height={row.height}
                locked={row.track.locked}
                muted={row.track.muted}
                hidden={row.track.hidden}
                solo={row.track.solo}
                enabled={row.track.enabled}
                selected={row.track.id === selectedTrackId}
                renaming={renamingTrackId === row.track.id}
                clipCount={clipsByTrack.get(row.track.id)?.length ?? 0}
                onSelect={handleSelectTrack}
                onContextMenu={handleTrackContextMenu}
                onToggle={handleTrackToggle}
                onStartRename={handleStartRename}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={handleRenameCancel}
                onResizePointerDown={gestures.onTrackResizePointerDown}
              />
            ))}
            <div style={{ height: BOTTOM_PADDING }} />
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={scroll.viewportRef}
            data-timeline-viewport
            className={cn('absolute inset-0 overflow-auto bg-[#1a1a1a] select-none', cursorClass)}
            onScroll={() => scroll.onViewportScroll()}
            onDragOver={handleViewportDragOver}
            onDrop={handleViewportDrop}
            onDragLeave={handleViewportDragLeave}
          >
            <div
              ref={scroll.contentRef}
              className="relative"
              style={{ width: scroll.contentWidth, height: scroll.contentHeight }}
            >
              {rows.map((row) => (
                <TrackLane
                  key={row.track.id}
                  trackId={row.track.id}
                  trackName={row.track.name}
                  kind={row.track.kind}
                  top={row.top}
                  height={row.height}
                  contentWidth={scroll.contentWidth}
                  locked={row.track.locked}
                  hidden={row.track.hidden}
                  muted={row.track.muted}
                  enabled={row.track.enabled}
                  selected={row.track.id === selectedTrackId}
                  clips={clipsByTrack.get(row.track.id) ?? EMPTY_CLIPS}
                  mediaMap={mediaMap}
                  selectedIds={selectedIds}
                  zoom={zoom}
                  fps={fps}
                  dropIndicator={drop.dropIndicator}
                  onClipPointerDown={gestures.onClipPointerDown}
                  onClipDoubleClick={gestures.onClipDoubleClick}
                  onClipContextMenu={handleClipContextMenu}
                  onTrimPointerDown={gestures.onTrimPointerDown}
                  onLanePointerDown={handleLanePointerDown}
                  onLaneContextMenu={handleLaneContextMenu}
                  onDragOver={handleLaneDragOver}
                  onDrop={handleLaneDrop}
                />
              ))}

              {/* empty space below the tracks */}
              <div
                className="absolute left-0 z-0"
                style={{ top: rowHeightTotal, height: BOTTOM_PADDING, width: '100%' }}
                onPointerDown={handleEmptyAreaPointerDown}
                onContextMenu={handleEmptyAreaContextMenu}
              />

              <TimelinePlayheadLine fps={fps} zoom={zoom} height={scroll.contentHeight} />

              {gestures.snapLineFrame !== null ? (
                <div
                  className="pointer-events-none absolute top-0 z-[40] w-px"
                  style={{
                    left: frameToPixels(gestures.snapLineFrame, fps, zoom),
                    height: scroll.contentHeight,
                    backgroundColor: SNAP_COLOR,
                  }}
                >
                  <div
                    className="absolute -left-[4px] top-0 h-0 w-0"
                    style={{
                      borderLeft: '4px solid transparent',
                      borderRight: '4px solid transparent',
                      borderTop: `6px solid ${SNAP_COLOR}`,
                    }}
                  />
                </div>
              ) : null}

              {gestures.marqueeRect ? (
                <div
                  className="pointer-events-none absolute z-[44] border border-app-accent bg-app-accent/15"
                  style={{
                    left: gestures.marqueeRect.left,
                    top: gestures.marqueeRect.top,
                    width: gestures.marqueeRect.width,
                    height: gestures.marqueeRect.height,
                  }}
                />
              ) : null}
            </div>
          </div>

          {isEmpty ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
              <div className="flex flex-col items-center gap-1.5 rounded border border-dashed border-[#3d3d3d] bg-[#202020]/85 px-6 py-5 text-center shadow-lg">
                <Film size={20} className="text-app-textFaint" strokeWidth={1.5} />
                <p className="text-xs font-medium text-app-textDim">Your timeline is empty</p>
                <p className="max-w-[320px] text-2xs leading-relaxed text-app-textFaint">
                  Drag media from the Project panel onto a track to start editing. Trim, move and layer clips across
                  multiple video and audio tracks.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} /> : null}
    </div>
  );
});
