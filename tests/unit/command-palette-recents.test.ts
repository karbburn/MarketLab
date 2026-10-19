import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_DATASETS,
  pushRecentDataset,
  readRecentDatasetIds,
  rememberRecentDataset,
  writeRecentDatasetIds,
  RECENT_DATASETS_STORAGE_KEY,
} from '../../src/lib/command-palette/recents';

/** Minimal in-memory `localStorage` stand-in, optionally hostile. */
function memoryStorage(initial: string | null = null, behaviour: 'ok' | 'throw' = 'ok') {
  let value = initial;
  return {
    get value() {
      return value;
    },
    getItem(): string | null {
      if (behaviour === 'throw') throw new Error('blocked');
      return value;
    },
    setItem(_key: string, next: string): void {
      if (behaviour === 'throw') throw new Error('quota exceeded');
      value = next;
    },
  };
}

describe('pushRecentDataset', () => {
  it('moves the id to the front', () => {
    expect(pushRecentDataset(['b', 'c'], 'c')).toEqual(['c', 'b']);
  });

  it('de-duplicates and caps the list', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(pushRecentDataset(ids, 'e')).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(pushRecentDataset(ids, 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(pushRecentDataset(ids, 'f')).toHaveLength(MAX_RECENT_DATASETS);
  });

  it('ignores an empty id', () => {
    expect(pushRecentDataset(['a'], '')).toEqual(['a']);
  });

  it('never returns more than the caller asked for', () => {
    expect(pushRecentDataset(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a']);
  });
});

describe('readRecentDatasetIds', () => {
  it('returns an empty list without storage', () => {
    expect(readRecentDatasetIds(null)).toEqual([]);
  });

  it('reads stored ids newest first', () => {
    const storage = memoryStorage(JSON.stringify(['ds_b', 'ds_a']));
    expect(readRecentDatasetIds(storage)).toEqual(['ds_b', 'ds_a']);
  });

  it('discards malformed, duplicate and non-string entries', () => {
    const storage = memoryStorage(JSON.stringify(['ds_a', 'ds_a', 7, null, '', 'ds_b']));
    expect(readRecentDatasetIds(storage)).toEqual(['ds_a', 'ds_b']);
  });

  it('survives unparseable or non-array payloads', () => {
    expect(readRecentDatasetIds(memoryStorage('{not json'))).toEqual([]);
    expect(readRecentDatasetIds(memoryStorage(JSON.stringify({ ds_a: true })))).toEqual([]);
    expect(readRecentDatasetIds(memoryStorage(null))).toEqual([]);
  });

  it('survives storage that throws', () => {
    expect(readRecentDatasetIds(memoryStorage(null, 'throw'))).toEqual([]);
  });
});

describe('writeRecentDatasetIds', () => {
  it('stores a capped list under the palette key', () => {
    const storage = memoryStorage();
    writeRecentDatasetIds(['ds_a', 'ds_b', 'ds_c', 'ds_d', 'ds_e', 'ds_f'], storage);
    const raw = storage.value;
    expect(raw).not.toBeNull();
    expect(JSON.parse(String(raw))).toHaveLength(MAX_RECENT_DATASETS);
  });

  it('never throws when storage is blocked', () => {
    expect(() => writeRecentDatasetIds(['ds_a'], memoryStorage(null, 'throw'))).not.toThrow();
    expect(() => writeRecentDatasetIds(['ds_a'], null)).not.toThrow();
  });

  it('remembers under the documented key', () => {
    expect(RECENT_DATASETS_STORAGE_KEY).toBe('marketlab.commandPalette.recentDatasets');
  });
});

describe('rememberRecentDataset', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    expect(rememberRecentDataset('ds_a', storage)).toEqual(['ds_a']);
    expect(rememberRecentDataset('ds_b', storage)).toEqual(['ds_b', 'ds_a']);
    expect(readRecentDatasetIds(storage)).toEqual(['ds_b', 'ds_a']);
  });
});
