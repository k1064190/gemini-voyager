/**
 * Tests for provider-aware sync message handlers in background/index.ts.
 *
 * Specifically covers:
 *  - getActiveProvider() routing (via gv.sync.getState and gv.sync.setMode)
 *  - storage throws → error propagates (no silent Google Drive fallback)
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockedFunction } from 'vitest';

import type { SyncState } from '@/core/types/sync';
import { DEFAULT_SYNC_STATE } from '@/core/types/sync';

// ──────────────────────────────────────────────
// Service mocks (hoisted before any imports)
// ──────────────────────────────────────────────

const googleDriveState: SyncState = {
  ...DEFAULT_SYNC_STATE,
  mode: 'auto',
  lastSyncTime: 11111,
};

const localFolderState: SyncState = {
  ...DEFAULT_SYNC_STATE,
  mode: 'manual',
  lastSyncTime: 99999,
};

const mockGoogleDriveSvc = {
  getState: vi.fn().mockResolvedValue(googleDriveState),
  setMode: vi.fn().mockResolvedValue(undefined),
  upload: vi.fn().mockResolvedValue(true),
  download: vi.fn().mockResolvedValue(null),
  authenticate: vi.fn().mockResolvedValue(false),
  signOut: vi.fn().mockResolvedValue(undefined),
  onStateChange: vi.fn(),
};

const mockLocalFolderSvc = {
  getState: vi.fn().mockResolvedValue(localFolderState),
  setMode: vi.fn().mockResolvedValue(undefined),
  upload: vi.fn().mockResolvedValue(true),
  download: vi.fn().mockResolvedValue(null),
  onStateChange: vi.fn(),
};

vi.mock('webextension-polyfill', () => ({
  default: {
    permissions: { contains: vi.fn().mockResolvedValue(false) },
  },
}));

vi.mock('@/core/services/AccountIsolationService', () => ({
  accountIsolationService: { onStateChange: vi.fn() },
  detectAccountPlatformFromUrl: vi.fn().mockReturnValue('gemini'),
  extractRouteUserIdFromUrl: vi.fn().mockReturnValue(null),
}));

vi.mock('@/core/services/GoogleDriveSyncService', () => ({
  googleDriveSyncService: mockGoogleDriveSvc,
}));

vi.mock('@/core/services/LocalFolderSyncService', () => ({
  localFolderSyncService: mockLocalFolderSvc,
}));

// ──────────────────────────────────────────────
// Chrome mock
// ──────────────────────────────────────────────

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

let capturedListener: MessageListener;
let storageLocalGet: MockedFunction<(...args: unknown[]) => Promise<Record<string, unknown>>>;

function buildChromeMock() {
  storageLocalGet = vi.fn().mockResolvedValue({});
  return {
    scripting: undefined, // makes registerFetchInterceptor / syncCustomContentScripts early-return
    storage: {
      local: {
        get: storageLocalGet,
        set: vi.fn().mockResolvedValue(undefined),
      },
      sync: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn() },
    },
    permissions: {
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getManifest: vi.fn().mockReturnValue({ content_scripts: [] }),
      onMessage: {
        addListener: vi.fn().mockImplementation((fn: MessageListener) => {
          capturedListener = fn;
        }),
      },
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
    tabs: { create: vi.fn() },
    action: { openPopup: vi.fn() },
  } as unknown as typeof chrome;
}

/**
 * Invoke the captured onMessage listener and await the sendResponse call.
 */
function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    capturedListener(message, {}, (response) => resolve(response));
  });
}

// ──────────────────────────────────────────────
// Module load
// ──────────────────────────────────────────────

beforeAll(async () => {
  vi.stubGlobal('chrome', buildChromeMock());
  // Dynamic import registers chrome.runtime.onMessage.addListener → captures listener
  await import('../index');
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe('gv.sync.getState — provider routing', () => {
  it('routes to localFolderSyncService when provider is local-folder', async () => {
    storageLocalGet.mockResolvedValueOnce({ gvSyncProvider: 'local-folder' });
    mockGoogleDriveSvc.getState.mockClear();
    mockLocalFolderSvc.getState.mockClear();

    const response = (await sendMessage({ type: 'gv.sync.getState' })) as {
      ok: boolean;
      state: SyncState;
    };

    expect(mockLocalFolderSvc.getState).toHaveBeenCalledOnce();
    expect(mockGoogleDriveSvc.getState).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
    expect(response.state.lastSyncTime).toBe(localFolderState.lastSyncTime);
  });

  it('routes to googleDriveSyncService when provider is google-drive', async () => {
    storageLocalGet.mockResolvedValueOnce({ gvSyncProvider: 'google-drive' });
    mockGoogleDriveSvc.getState.mockClear();
    mockLocalFolderSvc.getState.mockClear();

    const response = (await sendMessage({ type: 'gv.sync.getState' })) as {
      ok: boolean;
      state: SyncState;
    };

    expect(mockGoogleDriveSvc.getState).toHaveBeenCalledOnce();
    expect(mockLocalFolderSvc.getState).not.toHaveBeenCalled();
    expect(response.state.lastSyncTime).toBe(googleDriveState.lastSyncTime);
  });

  it('defaults to googleDriveSyncService when provider key is absent', async () => {
    storageLocalGet.mockResolvedValueOnce({}); // key not set
    mockGoogleDriveSvc.getState.mockClear();
    mockLocalFolderSvc.getState.mockClear();

    await sendMessage({ type: 'gv.sync.getState' });

    expect(mockGoogleDriveSvc.getState).toHaveBeenCalledOnce();
    expect(mockLocalFolderSvc.getState).not.toHaveBeenCalled();
  });

  it('propagates storage error instead of silently falling back to Google Drive', async () => {
    storageLocalGet.mockRejectedValueOnce(new Error('storage unavailable'));
    mockGoogleDriveSvc.getState.mockClear();
    mockLocalFolderSvc.getState.mockClear();

    const response = (await sendMessage({ type: 'gv.sync.getState' })) as {
      ok: boolean;
      error?: string;
    };

    // Storage threw → caller gets an error response, not a silent GDrive fallback
    expect(response.ok).toBe(false);
    expect(mockGoogleDriveSvc.getState).not.toHaveBeenCalled();
    expect(mockLocalFolderSvc.getState).not.toHaveBeenCalled();
  });
});

describe('gv.sync.setMode — provider routing', () => {
  it('calls localFolderSyncService.setMode when provider is local-folder', async () => {
    storageLocalGet.mockResolvedValueOnce({ gvSyncProvider: 'local-folder' });
    mockGoogleDriveSvc.setMode.mockClear();
    mockLocalFolderSvc.setMode.mockClear();

    await sendMessage({ type: 'gv.sync.setMode', payload: { mode: 'manual' } });

    expect(mockLocalFolderSvc.setMode).toHaveBeenCalledWith('manual');
    expect(mockGoogleDriveSvc.setMode).not.toHaveBeenCalled();
  });

  it('calls googleDriveSyncService.setMode when provider is google-drive', async () => {
    storageLocalGet.mockResolvedValueOnce({ gvSyncProvider: 'google-drive' });
    mockGoogleDriveSvc.setMode.mockClear();
    mockLocalFolderSvc.setMode.mockClear();

    await sendMessage({ type: 'gv.sync.setMode', payload: { mode: 'auto' } });

    expect(mockGoogleDriveSvc.setMode).toHaveBeenCalledWith('auto');
    expect(mockLocalFolderSvc.setMode).not.toHaveBeenCalled();
  });
});
