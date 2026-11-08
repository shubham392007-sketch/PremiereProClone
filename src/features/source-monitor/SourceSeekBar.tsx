/** Custom source-monitor scrub bar that renders In/Out marks and the playhead. */
import { useCallback, useRef } from 'react';
import { cn } from '@/utils/format';

interface SourceSeekBarProps {
  durationFrames: number;
  currentFrame: number;
  inFrame: number | null;
  outFrame: number | null;
  disabled?: boolean;
  onSeek: (frame: number) => void;
  onScrubStart?: () => void;
}

export function SourceSeekBar({
  durationFrames,
  currentFrame,
  inFrame,
  outFrame,
  disabled = false,
  onSeek,
  onScrubStart,
}: SourceSeekBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const percent = useCallback(
    (frame: number) => {
      if (durationFrames <= 0) return 0;
      return Math.max(0, Math.min(100, (frame / durationFrames) * 100));
    },
    [durationFrames],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || durationFrames <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      onSeek(Math.round(ratio * durationFrames));
    },
    [durationFrames, onSeek],
  );

  const inPercent = inFrame !== null ? percent(inFrame) : null;
  const outPercent = outFrame !== null ? percent(outFrame) : null;
  const rangeLeft = inPercent !== null ? inPercent : 0;
  const rangeRight = outPercent !== null ? outPercent : durationFrames > 0 ? 100 : 0;
  const showRange = inPercent !== null || outPercent !== null;

  return (
    <div
      ref={trackRef}
      data-testid="source-seek-bar"
      role="slider"
      aria-label="Source position"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, durationFrames)}
      aria-valuenow={Math.max(0, Math.min(currentFrame, durationFrames))}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        'relative h-4 select-none rounded-[2px] outline-none focus-visible:ring-1 focus-visible:ring-app-accent',
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
      )}
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        draggingRef.current = true;
        onScrubStart?.();
        seekFromClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        seekFromClientX(event.clientX);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onScrubStart?.();
          onSeek(currentFrame - 1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onScrubStart?.();
          onSeek(currentFrame + 1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          onScrubStart?.();
          onSeek(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          onScrubStart?.();
          onSeek(durationFrames);
        }
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-[#3a3a3a]" />
      {showRange ? (
        <div
          className="absolute top-1/2 h-[4px] -translate-y-1/2 bg-[#8a6a2a]/70"
          style={{ left: `${rangeLeft}%`, width: `${Math.max(0, rangeRight - rangeLeft)}%` }}
        />
      ) : null}
      <div
        className="absolute top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-[#7a7a7a]"
        style={{ left: 0, width: `${percent(currentFrame)}%` }}
      />
      {inPercent !== null ? (
        <div
          className="pointer-events-none absolute top-1/2 h-[10px] w-px -translate-y-1/2 bg-[#e5b75a]"
          style={{ left: `${inPercent}%` }}
          title="In point"
        />
      ) : null}
      {outPercent !== null ? (
        <div
          className="pointer-events-none absolute top-1/2 h-[10px] w-px -translate-y-1/2 bg-[#e5b75a]"
          style={{ left: `${outPercent}%` }}
          title="Out point"
        />
      ) : null}
      <div
        className="pointer-events-none absolute top-1/2 h-3 w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-[1px] border border-black/50 bg-white shadow"
        style={{ left: `${percent(currentFrame)}%` }}
      />
    </div>
  );
}
