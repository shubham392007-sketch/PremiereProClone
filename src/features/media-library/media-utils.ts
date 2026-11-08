/** Formatting helpers and constants shared by the Media panel views. */
import type { FrameRate, MediaAsset, MediaKind } from '@/types';
import { formatBytes } from '@/utils/format';
import { frameToTimecode, secondsToFrame } from '@/utils/time';

/** dataTransfer type used for media drags from the panel/source monitor to the timeline. */
export const MEDIA_DRAG_TYPE = 'application/x-premiere-media';

export const KIND_LABELS: Record<MediaKind, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
};

export function assetDurationFrames(asset: MediaAsset, fps: FrameRate): number {
  if (asset.kind === 'image') return 0;
  if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0) return 0;
  return Math.max(0, secondsToFrame(asset.durationSec, fps));
}

export function assetDurationLabel(asset: MediaAsset, fps: FrameRate): string {
  if (asset.kind === 'image') return 'Still';
  if (!asset.durationSec) return '—';
  return frameToTimecode(assetDurationFrames(asset, fps), fps);
}

export function assetResolutionLabel(asset: MediaAsset): string {
  if (asset.kind === 'audio') return '—';
  if (asset.width > 0 && asset.height > 0) return `${asset.width} × ${asset.height}`;
  return '—';
}

export function assetFpsLabel(asset: MediaAsset, sequenceFps: FrameRate): string {
  if (asset.kind !== 'video') return '—';
  return asset.fps?.label ?? sequenceFps.label;
}

export function assetSizeLabel(asset: MediaAsset): string {
  return formatBytes(asset.sizeBytes);
}

export function mediaMatchesSearch(asset: MediaAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    asset.name.toLowerCase().includes(needle) ||
    asset.fileName.toLowerCase().includes(needle) ||
    KIND_LABELS[asset.kind].toLowerCase().includes(needle)
  );
}

export type MediaSortKey = 'name' | 'kind' | 'duration' | 'date';

export const MEDIA_SORT_OPTIONS: { value: MediaSortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'kind', label: 'Kind' },
  { value: 'duration', label: 'Duration' },
  { value: 'date', label: 'Date Added' },
];

const KIND_ORDER: Record<MediaKind, number> = { video: 0, audio: 1, image: 2 };

export function sortMediaAssets(assets: MediaAsset[], key: MediaSortKey, direction: 1 | -1): MediaAsset[] {
  const sorted = [...assets].sort((a, b) => {
    let result = 0;
    switch (key) {
      case 'name':
        result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'kind':
        result = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        if (result === 0) result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'duration':
        result = a.durationSec - b.durationSec;
        break;
      case 'date':
        result = a.importedAt - b.importedAt;
        break;
      default:
        result = 0;
    }
    return result * direction;
  });
  return sorted;
}
