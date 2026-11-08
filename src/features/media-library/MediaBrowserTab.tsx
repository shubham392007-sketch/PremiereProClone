/** Media Browser tab: flat grid of every clip in the project with kind filters. */
import { useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { Film, Search, Upload, X } from 'lucide-react';
import type { FrameRate, MediaAsset, MediaKind } from '@/types';
import { EmptyState } from '@/components/common/EmptyState';
import { cn } from '@/utils/format';
import type { AssetInteractionHandlers } from './MediaThumbnails';
import { MediaGridCard } from './MediaThumbnails';
import { mediaMatchesSearch } from './media-utils';
import { setMediaDragPayload } from './media-actions';

type KindFilter = 'all' | MediaKind;

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Image' },
];

export interface MediaBrowserTabProps {
  assets: MediaAsset[];
  sequenceFps: FrameRate;
  importing: boolean;
  onPickFiles: () => void;
  onOpenSource: (asset: MediaAsset) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, asset: MediaAsset, selectionIds: string[]) => void;
}

export function MediaBrowserTab({
  assets,
  sequenceFps,
  importing,
  onPickFiles,
  onOpenSource,
  onContextMenu,
}: MediaBrowserTabProps) {
  const [filter, setFilter] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const list = assets.filter(
      (asset) => (filter === 'all' || asset.kind === filter) && mediaMatchesSearch(asset, search),
    );
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [assets, filter, search]);

  const handleSelect = (_event: MouseEvent<HTMLElement>, asset: MediaAsset) => {
    setSelectedId(asset.id);
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>, asset: MediaAsset) => {
    event.preventDefault();
    setSelectedId(asset.id);
    onContextMenu(event, asset, [asset.id]);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-app-border bg-app-panel px-1.5 py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn h-6 shrink-0 gap-1 px-2 text-2xs"
            onClick={onPickFiles}
            disabled={importing}
            title="Import media files (multiple)"
          >
            <Upload size={12} />
            Import
          </button>
          <div className="relative ml-auto min-w-0 flex-1">
            <Search
              size={11}
              className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-app-textFaint"
            />
            <input
              className="field-sm w-full pl-5 pr-1"
              placeholder="Search media"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search media browser"
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                'h-5 rounded-[3px] px-1.5 text-3xs uppercase tracking-wide transition-colors',
                filter === option.id
                  ? 'bg-app-selection text-app-text'
                  : 'text-app-textFaint hover:bg-[#2d2d2d] hover:text-app-textDim',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {assets.length === 0 ? (
          <EmptyState
            icon={Film}
            title="No media in this project"
            description="Import media or drag files into this panel. Imported clips appear here and in the Project tab."
            action={
              <button type="button" className="btn-primary h-6 gap-1 px-2 text-2xs" onClick={onPickFiles}>
                <Upload size={12} />
                Import Media
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matching clips"
            description="No clips match the current filter and search text."
            action={
              <button
                type="button"
                className="btn h-6 gap-1 px-2 text-2xs"
                onClick={() => {
                  setSearch('');
                  setFilter('all');
                }}
              >
                <X size={12} />
                Reset filters
              </button>
            }
          />
        ) : (
          <>
            <div className="flex h-6 items-center gap-2 border-b border-app-border px-2 text-3xs text-app-textFaint">
              <span className="uppercase tracking-wide text-app-textDim">Media Browser</span>
              <span>
                {filtered.length} clip{filtered.length === 1 ? '' : 's'}
              </span>
              <span
                className="ml-auto truncate"
                title="Drag to the timeline to insert · Double-click to open in the Source Monitor"
              >
                Drag to timeline · Double-click to open
              </span>
            </div>
            <div role="list" className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] content-start gap-2 p-2">
              {filtered.map((asset) => (
                <MediaGridCard
                  key={asset.id}
                  asset={asset}
                  sequenceFps={sequenceFps}
                  selected={selectedId === asset.id}
                  handlers={handlers}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
