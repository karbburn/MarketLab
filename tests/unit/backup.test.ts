import { describe, expect, it } from 'vitest';
import { createBackup, isEmptyReplaceRestore, mergeBackup, parseBackup, type BackupBundle } from '../../src/lib/export/backup';
import type { BacktestConfig, Bar, Dataset, Instrument, ScreenerDefinition, UserPreferences, Watchlist, Workspace } from '../../src/domain/types';

function instrument(id: string, symbol: string): Instrument {
  return { id, symbol, displayName: symbol, assetType: 'equity', currency: 'USD' };
}

function dataset(id: string, instrumentId: string, contentHash: string): Dataset {
  return {
    id,
    instrumentId,
    name: `${id} - daily`,
    sourceKind: 'bundled-sample',
    sourceDescription: 'test',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2024-01-01',
    lastDate: '2024-01-05',
    rowCount: 2,
    importedAt: '2024-01-05T00:00:00.000Z',
    contentHash,
    hasVolume: true,
    validation: {
      acceptedRows: 2,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
  };
}

const bars: Bar[] = [
  { date: '2024-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { date: '2024-01-03', open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 },
];

function workspace(id: string, datasetId: string, instrumentId: string): Workspace {
  return {
    id,
    name: id,
    schemaVersion: 1,
    layout: 'single',
    charts: [
      {
        id: `${id}-chart`,
        instrumentId,
        datasetId,
        timeframe: '1D',
        chartType: 'candlestick',
        showVolume: true,
        priceScaleMode: 'normal',
        visibleRange: null,
        indicators: [],
        drawings: [],
        compareDatasetIds: [],
      },
    ],
    linkGroups: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function watchlist(id: string, instrumentIds: string[]): Watchlist {
  return { id, name: id, instrumentIds, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
}

function screener(id: string, universeDatasetIds: string[]): ScreenerDefinition {
  return {
    id,
    name: id,
    schemaVersion: 1,
    universeDatasetIds,
    combinators: [],
    filters: [],
    cutoff: null,
    sortBy: 'symbol',
    sortDirection: 'asc',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function backtest(id: string, datasetId: string): BacktestConfig {
  return {
    id,
    name: id,
    datasetId,
    startDate: null,
    endDate: null,
    initialCapital: 10_000,
    positionSizePct: 100,
    commissionBps: 0,
    slippageBps: 0,
    stopLossPct: null,
    takeProfitPct: null,
    entry: [],
    exit: [],
    entryLogic: 'AND',
    exitLogic: 'OR',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const emptyBase = {
  instruments: [] as Instrument[],
  datasets: [] as Dataset[],
  barsByDataset: {} as Record<string, Bar[]>,
  workspaces: [] as Workspace[],
  watchlists: [] as Watchlist[],
  screeners: [],
  backtests: [],
};

describe('mergeBackup', () => {
  it('merges by id and overwrites an existing record', () => {
    const base = {
      ...emptyBase,
      instruments: [instrument('i1', 'AAA')],
      datasets: [dataset('d1', 'i1', 'hash-1')],
      barsByDataset: { d1: bars },
    };
    const bundle: BackupBundle = {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i1', 'AAA-renamed')],
      datasets: [dataset('d1', 'i1', 'hash-1')],
      bars: [{ id: 'd1', bars }],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
    };

    const result = mergeBackup(base, bundle);
    expect(result.datasets).toHaveLength(1);
    expect(result.instruments).toHaveLength(1);
    expect(result.instruments[0]?.symbol).toBe('AAA-renamed');
    expect(result.overwritten).toBe(2);
    expect(result.barsByDataset.d1).toHaveLength(2);
  });

  it('skips a dataset with an identical content hash and re-points its panels', () => {
    // Same series, different ids: this is what a local reset produces.
    const base = {
      ...emptyBase,
      instruments: [instrument('i-new', 'AAA')],
      datasets: [dataset('d-new', 'i-new', 'hash-1')],
      barsByDataset: { 'd-new': bars },
    };
    const bundle: BackupBundle = {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i-old', 'AAA')],
      datasets: [dataset('d-old', 'i-old', 'hash-1'), dataset('d-other', 'i-old', 'hash-2')],
      bars: [
        { id: 'd-old', bars },
        { id: 'd-other', bars },
      ],
      workspaces: [workspace('ws-old', 'd-old', 'i-old'), workspace('ws-other', 'd-other', 'i-old')],
      watchlists: [watchlist('wl', ['i-old'])],
      preferences: null,
      screeners: [],
      backtests: [],
    };

    const result = mergeBackup(base, bundle);

    expect(result.duplicateDatasets).toBe(1);
    expect(result.datasets.map((entry) => entry.id).sort()).toEqual(['d-new', 'd-other']);
    expect(result.barsByDataset['d-old']).toBeUndefined();

    // The identical series is not duplicated and its panel now points at the stored one.
    const identical = result.workspaces.find((entry) => entry.id === 'ws-old');
    expect(identical?.charts[0]?.datasetId).toBe('d-new');
    expect(identical?.charts[0]?.instrumentId).toBe('i-new');
    expect(result.remappedPanels).toBe(1);

    // A genuinely new series keeps its own identity and instrument.
    const distinct = result.workspaces.find((entry) => entry.id === 'ws-other');
    expect(distinct?.charts[0]?.datasetId).toBe('d-other');
    expect(result.instruments.map((entry) => entry.id).sort()).toEqual(['i-new', 'i-old']);
  });

  it('remaps comparison overlays through the same duplicate-series resolution', () => {
    const base = {
      ...emptyBase,
      instruments: [instrument('i-new', 'AAA')],
      datasets: [dataset('d-new', 'i-new', 'hash-1')],
      barsByDataset: { 'd-new': bars },
    };
    const source = workspace('ws-old', 'd-old', 'i-old');
    // The first comparison is the same series as the panel (which dedupes onto
    // the stored copy and must not survive as a self-reference); the second is a
    // genuinely new series.
    (source.charts[0] as Workspace['charts'][number]).compareDatasetIds = ['d-old', 'd-old-other'];
    const bundle: BackupBundle = {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i-old', 'AAA')],
      datasets: [dataset('d-old', 'i-old', 'hash-1'), dataset('d-old-other', 'i-old', 'hash-2')],
      bars: [
        { id: 'd-old', bars },
        { id: 'd-old-other', bars },
      ],
      workspaces: [source],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
    };

    const result = mergeBackup(base, bundle);
    const merged = result.workspaces.find((entry) => entry.id === 'ws-old');
    expect(merged?.charts[0]?.datasetId).toBe('d-new');
    expect(merged?.charts[0]?.compareDatasetIds).toEqual(['d-old-other']);
  });

  it('remaps watchlist entries onto the stored instrument when the series already exists', () => {
    const base = {
      ...emptyBase,
      instruments: [instrument('i-new', 'AAA')],
      datasets: [dataset('d-new', 'i-new', 'hash-1')],
      barsByDataset: { 'd-new': bars },
    };
    const bundle: BackupBundle = {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i-old', 'AAA')],
      datasets: [dataset('d-old', 'i-old', 'hash-1')],
      bars: [{ id: 'd-old', bars }],
      workspaces: [],
      watchlists: [watchlist('wl', ['i-old'])],
      preferences: null,
      screeners: [],
      backtests: [],
    };

    const result = mergeBackup(base, bundle);
    expect(result.watchlists[0]?.instrumentIds).toEqual(['i-new']);
    // The skipped dataset's instrument was not written.
    expect(result.instruments.map((entry) => entry.id)).toEqual(['i-new']);
  });

  it('remaps saved backtests and screeners when a dataset is deduplicated', () => {
    const base = {
      ...emptyBase,
      instruments: [instrument('i-new', 'AAA')],
      datasets: [dataset('d-new', 'i-new', 'hash-1')],
      barsByDataset: { 'd-new': bars },
    };
    const bundle: BackupBundle = {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i-old', 'AAA')],
      datasets: [dataset('d-old', 'i-old', 'hash-1')],
      bars: [{ id: 'd-old', bars }],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [screener('s-old', ['d-old'])],
      backtests: [backtest('bt-old', 'd-old')],
    };

    const result = mergeBackup(base, bundle);
    expect(result.duplicateDatasets).toBe(1);
    expect(result.screeners[0]?.universeDatasetIds).toEqual(['d-new']);
    expect(result.backtests[0]?.datasetId).toBe('d-new');
  });

  it('round-trips a backup that was just exported', () => {
    const entities = {
      instruments: [instrument('i1', 'AAA')],
      datasets: [dataset('d1', 'i1', 'hash-1')],
      barsByDataset: { d1: bars },
      workspaces: [workspace('ws1', 'd1', 'i1')],
      watchlists: [watchlist('wl1', ['i1'])],
      screeners: [],
      backtests: [],
    };
    const bundle = createBackup({ ...entities, preferences: null, bars: [{ id: 'd1', bars }] });
    const result = mergeBackup(emptyBase, bundle);

    expect(result.duplicateDatasets).toBe(0);
    expect(result.datasets).toHaveLength(1);
    expect(result.workspaces[0]?.charts[0]?.datasetId).toBe('d1');
    expect(result.barsByDataset.d1).toHaveLength(2);
  });
});

describe('parseBackup validation', () => {
  function backupInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      app: 'marketlab',
      schemaVersion: 1,
      exportedAt: '2024-02-01T00:00:00.000Z',
      instruments: [instrument('i1', 'AAA')],
      datasets: [dataset('d1', 'i1', 'hash-1')],
      bars: [{ id: 'd1', bars }],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
      ...overrides,
    };
  }

  it('accepts a well-formed backup', () => {
    const result = parseBackup(backupInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.datasets).toHaveLength(1);
    expect(result.value.bars).toHaveLength(1);
  });

  it('rejects a bars entry containing anything that is not a valid bar', () => {
    const result = parseBackup(backupInput({ bars: [{ id: 'd1', bars: [1, 2, 3] }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bars).toEqual([]);
    expect(result.skipped).toContain('bars:d1');
  });

  it('rejects an invalid bar inside an otherwise well-formed series', () => {
    const invalidBars = [...bars, { date: '2024-02-31', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    const result = parseBackup(backupInput({ bars: [{ id: 'd1', bars: invalidBars }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bars).toEqual([]);
    expect(result.skipped).toContain('bars:d1');
  });

  it('rejects screeners that do not satisfy the screener schema', () => {
    const incomplete = {
      id: 's1',
      name: 'incomplete',
      schemaVersion: 1,
      universeDatasetIds: ['d1'],
      filters: [],
      cutoff: null,
      sortBy: 'symbol',
      sortDirection: 'asc',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const result = parseBackup(backupInput({ screeners: [incomplete] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.screeners).toEqual([]);
    expect(result.skipped).toContain('screeners:s1');
  });

  it('rejects backtests that do not satisfy the backtest schema', () => {
    const incomplete = {
      ...backtest('bt1', 'd1'),
      exit: undefined,
    };
    const result = parseBackup(backupInput({ backtests: [incomplete] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.backtests).toEqual([]);
    expect(result.skipped).toContain('backtests:bt1');
  });

  it('accepts valid screeners and backtests', () => {
    const result = parseBackup(backupInput({ screeners: [screener('s1', ['d1'])], backtests: [backtest('bt1', 'd1')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.screeners).toHaveLength(1);
    expect(result.value.backtests).toHaveLength(1);
  });

  it('rejects a dataset that does not satisfy the dataset schema', () => {
    // Plausible-looking but incomplete: no validation summary, source kind,
    // dates or content hash. Rendering this record throws in the data page.
    const incomplete = { id: 'd1', instrumentId: 'i1', rowCount: 2 };
    const result = parseBackup(backupInput({ datasets: [incomplete] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.datasets).toEqual([]);
    expect(result.value.bars).toEqual([]);
    expect(result.skipped).toContain('datasets:d1');
  });

  it('rejects an instrument that does not satisfy the instrument schema', () => {
    const incomplete = { id: 'i1', symbol: 'AAA', assetType: 'equity', currency: 'USD' };
    const result = parseBackup(backupInput({ instruments: [incomplete] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instruments).toEqual([]);
    expect(result.skipped).toContain('instruments:i1');
    // The dataset loses its instrument and is dropped with it.
    expect(result.value.datasets).toEqual([]);
  });

  it('rejects invalid preferences and reports them', () => {
    const result = parseBackup(backupInput({ preferences: { theme: 'neon' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preferences).toBeNull();
    expect(result.skipped).toContain('preferences');
  });

  it('accepts preferences that satisfy the preferences schema', () => {
    const preferences: UserPreferences = {
      theme: 'light',
      defaultWorkspaceId: null,
      showVolumeByDefault: false,
      defaultChartType: 'line',
      defaultTimeframe: '1W',
    };
    const result = parseBackup(backupInput({ preferences }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preferences).toEqual(preferences);
    expect(result.skipped).not.toContain('preferences');
  });
});

describe('isEmptyReplaceRestore', () => {
  it('refuses an empty backup over a non-empty library', () => {
    expect(
      isEmptyReplaceRestore({
        local: { datasets: [dataset('d1', 'i1', 'hash-1')], workspaces: [] },
        merged: { datasets: [], workspaces: [] },
      }),
    ).toBe(true);
  });

  it('allows an empty backup when the library is already empty', () => {
    expect(
      isEmptyReplaceRestore({
        local: { datasets: [], workspaces: [] },
        merged: { datasets: [], workspaces: [] },
      }),
    ).toBe(false);
  });

  it('allows a backup that carries a dataset or workspace', () => {
    expect(
      isEmptyReplaceRestore({
        local: { datasets: [dataset('d1', 'i1', 'hash-1')], workspaces: [] },
        merged: { datasets: [dataset('d2', 'i2', 'hash-2')], workspaces: [] },
      }),
    ).toBe(false);
    expect(
      isEmptyReplaceRestore({
        local: { datasets: [dataset('d1', 'i1', 'hash-1')], workspaces: [] },
        merged: { datasets: [], workspaces: [workspace('ws1', 'd1', 'i1')] },
      }),
    ).toBe(false);
  });

  it('refuses when the library only holds workspaces', () => {
    expect(
      isEmptyReplaceRestore({
        local: { datasets: [], workspaces: [workspace('ws1', 'd1', 'i1')] },
        merged: { datasets: [], workspaces: [] },
      }),
    ).toBe(true);
  });
});
