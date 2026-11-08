/** Shared thumbnail / waveform / asset card components for the Media panel. */
import { useEffect, useRef, type DragEvent, type MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Film, Image as ImageIcon, Music2 } from 'lucide-react';
import type { FrameRate, MediaAsset, MediaKind } from '@/types';
import { drawWaveform } from '@/services/thumbnail-service';
import { cn } from '@/utils/format';
import {
  KIND_LABELS,
  assetDurationLabel,
  assetFpsLabel,
  assetResolutionLabel,
  assetSizeLabel,
} from './media-utils';

export const KIND_ICONS: Record<MediaKind, LucideIcon> = {
  video: Film,
  audio: Music2,
  image: ImageIcon,
};

export const KIND_ICON_COLORS: Record<MediaKind, string> = {
  video: 'text-[#7fb3ef]',
  audio: 'text-[#5fd0a0]',
  image: 'text-[#e0b382]',
};

export function KindGlyph({
  kind,
  size = 12,
  className,
}: {
  kind: MediaKind | null;
  size?: number;
  className?: string;
}) {
  if (!kind) return <span className="inline-block" style={{ width: size, height: size }} />;
  const Icon = KIND_ICONS[kind];
  return <Icon size={size} strokeWidth={1.75} className={cn(KIND_ICON_COLORS[kind], className)} />;
}

/** Compact canvas waveform used in cards, list rows and the source monitor. */
export function WaveformPreview({
  peaks,
  className,
  color,
  progress,
  gridLines,
}: {
  peaks?: number[];
  className?: string;
  color?: string;
  progress?: number;
  gridLines?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawWaveform(canvas, peaks, { color, progress, gridLines });
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, color, progress, gridLines]);

  return <canvas ref={canvasRef} className={cn('block h-full w-full', className)} aria-hidden="true" />;
}

export function MediaThumbnail({ asset, className }: { asset: MediaAsset; className?: string }) {
  if (asset.thumbnailDataUrl) {
    return (
      <img
        src={asset.thumbnailDataUrl}
        alt=""
        draggable={false}
        className={cn('h-full w-full object-contain', className)}
      />
    );
  }
  const Icon = KIND_ICONS[asset.kind];
  return (
    <div className={cn('flex h-full w-full items-center justify-center bg-[#1b1b1b]', className)}>
      <Icon size={22} strokeWidth={1.5} className="text-app-textFaint" />
    </div>
  );
}

function OfflineOverlay() {
  return (
    <div
      data-testid="media-offline"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70"
    >
      <AlertTriangle size={16} className="text-[#ff9b9b]" />
      <span className="px-1 text-center text-3xs font-semibold uppercase tracking-wide text-[#ff9b9b]">
        Media Offline
      </span>
    </div>
  );
}

export interface AssetInteractionHandlers {
  onSelect: (event: MouseEvent<HTMLElement>, asset: MediaAsset) => void;
  onOpen: (asset: MediaAsset) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, asset: MediaAsset) => void;
  onDragStart: (event: DragEvent<HTMLElement>, asset: MediaAsset) => void;
}

function cardTitle(asset: MediaAsset): string {
  const parts = [asset.name, `${KIND_LABELS[asset.kind]}`];
  if (asset.width && asset.height) parts.push(`${asset.width} × ${asset.height}`);
  parts.push(assetSizeLabel(asset));
  if (asset.missing) parts.push('Media offline — relink to restore');
  return parts.join(' · ');
}

