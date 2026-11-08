import { memo, useEffect, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { FrameRate, Marker } from '@/types';
import { frameToTimecode } from '@/utils/time';
import { frameToPixels } from '@/utils/timeline-geometry';
import { computeRulerTicks } from './timeline-helpers';
import { TimelinePlayheadHandle } from './TimelinePlayhead';

export interface TimelineRulerProps {
  fps: FrameRate;
  zoom: number;
  contentWidth: number;
  viewportWidth: number;
  viewportRef: RefObject<HTMLDivElement>;
  markers: Marker[];
  onSeekStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onMarkerMenu: (event: ReactMouseEvent<HTMLElement>, marker: Marker) => void;
  onMarkerActivate: (marker: Marker) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

function markersEqual(a: Marker[], b: Marker[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index].id !== b[index].id || a[index].frame !== b[index].frame || a[index].color !== b[index].color) {
      return false;
    }
  }
  return true;
}

/**
 * Time ruler with adaptive tick marks/timecode labels, sequence markers and the
 * playhead handle. Only visible ticks are rendered; it tracks the viewport's
 * horizontal scroll independently so scrolling never re-renders the clip tree.
 */
export const TimelineRuler = memo(
  function TimelineRuler({
    fps,
    zoom,
    contentWidth,
    viewportWidth,
    viewportRef,
    markers,
    onSeekStart,
    onMarkerMenu,
    onMarkerActivate,
    onContextMenu,
  }: TimelineRulerProps) {
    const [scrollLeft, setScrollLeft] = useState(0);

    useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      let raf = 0;
      const handleScroll = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          setScrollLeft(viewport.scrollLeft);
        });
      };
      setScrollLeft(viewport.scrollLeft);
      viewport.addEventListener('scroll', handleScroll, { passive: true });
      return () => {
        viewport.removeEventListener('scroll', handleScroll);
        if (raf) cancelAnimationFrame(raf);
      };
    }, [viewportRef]);

    const ticks = computeRulerTicks(fps, zoom, scrollLeft, Math.max(1, viewportWidth));
    const viewportLeft = scrollLeft - 64;
    const viewportRight = scrollLeft + viewportWidth + 64;
    const visibleMarkers = markers.filter((marker) => {
      const x = frameToPixels(marker.frame, fps, zoom);
      return x >= viewportLeft && x <= viewportRight;
    });

    return (
      <div
        className="relative h-full w-full select-none overflow-hidden border-b border-app-border bg-[#242424]"
        onPointerDown={onSeekStart}
        onContextMenu={onContextMenu}
        title="Drag to scrub the playhead"
      >
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: contentWidth, transform: `translateX(${-scrollLeft}px)` }}
        >
          {ticks.map((tick) => (
            <div key={tick.frame} className="absolute bottom-0" style={{ left: tick.x }}>
              <div
                style={{
                  width: 1,
                  height: tick.major ? 12 : 5,
                  backgroundColor: tick.major ? '#8f8f8f' : '#575757',
                }}
              />
              {tick.major ? (
                <span
                  className="pointer-events-none absolute whitespace-nowrap font-mono text-[9px] leading-none tabular-nums text-[#b9b9b9]"
                  style={{ left: 3, bottom: 14 }}
                >
                  {frameToTimecode(tick.frame, fps)}
                </span>
              ) : null}
            </div>
          ))}

          {visibleMarkers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className="absolute top-0 z-[28] flex flex-col items-center outline-none"
              style={{ left: frameToPixels(marker.frame, fps, zoom), transform: 'translateX(-5px)' }}
              title={`${marker.name} — ${frameToTimecode(marker.frame, fps)}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                onMarkerActivate(marker);
              }}
              onContextMenu={(event) => onMarkerMenu(event, marker)}
            >
              <span
                style={{
                  width: 0,
                  height: 0,
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: `8px solid ${marker.color}`,
                }}
              />
            </button>
          ))}

          <TimelinePlayheadHandle fps={fps} zoom={zoom} />
        </div>
      </div>
    );
  },
  (previous, next) =>
    previous.fps.num === next.fps.num &&
    previous.fps.den === next.fps.den &&
    previous.zoom === next.zoom &&
    previous.contentWidth === next.contentWidth &&
    previous.viewportWidth === next.viewportWidth &&
    previous.viewportRef === next.viewportRef &&
    previous.onSeekStart === next.onSeekStart &&
    previous.onMarkerMenu === next.onMarkerMenu &&
    previous.onMarkerActivate === next.onMarkerActivate &&
    previous.onContextMenu === next.onContextMenu &&
    markersEqual(previous.markers, next.markers),
);
