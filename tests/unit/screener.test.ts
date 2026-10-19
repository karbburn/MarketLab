import { describe, it, expect } from 'vitest';
import type {
  Bar,
  Dataset,
  Instrument,
  ScreenerDefinition,
  ScreenerFilter,
} from '../../src/domain/types';
import { computeField } from '../../src/lib/screener/fields';
import { evaluateScreener } from '../../src/lib/screener/evaluate';
import type { ScreenerInput } from '../../src/lib/screener/evaluate';

function barsFromCloses(closes: readonly number[]): Bar[] {
  return closes.map((close, index) => ({
    date: `2024-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000 + index,
  }));
}

function instrument(id: string, symbol: string): Instrument {
  return { id, symbol, displayName: symbol, assetType: 'equity', currency: 'USD' };
}

function dataset(id: string, instrumentId: string): Dataset {
  return {
    id,
    instrumentId,
    name: id,
    sourceKind: 'user-csv',
    sourceDescription: 'test fixture',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2024-01-01',
    lastDate: '2024-01-06',
    rowCount: 6,
    importedAt: '2024-01-06T00:00:00.000Z',
    contentHash: 'test-hash',
    hasVolume: true,
    validation: {
      acceptedRows: 6,
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

function filter(overrides: Partial<ScreenerFilter>): ScreenerFilter {
  return { id: 'f', field: 'close', operator: 'gt', value: 0, window: 1, ...overrides };
}

function definition(overrides: Partial<ScreenerDefinition>): ScreenerDefinition {
  return {
    id: 'def',
    name: 'test screener',
    schemaVersion: 1,
    universeDatasetIds: [],
    combinators: [],
    filters: [],
    cutoff: null,
    sortBy: 'symbol',
    sortDirection: 'asc',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ascending = barsFromCloses([10, 11, 12, 13, 14, 15]);

describe('computeField', () => {
  it('reads the last close and the previous close for the close field', () => {
    expect(computeField('close', 1, ascending)).toEqual({ current: 15, previous: 14 });
  });

  it('computes the window return at the last and previous bars', () => {
    const reading = computeField('return', 2, ascending);
    // last: 13 -> 15; previous: 12 -> 14
    expect(reading.current as number).toBeCloseTo((15 / 13 - 1) * 100, 10);
    expect(reading.previous as number).toBeCloseTo((14 / 12 - 1) * 100, 10);
  });

  it('computes the percentage distance from the SMA', () => {
    const reading = computeField('price-vs-sma', 3, ascending);
    // sma at 5 = (13+14+15)/3 = 14 -> (15-14)/14; sma at 4 = (12+13+14)/3 = 13
    expect(reading.current as number).toBeCloseTo((15 / 14 - 1) * 100, 10);
    expect(reading.previous as number).toBeCloseTo((14 / 13 - 1) * 100, 10);
  });

  it('reads the RSI at the last and previous bars', () => {
    const reading = computeField('rsi', 3, ascending);
    // A monotonically rising series has no losses, so RSI is 100.
    expect(reading.current).toBe(100);
    expect(reading.previous).toBe(100);
  });

  it('returns nulls when there are fewer than two bars', () => {
    expect(computeField('close', 1, [])).toEqual({ current: null, previous: null });
    expect(computeField('close', 1, barsFromCloses([10]))).toEqual({ current: null, previous: null });
  });
});

describe('evaluateScreener combinators', () => {
  const inputs: ScreenerInput[] = [
    { dataset: dataset('ds-a', 'inst-a'), instrument: instrument('inst-a', 'AAA'), bars: barsFromCloses([10, 11, 12, 13, 14, 15]) },
    { dataset: dataset('ds-b', 'inst-b'), instrument: instrument('inst-b', 'BBB'), bars: barsFromCloses([5, 5, 5, 5, 5, 5]) },
  ];
  const filters = [
    filter({ id: 'f1', field: 'close', operator: 'gt', value: 10 }),
    filter({ id: 'f2', field: 'close', operator: 'lt', value: 100 }),
  ];

  it('joins filters with AND by default semantics', () => {
    const result = evaluateScreener(definition({ filters, combinators: ['AND'] }), inputs);
    expect(result.evaluatedCount).toBe(2);
    expect(result.matchedCount).toBe(1);
    expect(result.rows.find((row) => row.symbol === 'AAA')?.passed).toBe(true);
    expect(result.rows.find((row) => row.symbol === 'BBB')?.passed).toBe(false);
  });

  it('joins filters with OR when the combinator says so', () => {
    const result = evaluateScreener(definition({ filters, combinators: ['OR'] }), inputs);
    expect(result.matchedCount).toBe(2);
  });
});

describe('evaluateScreener uncomputable fields', () => {
  it('treats a filter whose field cannot be computed as not matched', () => {
    const bars = barsFromCloses([10, 11]);
    const input: ScreenerInput = {
      dataset: dataset('ds', 'inst'),
      instrument: instrument('inst', 'SHORT'),
      bars,
    };
    const result = evaluateScreener(
      definition({ filters: [filter({ id: 'r', field: 'rsi', operator: 'gt', value: 0, window: 14 })] }),
      [input],
    );
    expect(result.matchedCount).toBe(0);
    expect(result.rows[0]?.values.rsi).toBeNull();
    expect(result.rows[0]?.passed).toBe(false);
  });
});

describe('evaluateScreener sorting', () => {
  const longSeries = barsFromCloses(Array.from({ length: 20 }, (_, i) => 10 + i));
  const shortSeries = barsFromCloses([10, 11]);
  const inputs: ScreenerInput[] = [
    { dataset: dataset('ds-b', 'inst-b'), instrument: instrument('inst-b', 'BBB'), bars: shortSeries },
    { dataset: dataset('ds-a', 'inst-a'), instrument: instrument('inst-a', 'AAA'), bars: longSeries },
  ];
  const def = definition({
    filters: [filter({ id: 'r', field: 'rsi', operator: 'gte', value: 0, window: 14 })],
    sortBy: 'rsi',
    sortDirection: 'asc',
  });

  it('puts rows with a null sort value last when ascending', () => {
    const result = evaluateScreener(def, inputs);
    expect(result.rows[0]?.symbol).toBe('AAA');
    expect(result.rows[0]?.values.rsi).not.toBeNull();
    expect(result.rows[1]?.symbol).toBe('BBB');
    expect(result.rows[1]?.values.rsi).toBeNull();
  });

  it('still puts rows with a null sort value last when descending', () => {
    const result = evaluateScreener({ ...def, sortDirection: 'desc' }, inputs);
    expect(result.rows[0]?.symbol).toBe('AAA');
    expect(result.rows[1]?.symbol).toBe('BBB');
    expect(result.rows[1]?.values.rsi).toBeNull();
  });

  it('computes the sort field even when it is not one of the filters', () => {
    const sortedInputs: ScreenerInput[] = [
      { dataset: dataset('ds-b', 'inst-b'), instrument: instrument('inst-b', 'BBB'), bars: barsFromCloses([10, 10, 10, 10, 10, 10]) },
      { dataset: dataset('ds-a', 'inst-a'), instrument: instrument('inst-a', 'AAA'), bars: barsFromCloses([10, 11, 12, 13, 14, 15]) },
    ];
    const result = evaluateScreener(
      definition({
        filters: [filter({ id: 'p', field: 'price-vs-sma', operator: 'gt', value: -100, window: 3 })],
        sortBy: 'return',
        sortDirection: 'desc',
      }),
      sortedInputs,
    );
    expect(result.rows[0]?.symbol).toBe('AAA');
    expect(result.rows[0]?.values.return).not.toBeUndefined();
    expect(result.rows[1]?.values.return).not.toBeUndefined();
  });
});