/** Grid thumbnail card used by both the Project and Media Browser tabs. */
export function MediaGridCard({
  asset,
  sequenceFps,
  selected,
  handlers,
}: {
  asset: MediaAsset;
  sequenceFps: FrameRate;
  selected: boolean;
  handlers: AssetInteractionHandlers;
}) {
  return (
    <div
      data-media-id={asset.id}
      data-testid="media-asset"
      role="listitem"
      aria-selected={selected}
      draggable
      title={cardTitle(asset)}
      onDragStart={(event) => handlers.onDragStart(event, asset)}
      onClick={(event) => handlers.onSelect(event, asset)}
      onDoubleClick={() => handlers.onOpen(asset)}
      onContextMenu={(event) => handlers.onContextMenu(event, asset)}
      className={cn(
        'group flex cursor-default flex-col overflow-hidden rounded-[3px] border bg-app-panel2 transition-colors',
        selected
          ? 'border-app-accent ring-1 ring-app-accent'
          : 'border-app-border hover:border-app-borderStrong',
        asset.missing && 'opacity-90',
      )}
    >
      <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-black">
        <MediaThumbnail asset={asset} className="object-contain" />
        {asset.kind === 'video' && asset.waveformPeaks?.length ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-black/35">
            <WaveformPreview peaks={asset.waveformPeaks} color="#5fd0a0" progress={0} />
          </span>
        ) : null}
        <span className="pointer-events-none absolute left-1 top-1 flex items-center gap-1 rounded-[2px] bg-black/70 px-1 py-0.5">
          <KindGlyph kind={asset.kind} size={10} />
          <span className="text-3xs uppercase tracking-wide text-app-textDim">{KIND_LABELS[asset.kind]}</span>
        </span>
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-[2px] bg-black/75 px-1 py-0.5 font-mono text-3xs tabular-nums text-app-textDim">
          {assetDurationLabel(asset, sequenceFps)}
        </span>
        {asset.hasAudio && asset.kind === 'video' ? (
          <span
            className="pointer-events-none absolute bottom-1 left-1 flex items-center rounded-[2px] bg-black/70 px-1"
            title="Has audio"
          >
            <Music2 size={9} className="text-[#5fd0a0]" />
          </span>
        ) : null}
        {asset.missing ? <OfflineOverlay /> : null}
      </div>
      <div className="min-w-0 px-1.5 py-1">
        <p className="truncate text-2xs text-app-text" title={asset.name}>
          {asset.name}
        </p>
        <div className="flex items-center justify-between gap-1 text-3xs text-app-textFaint">
          <span className="truncate">
            {asset.kind === 'audio' ? 'Audio' : assetResolutionLabel(asset)}
          </span>
          <span className="shrink-0">{asset.kind === 'video' ? assetFpsLabel(asset, sequenceFps) : ''}</span>
        </div>
      </div>
    </div>
  );
}

export const MEDIA_LIST_COLUMNS = 'minmax(150px, 1fr) 56px 92px 100px 46px 64px';

export function MediaListHeader() {
  return (
    <div
      role="row"
      className="sticky top-0 z-10 grid h-[24px] shrink-0 items-center gap-2 border-b border-app-border bg-app-panel2 px-2 text-3xs uppercase tracking-wide text-app-textFaint"
      style={{ gridTemplateColumns: MEDIA_LIST_COLUMNS }}
    >
      <span>Name</span>
      <span>Kind</span>
      <span className="text-right">Duration</span>
      <span className="text-right">Resolution</span>
      <span className="text-right">FPS</span>
      <span className="text-right">Size</span>
    </div>
  );
}

/** Compact table row variant of the media list. */
export function MediaListRow({
  asset,
  sequenceFps,
  selected,
  handlers,
}: {
  asset: MediaAsset;
  sequenceFps: FrameRate;
  selected: boolean;
  handlers: AssetInteractionHandlers;
}) {
  return (
    <div
      data-media-id={asset.id}
      data-testid="media-asset"
      role="row"
      aria-selected={selected}
      draggable
      title={cardTitle(asset)}
      onDragStart={(event) => handlers.onDragStart(event, asset)}
      onClick={(event) => handlers.onSelect(event, asset)}
      onDoubleClick={() => handlers.onOpen(asset)}
      onContextMenu={(event) => handlers.onContextMenu(event, asset)}
      className={cn(
        'grid h-[32px] shrink-0 cursor-default items-center gap-2 border-b border-[#2a2a2a] px-2 text-2xs',
        selected ? 'bg-app-selection/70 text-app-text' : 'text-app-textDim hover:bg-[#2a2a2a]',
      )}
      style={{ gridTemplateColumns: MEDIA_LIST_COLUMNS }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="relative flex h-[22px] w-[40px] shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-[#333] bg-black">
          <MediaThumbnail asset={asset} />
          {asset.missing ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/70">
              <AlertTriangle size={10} className="text-[#ff9b9b]" />
            </span>
          ) : null}
        </span>
        <KindGlyph kind={asset.kind} size={11} className="shrink-0" />
        <span className="truncate" title={asset.name}>
          {asset.name}
        </span>
        {asset.kind === 'audio' && asset.waveformPeaks?.length ? (
          <span className="h-3 w-12 shrink-0 overflow-hidden rounded-sm bg-[#141d19]">
            <WaveformPreview peaks={asset.waveformPeaks} color="#4cba91" />
          </span>
        ) : null}
        {asset.missing ? (
          <span className="shrink-0 rounded-[2px] border border-[#6b2b2b] px-1 text-3xs uppercase text-[#ff9b9b]">
            Offline
          </span>
        ) : null}
      </span>
      <span>{KIND_LABELS[asset.kind]}</span>
      <span className="text-right font-mono tabular-nums">{assetDurationLabel(asset, sequenceFps)}</span>
      <span className="truncate text-right font-mono tabular-nums">{assetResolutionLabel(asset)}</span>
      <span className="text-right font-mono tabular-nums">{assetFpsLabel(asset, sequenceFps)}</span>
      <span className="text-right font-mono tabular-nums">{assetSizeLabel(asset)}</span>
    </div>
  );
}
