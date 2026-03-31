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
import { loadHandle, removeHandle, saveHandle } from '@/core/utils/idb';

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const FILE_NAMES = {
  folders: 'gemini-voyager-folders.json',
  prompts: 'gemini-voyager-prompts.json',
  starred: 'gemini-voyager-starred.json',
  forks: 'gemini-voyager-forks.json',
} as const;

const VERSION = '1';

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
    folders: FolderData,
    prompts: PromptItem[],
    starred: StarredMessagesDataSync | null,
    _interactive: boolean,
    platform: SyncPlatform,
    forks: ForkNodesDataSync | null,
    _accountScope: SyncAccountScope | null,
  ): Promise<boolean> {
    const handle = await this.getHandle();
    if (!handle) {
      this.updateState({ error: 'No folder selected for local sync', isSyncing: false });
      return false;
    }

    const hasPermission = await this.verifyPermission(handle);
    if (!hasPermission) {
      this.updateState({ error: 'Permission denied for local sync folder', isSyncing: false });
      return false;
    }

    this.updateState({ isSyncing: true, error: null });

    try {
      const now = new Date().toISOString();
      const isAIStudio = platform === 'aistudio';

      const folderPayload: FolderExportPayload = {
        format: 'gemini-voyager.folders.v1',
        exportedAt: now,
        version: VERSION,
        data: folders,
      };
      await this.writeJsonFile(handle, FILE_NAMES.folders, folderPayload);

      const promptPayload: PromptExportPayload = {
        format: 'gemini-voyager.prompts.v1',
        exportedAt: now,
        version: VERSION,
        items: prompts,
      };
      await this.writeJsonFile(handle, FILE_NAMES.prompts, promptPayload);

      if (starred) {
        const starredPayload: StarredExportPayload = {
          format: 'gemini-voyager.starred.v1',
          exportedAt: now,
          version: VERSION,
          data: starred,
        };
        await this.writeJsonFile(handle, FILE_NAMES.starred, starredPayload);
      }

      if (forks) {
        const forkPayload: ForkExportPayload = {
          format: 'gemini-voyager.forks.v1',
          exportedAt: now,
          version: VERSION,
          data: forks,
        };
        await this.writeJsonFile(handle, FILE_NAMES.forks, forkPayload);
      }

      const timestamp = Date.now();
      if (isAIStudio) {
        this.updateState({ lastUploadTimeAIStudio: timestamp, isSyncing: false });
      } else {
        this.updateState({ lastUploadTime: timestamp, isSyncing: false });
      }
      await this.saveState();
      return true;
    } catch (err: unknown) {
      const message =
        err instanceof DOMException
          ? this.getErrorMessage(err)
          : err instanceof Error
            ? err.message
            : 'Unknown error during upload';
      this.updateState({ error: message, isSyncing: false });
      await this.saveState();
      return false;
    }
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
    const handle = await this.getHandle();
    if (!handle) {
      return null;
    }

    const hasPermission = await this.verifyPermission(handle);
    if (!hasPermission) {
      this.updateState({ error: 'Permission denied for local sync folder' });
      return null;
    }

    try {
      const folders = await this.readJsonFile<FolderExportPayload>(handle, FILE_NAMES.folders);
      const prompts = await this.readJsonFile<PromptExportPayload>(handle, FILE_NAMES.prompts);
      const starred = await this.readJsonFile<StarredExportPayload>(handle, FILE_NAMES.starred);
      const forks = await this.readJsonFile<ForkExportPayload>(handle, FILE_NAMES.forks);

      this.updateState({ lastSyncTime: Date.now(), error: null });
      await this.saveState();

      return { folders, prompts, starred, forks };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        await removeHandle();
        this.updateState({ error: 'Sync folder no longer available' });
        return null;
      }
      const message = err instanceof Error ? err.message : 'Unknown error during download';
      this.updateState({ error: message });
      return null;
    }
  }

  private getErrorMessage(err: DOMException): string {
    switch (err.name) {
      case 'NotFoundError':
        return 'Sync folder no longer available. Please select a new folder.';
      case 'NotAllowedError':
        return 'Permission denied. Please grant access to the folder.';
      case 'AbortError':
        return 'Operation was cancelled.';
      default:
        return err.message || 'Unknown file system error';
    }
  }

  private async writeJsonFile(
    handle: FileSystemDirectoryHandle,
    name: string,
    data: unknown,
  ): Promise<void> {
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(JSON.stringify(data, null, 2));
    } finally {
      await writable.close();
    }
  }

  private async readJsonFile<T>(
    handle: FileSystemDirectoryHandle,
    name: string,
  ): Promise<T | null> {
    try {
      const fileHandle = await handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      const text = await file.text();
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        return null;
      }
      return null;
    }
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
