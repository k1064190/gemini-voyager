import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/utils/idb', () => ({
  loadHandle: vi.fn(),
  saveHandle: vi.fn(),
  removeHandle: vi.fn(),
}));

// Predictable hash for account scoping assertions
vi.mock('@/core/utils/hash', () => ({
  hashString: vi.fn((input: string) => `hash-${input}`),
}));

import { loadHandle, removeHandle } from '@/core/utils/idb';

type MockedChrome = typeof chrome;

function createChromeMock(): MockedChrome {
  return {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      sync: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  } as unknown as MockedChrome;
}

/**
 * Creates a mock FileSystemDirectoryHandle that reads/writes in-memory.
 *
 * @param name - directory handle name
 * @param opts.staleWrite - when true, close() succeeds but does NOT persist data,
 *   simulating a stale File System Access API permission in a service worker.
 */
function createMockHandle(name = 'test-folder', opts?: { staleWrite?: boolean }) {
  const files = new Map<string, string>();
  return {
    name,
    kind: 'directory' as const,
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    getFileHandle: vi.fn().mockImplementation((fileName: string) => {
      return Promise.resolve({
        getFile: () => {
          const content = files.get(fileName) ?? '';
          return Promise.resolve({
            text: () => Promise.resolve(content),
            size: content.length,
          });
        },
        createWritable: () => {
          let written = '';
          return Promise.resolve({
            write: vi.fn().mockImplementation((data: string) => {
              written = data;
              return Promise.resolve();
            }),
            close: vi.fn().mockImplementation(() => {
              if (!opts?.staleWrite) {
                files.set(fileName, written);
              }
              return Promise.resolve();
            }),
          });
        },
      });
    }),
    /** Exposes internal file store for test assertions */
    _files: files,
  };
}

async function loadServiceClass() {
  vi.resetModules();
  const mod = await import('../LocalFolderSyncService');
  return mod.LocalFolderSyncService;
}

describe('LocalFolderSyncService — isSupported', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).showDirectoryPicker;
  });

  it('returns true when showDirectoryPicker exists on globalThis', async () => {
    (globalThis as Record<string, unknown>).showDirectoryPicker = vi.fn();
    const Service = await loadServiceClass();
    expect(Service.isSupported()).toBe(true);
  });

  it('returns false when showDirectoryPicker is absent', async () => {
    delete (globalThis as Record<string, unknown>).showDirectoryPicker;
    const Service = await loadServiceClass();
    expect(Service.isSupported()).toBe(false);
  });
});

describe('LocalFolderSyncService — getState / setMode', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns DEFAULT_SYNC_STATE initially', async () => {
    const Service = await loadServiceClass();
    const service = new Service();
    const state = await service.getState();
    expect(state.mode).toBe('disabled');
    expect(state.isSyncing).toBe(false);
    expect(state.error).toBeNull();
  });

  it('setMode persists to chrome.storage.local using LocalSyncStorageKeys', async () => {
    const Service = await loadServiceClass();
    const service = new Service();
    await service.getState(); // drain stateLoadPromise before mutating
    await service.setMode('manual');
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ gvLocalSyncMode: 'manual' }),
    );
  });

  it('setMode updates state returned by getState', async () => {
    const Service = await loadServiceClass();
    const service = new Service();
    await service.getState(); // drain stateLoadPromise before mutating
    await service.setMode('auto');
    const state = await service.getState();
    expect(state.mode).toBe('auto');
  });

  it('onStateChange callback fires on mode change', async () => {
    const Service = await loadServiceClass();
    const service = new Service();
    await service.getState(); // drain stateLoadPromise before registering callback
    const cb = vi.fn();
    service.onStateChange(cb);
    await service.setMode('manual');
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual' }));
  });
});

