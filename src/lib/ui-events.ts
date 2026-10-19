/**
 * A tiny event bus for the two ways data enters the application.
 *
 * The import and download dialogs live in the application shell, but the pages
 * that need them (overview, data library, chart workspace, research screens)
 * are rendered inside the shell's outlet. Instead of threading the dialog
 * state through every page, the pages raise a request and the shell answers
 * it. The events carry no data: they only say "open this dialog".
 */

export const IMPORT_DATA_EVENT = 'marketlab:import-data';
export const DOWNLOAD_DATA_EVENT = 'marketlab:download-data';
export const BULK_DOWNLOAD_DATA_EVENT = 'marketlab:bulk-download-data';

/** Asks the shell to open the CSV import dialog. */
export function requestImportDialog(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(IMPORT_DATA_EVENT));
}

/** Asks the shell to open the market-data download dialog. */
export function requestDownloadDialog(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DOWNLOAD_DATA_EVENT));
}

/** Asks the shell to open the many-symbol download dialog. */
export function requestBulkDownloadDialog(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(BULK_DOWNLOAD_DATA_EVENT));
}
