/** User actions available from the Media panel (context menus, drag payloads). */
import type { DragEvent } from 'react';
import type { MediaAsset } from '@/types';
import { usePlaybackStore } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { useMediaStore } from '@/stores/media-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { confirmAction, notify } from '@/stores/workspace-store';
import { cleanupOrphanMedia } from '@/services/storage/project-storage';
import { MEDIA_DRAG_TYPE } from './media-utils';

/** Load an asset into the Source monitor (double click / context menu). */
export function openMediaInSource(asset: MediaAsset): void {
  if (asset.missing) {
    notify('error', 'Media is offline', `Relink "${asset.name}" to preview and edit it.`);
    return;
  }
  usePlaybackStore.getState().openSource(asset.id);
}

/** Append the whole asset at the program playhead on a compatible track. */
export function insertMediaAtPlayhead(asset: MediaAsset): void {
  if (asset.missing) {
    notify('error', 'Media is offline', `Relink "${asset.name}" before adding it to the timeline.`);
    return;
  }
  const frame = usePlaybackStore.getState().currentFrame;
  useTimelineStore.getState().insertMediaAt(asset.id, null, frame);
}

/** dataTransfer payload consumed by the timeline drop handler. */
export function setMediaDragPayload(event: DragEvent<HTMLElement>, asset: MediaAsset): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(MEDIA_DRAG_TYPE, asset.id);
  event.dataTransfer.setData('text/plain', asset.id);
  event.dataTransfer.effectAllowed = 'copy';
}

export function moveMediaToBin(asset: MediaAsset, binId: string | null): void {
  useProjectStore.getState().moveMediaToBin(asset.id, binId);
}

/** Remove one or more assets with a confirmation dialog (also removes clips). */
export function removeMediaAssets(assets: MediaAsset[]): void {
  const items = assets.filter(Boolean);
  if (!items.length) return;
  const single = items.length === 1 ? items[0] : null;
  confirmAction({
    title: single ? 'Remove media?' : `Remove ${items.length} media items?`,
    message: single
      ? `"${single.name}" will be removed from the project. Any timeline clips using it are deleted too. The original file on disk is not touched.`
      : `${items.length} media items will be removed from the project. Timeline clips using them are deleted too. The original files on disk are not touched.`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: () => {
      if (single) {
        useProjectStore.getState().removeMedia(single.id);
        return;
      }
      const ids = new Set(items.map((item) => item.id));
      useProjectStore.getState().applyEdit(`Remove ${items.length} media items`, (draft) => {
        draft.media = draft.media.filter((media) => !ids.has(media.id));
        for (const sequence of draft.sequences) {
          sequence.clips = sequence.clips.filter((clip) => !ids.has(clip.mediaId));
        }
      });
      for (const item of items) useMediaStore.getState().removeMediaUrl(item.id);
      void (async () => {
        await useProjectStore.getState().saveNow();
        await cleanupOrphanMedia().catch(() => undefined);
      })();
    },
  });
}
