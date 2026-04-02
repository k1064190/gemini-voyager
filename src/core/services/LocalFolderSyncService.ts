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
import { DEFAULT_SYNC_STATE, LocalSyncStorageKeys, SyncStorageKeys } from '@/core/types/sync';
import { loadHandle, removeHandle, saveHandle } from '@/core/utils/idb';
import { hashString } from '@/core/utils/hash';

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
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  async upload(
    folders: FolderData,
    prompts: PromptItem[],
    starred: StarredMessagesDataSync | null,
    _interactive: boolean,
    platform: SyncPlatform,
    forks: ForkNodesDataSync | null,
    accountScope: SyncAccountScope | null,
  ): Promise<boolean> {
    const handle = await this.getHandle();
    if (!handle) {
      this.updateState({ error: 'No folder selected for local sync', errorCode: 'no_handle', isSyncing: false });
      return false;
    }

    const hasPermission = await this.verifyPermission(handle);
    if (!hasPermission) {
      this.updateState({ error: 'Permission expired. Please re-select the sync folder.', errorCode: 'permission_expired', isSyncing: false });
      return false;
    }

    this.updateState({ isSyncing: true, error: null, errorCode: undefined });

    try {
      const now = new Date().toISOString();
      const isAIStudio = platform === 'aistudio';

      const folderPayload: FolderExportPayload = {
        format: 'gemini-voyager.folders.v1',
        exportedAt: now,
        version: VERSION,
        data: folders,
      };
      await this.writeJsonFile(handle, this.getFileName(FILE_NAMES.folders, accountScope), folderPayload);

      const promptPayload: PromptExportPayload = {
        format: 'gemini-voyager.prompts.v1',
        exportedAt: now,
        version: VERSION,
        items: prompts,
      };
      await this.writeJsonFile(handle, this.getFileName(FILE_NAMES.prompts, accountScope), promptPayload);

      if (starred) {
        const starredPayload: StarredExportPayload = {
          format: 'gemini-voyager.starred.v1',
          exportedAt: now,
          version: VERSION,
          data: starred,
        };
        await this.writeJsonFile(handle, this.getFileName(FILE_NAMES.starred, accountScope), starredPayload);
      }

      if (forks) {
        const forkPayload: ForkExportPayload = {
          format: 'gemini-voyager.forks.v1',
          exportedAt: now,
          version: VERSION,
          data: forks,
        };
        await this.writeJsonFile(handle, this.getFileName(FILE_NAMES.forks, accountScope), forkPayload);
      }

      const timestamp = Date.now();
      if (isAIStudio) {
        this.updateState({ lastUploadTimeAIStudio: timestamp, isSyncing: false, errorCode: undefined });
      } else {
        this.updateState({ lastUploadTime: timestamp, isSyncing: false, errorCode: undefined });
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
    accountScope: SyncAccountScope | null,
  ): Promise<{
    folders: FolderExportPayload | null;
    prompts: PromptExportPayload | null;
    starred: StarredExportPayload | null;
    forks: ForkExportPayload | null;
  } | null> {
    const handle = await this.getHandle();
    if (!handle) {
      this.updateState({ error: 'No folder selected for local sync', errorCode: 'no_handle' });
      return null;
    }

    const hasPermission = await this.verifyPermission(handle);
    if (!hasPermission) {
      this.updateState({ error: 'Permission expired. Please re-select the sync folder.', errorCode: 'permission_expired' });
      return null;
    }

    try {
      const folders = await this.readJsonFile<FolderExportPayload>(handle, this.getFileName(FILE_NAMES.folders, accountScope));
      const prompts = await this.readJsonFile<PromptExportPayload>(handle, this.getFileName(FILE_NAMES.prompts, accountScope));
      const starred = await this.readJsonFile<StarredExportPayload>(handle, this.getFileName(FILE_NAMES.starred, accountScope));
      const forks = await this.readJsonFile<ForkExportPayload>(handle, this.getFileName(FILE_NAMES.forks, accountScope));

      this.updateState({ lastSyncTime: Date.now(), error: null, errorCode: undefined });
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

  /**
   * Returns a scoped file name for multi-account isolation.
   * Appends `-acct-{hash}` before `.json` when an accountScope is provided.
   */
  private getFileName(baseName: string, accountScope: SyncAccountScope | null): string {
    if (!accountScope) return baseName;
    const suffix = `acct-${hashString(accountScope.accountKey)}`;
    return baseName.replace('.json', `-${suffix}.json`);
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
    // Verify write landed on disk — catches silent FSA failures in service workers
    const verifyHandle = await handle.getFileHandle(name);
    const file = await verifyHandle.getFile();
    if (file.size === 0) {
      throw new Error('Write verification failed: file is empty after write');
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
        LocalSyncStorageKeys.MODE,
        LocalSyncStorageKeys.LAST_SYNC_TIME,
        LocalSyncStorageKeys.LAST_UPLOAD_TIME,
        LocalSyncStorageKeys.SYNC_ERROR,
        LocalSyncStorageKeys.LAST_SYNC_TIME_AISTUDIO,
        LocalSyncStorageKeys.LAST_UPLOAD_TIME_AISTUDIO,
      ]);
      this.state = {
        mode: (result[LocalSyncStorageKeys.MODE] as SyncMode) || 'disabled',
        lastSyncTime: getNumberValue(result[LocalSyncStorageKeys.LAST_SYNC_TIME]),
        lastUploadTime: getNumberValue(result[LocalSyncStorageKeys.LAST_UPLOAD_TIME]),
        lastSyncTimeAIStudio: getNumberValue(result[LocalSyncStorageKeys.LAST_SYNC_TIME_AISTUDIO]),
        lastUploadTimeAIStudio: getNumberValue(result[LocalSyncStorageKeys.LAST_UPLOAD_TIME_AISTUDIO]),
        error: getStringValue(result[LocalSyncStorageKeys.SYNC_ERROR]),
        isSyncing: false,
        isAuthenticated: false,
      };

      // One-time migration: if local keys are unset but shared keys have data,
      // copy lastSyncTime so existing users don't lose their sync history.
      if (!this.state.lastSyncTime) {
        const old = await chrome.storage.local.get([SyncStorageKeys.LAST_SYNC_TIME]);
        const migrated = getNumberValue(old[SyncStorageKeys.LAST_SYNC_TIME]);
        if (migrated) {
          this.state.lastSyncTime = migrated;
        }
      }
    } catch {
      // Storage unavailable — keep defaults
    }
  }

  private async saveState(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [LocalSyncStorageKeys.MODE]: this.state.mode,
        [LocalSyncStorageKeys.LAST_SYNC_TIME]: this.state.lastSyncTime,
        [LocalSyncStorageKeys.LAST_UPLOAD_TIME]: this.state.lastUploadTime,
        [LocalSyncStorageKeys.SYNC_ERROR]: this.state.error,
        [LocalSyncStorageKeys.LAST_SYNC_TIME_AISTUDIO]: this.state.lastSyncTimeAIStudio,
        [LocalSyncStorageKeys.LAST_UPLOAD_TIME_AISTUDIO]: this.state.lastUploadTimeAIStudio,
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
    const queryResult = await permHandle.queryPermission({ mode: 'readwrite' });
    if (queryResult === 'granted') {
      // I/O probe: queryPermission can return stale 'granted' in service workers.
      // Attempt a real write+read to confirm the permission is live.
      try {
        const probeHandle = await handle.getFileHandle('.gv-sync-probe', { create: true });
        const writable = await probeHandle.createWritable();
        await writable.write('ok');
        await writable.close();
        const file = await (await handle.getFileHandle('.gv-sync-probe')).getFile();
        const text = await file.text();
        if (text !== 'ok') return false;
        return true;
      } catch {
        return false;
      }
    }

    // Try requesting — works when caller has transient user activation.
    // Service workers have no user gesture, so requestPermission will throw;
    // catch it and return false so the caller can surface an actionable error.
    try {
      const requestResult = await permHandle.requestPermission({ mode: 'readwrite' });
      return requestResult === 'granted';
    } catch {
      return false;
    }
  }

  private async getHandle(): Promise<FileSystemDirectoryHandle | null> {
    return loadHandle();
  }
}

export const localFolderSyncService = new LocalFolderSyncService();
