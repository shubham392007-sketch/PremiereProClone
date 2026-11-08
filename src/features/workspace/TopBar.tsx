import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Clapperboard,
  Download,
  FilePlus2,
  FolderOpen,
  Keyboard,
  Redo2,
  Save,
  Settings,
  Undo2,
  Video,
} from 'lucide-react';
import { useProjectStore, getActiveSequence } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useWorkspaceStore, notify } from '@/stores/workspace-store';
import { programPlayback } from '@/engine/playback/registry';
import { createSequence } from '@/engine/timeline/factory';
import { downloadProjectFile } from '@/services/project-file';
import { flushAutosave } from '@/services/autosave';
import { cn, formatBytes } from '@/utils/format';
import { frameToTimecode } from '@/utils/time';
import type { Sequence } from '@/types';

type MenuEntry =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      onClick: () => void;
    };

const WORKSPACE_LAYOUTS = [
  { id: 'editing', label: 'Editing', left: 22, timeline: 40, properties: true },
  { id: 'assembly', label: 'Assembly', left: 28, timeline: 34, properties: false },
  { id: 'audio', label: 'Audio', left: 20, timeline: 52, properties: true },
] as const;

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const lastSavedAt = useProjectStore((s) => s.lastSavedAt);
  const saveError = useProjectStore((s) => s.saveError);
  const undoLabel = useProjectStore((s) => s.undoLabel);
  const redoLabel = useProjectStore((s) => s.redoLabel);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);
  const saveNow = useProjectStore((s) => s.saveNow);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const undoCount = useProjectStore((s) => s.past.length);

  const openDialog = useWorkspaceStore((s) => s.openDialog);
  const leftWidthPct = useWorkspaceStore((s) => s.leftWidthPct);
  const timelineHeightPct = useWorkspaceStore((s) => s.timelineHeightPct);
  const propertiesVisible = useWorkspaceStore((s) => s.propertiesVisible);
  const setLeftWidthPct = useWorkspaceStore((s) => s.setLeftWidthPct);
  const setTimelineHeightPct = useWorkspaceStore((s) => s.setTimelineHeightPct);
  const setPropertiesVisible = useWorkspaceStore((s) => s.setPropertiesVisible);

  const selectedCount = useTimelineStore((s) => s.selectedClipIds.length);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [openMenu]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);

  if (!project) return null;
  const sequence = getActiveSequence();
  const selectedLayout =
    WORKSPACE_LAYOUTS.find(
      (layout) =>
        layout.left === leftWidthPct &&
        layout.timeline === timelineHeightPct &&
        layout.properties === propertiesVisible,
    )?.id ?? 'custom';

  const applyLayout = (id: string) => {
    const layout = WORKSPACE_LAYOUTS.find((item) => item.id === id);
    if (!layout) return;
    setLeftWidthPct(layout.left);
    setTimelineHeightPct(layout.timeline);
    setPropertiesVisible(layout.properties);
  };

  const handleNewProject = async () => {
    await flushAutosave();
    useProjectStore.getState().closeProject();
    openDialog('new-project');
  };

  const handleOpenProject = async () => {
    await flushAutosave();
    useProjectStore.getState().closeProject();
  };

  const handleExportProjectFile = async () => {
    try {
      await downloadProjectFile(project);
      notify('success', 'Project file downloaded', 'Media must be relinked when this file is imported elsewhere.');
    } catch (error) {
      notify('error', 'Could not export project file', error instanceof Error ? error.message : undefined);
    }
  };

  const createNewSequence = () => {
    const base = getActiveSequence();
    if (!base) return;
    const existingNames = new Set(project.sequences.map((s) => s.name));
    let index = project.sequences.length + 1;
    let name = `Sequence ${String(index).padStart(2, '0')}`;
    while (existingNames.has(name)) {
      index++;
      name = `Sequence ${String(index).padStart(2, '0')}`;
    }
    let createdId = '';
    useProjectStore.getState().applyEdit('New sequence', (draft) => {
      const next = createSequence({
        name,
        sequenceName: name,
        width: base.width,
        height: base.height,
        frameRate: base.frameRate,
        audioSampleRate: base.audioSampleRate,
        colorSpace: base.colorSpace,
        previewQuality: base.previewQuality,
      });
      draft.sequences.push(next);
      draft.activeSequenceId = next.id;
      createdId = next.id;
    });
    useTimelineStore.getState().clearSelection();
    usePlaybackStore.getState().setCurrentFrame(0);
    if (createdId) notify('success', `Sequence "${name}" created`);
  };

  const switchSequence = (sequenceId: string) => {
    useProjectStore.getState().applyEdit('Switch sequence', (draft) => {
      draft.activeSequenceId = sequenceId;
    }, { history: false });
    useTimelineStore.getState().clearSelection();
    usePlaybackStore.getState().setCurrentFrame(0);
  };

  const commitName = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed && trimmed !== project.name) useProjectStore.getState().renameProject(trimmed);
  };

  const fileMenu: MenuEntry[] = [
    { label: 'New Project…', onClick: () => void handleNewProject() },
    { label: 'Open Project…', shortcut: 'Home', onClick: () => void handleOpenProject() },
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl+S', onClick: () => void saveNow() },
    { label: 'Export Project File (.json)…', onClick: () => void handleExportProjectFile() },
    { separator: true },
    { label: 'Export Video…', shortcut: 'Ctrl+E', onClick: () => openDialog('export') },
    { separator: true },
    { label: 'Close Project', onClick: () => void handleOpenProject() },
  ];

  const editMenu: MenuEntry[] = [
    {
      label: undoLabel ? `Undo ${undoLabel}` : 'Undo',
      shortcut: 'Ctrl+Z',
      disabled: !canUndo,
      onClick: () => undo(),
    },
    {
      label: redoLabel ? `Redo ${redoLabel}` : 'Redo',
      shortcut: 'Ctrl+Shift+Z',
      disabled: !canRedo,
      onClick: () => redo(),
    },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: !selectedCount, onClick: () => useTimelineStore.getState().cutSelection() },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !selectedCount, onClick: () => useTimelineStore.getState().copySelection() },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: !useTimelineStore.getState().clipboard.length, onClick: () => useTimelineStore.getState().pasteAtPlayhead() },
    { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !selectedCount, onClick: () => useTimelineStore.getState().duplicateSelection() },
    { label: 'Delete', shortcut: 'Delete', disabled: !selectedCount, onClick: () => useTimelineStore.getState().deleteSelection() },
    { separator: true },
    { label: 'Select All Clips', shortcut: 'Ctrl+A', onClick: () => useTimelineStore.getState().selectAllClips() },
    { label: 'Split at Playhead', shortcut: 'Ctrl+K', disabled: !selectedCount, onClick: () => useTimelineStore.getState().splitAtPlayhead(false) },
    { separator: true },
    { label: 'Add Marker at Playhead', shortcut: 'M', onClick: () => useTimelineStore.getState().addMarkerAtPlayhead() },
  ];

  const sequenceMenu: MenuEntry[] = [
    { label: 'New Sequence…', onClick: createNewSequence },
    ...(project.sequences.length > 1
      ? project.sequences
          .filter((seq) => seq.id !== project.activeSequenceId)
          .map((seq) => ({
            label: `Open Sequence: ${seq.name}`,
            onClick: () => switchSequence(seq.id),
          }))
      : []),
    { separator: true },
    { label: 'Add Video Track', onClick: () => useTimelineStore.getState().addTrack('video') },
    { label: 'Add Audio Track', onClick: () => useTimelineStore.getState().addTrack('audio') },
    { separator: true },
    { label: 'Zoom In', shortcut: '+', onClick: () => useTimelineStore.getState().zoomIn() },
    { label: 'Zoom Out', shortcut: '-', onClick: () => useTimelineStore.getState().zoomOut() },
    {
      label: 'Zoom to Fit',
      shortcut: '\\',
      onClick: () => {
        const width =
          (document.querySelector('[data-timeline-viewport]') as HTMLElement | null)?.clientWidth ??
          Math.max(600, window.innerWidth * 0.72);
        useTimelineStore.getState().zoomToFit(width);
      },
    },
  ];

  const helpMenu: MenuEntry[] = [
    { label: 'Keyboard Shortcuts', onClick: () => openDialog('shortcuts') },
    { label: 'Settings', onClick: () => openDialog('settings') },
  ];

  const menus: { id: string; label: string; items: MenuEntry[] }[] = [
    { id: 'file', label: 'File', items: fileMenu },
    { id: 'edit', label: 'Edit', items: editMenu },
    { id: 'sequence', label: 'Sequence', items: sequenceMenu },
    { id: 'help', label: 'Help', items: helpMenu },
  ];

  const statusLabel =
    saveStatus === 'saving'
      ? 'Saving…'
      : saveStatus === 'unsaved'
        ? 'Unsaved Changes'
        : saveStatus === 'error'
          ? 'Save Failed'
          : saveStatus === 'saved'
            ? 'Saved'
            : 'Not Saved';

  return (
    <header className="relative z-[60] flex h-11 shrink-0 items-center border-b border-app-border bg-[#1e1e1e]">
      <div className="flex h-full items-center gap-2 border-r border-app-border px-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-[3px] bg-app-accent">
          <Clapperboard size={14} className="text-white" />
        </div>
        <span className="text-2xs font-bold tracking-[0.14em] text-app-text">
          PREMIERE <span className="text-app-accent">WEB</span>
        </span>
      </div>

      <div ref={menuRef} className="flex h-full items-center">
        {menus.map((menu) => (
          <div key={menu.id} className="relative flex h-full items-center">
            <button
              type="button"
              className={cn(
                'h-full px-2.5 text-2xs text-app-textDim hover:bg-[#2a2a2a] hover:text-app-text',
                openMenu === menu.id && 'bg-[#2a2a2a] text-app-text',
              )}
              onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
              onPointerEnter={() => {
                if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
              }}
            >
              {menu.label}
            </button>
            {openMenu === menu.id ? (
              <div className="absolute left-0 top-full z-[80] min-w-[230px] border border-[#4a4a4a] bg-[#2b2b2b] py-1 shadow-2xl">
                {menu.items.map((item, index) =>
                  item.separator ? (
                    <div key={`sep-${index}`} className="separator-h" />
                  ) : (
                    <button
                      key={`${item.label}-${index}`}
                      type="button"
                      disabled={item.disabled}
                      className={cn(
                        'menu-item justify-between text-left',
                        item.disabled && 'menu-item-disabled',
                        item.danger && 'text-[#ff9b9b]',
                      )}
                      onClick={() => {
                        setOpenMenu(null);
                        item.onClick();
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut ? (
                        <span className="ml-4 text-3xs text-app-textFaint">{item.shortcut}</span>
                      ) : null}
                    </button>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="ml-3 flex min-w-0 items-center gap-2 border-l border-app-border pl-3">
        {editingName ? (
          <input
            ref={nameInputRef}
            className="h-6 w-[190px] rounded-[2px] border border-app-accent bg-[#191919] px-1.5 text-xs text-app-text outline-none"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') setEditingName(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="max-w-[240px] truncate rounded-[2px] px-1.5 py-0.5 text-xs font-medium text-app-text hover:bg-[#2c2c2c]"
            title="Double-click to rename project"
            onDoubleClick={() => {
              setNameDraft(project.name);
              setEditingName(true);
            }}
          >
            {project.name}
          </button>
        )}
        <span className="text-app-textFaint">/</span>
        <select
          className="h-6 max-w-[150px] rounded-[2px] border border-[#3a3a3a] bg-[#242424] px-1 text-2xs text-app-textDim outline-none focus:border-app-accent"
          value={project.activeSequenceId}
          title="Active sequence"
          onChange={(e) => {
            if (e.target.value === '__new__') createNewSequence();
            else switchSequence(e.target.value);
          }}
        >
          {project.sequences.map((seq) => (
            <option key={seq.id} value={seq.id}>
              {seq.name}
            </option>
          ))}
          <option value="__new__">＋ New Sequence…</option>
        </select>
        <SequenceBadge sequence={sequence} />
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 pr-2.5">
        <div className="mr-1 hidden items-center gap-1 border-r border-app-border pr-2 lg:flex">
          <span className="text-3xs uppercase tracking-wide text-app-textFaint">Workspace</span>
          <select
            className="h-6 rounded-[2px] border border-[#3a3a3a] bg-[#242424] px-1 text-2xs text-app-textDim outline-none focus:border-app-accent"
            value={selectedLayout}
            onChange={(e) => applyLayout(e.target.value)}
            title="Workspace layout"
          >
            {selectedLayout === 'custom' ? <option value="custom">Custom</option> : null}
            {WORKSPACE_LAYOUTS.map((layout) => (
              <option key={layout.id} value={layout.id}>
                {layout.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="icon-btn"
          title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          onClick={() => undo()}
          disabled={!canUndo}
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}
          onClick={() => redo()}
          disabled={!canRedo}
        >
          <Redo2 size={14} />
        </button>
        <span className="mx-0.5 h-5 w-px bg-app-border" />
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1.5 rounded-[2px] px-1.5 text-2xs hover:bg-[#2c2c2c]"
          title={saveError ?? `Last saved ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : 'never'}`}
          onClick={() => void saveNow()}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              saveStatus === 'saved' && 'bg-app-success',
              saveStatus === 'saving' && 'animate-pulse bg-app-accent',
              saveStatus === 'unsaved' && 'bg-[#d9a33a]',
              saveStatus === 'error' && 'bg-[#e05252]',
              saveStatus === 'idle' && 'bg-app-textFaint',
            )}
          />
          <span
            className={cn(
              'text-app-textDim',
              saveStatus === 'unsaved' && 'text-[#d9c48e]',
              saveStatus === 'error' && 'text-[#ff9b9b]',
            )}
          >
            {statusLabel}
          </span>
        </button>
        <button type="button" className="icon-btn" title="Keyboard Shortcuts" onClick={() => openDialog('shortcuts')}>
          <Keyboard size={14} />
        </button>
        <button type="button" className="icon-btn" title="Settings" onClick={() => openDialog('settings')}>
          <Settings size={14} />
        </button>
        <button
          type="button"
          className="btn-primary ml-1 h-7 px-2.5"
          title="Export sequence as a video file (Ctrl+E)"
          onClick={() => openDialog('export')}
        >
          <Download size={13} />
          Export
        </button>
      </div>

      {undoCount > 0 ? (
        <span className="pointer-events-none absolute bottom-0 left-0 h-px bg-transparent" aria-hidden />
      ) : null}
    </header>
  );
}

function SequenceBadge({ sequence }: { sequence: Sequence | null }) {
  if (!sequence) return null;
  return (
    <span
      className="ml-1 hidden items-center gap-1 text-3xs text-app-textFaint xl:flex"
      title={`${sequence.width} × ${sequence.height} · ${sequence.frameRate.label} fps · ${sequence.audioSampleRate / 1000} kHz`}
    >
      <Video size={10} />
      {sequence.width}×{sequence.height} · {sequence.frameRate.label} fps
    </span>
  );
}

export function useProjectStatusSummary(): { label: string; detail: string } {
  const project = useProjectStore((s) => s.project);
  const currentFrame = usePlaybackStore((s) => s.currentFrame);
  const sequence = project ? project.sequences.find((s) => s.id === project.activeSequenceId) : null;
  if (!project || !sequence) return { label: 'No project', detail: '' };
  return {
    label: `${frameToTimecode(currentFrame, sequence.frameRate)} / ${frameToTimecode(
      Math.max(0, currentFrame),
      sequence.frameRate,
    )}`,
    detail: `${project.media.length} media · ${project.sequences.length} sequence${project.sequences.length === 1 ? '' : 's'} · ${formatBytes(
      project.media.reduce((sum, m) => sum + m.sizeBytes, 0),
    )}`,
  };
}

export function MenuItemContent({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-4 w-4 items-center justify-center text-app-textDim">{icon}</span>
      {children}
    </span>
  );
}

export { FilePlus2, FolderOpen, Save, Undo2, Redo2, Settings, Keyboard, ChevronDown, Download, Video, programPlayback };
