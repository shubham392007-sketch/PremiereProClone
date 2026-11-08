import { create } from 'zustand';
import type { MediaAsset } from '@/types';
import { mediaStorage } from '@/services/storage/media-storage';

/**
 * Runtime media URLs live outside the persisted project. Object URLs are
 * recreated on project open and revoked when media is removed or the project
 * closes.
 */
interface MediaRuntimeState {
  urls: Record<string, string>;
  /** media ids whose backing blob could not be found while hydrating */
  missingIds: string[];
  hydrating: boolean;
  hydrateProgress: { done: number; total: number };
  hydrateProjectMedia: (assets: MediaAsset[]) => Promise<string[]>;
  setMediaUrl: (mediaId: string, url: string) => void;
  removeMediaUrl: (mediaId: string) => void;
  clearAllUrls: () => void;
  hasUrl: (mediaId: string) => boolean;
}

export const useMediaStore = create<MediaRuntimeState>((set, get) => ({
  urls: {},
  missingIds: [],
  hydrating: false,
  hydrateProgress: { done: 0, total: 0 },

  async hydrateProjectMedia(assets) {
    // Revoke URLs for media that is no longer part of the project.
    const validIds = new Set(assets.map((a) => a.id));
    const current = get().urls;
    for (const [mediaId, url] of Object.entries(current)) {
      if (!validIds.has(mediaId)) {
        URL.revokeObjectURL(url);
        set((state) => {
          const next = { ...state.urls };
          delete next[mediaId];
          return { urls: next };
        });
      }
    }
    set({ hydrating: true, hydrateProgress: { done: 0, total: assets.length } });
    const missing: string[] = [];
    let done = 0;
    // limited concurrency to keep the UI responsive while restoring large files
    const queue = [...assets];
    const worker = async () => {
      while (queue.length) {
        const asset = queue.shift()!;
        if (get().urls[asset.id]) {
          done++;
          set({ hydrateProgress: { done, total: assets.length } });
          continue;
        }
        try {
          const blob = await mediaStorage.getBlob(asset.storageKey);
          if (!blob || blob.size === 0) {
            missing.push(asset.id);
          } else {
            const url = URL.createObjectURL(blob);
            set((state) => ({ urls: { ...state.urls, [asset.id]: url } }));
          }
        } catch {
          missing.push(asset.id);
        }
        done++;
        set({ hydrateProgress: { done, total: assets.length } });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    set({ hydrating: false, missingIds: missing });
    return missing;
  },

  setMediaUrl(mediaId, url) {
    const existing = get().urls[mediaId];
    if (existing && existing !== url) URL.revokeObjectURL(existing);
    set((state) => ({ urls: { ...state.urls, [mediaId]: url } }));
  },

  removeMediaUrl(mediaId) {
    const url = get().urls[mediaId];
    if (url) URL.revokeObjectURL(url);
    set((state) => {
      const next = { ...state.urls };
      delete next[mediaId];
      return {
        urls: next,
        missingIds: state.missingIds.filter((id) => id !== mediaId),
      };
    });
  },

  clearAllUrls() {
    for (const url of Object.values(get().urls)) URL.revokeObjectURL(url);
    set({ urls: {}, missingIds: [], hydrating: false });
  },

  hasUrl(mediaId) {
    return Boolean(get().urls[mediaId]);
  },
}));

/** Non-reactive accessor for engine code. */
export function getMediaUrl(mediaId: string): string | undefined {
  return useMediaStore.getState().urls[mediaId];
}
