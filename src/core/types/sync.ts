/**
 * Sync-related type definitions for Google Drive sync feature
 * Provides type safety for sync state management and data transfer
 */
import type { StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import type { FolderData } from './folder';

/**
 * Sync mode configuration
 * - disabled: Sync feature is off
 * - manual: User must click "Sync Now" to trigger sync
 * - auto: Sync happens automatically on startup and periodically
 */
export type SyncMode = 'disabled' | 'manual' | 'auto';

/**
 * Platform identifier for sync operations
 * - gemini: Main Gemini website (gemini.google.com)
 * - aistudio: AI Studio website (aistudio.google.com, aistudio.google.cn)
 */
export type SyncPlatform = 'gemini' | 'aistudio';

/**
 * Sync provider for upload destination
 * - google-drive: Sync via Google Drive (default, all browsers)
 * - local-folder: Sync via local filesystem (Chromium only)
 */
export type SyncProvider = 'google-drive' | 'local-folder';

export interface SyncAccountScope {
  accountKey: string;
  accountId: number;
  routeUserId: string | null;
}

/**
 * Current sync state for UI display
 */
export interface SyncState {
  /** Current sync mode setting */
  mode: SyncMode;
  /** Timestamp of last successful sync/download (null if never synced) - Gemini */
  lastSyncTime: number | null;
  /** Timestamp of last successful upload (null if never uploaded) - Gemini */
  lastUploadTime: number | null;
  /** Timestamp of last successful sync/download for AI Studio */
  lastSyncTimeAIStudio: number | null;
  /** Timestamp of last successful upload for AI Studio */
  lastUploadTimeAIStudio: number | null;
  /** Whether a sync operation is currently in progress */
  isSyncing: boolean;
  /** Last error message (null if no error) */
  error: string | null;
  /** Structured error code for actionable UI responses */
  errorCode?: 'no_handle' | 'permission_expired';
  /** Whether user is authenticated with Google */
  isAuthenticated: boolean;
}

/**
 * Prompt item structure (mirrored from prompt manager for type safety)
 */
export interface PromptItem {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
}

/**
 * Folder export payload format (matches existing export format)
 */
export interface FolderExportPayload {
  format: 'gemini-voyager.folders.v1';
  exportedAt: string;
  version: string;
  data: FolderData;
}

/**
 * Prompt export payload format (matches existing export format)
 */
export interface PromptExportPayload {
  format: 'gemini-voyager.prompts.v1';
  exportedAt: string;
  version?: string;
  items: PromptItem[];
}
/**
 * Re-export starred message types from their canonical source
 * These are used for Google Drive sync
 */
export type {
  StarredMessage as StarredMessageSync,
  StarredMessagesData as StarredMessagesDataSync,
} from '@/pages/content/timeline/starredTypes';

/**
 * Starred messages export payload format
 */
export interface StarredExportPayload {
  format: 'gemini-voyager.starred.v1';
  exportedAt: string;
  version?: string;
  data: StarredMessagesData;
}

/**
 * Re-export fork node types from their canonical source
 */
export type {
  ForkNode as ForkNodeSync,
  ForkNodesData as ForkNodesDataSync,
} from '@/pages/content/fork/forkTypes';

/**
 * Fork nodes export payload format
 */
export interface ForkExportPayload {
  format: 'gemini-voyager.forks.v1';
  exportedAt: string;
  version?: string;
  data: import('@/pages/content/fork/forkTypes').ForkNodesData;
}

/**
 * Data payload synced to Google Drive
 * Uses embedded export formats for compatibility with import/export feature
 */
export interface SyncData {
  /** Extension version that created this sync data */
  version: string;
  /** Format identifier for backward compatibility */
  format: 'gemini-voyager.sync.v1';
  /** Folder data in export format */
  folders: FolderExportPayload;
  /** Prompt data in export format */
  prompts: PromptExportPayload;
  /** Timestamp when this data was synced */
  syncedAt: number;
}

/**
 * Storage keys for sync-related settings
 */
export const SyncStorageKeys = {
  MODE: 'gvSyncMode',
  LAST_SYNC_TIME: 'gvLastSyncTime',
  SYNC_ERROR: 'gvSyncError',
  PROVIDER: 'gvSyncProvider',
  FOLDER_NAME: 'gvSyncFolderName',
} as const;

/**
 * Storage keys for local-folder sync state — independent namespace to prevent
 * collision with Google Drive sync keys when both providers are configured.
 */
export const LocalSyncStorageKeys = {
  MODE: 'gvLocalSyncMode',
  LAST_SYNC_TIME: 'gvLocalLastSyncTime',
  LAST_UPLOAD_TIME: 'gvLocalLastUploadTime',
  SYNC_ERROR: 'gvLocalSyncError',
  LAST_SYNC_TIME_AISTUDIO: 'gvLocalLastSyncTimeAIStudio',
  LAST_UPLOAD_TIME_AISTUDIO: 'gvLocalLastUploadTimeAIStudio',
} as const;

/**
 * Default sync state for initial load
 */
export const DEFAULT_SYNC_STATE: SyncState = {
  mode: 'disabled',
  lastSyncTime: null,
  lastUploadTime: null,
  lastSyncTimeAIStudio: null,
  lastUploadTimeAIStudio: null,
  isSyncing: false,
  error: null,
  isAuthenticated: false,
};

/**
 * Sync message types for background script communication
 */
export type SyncMessageType =
  | 'gv.sync.authenticate'
  | 'gv.sync.signOut'
  | 'gv.sync.upload'
  | 'gv.sync.download'
  | 'gv.sync.getState'
  | 'gv.sync.setMode'
  | 'gv.sync.localUpload'
  | 'gv.sync.localDownload'
  | 'gv.sync.localGetState'
  | 'gv.sync.localPickerComplete';

/**
 * Message payload for sync operations
 */
export interface SyncMessage {
  type: SyncMessageType;
  payload?: {
    mode?: SyncMode;
    data?: SyncData;
    interactive?: boolean;
    platform?: SyncPlatform;
    accountScope?: SyncAccountScope;
  };
}

/**
 * Response from sync operations
 */
export interface SyncResponse {
  ok: boolean;
  error?: string;
  /** Structured error code forwarded from SyncState for actionable UI responses */
  errorCode?: 'no_handle' | 'permission_expired';
  state?: SyncState;
  data?: SyncData;
}