describe('LocalFolderSyncService — upload', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
    vi.mocked(removeHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts = [{ id: '1', text: 'hello', tags: [], createdAt: 0 }];

  it('returns false and sets error when no handle stored', async () => {
    vi.mocked(loadHandle).mockResolvedValue(null);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.error).toBeTruthy();
  });

  it('returns false and sets error when permission denied', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('denied');
    handle.requestPermission.mockResolvedValue('denied');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.error).toContain('Permission expired');
  });

  it('uploads folders and prompts files on success', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(true);
    expect(handle.getFileHandle).toHaveBeenCalledWith('gemini-voyager-folders.json', { create: true });
    expect(handle.getFileHandle).toHaveBeenCalledWith('gemini-voyager-prompts.json', { create: true });
  });

  it('writes starred and forks files when provided', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const starred = { messages: {} };
    const forks = { nodes: {}, groups: {} };
    await service.upload(folders, prompts, starred, true, 'gemini', forks, null);
    expect(handle.getFileHandle).toHaveBeenCalledWith('gemini-voyager-starred.json', { create: true });
    expect(handle.getFileHandle).toHaveBeenCalledWith('gemini-voyager-forks.json', { create: true });
  });

  it('does not write starred/forks files when null', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const names = handle.getFileHandle.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).not.toContain('gemini-voyager-starred.json');
    expect(names).not.toContain('gemini-voyager-forks.json');
  });

  it('sets lastUploadTime for gemini platform', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const state = await service.getState();
    expect(state.lastUploadTime).toBeTypeOf('number');
    expect(state.lastUploadTimeAIStudio).toBeNull();
  });

  it('sets lastUploadTimeAIStudio for aistudio platform', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'aistudio', null, null);
    const state = await service.getState();
    expect(state.lastUploadTimeAIStudio).toBeTypeOf('number');
    expect(state.lastUploadTime).toBeNull();
  });

  it('uses account-scoped file names when accountScope provided', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const accountScope = { accountKey: 'user@example.com', accountId: 1, routeUserId: 'uid' };
    await service.upload(folders, prompts, null, true, 'gemini', null, accountScope);
    const names = handle.getFileHandle.mock.calls.map((c: unknown[]) => c[0]);
    // hashString mock returns `hash-${input}`
    expect(names).toContain('gemini-voyager-folders-acct-hash-user@example.com.json');
    expect(names).toContain('gemini-voyager-prompts-acct-hash-user@example.com.json');
  });

  it('uses base file names when accountScope is null', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const names = handle.getFileHandle.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain('gemini-voyager-folders.json');
    expect(names).toContain('gemini-voyager-prompts.json');
  });

  it('written JSON has correct payload format and version', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);

    const text = handle._files.get('gemini-voyager-folders.json') ?? '';
    const parsed = JSON.parse(text) as { format?: string; version?: string };
    expect(parsed.format).toBe('gemini-voyager.folders.v1');
    expect(parsed.version).toBe('1');
  });
});

describe('LocalFolderSyncService — download', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
    vi.mocked(removeHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns null when no handle stored', async () => {
    vi.mocked(loadHandle).mockResolvedValue(null);
    const Service = await loadServiceClass();
    const service = new Service();
    const result = await service.download(true, 'gemini', null);
    expect(result).toBeNull();
  });

  it('returns null and sets error when permission denied', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('denied');
    handle.requestPermission.mockResolvedValue('denied');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const result = await service.download(true, 'gemini', null);
    expect(result).toBeNull();
    const state = await service.getState();
    expect(state.error).toContain('Permission expired');
  });

  it('sets lastSyncTime on successful download', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.download(true, 'gemini', null);
    const state = await service.getState();
    expect(state.lastSyncTime).toBeTypeOf('number');
  });

  it('returns null payload for each missing file (empty handle)', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const result = await service.download(true, 'gemini', null);
    // Empty files produce empty string → readJsonFile returns null
    expect(result).not.toBeNull();
    expect(result?.folders).toBeNull();
    expect(result?.prompts).toBeNull();
    expect(result?.starred).toBeNull();
    expect(result?.forks).toBeNull();
  });

  it('reads account-scoped file names when accountScope provided', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const accountScope = { accountKey: 'user@example.com', accountId: 1, routeUserId: 'uid' };
    await service.download(true, 'gemini', accountScope);
    const names = handle.getFileHandle.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain('gemini-voyager-folders-acct-hash-user@example.com.json');
  });

  it('returns parsed payloads from stored JSON files', async () => {
    const handle = createMockHandle();
    // Pre-populate the file store with a valid payload
    const foldersPayload = {
      format: 'gemini-voyager.folders.v1',
      exportedAt: '2025-01-01T00:00:00.000Z',
      version: '1',
      data: { folders: [], folderContents: {} },
    };
    handle._files.set('gemini-voyager-folders.json', JSON.stringify(foldersPayload));
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const result = await service.download(true, 'gemini', null);
    expect(result?.folders).toEqual(foldersPayload);
  });
});

describe('LocalFolderSyncService — error codes', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts: { id: string; text: string; tags: string[]; createdAt: number }[] = [];

  it('upload sets errorCode no_handle when no handle stored', async () => {
    vi.mocked(loadHandle).mockResolvedValue(null);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const state = await service.getState();
    expect(state.errorCode).toBe('no_handle');
  });

  it('upload sets errorCode permission_expired when permission cannot be obtained', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('prompt');
    handle.requestPermission.mockResolvedValue('denied');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const state = await service.getState();
    expect(state.errorCode).toBe('permission_expired');
  });

  it('upload clears errorCode on success', async () => {
    const handle = createMockHandle();
    // Simulate a prior error state, then a successful upload
    vi.mocked(loadHandle).mockResolvedValueOnce(null); // first call → no_handle
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null); // sets errorCode
    await service.upload(folders, prompts, null, true, 'gemini', null, null); // clears it
    const state = await service.getState();
    expect(state.errorCode).toBeUndefined();
  });

  it('download sets errorCode no_handle when no handle stored', async () => {
    vi.mocked(loadHandle).mockResolvedValue(null);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.download(true, 'gemini', null);
    const state = await service.getState();
    expect(state.errorCode).toBe('no_handle');
  });

  it('download sets errorCode permission_expired when permission cannot be obtained', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('prompt');
    handle.requestPermission.mockResolvedValue('denied');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.download(true, 'gemini', null);
    const state = await service.getState();
    expect(state.errorCode).toBe('permission_expired');
  });

  it('download clears errorCode on success', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValueOnce(null); // first → no_handle
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.download(true, 'gemini', null); // sets errorCode
    await service.download(true, 'gemini', null); // clears it
    const state = await service.getState();
    expect(state.errorCode).toBeUndefined();
  });
});

