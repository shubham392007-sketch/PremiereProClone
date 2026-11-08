import { memo, useMemo, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { FrameRate, MediaAsset, TimelineClip, TrackKind } from '@/types';
import { frameToPixels } from '@/utils/timeline-geometry';
import { cn } from '@/utils/format';
import { TimelineClip as TimelineClipView } from './TimelineClip';
import type { DropIndicator } from './useTimelineDrop';

export interface TrackLaneProps {
  trackId: string;
  trackName: string;
  kind: TrackKind;
  top: number;
  height: number;
  contentWidth: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  enabled: boolean;
  selected: boolean;
  clips: TimelineClip[];
  mediaMap: Map<string, MediaAsset>;
  selectedIds: string[];
  zoom: number;
  fps: FrameRate;
  dropIndicator: DropIndicator | null;
  onClipPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip) => void;
  onClipDoubleClick: (event: ReactMouseEvent<HTMLElement>, clip: TimelineClip) => void;
  onClipContextMenu: (event: ReactMouseEvent<HTMLElement>, clip: TimelineClip) => void;
  onTrimPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, edge: 'start' | 'end') => void;
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>, trackId: string) => void;
  onLaneContextMenu: (event: ReactMouseEvent<HTMLElement>, trackId: string) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>, trackId: string) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>, trackId: string) => void;
}

const LANE_BACKGROUND = {
  video: '#262626',
  audio: '#222222',
} as const;

/**
 * One timeline track lane: clips plus the lane's own background interactions
 * (marquee selection, context menu and media drop target).
 */
export const TrackLane = memo(
  function TrackLane({
    trackId,
    trackName,
    kind,
    top,
    height,
    contentWidth,
    locked,
    hidden,
    muted,
    selected,
    clips,
    mediaMap,
    selectedIds,
    zoom,
    fps,
    dropIndicator,
    onClipPointerDown,
    onClipDoubleClick,
    onClipContextMenu,
    onTrimPointerDown,
    onLanePointerDown,
    onLaneContextMenu,
    onDragOver,
    onDrop,
  }: TrackLaneProps) {
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const gridSpacing = Math.max(12, zoom);
    const dimmed = hidden || (kind === 'audio' && muted);
    const dropFrame = dropIndicator && dropIndicator.trackId === trackId ? dropIndicator.frame : null;

    return (
      <div
        data-track-id={trackId}
        data-track-name={trackName}
        data-track-kind={kind}
        className={cn(
          'absolute left-0 border-b border-[#2d2d2d]',
          selected && 'ring-1 ring-inset ring-[#3f5d80]',
        )}
        style={{
          top,
          height,
          width: contentWidth,
          backgroundColor: selected ? '#2b2f35' : LANE_BACKGROUND[kind],
          backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.032) 0 1px, transparent 1px ${gridSpacing}px)`,
        }}
        onPointerDown={(event) => onLanePointerDown(event, trackId)}
        onContextMenu={(event) => onLaneContextMenu(event, trackId)}
        onDragOver={(event) => onDragOver(event, trackId)}
        onDrop={(event) => onDrop(event, trackId)}
      >
        {locked ? (
          <div
            className="pointer-events-none absolute inset-0 z-[6]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(0,0,0,0.16) 0 8px, rgba(255,255,255,0.02) 8px 16px)',
            }}
          />
        ) : null}

        {clips.map((clip) => (
          <TimelineClipView
            key={clip.id}
            clip={clip}
            media={mediaMap.get(clip.mediaId)}
            isSelected={selectedSet.has(clip.id)}
            isLocked={locked}
            isDimmed={dimmed}
            zoom={zoom}
            fps={fps}
            height={height}
            onPointerDown={onClipPointerDown}
            onDoubleClick={onClipDoubleClick}
            onContextMenu={onClipContextMenu}
            onTrimPointerDown={onTrimPointerDown}
          />
        ))}

        {dropFrame !== null ? (
          <>
            <div className="pointer-events-none absolute inset-0 z-[8] bg-app-accent/10" />
            <div
              className="pointer-events-none absolute inset-y-0 z-[9] w-[2px] bg-app-accent"
              style={{ left: frameToPixels(dropFrame, fps, zoom) }}
            >
              <div className="absolute -left-[4px] top-0 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-app-accent" />
            </div>
          </>
        ) : null}
      </div>
    );
  },
  (previous, next) =>
    previous.trackId === next.trackId &&
    previous.trackName === next.trackName &&
    previous.kind === next.kind &&
    previous.top === next.top &&
    previous.height === next.height &&
    previous.contentWidth === next.contentWidth &&
    previous.locked === next.locked &&
    previous.hidden === next.hidden &&
    previous.muted === next.muted &&
    previous.selected === next.selected &&
    previous.clips === next.clips &&
    previous.mediaMap === next.mediaMap &&
    previous.selectedIds === next.selectedIds &&
    previous.zoom === next.zoom &&
    previous.fps.num === next.fps.num &&
    previous.fps.den === next.fps.den &&
    previous.dropIndicator === next.dropIndicator &&
    previous.onClipPointerDown === next.onClipPointerDown &&
    previous.onClipDoubleClick === next.onClipDoubleClick &&
    previous.onClipContextMenu === next.onClipContextMenu &&
    previous.onTrimPointerDown === next.onTrimPointerDown &&
    previous.onLanePointerDown === next.onLanePointerDown &&
    previous.onLaneContextMenu === next.onLaneContextMenu &&
    previous.onDragOver === next.onDragOver &&
    previous.onDrop === next.onDrop,
);
