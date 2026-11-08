import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clapperboard,
  Clock,
  Copy,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';
import type { BrowserCapabilities } from '@/utils/browser';
import { compatibilityWarnings, detectCapabilities } from '@/utils/browser';
import type { ProjectSummary } from '@/types';
import {
  deleteProjectDocument,
  duplicateProjectRecord,
  listProjectSummaries,
} from '@/services/storage/project-storage';
import { importProjectFile, downloadProjectFile } from '@/services/project-file';
import { mediaStorage } from '@/services/storage/media-storage';
import { loadProjectDocument } from '@/services/storage/project-storage';
import { useProjectStore } from '@/stores/project-store';
import { useWorkspaceStore, confirmAction, notify } from '@/stores/workspace-store';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { EmptyState, Spinner } from '@/components/common/EmptyState';
import { formatDateTime, formatRelativeDate } from '@/utils/format';

export function ProjectHome() {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  const [backend, setBackend] = useState<'opfs' | 'indexeddb' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; summary: ProjectSummary } | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const openProject = useProjectStore((s) => s.openProject);
  const isOpening = useProjectStore((s) => s.isOpening);
  const openDialog = useWorkspaceStore((s) => s.openDialog);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listProjectSummaries();
      setSummaries(list);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to read local projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    void detectCapabilities().then(setCaps);
    void mediaStorage.backend().then(setBackend);
  }, []);

  const warnings = useMemo(() => (caps ? compatibilityWarnings(caps) : []), [caps]);

  const handleOpen = async (id: string) => {
    try {
      await openProject(id);
    } catch (error) {
      notify('error', 'Project could not be opened', error instanceof Error ? error.message : undefined);
    }
  };

  const handleDelete = (summary: ProjectSummary) => {
    confirmAction({
      title: 'Delete project',
      message: `Delete "${summary.name}"? This removes the project and any media that is not used by another project. This cannot be undone.`,
      confirmLabel: 'Delete Project',
      danger: true,
      onConfirm: async () => {
        try {
          await deleteProjectDocument(summary.id);
          await refresh();
          notify('success', 'Project deleted');
        } catch (error) {
          notify('error', 'Could not delete project', error instanceof Error ? error.message : undefined);
        }
      },
    });
  };

  const handleDuplicate = async (summary: ProjectSummary) => {
    try {
      await duplicateProjectRecord(summary.id);
      await refresh();
      notify('success', 'Project duplicated', summary.name);
    } catch (error) {
      notify('error', 'Could not duplicate project', error instanceof Error ? error.message : undefined);
    }
  };

  const handleExportFile = async (summary: ProjectSummary) => {
    try {
      const project = await loadProjectDocument(summary.id);
      await downloadProjectFile(project);
    } catch (error) {
      notify('error', 'Could not export project file', error instanceof Error ? error.message : undefined);
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const project = await importProjectFile(file);
      await refresh();
      notify(
        'success',
        'Project imported',
        `${project.name}: media is offline after import. Re-import files from the Project panel to relink.`,
      );
    } catch (error) {
      notify('error', 'Could not import project', error instanceof Error ? error.message : undefined);
    } finally {
      setImporting(false);
    }
  };

  const menuItems: ContextMenuItem[] = menu
    ? [
        { label: 'Open Project', icon: <FolderOpen size={13} />, onClick: () => void handleOpen(menu.summary.id) },
        { label: 'Duplicate Project', icon: <Copy size={13} />, onClick: () => void handleDuplicate(menu.summary) },
        {
          label: 'Export Project File (.json)',
          icon: <HardDrive size={13} />,
          onClick: () => void handleExportFile(menu.summary),
        },
        { separator: true },
        {
          label: 'Delete Project',
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => handleDelete(menu.summary),
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#181818]">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-app-border bg-[#1d1d1d] px-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-app-accent">
            <Clapperboard size={18} className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-wide">
              PREMIERE <span className="text-app-accent">WEB</span>
            </div>
            <div className="text-3xs uppercase tracking-[0.18em] text-app-textFaint">Non-linear video editor · Phase 1</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="mr-1 hidden items-center gap-1.5 text-2xs text-app-textFaint sm:flex">
            <HardDrive size={12} />
            <span>Browser storage{backend ? ` · ${backend === 'opfs' ? 'OPFS' : 'IndexedDB'}` : ''}</span>
          </div>
          <button type="button" className="icon-btn" title="Keyboard Shortcuts" onClick={() => openDialog('shortcuts')}>
            <Keyboard size={15} />
          </button>
          <button type="button" className="icon-btn" title="Settings" onClick={() => openDialog('settings')}>
            <Settings size={15} />
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-app-text">Projects</h1>
            <p className="mt-1 text-xs text-app-textDim">
              Create a new edit, or open a project stored in this browser.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              title="Import a portable project .json file"
            >
              {importing ? <Spinner size={12} /> : <Upload size={13} />}
              Import Project
            </button>
            <button type="button" className="btn-primary" onClick={() => openDialog('new-project')}>
              <Plus size={14} />
              New Project
            </button>
          </div>
        </div>

        {warnings.length ? (
          <div className="mb-5 flex items-start gap-2 border border-[#5d4a20] bg-[#262215] px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#e5b75a]" />
            <div className="space-y-0.5">
              {warnings.map((warning) => (
                <p key={warning} className="text-2xs leading-relaxed text-[#d9c48e]">
                  {warning}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mb-3 flex items-center justify-between border-b border-app-border pb-2">
          <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-app-textDim">Recent projects</h2>
          <span className="text-2xs text-app-textFaint">{summaries.length} project{summaries.length === 1 ? '' : 's'}</span>
        </div>

        {loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-xs text-app-textDim">
            <Spinner /> Reading local projects…
          </div>
        ) : loadError ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 border border-[#6b2b2b] bg-[#241a1a]">
            <AlertTriangle size={20} className="text-[#ff8b8b]" />
            <p className="text-xs text-app-text">{loadError}</p>
            <button type="button" className="btn mt-2" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : summaries.length === 0 ? (
          <div className="flex h-64 items-center justify-center border border-dashed border-app-border bg-[#1c1c1c]">
            <EmptyState
              icon={Clapperboard}
              title="No projects yet"
              description="Create a project, import your footage and start editing. Everything is stored locally in this browser."
              action={
                <button type="button" className="btn-primary" onClick={() => openDialog('new-project')}>
                  <Plus size={14} /> Create your first project
                </button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((summary) => (
              <div
                key={summary.id}
                className="group relative flex cursor-pointer flex-col overflow-hidden border border-app-border bg-app-panel transition-colors hover:border-app-borderStrong"
                onClick={() => void handleOpen(summary.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleOpen(summary.id);
                }}
              >
                <div className="relative aspect-video w-full overflow-hidden border-b border-app-border bg-[#111111]">
                  {summary.thumbnailDataUrl ? (
                    <img
                      src={summary.thumbnailDataUrl}
                      alt={`${summary.name} thumbnail`}
                      className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,#26313d,#111111_70%)]">
                      <Video size={30} className="text-[#3b4b5c]" />
                    </div>
                  )}
                  <div className="absolute left-2 top-2 flex items-center gap-1 bg-black/55 px-1.5 py-0.5 text-3xs text-app-text">
                    <Clapperboard size={10} />
                    {summary.width} × {summary.height}
                  </div>
                  <button
                    type="button"
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-[3px] bg-black/50 text-app-textDim opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                    title="Project options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, summary });
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="truncate text-xs font-semibold text-app-text">{summary.name}</h3>
                    <span className="shrink-0 text-3xs uppercase text-app-textFaint">
                      {summary.frameRate.label} fps
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-2xs text-app-textFaint">
                    <span className="flex items-center gap-1">
                      <Video size={10} /> {summary.mediaCount} media · {summary.width}×{summary.height}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-3xs text-app-textFaint">
                    <span className="flex items-center gap-1" title={formatDateTime(summary.updatedAt)}>
                      <Clock size={10} /> {formatRelativeDate(summary.updatedAt)}
                    </span>
                    <span>{summary.width} × {summary.height}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center justify-between border-t border-app-border bg-[#1d1d1d] px-5 text-3xs text-app-textFaint">
        <span className="flex items-center gap-1">
          <Info size={10} />
          Media and projects are stored locally in this browser. Nothing is uploaded.
        </span>
        <span>{caps ? `WebCodecs ${caps.webCodecs ? 'available' : 'unavailable'} · H.264 encode ${caps.canEncodeH264 === null ? 'unknown' : caps.canEncodeH264 ? 'available' : 'unavailable'}` : ''}</span>
      </footer>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      {isOpening ? <div className="pointer-events-none fixed inset-0 bg-black/20" /> : null}
    </div>
  );
}
