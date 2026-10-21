import { describe, expect, it } from 'vitest';
import {
  createMemoryAdapter,
  type PersistenceAdapter,
  type PersistenceTransaction,
  type StoreName,
} from '../../src/lib/persistence/db';
import { loadState } from '../../src/state/store';
import type { Bar, Dataset, Instrument, UserPreferences, Watchlist, Workspace } from '../../src/domain/types';

let sequence = 0;

function demoInstrument(id: string): Instrument {
  return { id, symbol: 'ATX', displayName: 'Demo series', assetType: 'equity', currency: 'USD' };
}

function demoDataset(id: string, instrumentId: string): Dataset {
  sequence += 1;
  return {
    id,
    instrumentId,
    name: 'Demo series',
    sourceKind: 'bundled-sample',
    sourceDescription: 'legacy bundled demo',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2024-01-02',
    lastDate: '2024-01-03',
    rowCount: 2,
    importedAt: new Date(0).toISOString(),
    contentHash: `demo-hash-${sequence}`,
    hasVolume: false,
    provider: undefined,
    validation: {
      acceptedRows: 2,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 2,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
  };
}

function demoBars(id: string): Array<{ id: string; bars: Bar[] }> {
  return [
    {
      id,
      bars: [
        { date: '2024-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: null },
        { date: '2024-01-03', open: 10.5, high: 12, low: 10, close: 11.5, volume: null },
      ],
    },
  ];
}

function workspaceFor(id: string, datasetId: string, instrumentId: string): Workspace {
  return {
    id,
    name: 'Primary',
    schemaVersion: 1,
    layout: 'single',
    charts: [
      {
        id: `chart-${id}`,
        instrumentId,
        datasetId,
        timeframe: '1D',
        chartType: 'candlestick',
        showVolume: false,
        priceScaleMode: 'normal',
        visibleRange: null,
        indicators: [],
        drawings: [],
        compareDatasetIds: [],
      },
    ],
    linkGroups: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * A library holding one bundled demo series (with instrument, bars and a
 * workspace that only shows it) plus one imported series the migration must
 * never touch.
 */
async function seedLibrary(preferences?: UserPreferences): Promise<PersistenceAdapter> {
  const adapter = createMemoryAdapter();
  await adapter.put('instruments', demoInstrument('inst-demo'));
  await adapter.put<Instrument>('instruments', {
    ...demoInstrument('inst-user'),
    symbol: 'AAPL',
    displayName: 'Imported daily',
  });
  await adapter.put<Dataset>('datasets', demoDataset('ds-demo', 'inst-demo'));
  await adapter.put<Dataset>('datasets', { ...demoDataset('ds-user', 'inst-user'), sourceKind: 'user-csv' });
  for (const record of demoBars('ds-demo')) await adapter.put('bars', record);
  for (const record of demoBars('ds-user')) await adapter.put('bars', record);
  await adapter.put('workspaces', workspaceFor('ws-demo', 'ds-demo', 'inst-demo'));
  await adapter.put('workspaces', workspaceFor('ws-user', 'ds-user', 'inst-user'));
  await adapter.put('watchlists', {
    id: 'wl-demo',
    name: 'Demo watchlist',
    instrumentIds: ['inst-demo'],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } satisfies Watchlist);
  if (preferences) await adapter.put('preferences', { id: 'preferences', ...preferences });
  return adapter;
}

function importPreferences(): UserPreferences {
  return {
    theme: 'dark',
    defaultWorkspaceId: 'ws-demo',
    showVolumeByDefault: false,
    defaultChartType: 'candlestick',
    defaultTimeframe: '1D',
  };
}

const QUOTA_FAILURE = 'simulated quota failure';

/**
 * Copies of the adapter whose writes to `store` — direct and inside any
 * transaction — fail with `QUOTA_FAILURE`. Inside a transaction the remaining
 * writes must then be discarded, which the memory adapter guarantees.
 */
function adapterThatFailsOn(base: PersistenceAdapter, store: StoreName): PersistenceAdapter {
  const fail = () => new Error(QUOTA_FAILURE);
  return {
    ...base,
    put: async (target, value) => {
      if (target === store) throw fail();
      await base.put(target, value);
    },
    putMany: async (target, values) => {
      if (target === store) throw fail();
      await base.putMany(target, values);
    },
    transaction: async (targetStores, operation, options) =>
      base.transaction(
        targetStores,
        async (tx: PersistenceTransaction) =>
          operation(
            {
              ...tx,
              put: async (target, value) => {
                if (target === store) throw fail();
                await tx.put(target, value);
              },
              putMany: async (target, values) => {
                if (target === store) throw fail();
                await tx.putMany(target, values);
              },
            } as PersistenceTransaction,
          ),
        options,
      ),
  };
}

describe('loadState migration atomicity', () => {
  it('leaves the library untouched when the migration write fails partway', async () => {
    const adapter = await seedLibrary(importPreferences());
    const failing = adapterThatFailsOn(adapter, 'settings');

    // The settings record is written last inside the migration transaction, so
    // this reproduces a quota failure after the removals were already prepared.
    await expect(loadState(failing)).rejects.toThrow(QUOTA_FAILURE);

    // Nothing may be half-removed: in the previous non-transactional path the
    // bars and demo records were already committed before the failing write.
    expect((await adapter.list<Dataset>('datasets')).map((entry) => entry.id).sort()).toEqual(['ds-demo', 'ds-user']);
    expect(new Set((await adapter.list<{ id: string; bars: Bar[] }>('bars')).map((record) => record.id))).toEqual(
      new Set(['ds-demo', 'ds-user']),
    );
    expect((await adapter.list<Instrument>('instruments')).map((entry) => entry.id).sort()).toEqual([
      'inst-demo',
      'inst-user',
    ]);
    expect((await adapter.list<Workspace>('workspaces')).map((entry) => entry.id).sort()).toEqual(['ws-demo', 'ws-user']);
    expect(await adapter.list('settings')).toEqual([]);
    // Even the default-workspace preference points where it did before.
    const preferences = await adapter.get<UserPreferences & { id: string }>('preferences', 'preferences');
    expect(preferences?.defaultWorkspaceId).toBe('ws-demo');
  });

  it('completes the migration on a later load and keeps every user record', async () => {
    const adapter = await seedLibrary(importPreferences());

    const { snapshot, notice } = await loadState(adapter);

    expect(notice).toContain('demo dataset');
    expect(snapshot.datasets.map((entry) => entry.id)).toEqual(['ds-user']);
    expect(snapshot.barsByDataset).toHaveProperty('ds-user');
    expect(snapshot.barsByDataset).not.toHaveProperty('ds-demo');
    expect(snapshot.workspaces.map((entry) => entry.id)).toEqual(['ws-user']);
    expect(snapshot.watchlists).toEqual([]);
    expect(snapshot.instruments.map((entry) => entry.id)).toEqual(['inst-user']);
    // The removed default workspace is cleared from the stored preference and
    // the active workspace falls back to the surviving workspace.
    expect(snapshot.preferences.defaultWorkspaceId).toBeNull();
    expect(snapshot.activeWorkspaceId).toBe('ws-user');
    const settings = await adapter.list<{ id: string; schemaVersion: number; installedAt: string }>('settings');
    expect(settings).toHaveLength(1);
    expect(settings[0]?.schemaVersion).toBeGreaterThan(0);
  });

  it('reruns the migration unchanged on the next load after a failure', async () => {
    const adapter = await seedLibrary();
    await expect(loadState(adapterThatFailsOn(adapter, 'settings'))).rejects.toThrow(QUOTA_FAILURE);

    const second = await loadState(adapter);
    expect(second.notice).toContain('demo dataset');
    expect(second.snapshot.datasets.map((entry) => entry.id)).toEqual(['ds-user']);
    // And a third load repeats nothing: the migration is now settled.
    const third = await loadState(adapter);
    expect(third.notice).toBeNull();
  });
});
