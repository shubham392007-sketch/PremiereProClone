import { useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, MousePointer2, Scissors, Hand, ZoomIn, Magnet, Film, HardDrive } from 'lucide-react';
import { TopBar } from './TopBar';
import { MediaPanel } from '@/features/media-library/MediaPanel';
import { SourceMonitor } from '@/features/source-monitor/SourceMonitor';
import { ProgramMonitor } from '@/features/program-monitor/ProgramMonitor';
import { PropertiesPanel } from '@/features/properties/PropertiesPanel';
import { Timeline } from '@/features/timeline/Timeline';
import { ExportDialog } from '@/features/export/ExportDialog';
import { NewProjectDialog } from '@/features/project-manager/NewProjectDialog';
import { SettingsDialog } from '@/components/dialogs/SettingsDialog';
import { ShortcutsDialog } from '@/components/dialogs/ShortcutsDialog';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useProjectStore, getActiveSequence } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { sequenceEndFrame } from '@/engine/timeline/operations';
import { frameToTimecode } from '@/utils/time';
import { cn } from '@/utils/format';

export function EditorWorkspace() {
  const project = useProjectStore((s) => s.project);
  const leftWidthPct = useWorkspaceStore((s) => s.leftWidthPct);
  const timelineHeightPct = useWorkspaceStore((s) => s.timelineHeightPct);
  const propertiesVisible = useWorkspaceStore((s) => s.propertiesVisible);
  const setLeftWidthPct = useWorkspaceStore((s) => s.setLeftWidthPct);
  const setTimelineHeightPct = useWorkspaceStore((s) => s.setTimelineHeightPct);

  const mainRef = useRef<HTMLDivElement>(null);
  const projectId = project?.id ?? null;

  useKeyboardShortcuts(Boolean(project));

  // Initialise timeline zoom/scroll + program quality when a project opens.
  useEffect(() => {
    if (!projectId) return;
    const current = useProjectStore.getState().project;
    if (!current) return;
    useTimelineStore.getState().initFromWorkspace(current.workspace);
    usePlaybackStore.getState().setProgramQuality(current.previewQuality);
    usePlaybackStore.getState().setCurrentFrame(0);
  }, [projectId]);

  // Keep selection valid after undo/redo/deletions/sequence switches.
  const sequence = getActiveSequence();
  useEffect(() => {
    if (!sequence) return;
    const validClips = new Set(sequence.clips.map((clip) => clip.id));
    const state = useTimelineStore.getState();
    const filtered = state.selectedClipIds.filter((id) => validClips.has(id));
    if (filtered.length !== state.selectedClipIds.length) {
      state.selectClips(filtered);
    }
    if (state.selectedTrackId && !sequence.tracks.some((track) => track.id === state.selectedTrackId)) {
      state.selectTrack(null);
    }
  }, [sequence]);

  // Prevent the browser from navigating to a dropped file outside drop zones.
  useEffect(() => {
    const prevent = (event: DragEvent) => {
      event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const startLeftResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const main = mainRef.current;
      if (!main) return;
      const startX = event.clientX;
      const startPct = leftWidthPct;
      const width = main.getBoundingClientRect().width;
      const onMove = (move: PointerEvent) => {
        setLeftWidthPct(startPct + ((move.clientX - startX) / width) * 100);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [leftWidthPct, setLeftWidthPct],
  );

  const startTimelineResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const main = mainRef.current;
      if (!main) return;
      const rect = main.getBoundingClientRect();
      const startY = event.clientY;
      const startPct = timelineHeightPct;
      const onMove = (move: PointerEvent) => {
        setTimelineHeightPct(startPct + ((startY - move.clientY) / rect.height) * 100);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [timelineHeightPct, setTimelineHeightPct],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <TopBar />
      <div ref={mainRef} className="flex min-h-0 flex-1">
        <div
          className="min-h-0 shrink-0 border-r border-app-border"
          style={{ width: `${leftWidthPct}%`, minWidth: 220, maxWidth: '42%' }}
        >
          <MediaPanel />
        </div>
        <div
          className="w-[3px] shrink-0 cursor-col-resize bg-[#2a2a2a] transition-colors hover:bg-app-accent/70"
          onPointerDown={startLeftResize}
          title="Resize panel"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 flex-[1.02] border-r border-app-border">
              <SourceMonitor />
            </div>
            <div className="min-h-0 min-w-0 flex-[1.28]">
              <ProgramMonitor />
            </div>
            {propertiesVisible ? (
              <div className="w-[286px] shrink-0 border-l border-app-border">
                <PropertiesPanel />
              </div>
            ) : null}
          </div>
          <div
            className="h-[4px] shrink-0 cursor-row-resize border-t border-app-border bg-[#252525] transition-colors hover:bg-app-accent/70"
            onPointerDown={startTimelineResize}
            title="Resize timeline"
          />
          <div
            className="min-h-0 shrink-0 border-t border-app-border"
            style={{ height: `${timelineHeightPct}%` }}
          >
            <Timeline />
          </div>
        </div>
      </div>
      <StatusBar />
      <NewProjectDialog />
      <SettingsDialog />
      <ShortcutsDialog />
      <ExportDialog />
    </div>
  );
}

const TOOL_META = {
  select: { icon: MousePointer2, label: 'Selection Tool' },
  razor: { icon: Scissors, label: 'Razor Tool' },
  hand: { icon: Hand, label: 'Hand Tool' },
  zoom: { icon: ZoomIn, label: 'Zoom Tool' },
} as const;

function StatusBar() {
  const project = useProjectStore((s) => s.project);
  const sequence = getActiveSequence();
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const tool = useTimelineStore((s) => s.tool);
  const snapping = useTimelineStore((s) => s.snapping);
  const zoom = useTimelineStore((s) => s.zoomPixelsPerSecond);
  const selectedCount = useTimelineStore((s) => s.selectedClipIds.length);
  const toggleSnapping = useTimelineStore((s) => s.setSnapping);

  if (!project || !sequence) return null;
  const fps = sequence.frameRate;
  const end = sequenceEndFrame(sequence);
  const ToolIcon = TOOL_META[tool].icon;
  const durationLabel = frameToTimecode(end, fps);

  return (
    <footer className="flex h-[22px] shrink-0 items-center justify-between border-t border-app-border bg-[#1d1d1d] px-2.5 text-3xs text-app-textFaint">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1 text-app-textDim">
          <Film size={10} />
          {sequence.width}×{sequence.height} · {fps.label} fps
        </span>
        <span>{project.media.length} media</span>
        <span>{project.bins.length} bins</span>
        <span className="flex items-center gap-1">
          <ToolIcon size={10} /> {TOOL_META[tool].label}
        </span>
        <button
          type="button"
          className={cn('flex items-center gap-1 hover:text-app-text', snapping ? 'text-app-textDim' : 'text-[#8a6a2a]')}
          onClick={() => toggleSnapping(!snapping)}
          title="Toggle timeline snapping"
        >
          <Magnet size={10} /> Snap {snapping ? 'On' : 'Off'}
        </button>
      </div>
      <div className="flex items-center gap-3">
        {selectedCount ? <span>{selectedCount} clip{selectedCount === 1 ? '' : 's'} selected</span> : <span>No clip selected</span>}
        <span>Zoom {Math.round(zoom)} px/s</span>
        <span className="flex items-center gap-1">
          {isPlaying ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-app-success" /> : null}
          <span className="text-app-textDim timecode">{frameToTimecode(currentFrame, fps)}</span>
          <span>/</span>
          <span className="timecode">{durationLabel}</span>
        </span>
        <span className="flex items-center gap-1" title="Media storage backend">
          <HardDrive size={10} />
          Local
        </span>
        <AlertTriangleInfo />
      </div>
    </footer>
  );
}

function AlertTriangleInfo() {
  return (
    <span title="Phase 1 build — some advanced features are intentionally unavailable.">
      <AlertTriangle size={10} className="text-app-textFaint" />
    </span>
  );
}

export default EditorWorkspace;
