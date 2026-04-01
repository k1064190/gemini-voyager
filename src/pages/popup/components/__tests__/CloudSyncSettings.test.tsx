import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

import * as idb from '@/core/utils/idb';

import type { SyncState } from '@/core/types/sync';
import { DEFAULT_SYNC_STATE } from '@/core/types/sync';

import { CloudSyncSettings } from '../CloudSyncSettings';

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock('@/core/utils/browser', () => ({
  isSafari: () => false,
}));

vi.mock('@/core/services/LocalFolderSyncService', () => ({
  LocalFolderSyncService: {
    isSupported: () => true,
  },
}));

vi.mock('@/core/utils/idb', () => ({
  loadHandle: vi.fn().mockResolvedValue(null),
}));

type MockedChrome = typeof chrome;

const baseState: SyncState = {
  ...DEFAULT_SYNC_STATE,
  mode: 'manual',
  isAuthenticated: false,
};

function createChromeMock(sendMessage: ReturnType<typeof vi.fn>): MockedChrome {
  return {
    runtime: {
      sendMessage,
      lastError: null,
      id: 'test-extension-id',
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://gemini.google.com/app' }]),
      sendMessage: vi.fn().mockResolvedValue({
        ok: true,
        data: { folders: [], folderContents: {} },
      }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({
          gvFolderData: { folders: [], folderContents: {} },
          gvPromptItems: [],
          geminiTimelineStarredMessages: { messages: {} },
        }),
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

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CloudSyncSettings auth flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('triggers upload after clicking upload with Google Drive provider selected (default)', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.upload') {
        return Promise.resolve({
          ok: true,
          state: { ...baseState, isAuthenticated: true },
        });
      }
      return Promise.resolve({ ok: true });
    });

    (globalThis as { chrome: MockedChrome }).chrome = createChromeMock(sendMessageMock);

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    // Google Drive is the default provider — the persistent pill toggle is always shown.
    // Verify the toggle is rendered.
    const googleDriveButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncProviderGoogleDrive'),
    );
    expect(googleDriveButton).toBeTruthy();

    // Click Upload directly (no picker involved with the new pill toggle UI).
    const uploadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncUpload'),
    );
    expect(uploadButton).toBeTruthy();

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gv.sync.upload',
      }),
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gv.sync.authenticate',
      }),
    );
  });

  it('triggers download directly without a separate authenticate message', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.download') {
        return Promise.resolve({
          ok: true,
          state: { ...baseState, isAuthenticated: true },
          data: {
            folders: { data: { folders: [], folderContents: {} } },
            prompts: { items: [] },
            starred: { data: { messages: {} } },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    (globalThis as { chrome: MockedChrome }).chrome = createChromeMock(sendMessageMock);

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    const downloadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncMerge'),
    );
    expect(downloadButton).toBeTruthy();

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gv.sync.download',
      }),
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gv.sync.authenticate',
      }),
    );
  });
});

describe('CloudSyncSettings provider routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('sends gv.sync.download when provider is google-drive (default)', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.download') {
        return Promise.resolve({
          ok: true,
          state: baseState,
          data: {
            folders: { data: { folders: [], folderContents: {} } },
            prompts: { items: [] },
            starred: { data: { messages: {} } },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    const chromeMock = createChromeMock(sendMessageMock);
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    const downloadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncMerge'),
    );
    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gv.sync.download' }),
    );
  });

  it('sends gv.sync.localDownload when provider is local-folder', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.localDownload') {
        return Promise.resolve({
          ok: true,
          state: baseState,
          data: {
            folders: { data: { folders: [], folderContents: {} } },
            prompts: { items: [] },
            starred: { data: { messages: {} } },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    const chromeMock = {
      ...createChromeMock(sendMessageMock),
      storage: {
        ...createChromeMock(sendMessageMock).storage,
        local: {
          get: vi.fn().mockResolvedValue({
            gvFolderData: { folders: [], folderContents: {} },
            gvPromptItems: [],
            geminiTimelineStarredMessages: { messages: {} },
            gvSyncProvider: 'local-folder',
          }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as MockedChrome;

    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    const downloadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncMerge'),
    );
    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gv.sync.localDownload' }),
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gv.sync.download' }),
    );
  });

  it('sends gv.sync.localUpload when Local Folder selected and folder handle exists', async () => {
    // Simulate a stored folder handle already in IDB
    (idb.loadHandle as MockedFunction<typeof idb.loadHandle>).mockResolvedValueOnce(
      {} as FileSystemDirectoryHandle,
    );

    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.localUpload') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      return Promise.resolve({ ok: true });
    });

    const tabsCreateMock = vi.fn().mockResolvedValue({ id: 99 });
    const runtimeGetURLMock = vi.fn().mockReturnValue('chrome-extension://abc/src/pages/local-sync/index.html');

    const chromeMock = {
      ...createChromeMock(sendMessageMock),
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://gemini.google.com/app' }]),
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: { folders: [], folderContents: {} } }),
        create: tabsCreateMock,
      },
      runtime: {
        sendMessage: sendMessageMock,
        lastError: null,
        id: 'test-extension-id',
        getURL: runtimeGetURLMock,
      },
      storage: {
        local: {
          // Return local-folder as provider so handleSyncNow reads it from storage
          get: vi.fn().mockResolvedValue({
            gvFolderData: { folders: [], folderContents: {} },
            gvPromptItems: [],
            geminiTimelineStarredMessages: { messages: {} },
            gvSyncProvider: 'local-folder',
          }),
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

    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    // With the new pill toggle UI, the Local Folder pill is always visible.
    // The provider is already set to local-folder via storage mock.
    // Click Upload to trigger localUpload (handle exists).
    const uploadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncUpload'),
    );
    expect(uploadButton).toBeTruthy();

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    // Should upload, not open picker
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gv.sync.localUpload' }),
    );
    expect(tabsCreateMock).not.toHaveBeenCalled();
  });

  it('opens folder picker tab when Upload is clicked with local-folder provider and no handle', async () => {
    // loadHandle returns null — no folder handle stored
    (idb.loadHandle as MockedFunction<typeof idb.loadHandle>).mockResolvedValueOnce(null);

    const sendMessageMock = vi.fn().mockResolvedValue({ ok: true, state: baseState });
    const tabsCreateMock = vi.fn().mockResolvedValue({ id: 99 });
    const runtimeGetURLMock = vi.fn().mockReturnValue('chrome-extension://abc/src/pages/local-sync/index.html');

    const chromeMock = {
      ...createChromeMock(sendMessageMock),
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://gemini.google.com/app' }]),
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: { folders: [], folderContents: {} } }),
        create: tabsCreateMock,
      },
      runtime: {
        sendMessage: sendMessageMock,
        lastError: null,
        id: 'test-extension-id',
        getURL: runtimeGetURLMock,
      },
      storage: {
        local: {
          // Return local-folder as provider so handleSyncNow reads it from storage
          get: vi.fn().mockResolvedValue({
            gvFolderData: { folders: [], folderContents: {} },
            gvPromptItems: [],
            geminiTimelineStarredMessages: { messages: {} },
            gvSyncProvider: 'local-folder',
          }),
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

    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    // Click Upload — provider is local-folder but no handle exists, so picker tab opens.
    const uploadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncUpload'),
    );
    expect(uploadButton).toBeTruthy();

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(tabsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('local-sync') }),
    );
    // No upload message should be sent when redirecting to folder picker
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gv.sync.localUpload' }),
    );
  });
});
