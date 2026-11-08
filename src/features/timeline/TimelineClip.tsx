import { memo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { FrameRate, MediaAsset, TimelineClip as TimelineClipModel } from '@/types';
import { frameToTimecode } from '@/utils/time';
import { frameToPixels, framesToWidth } from '@/utils/timeline-geometry';
import { cn } from '@/utils/format';
import { CLIP_LABEL_MIN_WIDTH, CLIP_TIMECODE_MIN_WIDTH, MIN_CLIP_WIDTH } from './timeline-constants';

export interface TimelineClipProps {
  clip: TimelineClipModel;
  media: MediaAsset | undefined;
  isSelected: boolean;
  isLocked: boolean;
  isDimmed: boolean;
  zoom: number;
  fps: FrameRate;
  height: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClipModel) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>, clip: TimelineClipModel) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, clip: TimelineClipModel) => void;
  onTrimPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClipModel, edge: 'start' | 'end') => void;
}

const FALLBACK_COLORS = {
  video: '#33587f',
  audio: '#2f6554',
  image: '#6b4b2c',
} as const;

/** Build a mirrored waveform polygon from normalized peaks (0..1). */
function buildWaveformPoints(peaks: number[] | undefined): string | null {
  if (!peaks || peaks.length < 2) return null;
  const width = 1000;
  const middle = 50;
  const amplitude = 46;
  const step = width / (peaks.length - 1);
  const top: string[] = [];
  for (let index = 0; index < peaks.length; index++) {
    const value = Math.max(0, Math.min(1, peaks[index]));
    top.push(`${(index * step).toFixed(1)},${(middle - value * amplitude).toFixed(1)}`);
  }
  const bottom: string[] = [];
  for (let index = peaks.length - 1; index >= 0; index--) {
    const value = Math.max(0, Math.min(1, peaks[index]));
    bottom.push(`${(index * step).toFixed(1)},${(middle + value * amplitude).toFixed(1)}`);
  }
  return [...top, ...bottom].join(' ');
}

function clipFieldsEqual(a: TimelineClipModel, b: TimelineClipModel): boolean {
  return (
    a.id === b.id &&
    a.startFrame === b.startFrame &&
    a.durationFrames === b.durationFrames &&
    a.trackId === b.trackId &&
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.color === b.color &&
    a.playbackRate === b.playbackRate &&
    a.sourceInFrame === b.sourceInFrame &&
    a.mediaId === b.mediaId &&
    a.linkedClipId === b.linkedClipId &&
    a.audio.fadeInFrames === b.audio.fadeInFrames &&
    a.audio.fadeOutFrames === b.audio.fadeOutFrames &&
    a.audio.muted === b.audio.muted &&
    a.audio.gain === b.audio.gain
  );
}

function mediaFieldsEqual(a: MediaAsset | undefined, b: MediaAsset | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.missing === b.missing;
}

/**
 * A single timeline clip. Renders frame-accurate geometry, a repeated thumbnail
 * strip or waveform, fades and trim handles. Memoised so a live drag only
 * re-renders clips whose data actually changed.
 */
