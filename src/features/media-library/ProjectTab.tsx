/**
 * Project tab: bins, search/sort, thumbnail/list views, multi-select and
 * context-menu operations. All operations go through the project store.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Film,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  LayoutGrid,
  List,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Bin, FrameRate, MediaAsset } from '@/types';
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import { ContextMenu } from '@/components/common/ContextMenu';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { confirmAction } from '@/stores/workspace-store';
import { useProjectStore } from '@/stores/project-store';
import { cn } from '@/utils/format';
import type { AssetInteractionHandlers } from './MediaThumbnails';
import { MediaGridCard, MediaListHeader, MediaListRow } from './MediaThumbnails';
import { MEDIA_SORT_OPTIONS, mediaMatchesSearch, sortMediaAssets, type MediaSortKey } from './media-utils';
import { removeMediaAssets, setMediaDragPayload } from './media-actions';

export interface ProjectTabProps {
  assets: MediaAsset[];
  bins: Bin[];
  sequenceFps: FrameRate;
  selectedBinId: string | null;
  onSelectBin: (binId: string | null) => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onOpenSource: (asset: MediaAsset) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, asset: MediaAsset, selectionIds: string[]) => void;
  importing: boolean;
}

export function ProjectTab({
  assets,
  bins,
  sequenceFps,
  selectedBinId,
  onSelectBin,
  onPickFiles,
  onPickFolder,
  onOpenSource,
  onContextMenu,
  importing,
}: ProjectTabProps) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<MediaSortKey>('name');
  const [sortDirection, setSortDirection] = useState<1 | -1>(1);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selection, setSelection] = useState<string[]>([]);
  const [binMenu, setBinMenu] = useState<{ x: number; y: number; binId: string } | null>(null);
  const [editingBin, setEditingBin] = useState<{ id: string; value: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSelectedRef = useRef<string | null>(null);

  // Selection can never reference media that no longer exists.
  useEffect(() => {
    setSelection((previous) => {
      const next = previous.filter((id) => assets.some((asset) => asset.id === id));
      return next.length === previous.length ? previous : next;
    });
  }, [assets]);

  const selectedBin = selectedBinId ? bins.find((bin) => bin.id === selectedBinId) ?? null : null;

  const filtered = useMemo(() => {
    let list = assets;
    if (selectedBinId) list = list.filter((asset) => asset.binId === selectedBinId);
    if (search.trim()) list = list.filter((asset) => mediaMatchesSearch(asset, search));
    return sortMediaAssets(list, sortKey, sortDirection);
  }, [assets, selectedBinId, search, sortKey, sortDirection]);

  const offlineCount = filtered.filter((asset) => asset.missing).length;

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selection.includes(asset.id)),
    [assets, selection],
  );

  const handleSelect = (event: MouseEvent<HTMLElement>, asset: MediaAsset) => {
    if (event.shiftKey && lastSelectedRef.current) {
      const anchorIndex = filtered.findIndex((item) => item.id === lastSelectedRef.current);
      const targetIndex = filtered.findIndex((item) => item.id === asset.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const from = Math.min(anchorIndex, targetIndex);
        const to = Math.max(anchorIndex, targetIndex);
        setSelection(filtered.slice(from, to + 1).map((item) => item.id));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelection((previous) =>
        previous.includes(asset.id) ? previous.filter((id) => id !== asset.id) : [...previous, asset.id],
      );
    } else {
      setSelection([asset.id]);
    }
    lastSelectedRef.current = asset.id;
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>, asset: MediaAsset) => {
    event.preventDefault();
    const ids = selection.includes(asset.id) ? selection : [asset.id];
    if (!selection.includes(asset.id)) setSelection([asset.id]);
    lastSelectedRef.current = asset.id;
    onContextMenu(event, asset, ids);
  };

  const handleDragStart = (event: DragEvent<HTMLElement>, asset: MediaAsset) => {
    setMediaDragPayload(event, asset);
  };

  const handlers: AssetInteractionHandlers = {
    onSelect: handleSelect,
    onOpen: onOpenSource,
    onContextMenu: handleContextMenu,
    onDragStart: handleDragStart,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isFormField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
    if (isFormField) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAssets.length) {
      event.preventDefault();
      removeMediaAssets(selectedAssets);
    } else if (event.key === 'Escape') {
      setSelection([]);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(filtered.map((asset) => asset.id));
    }
  };

  const handleCreateBin = () => {
    const bin = useProjectStore.getState().addBin('New Bin');
    onSelectBin(bin.id);
    setEditingBin({ id: bin.id, value: bin.name });
  };

  const commitBinRename = () => {
    if (!editingBin) return;
    const name = editingBin.value.trim();
    if (name) useProjectStore.getState().renameBin(editingBin.id, name);
    setEditingBin(null);
  };

  const handleDeleteBin = (binId: string) => {
    const bin = bins.find((item) => item.id === binId);
    if (!bin) return;
    confirmAction({
      title: 'Delete bin?',
      message: `"${bin.name}" will be removed. Media inside it moves back to the project root; the files themselves are not deleted.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        useProjectStore.getState().deleteBin(binId);
        if (selectedBinId === binId) onSelectBin(null);
      },
    });
  };

  const binMenuItems: ContextMenuItem[] = binMenu
    ? [
        {
          label: 'Rename Bin',
          icon: <FolderInput size={13} />,
          onClick: () => {
            const bin = bins.find((item) => item.id === binMenu.binId);
            if (bin) setEditingBin({ id: bin.id, value: bin.name });
          },
        },
        { separator: true },
        {
          label: 'Delete Bin',
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: () => handleDeleteBin(binMenu.binId),
        },
      ]
    : [];

  const binContentEmpty = selectedBinId !== null && filtered.length === 0 && !search.trim();

  let emptyState: JSX.Element;
  if (assets.length === 0) {
    emptyState = (
      <EmptyState
        icon={Film}
        title="No media in project"
        description="Import video, audio and image files to start editing. You can also drag files straight into this panel."
        action={
          <button type="button" className="btn-primary h-6 gap-1 px-2 text-2xs" onClick={onPickFiles}>
            <Upload size={12} />
            Import Media
          </button>
        }
      />
    );
  } else if (binContentEmpty) {
    emptyState = (
      <EmptyState
        icon={Inbox}
        title="This bin is empty"
        description={`Drag media onto "${selectedBin?.name ?? 'this bin'}" or use the context menu to move items here.`}
        action={
          <button type="button" className="btn h-6 gap-1 px-2 text-2xs" onClick={onPickFiles}>
            <Upload size={12} />
            Import into bin
          </button>
        }
      />
    );
  } else {
    emptyState = (
      <EmptyState
        icon={Search}
        title="No matching media"
        description="No clips match the current search text in this view."
        action={
          <button type="button" className="btn h-6 gap-1 px-2 text-2xs" onClick={() => setSearch('')}>
            <X size={12} />
            Clear search
          </button>
        }
      />
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) &&
          !target.isContentEditable
        ) {
          rootRef.current?.focus({ preventScroll: true });
        }
      }}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      {/* toolbar */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-app-border bg-app-panel px-1.5 py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="import-media-button"
            className="btn h-6 gap-1 px-2 text-2xs"
            onClick={onPickFiles}
            disabled={importing}
            title="Import media files (multiple)"
          >
            <Upload size={12} />
            Import
          </button>
          <IconButton icon={FolderPlus} label="New Bin" size={22} iconSize={13} onClick={handleCreateBin} />
          <IconButton
            icon={FolderInput}
            label="Import Folder"
            size={22}
            iconSize={13}
            onClick={onPickFolder}
            disabled={importing}
          />
          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-[3px] border border-app-border bg-[#1b1b1b] p-0.5">
            <IconButton
              icon={LayoutGrid}
              label="Thumbnail view"
              size={20}
              iconSize={12}
              active={view === 'grid'}
              onClick={() => setView('grid')}
            />
            <IconButton
              icon={List}
              label="List view"
              size={20}
              iconSize={12}
              active={view === 'list'}
              onClick={() => setView('list')}
            />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search
              size={11}
              className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-app-textFaint"
            />
            <input
              className="field-sm w-full pl-5 pr-1"
              placeholder="Search media"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search media"
            />
          </div>
          <select
            className="select h-6 w-[86px] shrink-0 text-2xs"
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as MediaSortKey)}
            title="Sort media by"
            aria-label="Sort media by"
          >
            {MEDIA_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <IconButton
            icon={sortDirection === 1 ? ArrowDownAZ : ArrowUpAZ}
            label={sortDirection === 1 ? 'Sort descending' : 'Sort ascending'}
            size={22}
            iconSize={13}
            onClick={() => setSortDirection((previous) => (previous === 1 ? -1 : 1))}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* bins */}
        <aside className="flex w-[128px] shrink-0 flex-col border-r border-app-border bg-[#1c1c1c]">
          <div className="flex h-7 shrink-0 items-center justify-between border-b border-app-border px-1.5">
            <span className="text-2xs uppercase tracking-wide text-app-textDim">Bins</span>
            <IconButton icon={FolderPlus} label="New Bin" size={18} iconSize={11} onClick={handleCreateBin} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <BinRow
              icon={Inbox}
              label="All Media"
              count={assets.length}
              active={selectedBinId === null}
              onClick={() => onSelectBin(null)}
            />
            {bins.map((bin) => {
              const count = assets.filter((asset) => asset.binId === bin.id).length;
              return (
                <BinRow
                  key={bin.id}
                  icon={Folder}
                  label={bin.name}
                  count={count}
                  active={selectedBinId === bin.id}
                  editing={editingBin?.id === bin.id}
                  editValue={editingBin?.id === bin.id ? editingBin.value : ''}
                  onEditChange={(value) => setEditingBin({ id: bin.id, value })}
                  onEditCommit={commitBinRename}
                  onEditCancel={() => setEditingBin(null)}
                  onClick={() => onSelectBin(bin.id)}
                  onDoubleClick={() => setEditingBin({ id: bin.id, value: bin.name })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setBinMenu({ x: event.clientX, y: event.clientY, binId: bin.id });
                  }}
                />
              );
            })}
            {bins.length === 0 ? (
              <p className="px-2 py-1 text-3xs leading-relaxed text-app-textFaint">No bins yet. Create one to organize media.</p>
            ) : null}
          </div>
        </aside>

        {/* asset area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-6 shrink-0 items-center gap-2 border-b border-app-border px-2 text-3xs text-app-textFaint">
            <span className="truncate uppercase tracking-wide text-app-textDim">
              {selectedBin ? selectedBin.name : 'All Media'}
            </span>
            <span className="shrink-0">
              {filtered.length} item{filtered.length === 1 ? '' : 's'}
            </span>
            {selection.length > 0 ? (
              <span className="shrink-0 text-app-textDim">{selection.length} selected</span>
            ) : null}
            {offlineCount > 0 ? (
              <span className="ml-auto shrink-0 text-[#ff9b9b]">{offlineCount} offline</span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              emptyState
            ) : view === 'grid' ? (
              <div
                role="list"
                className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] content-start gap-2 p-2"
              >
                {filtered.map((asset) => (
                  <MediaGridCard
                    key={asset.id}
                    asset={asset}
                    sequenceFps={sequenceFps}
                    selected={selection.includes(asset.id)}
                    handlers={handlers}
                  />
                ))}
              </div>
            ) : (
              <>
                <MediaListHeader />
                {filtered.map((asset) => (
                  <MediaListRow
                    key={asset.id}
                    asset={asset}
                    sequenceFps={sequenceFps}
                    selected={selection.includes(asset.id)}
                    handlers={handlers}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {binMenu ? (
        <ContextMenu x={binMenu.x} y={binMenu.y} items={binMenuItems} onClose={() => setBinMenu(null)} />
      ) : null}
    </div>
  );
}

function BinRow({
  icon: Icon,
  label,
  count,
  active,
  editing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  active: boolean;
  editing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex h-[24px] cursor-default items-center gap-1.5 px-1.5 text-2xs',
        active ? 'bg-app-selection/70 text-app-text' : 'text-app-textDim hover:bg-[#2a2a2a]',
      )}
      title={label}
    >
      <Icon size={12} strokeWidth={1.75} className="shrink-0 text-app-textFaint" />
      {editing ? (
        <input
          autoFocus
          className="field-sm h-5 min-w-0 flex-1 px-1"
          value={editValue ?? ''}
          onChange={(event) => onEditChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onEditCommit?.();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onEditCancel?.();
            }
          }}
          onBlur={onEditCommit}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 font-mono text-3xs text-app-textFaint">{count}</span>
        </>
      )}
    </div>
  );
}
