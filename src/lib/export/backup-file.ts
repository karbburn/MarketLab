/**
 * The "export the current library as a JSON backup file" flow, in one place so
 * the workspaces screen and the command palette cannot drift apart. Browser
 * only: it needs a DOM to hand the file to.
 */

import { createBackup, serialiseBackup, type BackupInput } from './backup';
import { downloadTextFile } from './download';

/** Backup file name, dated to the day it was written. */
export function backupFileName(now: Date = new Date()): string {
  return `marketlab-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** Serialises the given local library and starts the download. */
export function downloadBackupFile(input: BackupInput, now: Date = new Date()): void {
  downloadTextFile(backupFileName(now), serialiseBackup(createBackup(input)), 'application/json');
}
