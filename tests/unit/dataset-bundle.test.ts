import { describe, expect, it } from 'vitest';
import type { Bar, Dataset, Instrument } from '../../src/domain/types';
import { describeDatasetBundleProblem } from '../../src/lib/validation/dataset-bundle';

const instrument: Instrument = {
  id: 'inst-1',
  symbol: 'AAA',
  displayName: 'AAA',
  assetType: 'equity',
  currency: 'USD',
};

const bars: Bar[] = [
  { date: '2024-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { date: '2024-01-03', open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 },
];

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    instrumentId: 'inst-1',
    name: 'AAA - daily',
    sourceKind: 'user-csv',
    sourceDescription: 'test',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2024-01-02',
    lastDate: '2024-01-03',
    rowCount: 2,
    importedAt: '2024-01-04T00:00:00.000Z',
    contentHash: 'hash',
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
    ...overrides,
  };
}

describe('dataset bundle consistency', () => {
  it('accepts a bundle whose metadata matches its bars', () => {
    expect(describeDatasetBundleProblem({ instrument, dataset: dataset(), bars })).toBeNull();
  });

  it('rejects a dataset that belongs to another instrument', () => {
    expect(describeDatasetBundleProblem({ instrument, dataset: dataset({ instrumentId: 'other' }), bars })).toContain(
      'does not belong',
    );
  });

  it('rejects an empty bundle', () => {
    expect(describeDatasetBundleProblem({ instrument, dataset: dataset({ rowCount: 0 }), bars: [] })).toContain(
      'no sessions',
    );
  });

  it('rejects a row count that does not match the bars', () => {
    expect(describeDatasetBundleProblem({ instrument, dataset: dataset({ rowCount: 3 }), bars })).toContain(
      'reports 3 rows',
    );
  });

  it('rejects a date range that does not match the first and last bars', () => {
    expect(describeDatasetBundleProblem({ instrument, dataset: dataset({ firstDate: '2024-01-01' }), bars })).toContain(
      'date range',
    );
  });

  it('rejects bars that are not in strict date order', () => {
    const outOfOrder: Bar[] = [
      bars[0] as Bar,
      { date: '2024-01-04', open: 2, high: 3, low: 1.5, close: 2.5, volume: 14 },
      bars[1] as Bar,
    ];
    expect(
      describeDatasetBundleProblem({ instrument, dataset: dataset({ rowCount: 3 }), bars: outOfOrder }),
    ).toContain('date order');
  });
});
