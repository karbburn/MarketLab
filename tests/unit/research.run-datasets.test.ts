import { describe, expect, it } from 'vitest';
import type { BacktestRun, Dataset, Instrument } from '../../src/domain/types';
import { indexInstrumentsById, resolveRunDataset, type RunDatasetResolution } from '../../src/lib/backtest/run-datasets';
import type { BacktestConfig, BacktestResult } from '../../src/domain/types';

function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return { id: 'inst-1', symbol: 'TST', displayName: 'Test', assetType: 'equity', currency: 'USD', ...overrides };
}

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    instrumentId: 'inst-1',
    name: 'Test series',
    sourceKind: 'user-csv',
    sourceDescription: 'unit test',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2024-01-01',
    lastDate: '2024-03-31',
    rowCount: 64,
    importedAt: '2024-04-01T00:00:00.000Z',
    contentHash: 'sha256:identity',
    hasVolume: true,
    validation: {
      acceptedRows: 64,
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

function run(datasetOverrides: Partial<BacktestRun['dataset']> = {}): BacktestRun {
  return {
    id: 'run-1',
    schemaVersion: 1,
    name: 'Saved run',
    createdAt: '2024-04-02T00:00:00.000Z',
    engineVersion: '1.0.0',
    config: { id: 'bt-1', name: 'Saved run', datasetId: 'ds-1', entry: [], exit: [], entryLogic: 'AND', exitLogic: 'OR', initialCapital: 100_000, positionSizePct: 100 } as unknown as BacktestConfig,
    dataset: {
      datasetId: 'ds-1',
      instrumentId: 'inst-1',
      instrumentSymbol: 'TST',
      datasetName: 'Test series',
      frequency: 'daily',
      contentHash: 'sha256:identity',
      windowFingerprint: 'sha256:window',
      windowStart: '2024-01-01',
      windowEnd: '2024-03-31',
      barCount: 64,
      ...datasetOverrides,
    },
    assumptions: [],
    metrics: { tradeCount: 0 } as unknown as BacktestResult['metrics'],
    trades: [],
  };
}

function resolve(
  testRun: BacktestRun,
  datasets: readonly Dataset[],
  instruments: readonly Instrument[] = [instrument()],
): RunDatasetResolution {
  return resolveRunDataset(testRun, datasets, indexInstrumentsById(instruments));
}

describe('resolveRunDataset', () => {
  it('resolves through the stored dataset id first and needs no identity checks', () => {
    const library = [dataset({ contentHash: 'sha256:something-else' })];
    const result = resolve(run(), library);
    expect(result.basis).toBe('stored-id');
    expect(result.dataset?.id).toBe('ds-1');
  });

  it('resolves a unique content-identical sibling by symbol', () => {
    const result = resolve(run(), [dataset({ id: 'ds-2', instrumentId: 'inst-2', name: 'Re-imported' })], [
      instrument({ id: 'inst-2' }),
    ]);
    expect(result.basis).toBe('matching-content');
    expect(result.dataset?.id).toBe('ds-2');
  });

  it('refuses a content-identical sibling whose instrument identity differs', () => {
    // An index and a fund can share an identical short window; the backup merge
    // rule requires the instrument identity to agree before re-pointing.
    const result = resolve(run(), [dataset({ id: 'ds-2', instrumentId: 'inst-2' })], [instrument({ id: 'inst-2', symbol: 'OTHER' })]);
    expect(result.basis).toBe('missing');
    expect(result.dataset).toBeNull();
  });

  it('refuses a sibling with the same instrument but changed content', () => {
    const result = resolve(run(), [dataset({ id: 'ds-2', contentHash: 'sha256:changed' })]);
    expect(result.basis).toBe('missing');
  });

  it('refuses a sibling with a different frequency', () => {
    const result = resolve(run(), [dataset({ id: 'ds-2', frequency: 'weekly' })]);
    expect(result.basis).toBe('missing');
  });

  it('resolves through the pinned instrument id when the run has no symbol', () => {
    const result = resolve(run({ instrumentSymbol: '' }), [dataset({ id: 'ds-2' })]);
    expect(result.basis).toBe('matching-content');
    expect(result.dataset?.id).toBe('ds-2');
  });

  it('stays missing when a symbolless run has no instrument pin and several candidates', () => {
    const result = resolve(run({ instrumentSymbol: '', instrumentId: 'inst-9' }), [
      dataset({ id: 'ds-2', instrumentId: 'inst-2' }),
      dataset({ id: 'ds-3', instrumentId: 'inst-3', name: 'Second copy' }),
    ], [instrument({ id: 'inst-2' }), instrument({ id: 'inst-3' })]);
    expect(result.basis).toBe('missing');
  });

  it('stays missing when two content-identical siblings are equally valid', () => {
    const result = resolve(run(), [
      dataset({ id: 'ds-2', instrumentId: 'inst-2' }),
      dataset({ id: 'ds-3', instrumentId: 'inst-2', name: 'Second copy' }),
    ], [instrument({ id: 'inst-2' })]);
    expect(result.basis).toBe('missing');
    expect(result.dataset).toBeNull();
  });

  it('is empty-library safe', () => {
    expect(resolve(run(), [])).toEqual({ dataset: null, basis: 'missing' });
  });
});
