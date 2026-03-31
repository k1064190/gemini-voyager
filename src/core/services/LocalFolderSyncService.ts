/**
 * Local Folder Sync Service
 *
 * Skeleton service for syncing extension data to a local filesystem folder
 * via the File System Access API. Mirrors GoogleDriveSyncService's public API.
 * Upload and download methods are stubs — to be implemented later.
 */
import type { FolderData } from '@/core/types/folder';
import type {
  FolderExportPayload,
  ForkExportPayload,
  ForkNodesDataSync,
  PromptExportPayload,
  PromptItem,
  StarredExportPayload,
  StarredMessagesDataSync,
  SyncAccountScope,
  SyncMode,
  SyncPlatform,
  SyncState,
} from '@/core/types/sync';
import { DEFAULT_SYNC_STATE, SyncStorageKeys } from '@/core/types/sync';
import { loadHandle, saveHandle } from '@/core/utils/idb';

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * File System Access API permission methods not yet in TypeScript DOM lib.
 */
interface FileSystemHandlePermission {
  queryPermission(descriptor: { mode: string }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: string }): Promise<PermissionState>;
}

export class LocalFolderSyncService {
  private state: SyncState = { ...DEFAULT_SYNC_STATE };
  private stateLoadPromise: Promise<void>;
  private stateChangeCallback: ((state: SyncState) => void) | null = null;

  constructor() {
    this.stateLoadPromise = this.loadState();
  }

  onStateChange(callback: (state: SyncState) => void): void {
    this.stateChangeCallback = callback;
  }

  async getState(): Promise<SyncState> {
    await this.stateLoadPromise;
    return { ...this.state };
  }

  async setMode(mode: SyncMode): Promise<void> {
    this.state.mode = mode;
    await this.saveState();
    this.notifyStateChange();
  }

  static isSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }

  async upload(
    _folders: FolderData,
    _prompts: PromptItem[],
    _starred: StarredMessagesDataSync | null,
    _interactive: boolean,
    _platform: SyncPlatform,
    _forks: ForkNodesDataSync | null,
    _accountScope: SyncAccountScope | null,
  ): Promise<boolean> {
    throw new Error('Not implemented: upload');
  }

  async download(
    _interactive: boolean,
    _platform: SyncPlatform,
    _accountScope: SyncAccountScope | null,
  ): Promise<{
    folders: FolderExportPayload | null;
    prompts: PromptExportPayload | null;
    starred: StarredExportPayload | null;
    forks: ForkExportPayload | null;
  } | null> {
    throw new Error('Not implemented: download');
  }

  // ============== Private Methods ==============

  private async loadState(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([
        SyncStorageKeys.MODE,
        SyncStorageKeys.LAST_SYNC_TIME,
        SyncStorageKeys.SYNC_ERROR,
      ]);
      this.state = {
        mode: (result[SyncStorageKeys.MODE] as SyncMode) || 'disabled',
        lastSyncTime: getNumberValue(result[SyncStorageKeys.LAST_SYNC_TIME]),
        lastUploadTime: null,
        lastSyncTimeAIStudio: null,
        lastUploadTimeAIStudio: null,
        error: getStringValue(result[SyncStorageKeys.SYNC_ERROR]),
        isSyncing: false,
        isAuthenticated: false,
      };
    } catch {
      // Storage unavailable — keep defaults
    }
  }

  private async saveState(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [SyncStorageKeys.MODE]: this.state.mode,
        [SyncStorageKeys.LAST_SYNC_TIME]: this.state.lastSyncTime,
        [SyncStorageKeys.SYNC_ERROR]: this.state.error,
      });
    } catch {
      // Storage unavailable — ignore
    }
  }

  private updateState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.stateChangeCallback) {
      this.stateChangeCallback({ ...this.state });
    }
  }

  private async verifyPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const permHandle = handle as unknown as FileSystemHandlePermission;
    const result = await permHandle.queryPermission({ mode: 'readwrite' });
    return result === 'granted';
  }

  private async requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const permHandle = handle as unknown as FileSystemHandlePermission;
    const result = await permHandle.requestPermission({ mode: 'readwrite' });
    return result === 'granted';
  }

  private async getHandle(): Promise<FileSystemDirectoryHandle | null> {
    return loadHandle();
  }
}

export const localFolderSyncService = new LocalFolderSyncService();