export const TimelineClip = memo(function TimelineClip({
  clip,
  media,
  isSelected,
  isLocked,
  isDimmed,
  zoom,
  fps,
  height,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
  onTrimPointerDown,
}: TimelineClipProps) {
  const left = frameToPixels(clip.startFrame, fps, zoom);
  const width = Math.max(MIN_CLIP_WIDTH, framesToWidth(clip.durationFrames, fps, zoom));
  const mediaKind = media?.kind;
  const backgroundColor = clip.color || (mediaKind ? FALLBACK_COLORS[mediaKind] : FALLBACK_COLORS.video);
  const label = clip.name || media?.name || 'Clip';
  const isAudio = mediaKind === 'audio';
  const waveformPoints = isAudio ? buildWaveformPoints(media?.waveformPeaks) : null;
  const fadeInWidth = clip.audio.fadeInFrames > 0 ? framesToWidth(clip.audio.fadeInFrames, fps, zoom) : 0;
  const fadeOutWidth = clip.audio.fadeOutFrames > 0 ? framesToWidth(clip.audio.fadeOutFrames, fps, zoom) : 0;
  const tooltip = [
    label,
    `${frameToTimecode(clip.startFrame, fps)} → ${frameToTimecode(clip.startFrame + clip.durationFrames, fps)}`,
    `Duration ${frameToTimecode(clip.durationFrames, fps)}`,
    clip.playbackRate !== 1 ? `Speed ${clip.playbackRate}x` : null,
    media?.missing ? 'Media offline' : null,
    `Media ID: ${clip.mediaId}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      role="button"
      tabIndex={-1}
      data-clip-id={clip.id}
      data-media-id={clip.mediaId}
      className={cn(
        'group/clip absolute z-10 overflow-hidden rounded-[2px] border border-black/60 text-left text-white shadow-[0_1px_2px_rgba(0,0,0,0.5)]',
        isSelected ? 'clip-selected z-20' : 'hover:border-white/40',
        isDimmed && 'opacity-50',
        !clip.enabled && 'opacity-45',
        !isLocked && 'cursor-grab active:cursor-grabbing',
      )}
      style={{
        left,
        width,
        top: 2,
        height: Math.max(10, height - 4),
        backgroundColor,
      }}
      title={tooltip}
      onPointerDown={(event) => onPointerDown(event, clip)}
      onDoubleClick={(event) => onDoubleClick(event, clip)}
      onContextMenu={(event) => onContextMenu(event, clip)}
    >
      {media?.thumbnailDataUrl && !isAudio ? (
        <div
          className="pointer-events-none absolute inset-0 opacity-55"
          style={{
            backgroundImage: `url(${media.thumbnailDataUrl})`,
            backgroundSize: 'auto 100%',
            backgroundRepeat: 'repeat-x',
            backgroundPosition: 'left center',
          }}
        />
      ) : null}

      {waveformPoints ? (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <polygon points={waveformPoints} fill="rgba(255,255,255,0.32)" />
          <line x1="0" y1="50" x2="1000" y2="50" stroke="rgba(255,255,255,0.28)" strokeWidth="0.7" />
        </svg>
      ) : null}

      {/* readability gradient */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.42), rgba(0,0,0,0.02) 38%, rgba(0,0,0,0.38))',
        }}
      />

      {fadeInWidth > 0 ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0"
          style={{
            width: fadeInWidth,
            background: 'linear-gradient(to right, rgba(0,0,0,0.62), rgba(0,0,0,0))',
          }}
        />
      ) : null}
      {fadeOutWidth > 0 ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{
            width: fadeOutWidth,
            background: 'linear-gradient(to left, rgba(0,0,0,0.62), rgba(0,0,0,0))',
          }}
        />
      ) : null}

      {!clip.enabled ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.35) 0 6px, transparent 6px 12px)' }}
        />
      ) : null}

      {media?.missing ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#4a2020]/70">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[#ffc4c4]">Media Offline</span>
        </div>
      ) : null}

      {width >= CLIP_LABEL_MIN_WIDTH ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 px-[5px] pt-[2px]">
          <span
            className="min-w-0 flex-1 truncate text-[10px] font-medium leading-[13px] text-white/95"
            style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}
          >
            {label}
          </span>
          {clip.playbackRate !== 1 && width >= 74 ? (
            <span className="shrink-0 rounded-[2px] bg-black/45 px-1 text-[8px] leading-[11px] text-white/85">
              {clip.playbackRate}x
            </span>
          ) : null}
        </div>
      ) : null}

      {width >= CLIP_TIMECODE_MIN_WIDTH ? (
        <div className="pointer-events-none absolute bottom-[2px] left-[5px] font-mono text-[9px] leading-none tabular-nums text-white/65">
          {frameToTimecode(clip.durationFrames, fps)}
        </div>
      ) : null}

      {!isLocked ? (
        <>
          <div
            className={cn(
              'absolute inset-y-0 left-0 z-30 flex w-[7px] cursor-ew-resize items-center justify-center',
              isSelected ? 'opacity-100' : 'opacity-0 group-hover/clip:opacity-100',
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
              onTrimPointerDown(event, clip, 'start');
            }}
            title="Trim clip start"
          >
            <span className="h-3 w-[2px] rounded-full bg-white/80" />
          </div>
          <div
            className={cn(
              'absolute inset-y-0 right-0 z-30 flex w-[7px] cursor-ew-resize items-center justify-center',
              isSelected ? 'opacity-100' : 'opacity-0 group-hover/clip:opacity-100',
            )}
            onPointerDown={(event) => {
              event.stopPropagation();
              onTrimPointerDown(event, clip, 'end');
            }}
            title="Trim clip end"
          >
            <span className="h-3 w-[2px] rounded-full bg-white/80" />
          </div>
        </>
      ) : null}
    </div>
  );
}, areClipPropsEqual);

function areClipPropsEqual(previous: TimelineClipProps, next: TimelineClipProps): boolean {
  return (
    previous.isSelected === next.isSelected &&
    previous.isLocked === next.isLocked &&
    previous.isDimmed === next.isDimmed &&
    previous.zoom === next.zoom &&
    previous.height === next.height &&
    previous.fps.num === next.fps.num &&
    previous.fps.den === next.fps.den &&
    previous.onPointerDown === next.onPointerDown &&
    previous.onDoubleClick === next.onDoubleClick &&
    previous.onContextMenu === next.onContextMenu &&
    previous.onTrimPointerDown === next.onTrimPointerDown &&
    mediaFieldsEqual(previous.media, next.media) &&
    clipFieldsEqual(previous.clip, next.clip)
  );
}
