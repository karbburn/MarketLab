import { describe, expect, it } from 'vitest';
import {
  createMemoryAdapter,
  type PersistenceAdapter,
  type PersistenceTransaction,
  type StoreName,
} from '../../src/lib/persistence/db';
import { APP_SCHEMA_VERSION } from '../../src/state/defaults';
import { loadState } from '../../src/state/store';
import type { Bar, Dataset, Instrument } from '../../src/domain/types';

const NOW = '2026-01-01T00:00:00.000Z';

function bars(closes: readonly number[]): Bar[] {
  return closes.map((close, index) => ({
    date: `2024-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  }));
}

function instrument(id: string): Instrument {
  return { id, symbol: id.toUpperCase(), displayName: id, assetType: 'equity', currency: 'USD' };
}

function dataset(id: string, instrumentId: string, series: readonly Bar[], overrides: Partial<Dataset> = {}): Dataset {
  return {
    id,
    instrumentId,
    name: id,
    sourceKind: 'user-csv',
    sourceDescription: 'test fixture',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: (series[0] as Bar).date,
    lastDate: (series[series.length - 1] as Bar).date,
    rowCount: series.length,
    importedAt: NOW,
    contentHash: `hash-${id}-${series.length}`,
    hasVolume: true,
    validation: {
      acceptedRows: series.length,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
    ...overrides,
  };
}

interface Counts {
  barsLists: number;
  barsGets: number;
}

/** Counts how the load path actually reads the bars store. */
function counting(adapter: PersistenceAdapter): { adapter: PersistenceAdapter; counts: Counts } {
  const counts: Counts = { barsLists: 0, barsGets: 0 };
  const wrapped: PersistenceAdapter = {
    ...adapter,
    transaction: <T,>(
      stores: readonly StoreName[],
      operation: (tx: PersistenceTransaction) => Promise<T> | T,
      options?: { mode?: 'readonly' | 'readwrite'; notify?: boolean },
    ) =>
      adapter.transaction(
        stores,
        (tx) =>
          operation({
            ...tx,
            list: <U,>(store: StoreName) => {
              if (store === 'bars') counts.barsLists += 1;
              return tx.list<U>(store);
            },
            get: <U,>(store: StoreName, id: string) => {
              if (store === 'bars') counts.barsGets += 1;
              return tx.get<U>(store, id);
            },
          }),
        options,
      ),
  };
  return { adapter: wrapped, counts };
}

async function seed(): Promise<{
  adapter: PersistenceAdapter;
  datasets: Dataset[];
  series: Record<string, Bar[]>;
}> {
  const adapter = createMemoryAdapter();
  const seriesA = bars([10, 11, 12]);
  const seriesB = bars([20, 21, 22]);
  const datasetA = dataset('ds-a', 'inst-a', seriesA);
  const datasetB = dataset('ds-b', 'inst-b', seriesB);
  await adapter.put('instruments', instrument('inst-a'));
  await adapter.put('instruments', instrument('inst-b'));
  await adapter.put('datasets', datasetA);
  await adapter.put('datasets', datasetB);
  await adapter.put('bars', { id: 'ds-a', bars: seriesA });
  await adapter.put('bars', { id: 'ds-b', bars: seriesB });
  await adapter.put('settings', {
    id: 'app',
    schemaVersion: APP_SCHEMA_VERSION,
    installedAt: NOW,
    syntheticDataRemovedAt: NOW,
  });
  return { adapter, datasets: [datasetA, datasetB], series: { 'ds-a': seriesA, 'ds-b': seriesB } };
}

describe('loadState bars cache', () => {
  it('reads every stored series on a cold load', async () => {
    const seeded = await seed();
    const { adapter, counts } = counting(seeded.adapter);
    const { snapshot } = await loadState(adapter);
    expect(counts.barsGets).toBe(2);
    expect(counts.barsLists).toBe(0);
    expect(snapshot.barsByDataset['ds-a']).toEqual(seeded.series['ds-a']);
  });

  it('reuses unchanged series instead of transferring them again', async () => {
    const seeded = await seed();
    const { adapter, counts } = counting(seeded.adapter);
    const { snapshot: first } = await loadState(adapter);
    counts.barsGets = 0;
    counts.barsLists = 0;

    const { snapshot: warm } = await loadState(adapter, {
      barsCache: { datasets: first.datasets, barsByDataset: first.barsByDataset },
    });

    expect(counts.barsGets).toBe(0);
    expect(counts.barsLists).toBe(0);
    // The very same arrays are handed back, so downstream selectors and charts
    // keep their referential identity.
    expect(warm.barsByDataset['ds-a']).toBe(first.barsByDataset['ds-a']);
    expect(warm.barsByDataset['ds-b']).toBe(first.barsByDataset['ds-b']);
    expect(warm.datasets).toEqual(first.datasets);
  });

  it('re-reads only a dataset whose stored metadata says its content changed', async () => {
    const seeded = await seed();
    const { adapter, counts } = counting(seeded.adapter);
    const { snapshot: first } = await loadState(adapter);

    const replacement = bars([30, 31, 32, 33]);
    await seeded.adapter.put('datasets', {
      ...(seeded.datasets[0] as Dataset),
      rowCount: replacement.length,
      lastDate: (replacement[replacement.length - 1] as Bar).date,
      contentHash: 'replaced',
      importedAt: '2026-02-01T00:00:00.000Z',
    });
    await seeded.adapter.put('bars', { id: 'ds-a', bars: replacement });
    counts.barsGets = 0;

    const { snapshot } = await loadState(adapter, {
      barsCache: { datasets: first.datasets, barsByDataset: first.barsByDataset },
    });

    expect(counts.barsGets).toBe(1);
    expect(snapshot.barsByDataset['ds-a']).toEqual(replacement);
    expect(snapshot.barsByDataset['ds-b']).toBe(first.barsByDataset['ds-b']);
  });

  it('does not resurrect a series deleted from storage', async () => {
    const seeded = await seed();
    const { adapter } = counting(seeded.adapter);
    const { snapshot: first } = await loadState(adapter);

    await seeded.adapter.remove('datasets', 'ds-b');
    await seeded.adapter.remove('bars', 'ds-b');

    const { snapshot } = await loadState(adapter, {
      barsCache: { datasets: first.datasets, barsByDataset: first.barsByDataset },
    });

    expect(snapshot.datasets.map((entry) => entry.id)).toEqual(['ds-a']);
    expect('ds-b' in snapshot.barsByDataset).toBe(false);
  });

  it('reads a newly added dataset even when the cache covers the others', async () => {
    const seeded = await seed();
    const { adapter, counts } = counting(seeded.adapter);
    const { snapshot: first } = await loadState(adapter);

    const seriesC = bars([40, 41]);
    await seeded.adapter.put('instruments', instrument('inst-c'));
    await seeded.adapter.put('datasets', dataset('ds-c', 'inst-c', seriesC));
    await seeded.adapter.put('bars', { id: 'ds-c', bars: seriesC });
    counts.barsGets = 0;

    const { snapshot } = await loadState(adapter, {
      barsCache: { datasets: first.datasets, barsByDataset: first.barsByDataset },
    });

    expect(counts.barsGets).toBe(1);
    expect(snapshot.barsByDataset['ds-c']).toEqual(seriesC);
    expect(snapshot.barsByDataset['ds-a']).toBe(first.barsByDataset['ds-a']);
  });
});