describe('LocalFolderSyncService — verifyPermission fallback', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts: { id: string; text: string; tags: string[]; createdAt: number }[] = [];

  it('succeeds when queryPermission returns prompt but requestPermission returns granted', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('prompt');
    handle.requestPermission.mockResolvedValue('granted');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(true);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    const state = await service.getState();
    expect(state.errorCode).toBeUndefined();
  });

  it('returns permission_expired when requestPermission throws (service worker context)', async () => {
    const handle = createMockHandle();
    handle.queryPermission.mockResolvedValue('prompt');
    handle.requestPermission.mockRejectedValue(new DOMException('Not allowed', 'NotAllowedError'));
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.errorCode).toBe('permission_expired');
  });
});

describe('LocalFolderSyncService — state persistence', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts: { id: string; text: string; tags: string[]; createdAt: number }[] = [];

  it('saveState persists all timestamps using LocalSyncStorageKeys', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const setCall = (chromeMock.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => {
        const arg = c[0] as Record<string, unknown>;
        return 'gvLocalLastUploadTime' in arg;
      },
    );
    expect(setCall).toBeDefined();
    const saved = setCall![0] as Record<string, unknown>;
    expect(saved['gvLocalSyncMode']).toBeDefined();
    expect(saved['gvLocalLastUploadTime']).toBeTypeOf('number');
  });

  it('loadState restores timestamps from LocalSyncStorageKeys on next init', async () => {
    const storedTime = 1710000000000;
    (chromeMock.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      gvLocalSyncMode: 'manual',
      gvLocalLastSyncTime: storedTime,
      gvLocalLastUploadTime: storedTime + 1,
      gvLocalSyncError: null,
      gvLocalLastSyncTimeAIStudio: storedTime + 2,
      gvLocalLastUploadTimeAIStudio: storedTime + 3,
    });
    const Service = await loadServiceClass();
    const service = new Service();
    const state = await service.getState();
    expect(state.mode).toBe('manual');
    expect(state.lastSyncTime).toBe(storedTime);
    expect(state.lastUploadTime).toBe(storedTime + 1);
    expect(state.lastSyncTimeAIStudio).toBe(storedTime + 2);
    expect(state.lastUploadTimeAIStudio).toBe(storedTime + 3);
  });

  it('loadState migrates lastSyncTime from shared key when local key is absent', async () => {
    const migratedTime = 1700000000000;
    // The module-level singleton + each new Service() call loadState(), so use
    // key-aware mockImplementation instead of mockResolvedValueOnce to avoid
    // ordering issues with how many times the mock is called before our instance.
    (chromeMock.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
      (keys: unknown) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        if (arr.includes('gvLastSyncTime')) {
          return Promise.resolve({ gvLastSyncTime: migratedTime });
        }
        return Promise.resolve({});
      },
    );
    const Service = await loadServiceClass();
    const service = new Service();
    const state = await service.getState();
    expect(state.lastSyncTime).toBe(migratedTime);
  });
});

describe('LocalFolderSyncService — write verification', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts: { id: string; text: string; tags: string[]; createdAt: number }[] = [];

  it('upload returns false when write completes but file is empty (stale permission)', async () => {
    // Use requestPermission path to bypass I/O probe, so we reach writeJsonFile
    // with stale writes that close() without persisting data.
    const handle = createMockHandle('stale-folder', { staleWrite: true });
    handle.queryPermission.mockResolvedValue('prompt');
    handle.requestPermission.mockResolvedValue('granted');
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.error).toContain('verification failed');
  });

  it('upload succeeds when write verification reads back non-empty file', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(true);
  });
});

describe('LocalFolderSyncService — permission I/O probe', () => {
  let chromeMock: MockedChrome;

  beforeEach(() => {
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.mocked(loadHandle).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const folders = { folders: [], folderContents: {} };
  const prompts: { id: string; text: string; tags: string[]; createdAt: number }[] = [];

  it('returns permission_expired when I/O probe write fails despite queryPermission granted', async () => {
    const handle = createMockHandle('probe-fail', { staleWrite: true });
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.errorCode).toBe('permission_expired');
  });

  it('returns permission_expired when I/O probe throws', async () => {
    const handle = createMockHandle();
    // Override getFileHandle to throw for the probe file
    const originalImpl = handle.getFileHandle.getMockImplementation()!;
    handle.getFileHandle.mockImplementation((fileName: string, opts?: { create?: boolean }) => {
      if (fileName === '.gv-sync-probe') {
        return Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
      }
      return originalImpl(fileName, opts);
    });
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.errorCode).toBe('permission_expired');
  });

  it('passes when I/O probe write and read-back succeed', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(true);
    // Probe file should exist in mock file store
    expect(handle._files.has('.gv-sync-probe')).toBe(true);
  });
});
