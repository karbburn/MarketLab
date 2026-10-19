/**
 * "Recently used" datasets for the command palette.
 *
 * This is presentation history, not application data: a short, best-effort list
 * of dataset ids kept in `localStorage` so the palette can offer the series a
 * user actually opens. It is deliberately defensive - a blocked or full storage
 * area simply means no recents - and it stores ids only. Rows are resolved
 * against the live library on every open, so a deleted dataset never reappears.
 */

export const RECENT_DATASETS_STORAGE_KEY = 'marketlab.commandPalette.recentDatasets';
export const MAX_RECENT_DATASETS = 5;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // Safari in private mode, or a page with storage blocked.
    return null;
  }
}

/** Moves `id` to the front, removes duplicates and caps the list. Pure. */
export function pushRecentDataset(ids: readonly string[], id: string, max = MAX_RECENT_DATASETS): string[] {
  if (id.length === 0) return [...ids];
  const limit = Math.max(1, max);
  return [id, ...ids.filter((entry) => entry !== id)].slice(0, limit);
}

/** Stored dataset ids, newest first. Anything malformed is discarded. */
export function readRecentDatasetIds(storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_DATASETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      ids.push(entry);
      if (ids.length >= MAX_RECENT_DATASETS) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function writeRecentDatasetIds(ids: readonly string[], storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_DATASETS_STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_DATASETS)));
  } catch {
    // Quota exceeded or storage blocked: recents are a convenience only.
  }
}

/** Records `id` as most recently used and returns the new list. */
export function rememberRecentDataset(id: string, storage: StorageLike | null = defaultStorage()): string[] {
  const next = pushRecentDataset(readRecentDatasetIds(storage), id);
  writeRecentDatasetIds(next, storage);
  return next;
}
