import { memo, type RefObject } from 'react';
import {
  Flag,
  Hand,
  Magnet,
  Maximize2,
  MousePointer2,
  Music,
  Plus,
  Scissors,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { FrameRate } from '@/types';
import type { LucideIcon } from 'lucide-react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { frameToTimecode } from '@/utils/time';
import { cn } from '@/utils/format';
import type { TimelineBodyHandle } from './TimelineBody';

export interface TimelineToolbarProps {
  fps: FrameRate | null;
  durationFrames: number;
  bodyRef: RefObject<TimelineBodyHandle>;
}

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  testId?: string;
  onClick: () => void;
}

function ToolButton({ icon: Icon, label, shortcut, active, testId, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      data-active={active ? 'true' : undefined}
      className="tool-btn"
      onClick={onClick}
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-app-border" />;
}

/** Live timecode readout; isolated so playback re-renders only this text. */
function CurrentTimecode({ fps }: { fps: FrameRate | null }) {
  const currentFrame = usePlaybackStore((state) => state.currentFrame);
  return (
    <span className="timecode min-w-[74px] text-[11px] font-medium text-[#9ecbff]" title="Playhead timecode">
      {fps ? frameToTimecode(currentFrame, fps) : '00:00:00:00'}
    </span>
  );
}

/**
 * Timeline toolbar: edit tools, snapping, track/marker creation and zoom
 * controls plus current timecode and sequence duration.
 */
export const TimelineToolbar = memo(
  function TimelineToolbar({ fps, durationFrames, bodyRef }: TimelineToolbarProps) {
    const tool = useTimelineStore((state) => state.tool);
    const snapping = useTimelineStore((state) => state.snapping);
    const selectionCount = useTimelineStore((state) => state.selectedClipIds.length);
    const setTool = useTimelineStore((state) => state.setTool);
    const setSnapping = useTimelineStore((state) => state.setSnapping);
    const addTrack = useTimelineStore((state) => state.addTrack);
    const addMarkerAtPlayhead = useTimelineStore((state) => state.addMarkerAtPlayhead);

    return (
      <div className="flex h-8 shrink-0 items-center gap-[2px] border-b border-app-border bg-[#232323] px-1.5">
        <ToolButton
          icon={MousePointer2}
          label="Selection Tool"
          shortcut="V"
          testId="tool-select"
          active={tool === 'select'}
          onClick={() => setTool('select')}
        />
        <ToolButton
          icon={Scissors}
          label="Razor Tool"
          shortcut="C"
          testId="tool-razor"
          active={tool === 'razor'}
          onClick={() => setTool('razor')}
        />
        <ToolButton
          icon={Hand}
          label="Hand Tool"
          shortcut="H"
          testId="tool-hand"
          active={tool === 'hand'}
          onClick={() => setTool('hand')}
        />
        <ToolButton
          icon={ZoomIn}
          label="Zoom Tool"
          shortcut="Z"
          testId="tool-zoom"
          active={tool === 'zoom'}
          onClick={() => setTool('zoom')}
        />

        <Divider />

        <ToolButton
          icon={Magnet}
          label={snapping ? 'Snapping On' : 'Snapping Off'}
          testId="snap-toggle"
          active={snapping}
          onClick={() => setSnapping(!snapping)}
        />

        <Divider />

        <button
          type="button"
          title="Add Video Track"
          aria-label="Add Video Track"
          data-testid="add-video-track"
          className="tool-btn relative"
          onClick={() => addTrack('video')}
        >
          <Video size={13} strokeWidth={1.75} />
          <Plus size={8} strokeWidth={2.5} className="absolute bottom-[2px] right-[2px]" />
        </button>
        <button
          type="button"
          title="Add Audio Track"
          aria-label="Add Audio Track"
          data-testid="add-audio-track"
          className="tool-btn relative"
          onClick={() => addTrack('audio')}
        >
          <Music size={13} strokeWidth={1.75} />
          <Plus size={8} strokeWidth={2.5} className="absolute bottom-[2px] right-[2px]" />
        </button>

        <Divider />

        <ToolButton
          icon={Flag}
          label="Add Marker at Playhead"
          shortcut="M"
          testId="add-marker"
          onClick={() => addMarkerAtPlayhead()}
        />

        <Divider />

        <ToolButton icon={ZoomOut} label="Zoom Out" onClick={() => bodyRef.current?.zoomOut()} />
        <ToolButton icon={Maximize2} label="Zoom to Fit" shortcut="\" onClick={() => bodyRef.current?.zoomToFit()} />
        <ToolButton icon={ZoomIn} label="Zoom In" onClick={() => bodyRef.current?.zoomIn()} />

        <div className="ml-auto flex shrink-0 items-center gap-2 pr-1">
          <span className={cn('text-3xs uppercase tracking-wide', selectionCount ? 'text-app-textDim' : 'text-app-textFaint')}>
            {selectionCount ? `${selectionCount} clip${selectionCount === 1 ? '' : 's'} selected` : 'No selection'}
          </span>
          <span className="h-4 w-px bg-app-border" />
          <CurrentTimecode fps={fps} />
          <span className="text-[10px] text-app-textFaint">
            /{' '}
            <span className="tabular-nums text-app-textDim">
              {fps ? frameToTimecode(Math.max(0, durationFrames), fps) : '00:00:00:00'}
            </span>
          </span>
        </div>
      </div>
    );
  },
  (previous, next) =>
    previous.bodyRef === next.bodyRef &&
    previous.durationFrames === next.durationFrames &&
    (previous.fps === next.fps ||
      (previous.fps !== null &&
        next.fps !== null &&
        previous.fps.num === next.fps.num &&
        previous.fps.den === next.fps.den)),
);
