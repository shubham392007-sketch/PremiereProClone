import { memo } from 'react';
import type { FrameRate } from '@/types';
import { usePlaybackStore } from '@/stores/playback-store';
import { frameToPixels } from '@/utils/timeline-geometry';
import { PLAYHEAD_COLOR } from './timeline-constants';

interface PlayheadProps {
  fps: FrameRate;
  zoom: number;
}

/**
 * Vertical playhead line across the clip lanes. Subscribes to the playhead frame
 * itself so playback only re-renders this tiny component, never the timeline.
 */
export const TimelinePlayheadLine = memo(function TimelinePlayheadLine({
  fps,
  zoom,
  height,
}: PlayheadProps & { height: number }) {
  const currentFrame = usePlaybackStore((state) => state.currentFrame);
  const x = frameToPixels(currentFrame, fps, zoom);
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-[26]"
      style={{ height, transform: `translateX(${x}px)` }}
      aria-hidden
    >
      <div
        className="h-full w-px"
        style={{ backgroundColor: PLAYHEAD_COLOR, boxShadow: '0 0 3px rgba(0, 0, 0, 0.85)' }}
      />
    </div>
  );
});

/** Draggable playhead handle rendered inside the ruler. */
export const TimelinePlayheadHandle = memo(function TimelinePlayheadHandle({ fps, zoom }: PlayheadProps) {
  const currentFrame = usePlaybackStore((state) => state.currentFrame);
  const x = frameToPixels(currentFrame, fps, zoom);
  return (
    <div
      className="pointer-events-none absolute top-0 z-[32]"
      style={{ transform: `translateX(${x}px)` }}
      aria-hidden
    >
      <div
        style={{
          width: 13,
          height: 14,
          marginLeft: -6,
          backgroundColor: PLAYHEAD_COLOR,
          clipPath: 'polygon(0 0, 100% 0, 100% 54%, 50% 100%, 0 54%)',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.6)',
        }}
      />
    </div>
  );
});
