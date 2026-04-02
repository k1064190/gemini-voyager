/**
 * IndexedDB utility for persisting FileSystemDirectoryHandle
 *
 * Handles are NOT serializable via chrome.storage, so we use IndexedDB instead.
 * Provides open/save/load/remove operations for a single directory handle.
 */

const DB_NAME = 'gv-local-sync';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'sync-dir-handle';
const DB_VERSION = 1;

/**
 * Opens (or creates) the IndexedDB database.
 * Creates the 'handles' object store on first run.
 *
 * @returns Promise resolving to the open IDBDatabase instance
 */
export async function openDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Persists a FileSystemDirectoryHandle in IndexedDB.
 *
 * @param handle - The directory handle to store
 */
export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(handle, HANDLE_KEY);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };

      tx.oncomplete = () => {
        db.close();
      };
    });
  } catch {
    // IndexedDB not available — silently ignore
  }
}

/**
 * Loads the previously stored FileSystemDirectoryHandle from IndexedDB.
 *
 * @returns The stored handle, or null if none exists or IndexedDB is unavailable
 */
export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    return new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(HANDLE_KEY);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result instanceof FileSystemDirectoryHandle ? result : null);
      };

      request.onerror = () => {
        reject(request.error);
      };

      tx.oncomplete = () => {
        db.close();
      };
    });
  } catch {
    // IndexedDB not available
    return null;
  }
}

/**
 * Removes the stored FileSystemDirectoryHandle from IndexedDB.
 */
export async function removeHandle(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(HANDLE_KEY);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };

      tx.oncomplete = () => {
        db.close();
      };
    });
  } catch {
    // IndexedDB not available — silently ignore
  }
}
