/**
 * Shared sync payload utilities
 *
 * Canonical payload construction and file naming shared by GoogleDriveSyncService
 * and LocalFolderSyncService. Changes here automatically apply to both providers.
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
  SyncPlatform,
} from '@/core/types/sync';
import { hashString } from '@/core/utils/hash';
import { EXTENSION_VERSION } from '@/core/utils/version';

/** Canonical file names for sync data. */
export const SYNC_FILE_NAMES = {
  folders: 'gemini-voyager-folders.json',
  aistudioFolders: 'gemini-voyager-aistudio-folders.json',
  prompts: 'gemini-voyager-prompts.json',
  starred: 'gemini-voyager-starred.json',
  forks: 'gemini-voyager-forks.json',
} as const;

const MAX_STARRED_CONTENT_LENGTH = 60;

/**
 * Returns the base file name for a given data type and platform.
 * AI Studio uses a separate folders file.
 *
 * @param type - sync data type
 * @param platform - 'gemini' or 'aistudio'
 * @returns base file name without account scope suffix
 */
export function getSyncBaseFileName(
  type: 'folders' | 'prompts' | 'starred' | 'forks',
  platform: SyncPlatform,
): string {
  if (type === 'folders' && platform === 'aistudio') {
    return SYNC_FILE_NAMES.aistudioFolders;
  }
  return SYNC_FILE_NAMES[type];
}

/**
 * Appends account-scope suffix to a base file name.
 * Format: `base.acct-{hash}.ext`
 *
 * @param baseName - file name with extension (e.g. 'gemini-voyager-folders.json')
 * @param accountScope - account scope, or null for unscoped
 * @returns scoped file name
 */
export function scopeFileName(baseName: string, accountScope: SyncAccountScope | null): string {
  if (!accountScope) return baseName;
  const suffix = `acct-${hashString(accountScope.accountKey)}`;
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return `${baseName}.${suffix}`;
  }
  return `${baseName.slice(0, dotIndex)}.${suffix}${baseName.slice(dotIndex)}`;
}

/**
 * Builds a FolderExportPayload.
 *
 * @param data - folder data
 * @param exportedAt - ISO 8601 timestamp
 * @returns payload ready for serialization
 */
export function buildFolderPayload(data: FolderData, exportedAt: string): FolderExportPayload {
  return {
    format: 'gemini-voyager.folders.v1',
    exportedAt,
    version: EXTENSION_VERSION,
    data,
  };
}

/**
 * Builds a PromptExportPayload.
 *
 * @param items - prompt items
 * @param exportedAt - ISO 8601 timestamp
 * @returns payload ready for serialization
 */
export function buildPromptPayload(items: PromptItem[], exportedAt: string): PromptExportPayload {
  return {
    format: 'gemini-voyager.prompts.v1',
    exportedAt,
    version: EXTENSION_VERSION,
    items,
  };
}

/**
 * Builds a StarredExportPayload with content truncated to save storage.
 *
 * @param data - starred messages data
 * @param exportedAt - ISO 8601 timestamp
 * @returns payload with truncated content, ready for serialization
 */
export function buildStarredPayload(
  data: StarredMessagesDataSync,
  exportedAt: string,
): StarredExportPayload {
  return {
    format: 'gemini-voyager.starred.v1',
    exportedAt,
    version: EXTENSION_VERSION,
    data: truncateStarredContent(data),
  };
}

/**
 * Builds a ForkExportPayload.
 *
 * @param data - fork nodes data
 * @param exportedAt - ISO 8601 timestamp
 * @returns payload ready for serialization
 */
export function buildForkPayload(
  data: ForkNodesDataSync,
  exportedAt: string,
): ForkExportPayload {
  return {
    format: 'gemini-voyager.forks.v1',
    exportedAt,
    version: EXTENSION_VERSION,
    data,
  };
}

/**
 * Truncates starred message content to MAX_STARRED_CONTENT_LENGTH characters.
 *
 * @param starred - starred messages data
 * @returns copy with truncated content
 */
export function truncateStarredContent(
  starred: StarredMessagesDataSync,
): StarredMessagesDataSync {
  return {
    messages: Object.fromEntries(
      Object.entries(starred.messages).map(([convId, messages]) => [
        convId,
        messages.map((msg) => ({
          ...msg,
          content:
            msg.content.length > MAX_STARRED_CONTENT_LENGTH
              ? msg.content.slice(0, MAX_STARRED_CONTENT_LENGTH) + '...'
              : msg.content,
        })),
      ]),
    ),
  };
}
