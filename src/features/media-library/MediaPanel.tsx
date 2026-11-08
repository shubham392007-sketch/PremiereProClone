/**
 * Media panel (Project dock).
 *
 * Renders its own tab bar (Project / Media Browser / Effects / History) and
 * fills the left dock. Owns the hidden file inputs, drag-and-drop import,
 * rename/relink dialogs, the asset context menu and the import progress list.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from 'react';
import {
  FolderInput,
  Link2,
  MonitorPlay,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Bin, MediaAsset, WorkspaceState } from '@/types';
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import { ContextMenu } from '@/components/common/ContextMenu';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { findSequence } from '@/engine/timeline/factory';
import { useProjectStore } from '@/stores/project-store';
import { notify } from '@/stores/workspace-store';
import {
  MEDIA_ACCEPT_BY_KIND,
  MEDIA_FILE_ACCEPT,
  importMediaFiles,
  mediaKindForFile,
  relinkMediaFile,
  type ImportProgressSnapshot,
} from '@/services/media-import';
import { ProjectTab } from './ProjectTab';
import { MediaBrowserTab } from './MediaBrowserTab';
import { EffectsTab } from './EffectsTab';
import { HistoryTab } from './HistoryTab';
import { ImportProgressList } from './ImportProgress';
import { insertMediaAtPlayhead, moveMediaToBin, openMediaInSource, removeMediaAssets } from './media-actions';

type LeftTab = WorkspaceState['leftTab'];

const TABS: { id: LeftTab; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'media', label: 'Media Browser' },
  { id: 'effects', label: 'Effects' },
  { id: 'history', label: 'History' },
];

const FALLBACK_FPS = { num: 30, den: 1, label: '30' };
const EMPTY_ASSETS: MediaAsset[] = [];
const EMPTY_BINS: Bin[] = [];

export function MediaPanel() {
  const project = useProjectStore((s) => s.project);
  const updateWorkspace = useProjectStore((s) => s.updateWorkspace);
  const activeTab: LeftTab = project?.workspace.leftTab ?? 'project';

  const assets = project?.media ?? EMPTY_ASSETS;
  const bins = project?.bins ?? EMPTY_BINS;
  const sequence = project ? findSequence(project) : undefined;
  const sequenceFps = sequence?.frameRate ?? FALLBACK_FPS;

  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  const [importSnapshot, setImportSnapshot] = useState<ImportProgressSnapshot | null>(null);
  const [importing, setImporting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; assetId: string; selectionIds: string[] } | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<MediaAsset | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const relinkTargetRef = useRef<MediaAsset | null>(null);
  const importingRef = useRef(false);
  const dragDepthRef = useRef(0);

  // A deleted bin cannot stay selected.
  useEffect(() => {
    if (selectedBinId && !bins.some((bin) => bin.id === selectedBinId)) setSelectedBinId(null);
  }, [bins, selectedBinId]);

  // webkitdirectory is not typed in React's DOM attributes; set it imperatively.
  const attachFolderInput = useCallback((element: HTMLInputElement | null) => {
    folderInputRef.current = element;
    if (element) {
      (element as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    }
  }, []);

  const runImport = useCallback(async (files: File[], binId: string | null) => {
    if (!files.length || importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setImportSnapshot({ running: true, items: [] });
    try {
      await importMediaFiles(files, { binId, onProgress: setImportSnapshot });
    } finally {
      importingRef.current = false;
      setImporting(false);
      setImportSnapshot((previous) => (previous && previous.items.length ? previous : null));
    }
  }, []);

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void runImport(files, selectedBinId);
  };

  const handleFolderInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!allFiles.length) return;
    const supported = allFiles.filter((file) => mediaKindForFile(file) !== null);
    if (!supported.length) {
      notify(
        'info',
        'No supported media files found',
        'That folder contains no supported video, audio or image files.',
      );
      return;
    }
    void runImport(supported, selectedBinId);
  };

  const handleRelinkInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const target = relinkTargetRef.current;
    relinkTargetRef.current = null;
    if (!file || !target) return;
    void relinkMediaFile(target.id, file);
  };

  const beginRelink = (asset: MediaAsset) => {
    relinkTargetRef.current = asset;
    relinkInputRef.current?.click();
  };

  const beginRename = (asset: MediaAsset) => {
    setRenameTarget(asset);
    setRenameValue(asset.name);
  };

  const commitRename = () => {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (next && next !== renameTarget.name) {
      useProjectStore.getState().updateMedia(renameTarget.id, { name: next }, 'Rename media');
    }
    setRenameTarget(null);
  };

  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, asset: MediaAsset, selectionIds: string[]) => {
      setContextMenu({ x: event.clientX, y: event.clientY, assetId: asset.id, selectionIds });
    },
    [],
  );

  const hasExternalFiles = (event: DragEvent<HTMLElement>): boolean => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let index = 0; index < types.length; index++) {
      if (types[index] === 'Files') return true;
    }
    return false;
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event) && !dropActive) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    dragDepthRef.current = 0;
    setDropActive(false);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void runImport(files, selectedBinId);
  };

  const contextAsset = contextMenu ? assets.find((asset) => asset.id === contextMenu.assetId) ?? null : null;

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextAsset || !contextMenu) return [];
    const selectionAssets = assets.filter((asset) => contextMenu.selectionIds.includes(asset.id));
    const removeTargets = selectionAssets.length ? selectionAssets : [contextAsset];
    return [
      {
        label: 'Open in Source Monitor',
        icon: <MonitorPlay size={13} />,
        onClick: () => openMediaInSource(contextAsset),
      },
      {
        label: 'Insert at Playhead',
        icon: <Plus size={13} />,
        onClick: () => insertMediaAtPlayhead(contextAsset),
      },
      { separator: true },
      {
        label: 'Rename…',
        icon: <Pencil size={13} />,
        onClick: () => beginRename(contextAsset),
      },
      {
        label: contextAsset.missing ? 'Relink Media…' : 'Replace Media…',
        icon: <Link2 size={13} />,
        onClick: () => beginRelink(contextAsset),
      },
      {
        label: 'Move to Bin',
        icon: <FolderInput size={13} />,
        submenu: [
          {
            label: 'All Media (no bin)',
            checked: contextAsset.binId === null,
            onClick: () => moveMediaToBin(contextAsset, null),
          },
          ...bins.map((bin) => ({
            label: bin.name,
            checked: contextAsset.binId === bin.id,
            onClick: () => moveMediaToBin(contextAsset, bin.id),
          })),
        ],
      },
      { separator: true },
      {
        label: removeTargets.length > 1 ? `Remove ${removeTargets.length} Media Items…` : 'Remove Media…',
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => removeMediaAssets(removeTargets),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextAsset, contextMenu, assets, bins]);

  const relinkAccept = contextAsset ? MEDIA_ACCEPT_BY_KIND[contextAsset.kind] : MEDIA_FILE_ACCEPT;

  if (!project) return null;

  return (
    <div
      data-testid="media-panel"
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app-panel"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* tab bar */}
      <div className="flex h-[30px] shrink-0 items-stretch overflow-x-auto border-b border-app-border bg-app-panel2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="tab whitespace-nowrap"
            data-active={activeTab === tab.id}
            onClick={() => updateWorkspace({ leftTab: tab.id })}
            title={tab.label}
          >
            {tab.label}
          </button>
        ))}
        <div className="ml-auto flex items-center pr-1">
          <IconButton
            icon={Upload}
            label="Import Media"
            size={22}
            iconSize={13}
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {activeTab === 'project' ? (
          <ProjectTab
            assets={assets}
            bins={bins}
            sequenceFps={sequenceFps}
            selectedBinId={selectedBinId}
            onSelectBin={setSelectedBinId}
            onPickFiles={() => fileInputRef.current?.click()}
            onPickFolder={() => folderInputRef.current?.click()}
            onOpenSource={openMediaInSource}
            onContextMenu={openContextMenu}
            importing={importing}
          />
        ) : activeTab === 'media' ? (
          <MediaBrowserTab
            assets={assets}
            sequenceFps={sequenceFps}
            importing={importing}
            onPickFiles={() => fileInputRef.current?.click()}
            onOpenSource={openMediaInSource}
            onContextMenu={openContextMenu}
          />
        ) : activeTab === 'effects' ? (
          <EffectsTab />
        ) : (
          <HistoryTab />
        )}

        {dropActive ? (
          <div className="pointer-events-none absolute inset-1 z-30 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-app-accent bg-[#152238]/85">
            <Upload size={22} className="text-app-accent" />
            <p className="text-xs font-medium text-app-text">Drop media files to import</p>
            <p className="text-2xs text-app-textDim">
              MP4, WebM, MOV, M4V · MP3, WAV, AAC, M4A, OGG, FLAC · PNG, JPG, WebP, GIF, BMP, AVIF
            </p>
          </div>
        ) : null}
      </div>

      {importSnapshot ? (
        <ImportProgressList snapshot={importSnapshot} onDismiss={() => setImportSnapshot(null)} />
      ) : null}

      {/* hidden inputs */}
      <input
        ref={fileInputRef}
        data-testid="media-file-input"
        type="file"
        multiple
        accept={MEDIA_FILE_ACCEPT}
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={attachFolderInput}
        data-testid="media-folder-input"
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
      />
      <input
        ref={relinkInputRef}
        data-testid="media-relink-input"
        type="file"
        accept={relinkAccept}
        className="hidden"
        onChange={handleRelinkInputChange}
      />

      {contextMenu && contextAsset ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      <Modal
        open={Boolean(renameTarget)}
        title="Rename media"
        subtitle={renameTarget?.fileName}
        onClose={() => setRenameTarget(null)}
        width={420}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRenameTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={commitRename}
              disabled={!renameValue.trim()}
            >
              Rename
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-1 p-4">
          <label className="label" htmlFor="rename-media-input">
            Name in project
          </label>
          <input
            id="rename-media-input"
            className="field"
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              }
            }}
          />
          <p className="pt-1 text-2xs leading-relaxed text-app-textFaint">
            Renaming affects the project only; the file on disk keeps its original name.
          </p>
        </div>
      </Modal>
    </div>
  );
}
