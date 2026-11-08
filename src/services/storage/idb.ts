/**
 * Low level IndexedDB access. One database with three object stores:
 *  - projects : serialized project documents (metadata + editing state)
 *  - media    : media blobs when OPFS is unavailable
 *  - app      : small application metadata (recent project, last opened)
 */

export const DB_NAME = 'premiere-web-editor';
export const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openEditorDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser. The editor requires IndexedDB for project storage.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) {
        const store = db.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('app')) {
        db.createObjectStore('app', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open the editor database'));
    request.onblocked = () => reject(new Error('The editor database is blocked by another tab. Close other editor tabs and retry.'));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openEditorDB();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).get(key));
  return result as T | undefined;
}

export async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openEditorDB();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).getAll()) as Promise<T[]>;
}

export async function idbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openEditorDB();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).put(value));
  await txDone(tx);
}

export async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openEditorDB();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).delete(key));
  await txDone(tx);
}

export async function idbClear(storeName: string): Promise<void> {
  const db = await openEditorDB();
  const tx = db.transaction(storeName, 'readwrite');
  await requestToPromise(tx.objectStore(storeName).clear());
  await txDone(tx);
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** test helper */
export function resetEditorDBForTests(): void {
  dbPromise = null;
}
