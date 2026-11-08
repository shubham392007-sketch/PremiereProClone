/**
 * Media blob persistence abstraction.
 *
 * Preference order:
 *   1. Origin Private File System (OPFS) for large media files.
 *   2. IndexedDB blob storage fallback.
 *
 * Storage keys are prefixed with their backend (`opfs:` / `idb:`) so that the
 * same project can be reopened in a browser where OPFS is unavailable.
 */
import { idbClear, idbDelete, idbGet, idbPut } from './idb';

const OPFS_DIR_NAME = 'media';

interface StoredMediaRecord {
  key: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  savedAt: number;
}

interface OpfsContext {
  root: FileSystemDirectoryHandle;
}

let opfsContextPromise: Promise<OpfsContext | null> | null = null;

async function getOpfsContext(): Promise<OpfsContext | null> {
  if (opfsContextPromise) return opfsContextPromise;
  opfsContextPromise = (async () => {
    try {
      const storage = navigator.storage as StorageManager & {
        getDirectory?: () => Promise<FileSystemDirectoryHandle>;
      };
      if (!storage || typeof storage.getDirectory !== 'function') return null;
      const root = await storage.getDirectory();
      return { root };
    } catch {
      return null;
    }
  })();
  return opfsContextPromise;
}

async function getOpfsFileHandle(
  fileName: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  const ctx = await getOpfsContext();
  if (!ctx) return null;
  try {
    const dir = await ctx.root.getDirectoryHandle(OPFS_DIR_NAME, { create });
    return await dir.getFileHandle(fileName, { create });
  } catch {
    return null;
  }
}

function extensionFor(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (fromName && fromName.length <= 5) return fromName;
  const fromMime = file.type.split('/')[1] ?? 'bin';
  return fromMime === 'quicktime' ? 'mov' : fromMime;
}

export const mediaStorage = {
  /** Persist a media file and return its storage key. */
  async saveFile(mediaId: string, file: File): Promise<string> {
    const fileName = `${mediaId}.${extensionFor(file)}`;
    const handle = await getOpfsFileHandle(fileName, true);
    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        return `opfs:${fileName}`;
      } catch {
        // fall through to IndexedDB
      }
    }
    const key = `idb:${fileName}`;
    const record: StoredMediaRecord = {
      key,
      blob: file,
      fileName: file.name,
      mimeType: file.type,
      savedAt: Date.now(),
    };
    await idbPut('media', record);
    return key;
  },

  async getBlob(storageKey: string): Promise<Blob | null> {
    if (!storageKey) return null;
    if (storageKey.startsWith('opfs:')) {
      const fileName = storageKey.slice(5);
      const handle = await getOpfsFileHandle(fileName, false);
      if (!handle) return null;
      try {
        return await handle.getFile();
      } catch {
        return null;
      }
    }
    const record = await idbGet<StoredMediaRecord>('media', storageKey);
    return record?.blob ?? null;
  },

  async exists(storageKey: string): Promise<boolean> {
    try {
      const blob = await this.getBlob(storageKey);
      return !!blob && blob.size > 0;
    } catch {
      return false;
    }
  },

  async deleteFile(storageKey: string): Promise<void> {
    if (!storageKey) return;
    if (storageKey.startsWith('opfs:')) {
      const ctx = await getOpfsContext();
      if (!ctx) return;
      try {
        const dir = await ctx.root.getDirectoryHandle(OPFS_DIR_NAME, { create: false });
        await dir.removeEntry(storageKey.slice(5));
      } catch {
        /* already gone */
      }
      return;
    }
    await idbDelete('media', storageKey);
  },

  backend(): Promise<'opfs' | 'indexeddb'> {
    return getOpfsContext().then((ctx) => (ctx ? 'opfs' : 'indexeddb'));
  },

  /** Remove every stored media blob (OPFS directory + IndexedDB fallback store). */
  async clearAll(): Promise<void> {
    const ctx = await getOpfsContext();
    if (ctx) {
      try {
        await ctx.root.removeEntry(OPFS_DIR_NAME, { recursive: true });
      } catch {
        /* directory may not exist */
      }
    }
    await idbClear('media');
  },
};

export type MediaStorageBackend = 'opfs' | 'indexeddb';
