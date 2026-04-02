import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';

import { loadHandle, openDB, removeHandle, saveHandle } from '../idb';

/**
 * Minimal mock satisfying FileSystemDirectoryHandle's shape.
 * Registered as a global so the `instanceof` check in `loadHandle` resolves correctly.
 *
 * Note: fake-indexeddb's structured clone does not preserve custom prototype chains,
 * so `loadHandle` will return null even after `saveHandle` in this test environment.
 * The round-trip tests below verify IDB operations via `openDB` directly.
 * Full end-to-end handle persistence is validated manually in a real browser.
 */
class MockFileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  constructor(public readonly name: string = 'test-folder') {}
}

Object.defineProperty(globalThis, 'FileSystemDirectoryHandle', {
  value: MockFileSystemDirectoryHandle,
  writable: true,
  configurable: true,
});

/** Reads the raw value stored in IndexedDB under the sync-dir-handle key. */
async function readRawHandleFromDB(): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const request = tx.objectStore('handles').get('sync-dir-handle');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

describe('idb — openDB', () => {
  it('creates the database and object store', async () => {
    const db = await openDB();
    expect(db.objectStoreNames.contains('handles')).toBe(true);
    db.close();
  });
});

describe('idb — loadHandle before any saves', () => {
  it('returns null when nothing is stored', async () => {
    const result = await loadHandle();
    expect(result).toBeNull();
  });
});

describe('idb — saveHandle', () => {
  afterEach(async () => {
    await removeHandle();
  });

  it('stores a value in IndexedDB (verifiable via openDB)', async () => {
    const handle = new MockFileSystemDirectoryHandle('my-folder');
    await saveHandle(handle as unknown as FileSystemDirectoryHandle);
    const raw = await readRawHandleFromDB();
    expect(raw).not.toBeUndefined();
    expect((raw as { name?: string }).name).toBe('my-folder');
  });

  it('second saveHandle overwrites the first', async () => {
    const first = new MockFileSystemDirectoryHandle('first');
    const second = new MockFileSystemDirectoryHandle('second');
    await saveHandle(first as unknown as FileSystemDirectoryHandle);
    await saveHandle(second as unknown as FileSystemDirectoryHandle);
    const raw = await readRawHandleFromDB();
    expect((raw as { name?: string }).name).toBe('second');
  });

  it('resolves without error', async () => {
    const handle = new MockFileSystemDirectoryHandle();
    await expect(saveHandle(handle as unknown as FileSystemDirectoryHandle)).resolves.toBeUndefined();
  });
});

describe('idb — removeHandle', () => {
  it('resolves without error when nothing is stored', async () => {
    await expect(removeHandle()).resolves.toBeUndefined();
  });

  it('deletes the stored entry so the key is gone', async () => {
    const handle = new MockFileSystemDirectoryHandle('to-remove');
    await saveHandle(handle as unknown as FileSystemDirectoryHandle);
    await removeHandle();
    const raw = await readRawHandleFromDB();
    expect(raw).toBeUndefined();
  });

  it('loadHandle returns null after removeHandle', async () => {
    const handle = new MockFileSystemDirectoryHandle();
    await saveHandle(handle as unknown as FileSystemDirectoryHandle);
    await removeHandle();
    const result = await loadHandle();
    expect(result).toBeNull();
  });
});
