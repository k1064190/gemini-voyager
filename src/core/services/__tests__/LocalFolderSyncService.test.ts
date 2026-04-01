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

/** Creates a mock FileSystemDirectoryHandle that reads/writes in-memory. */
function createMockHandle(name = 'test-folder') {
  const files = new Map<string, string>();
  return {
    name,
    kind: 'directory' as const,
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    getFileHandle: vi.fn().mockImplementation((fileName: string) => {
      return Promise.resolve({
        getFile: () =>
          Promise.resolve({
            text: () => Promise.resolve(files.get(fileName) ?? ''),
          }),
        createWritable: () => {
          let written = '';
          return Promise.resolve({
            write: vi.fn().mockImplementation((data: string) => {
              written = data;
              return Promise.resolve();
            }),
            close: vi.fn().mockImplementation(() => {
              files.set(fileName, written);
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

  it('setMode persists to chrome.storage.local', async () => {
    const Service = await loadServiceClass();
    const service = new Service();
    await service.getState(); // drain stateLoadPromise before mutating
    await service.setMode('manual');
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ gvSyncMode: 'manual' }),
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
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const ok = await service.upload(folders, prompts, null, true, 'gemini', null, null);
    expect(ok).toBe(false);
    const state = await service.getState();
    expect(state.error).toContain('Permission denied');
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
    expect(names[0]).toBe('gemini-voyager-folders-acct-hash-user@example.com.json');
    expect(names[1]).toBe('gemini-voyager-prompts-acct-hash-user@example.com.json');
  });

  it('uses base file names when accountScope is null', async () => {
    const handle = createMockHandle();
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    await service.upload(folders, prompts, null, true, 'gemini', null, null);
    const names = handle.getFileHandle.mock.calls.map((c: unknown[]) => c[0]);
    expect(names[0]).toBe('gemini-voyager-folders.json');
    expect(names[1]).toBe('gemini-voyager-prompts.json');
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
    vi.mocked(loadHandle).mockResolvedValue(handle as unknown as FileSystemDirectoryHandle);
    const Service = await loadServiceClass();
    const service = new Service();
    const result = await service.download(true, 'gemini', null);
    expect(result).toBeNull();
    const state = await service.getState();
    expect(state.error).toContain('Permission denied');
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
    expect(names[0]).toBe('gemini-voyager-folders-acct-hash-user@example.com.json');
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
