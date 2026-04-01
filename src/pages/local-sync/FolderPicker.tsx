// ABOUTME: Folder picker page for local folder sync — uses File System Access API
// to select a directory, persists the handle in IndexedDB, and signals completion.
import React, { useCallback, useEffect, useState } from 'react';

import { SyncStorageKeys } from '@/core/types/sync';
import { loadHandle, saveHandle } from '@/core/utils/idb';

/**
 * Subset of FileSystemHandlePermission used for type-safe permission queries.
 * These methods exist on FileSystemDirectoryHandle in Chromium but are not yet
 * in the TypeScript DOM lib.
 */
interface FileSystemHandlePermission {
  queryPermission(descriptor: { mode: string }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: string }): Promise<PermissionState>;
}

type PickerStatus =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'connected'; name: string }
  | { kind: 'disconnected'; name: string }
  | { kind: 'error'; message: string };

const styles = {
  container: {
    maxWidth: 420,
    margin: '48px auto',
    padding: 24,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    borderRadius: 12,
    border: '1px solid #e2e8f0',
  } as React.CSSProperties,

  title: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 8,
  } as React.CSSProperties,

  subtitle: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 20,
  } as React.CSSProperties,

  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    fontSize: 13,
  } as React.CSSProperties,

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  } as React.CSSProperties,

  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 8,
    border: '1px solid #e2e8f0',
    cursor: 'pointer',
    background: '#ffffff',
    color: '#1e293b',
  } as React.CSSProperties,

  buttonPrimary: {
    background: '#3b82f6',
    color: '#ffffff',
    border: '1px solid #3b82f6',
  } as React.CSSProperties,

  errorText: {
    fontSize: 12,
    color: '#ef4444',
    marginTop: 8,
  } as React.CSSProperties,
} as const;

const darkOverrides = `
@media (prefers-color-scheme: dark) {
  .gv-folder-picker-container {
    background: #1e293b;
    border-color: #334155;
  }
  .gv-folder-picker-title {
    color: #f1f5f9;
  }
  .gv-folder-picker-subtitle {
    color: #94a3b8;
  }
  .gv-folder-picker-button {
    background: #334155;
    border-color: #475569;
    color: #f1f5f9;
  }
  .gv-folder-picker-button-primary {
    background: #3b82f6;
    border-color: #3b82f6;
    color: #ffffff;
  }
}`;

async function checkPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permHandle = handle as unknown as FileSystemHandlePermission;
  const result = await permHandle.queryPermission({ mode: 'readwrite' });
  return result === 'granted';
}

async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permHandle = handle as unknown as FileSystemHandlePermission;
  const result = await permHandle.requestPermission({ mode: 'readwrite' });
  return result === 'granted';
}

export default function FolderPicker() {
  const [status, setStatus] = useState<PickerStatus>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function checkExisting() {
      if (!('showDirectoryPicker' in window)) {
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: 'Your browser does not support the File System Access API.',
          });
        }
        return;
      }

      const handle = await loadHandle();
      if (!handle) {
        if (!cancelled) setStatus({ kind: 'idle' });
        return;
      }

      const hasPermission = await checkPermission(handle);
      if (!cancelled) {
        setStatus(
          hasPermission
            ? { kind: 'connected', name: handle.name }
            : { kind: 'disconnected', name: handle.name },
        );
      }
    }

    checkExisting();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectFolder = useCallback(async () => {
    try {
      const picker = (window as unknown as Record<string, unknown>).showDirectoryPicker as
        | ((options: {
            mode: string;
            id: string;
            startIn: string;
          }) => Promise<FileSystemDirectoryHandle>)
        | undefined;

      if (!picker) {
        setStatus({
          kind: 'error',
          message: 'Your browser does not support the File System Access API.',
        });
        return;
      }

      const handle = await picker({
        mode: 'readwrite',
        id: 'gemini-voyager-sync',
        startIn: 'documents',
      });

      await saveHandle(handle);

      await chrome.storage.local.set({ [SyncStorageKeys.FOLDER_NAME]: handle.name });

      chrome.runtime.sendMessage({ type: 'gv.sync.localPickerComplete' });

      setStatus({ kind: 'connected', name: handle.name });

      // Close the tab after a brief delay so the user sees the success state
      setTimeout(() => {
        window.close();
      }, 600);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled the picker — no error state needed
        return;
      }
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permission denied. Please grant access to the folder.'
          : err instanceof Error
            ? err.message
            : 'An unexpected error occurred.';
      setStatus({ kind: 'error', message });
    }
  }, []);

  const handleGrantAccess = useCallback(async () => {
    const handle = await loadHandle();
    if (!handle) {
      setStatus({ kind: 'idle' });
      return;
    }

    const granted = await requestPermission(handle);
    setStatus(
      granted
        ? { kind: 'connected', name: handle.name }
        : { kind: 'error', message: 'Permission denied. Please grant access to the folder.' },
    );
  }, []);

  const statusColor = (() => {
    if (status.kind === 'connected') return '#22c55e';
    if (status.kind === 'disconnected') return '#f59e0b';
    return '#94a3b8';
  })();

  return (
    <>
      <style>{darkOverrides}</style>
      <div className="gv-folder-picker-container" style={styles.container}>
        <h1 className="gv-folder-picker-title" style={styles.title}>
          Local Folder Sync
        </h1>
        <p className="gv-folder-picker-subtitle" style={styles.subtitle}>
          Select a folder on your device to sync your data. The folder will receive JSON files
          representing your folders, prompts, and starred messages.
        </p>

        {/* Status indicator */}
        <div style={styles.statusRow}>
          {' '}
          <span
            className="gv-folder-picker-status-dot"
            style={{ ...styles.statusDot, backgroundColor: statusColor }}
          />
          <span className="gv-folder-picker-subtitle">
            {status.kind === 'loading' && 'Checking status…'}
            {status.kind === 'idle' && 'No folder selected'}
            {status.kind === 'connected' && `Connected: ${status.name}`}
            {status.kind === 'disconnected' && `Needs re-authorization: ${status.name}`}
            {status.kind === 'error' && status.message}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {(status.kind === 'idle' || status.kind === 'error') && (
            <button
              className="gv-folder-picker-button gv-folder-picker-button-primary"
              style={{ ...styles.button, ...styles.buttonPrimary }}
              onClick={handleSelectFolder}
            >
              Select Folder
            </button>
          )}

          {status.kind === 'disconnected' && (
            <button
              className="gv-folder-picker-button gv-folder-picker-button-primary"
              style={{ ...styles.button, ...styles.buttonPrimary }}
              onClick={handleGrantAccess}
            >
              Grant Access
            </button>
          )}

          {status.kind === 'connected' && (
            <button
              className="gv-folder-picker-button"
              style={styles.button}
              onClick={handleSelectFolder}
            >
              Change Folder
            </button>
          )}
        </div>

        {status.kind === 'error' && (
          <p className="gv-folder-picker-error" style={styles.errorText}>
            {status.message}
          </p>
        )}
      </div>
    </>
  );
}
