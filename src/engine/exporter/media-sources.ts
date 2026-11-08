/**
 * Resolves project media ids to object URLs for the export engine.
 *
 * The runtime media URLs maintained by `useMediaStore` are reused when
 * available (no extra object URLs leak). If a media asset is not hydrated yet,
 * its blob is read from the media storage layer and wrapped in a temporary
 * object URL that the resolver revokes on dispose.
 */
import type { MediaAsset, Project } from '@/types';
import { mediaStorage } from '@/services/storage/media-storage';
import { useMediaStore } from '@/stores/media-store';

/** Collects unique, non-fatal export warnings and forwards them to the UI. */
export class WarningCollector {
  private readonly seen = new Set<string>();
  private readonly collected: string[] = [];

  constructor(private readonly onWarning?: (message: string) => void) {}

  add(message: string): void {
    const trimmed = message.trim();
    if (!trimmed || this.seen.has(trimmed)) return;
    this.seen.add(trimmed);
    this.collected.push(trimmed);
    this.onWarning?.(trimmed);
  }

  list(): string[] {
    return [...this.collected];
  }
}

/**
 * Owns the media URL table for one export run and knows which URLs it created
 * itself (those must be revoked when the export finishes or is cancelled).
 */
export class ExportMediaResolver {
  private readonly assets = new Map<string, MediaAsset>();
  private readonly urls = new Map<string, string>();
  private readonly ownedUrls: string[] = [];
  private readonly missingIds = new Set<string>();
  private disposed = false;

  constructor(
    project: Project,
    private readonly warnings: WarningCollector,
  ) {
    for (const asset of project.media) this.assets.set(asset.id, asset);
  }

  asset(mediaId: string): MediaAsset | undefined {
    return this.assets.get(mediaId);
  }

  url(mediaId: string): string | undefined {
    return this.urls.get(mediaId);
  }

  isMissing(mediaId: string): boolean {
    return this.missingIds.has(mediaId) || !this.urls.has(mediaId);
  }

  /**
   * Resolve every media id used by the export. Missing/offline media is skipped
   * with a warning rather than failing the whole export.
   */
  async resolveAll(mediaIds: Iterable<string>): Promise<void> {
    const unique = [...new Set(mediaIds)];
    if (!unique.length) return;
    const storeUrls = useMediaStore.getState().urls;
    for (const mediaId of unique) {
      if (this.disposed) return;
      const asset = this.assets.get(mediaId);
      if (!asset) {
        this.missingIds.add(mediaId);
        this.warnings.add('A timeline clip references media that is not part of this project and was skipped.');
        continue;
      }
      const existing = storeUrls[mediaId] ?? this.urls.get(mediaId);
      if (existing) {
        this.urls.set(mediaId, existing);
        continue;
      }
      try {
        const blob = await mediaStorage.getBlob(asset.storageKey);
        if (!blob || blob.size === 0) throw new Error('Media blob is empty');
        const url = URL.createObjectURL(blob);
        this.ownedUrls.push(url);
        this.urls.set(mediaId, url);
      } catch {
        this.missingIds.add(mediaId);
        this.warnings.add(
          asset.missing
            ? `"${asset.name}" is offline (its file could not be found); its clips render as black/silence.`
            : `"${asset.name}" could not be loaded from storage; its clips render as black/silence.`,
        );
      }
    }
  }

  /** Raw bytes of a media source (used to decode audio). */
  async arrayBufferFor(mediaId: string): Promise<ArrayBuffer | null> {
    const url = this.urls.get(mediaId);
    if (!url) return null;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.arrayBuffer();
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const url of this.ownedUrls) URL.revokeObjectURL(url);
    this.ownedUrls.length = 0;
    this.urls.clear();
  }
}
