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

function dataset(id: string, instrumentId: string, frequency: Dataset['frequency'] = 'daily'): Dataset {
  return {
    id,
    instrumentId,
    name: id,
    sourceKind: 'user-csv',
    sourceDescription: 'test fixture',
    frequency,
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
    sortWindow: 20,
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

  it('reads the previous value from the same series it computed for the current value', () => {
    const series = barsFromCloses(Array.from({ length: 24 }, (_, index) => 100 + (index % 5) * 3 - index));
    for (const field of ['return', 'price-vs-sma', 'price-vs-ema', 'rsi', 'volatility', 'max-drawdown', 'relative-volume'] as const) {
      const full = computeField(field, 5, series);
      const earlier = computeField(field, 5, series.slice(0, -1));
      expect(full.previous, field).toBe(earlier.current);
    }
  });

  it('computes relative volume against the volume SMA and nulls it without volume', () => {
    // Volumes 1000..1004; the window-2 baseline at the last bar is (1002+1003)/2.
    const reading = computeField('relative-volume', 2, barsFromCloses([10, 11, 12, 13, 14]));
    expect(reading.current as number).toBeCloseTo(1004 / ((1003 + 1004) / 2), 10);
    const noVolume = barsFromCloses([10, 11, 12]).map((bar) => ({ ...bar, volume: null }));
    expect(computeField('relative-volume', 2, noVolume).current).toBeNull();
  });
});

describe('evaluateScreener cutoff', () => {
  it('evaluates only sessions up to the cutoff without mutating the stored bars', () => {
    const bars = barsFromCloses([10, 20, 30, 40]);
    const input: ScreenerInput = {
      dataset: dataset('ds', 'inst'),
      instrument: instrument('inst', 'CUT'),
      bars,
    };
    const result = evaluateScreener(
      definition({
        cutoff: '2024-01-02',
        filters: [filter({ id: 'c', field: 'close', operator: 'gt', value: 15 })],
      }),
      [input],
    );
    expect(result.rows[0]?.asOf).toBe('2024-01-02');
    expect(result.rows[0]?.values.close).toBe(20);
    expect(result.rows[0]?.passed).toBe(true);
    // The input remains the complete stored series.
    expect(input.bars.map((bar) => bar.close)).toEqual([10, 20, 30, 40]);
  });

  it('uses one reading when a filter and the sort field share a field and window', () => {
    const inputs: ScreenerInput[] = [
      { dataset: dataset('ds-a', 'inst-a'), instrument: instrument('inst-a', 'AAA'), bars: barsFromCloses(Array.from({ length: 20 }, (_, i) => 10 + i)) },
      { dataset: dataset('ds-b', 'inst-b'), instrument: instrument('inst-b', 'BBB'), bars: barsFromCloses(Array.from({ length: 20 }, (_, i) => 40 - i)) },
    ];
    const shared = definition({
      filters: [filter({ id: 'r', field: 'return', operator: 'gt', value: -1000, window: 5 })],
      sortBy: 'return',
      sortWindow: 5,
      sortDirection: 'desc',
    });
    const result = evaluateScreener(shared, inputs);
    // AAA rises over five sessions, BBB falls.
    expect(result.rows.map((row) => row.symbol)).toEqual(['AAA', 'BBB']);
    for (const input of inputs) {
      const row = result.rows.find((entry) => entry.symbol === input.instrument.symbol);
      const expected = computeField('return', 5, input.bars).current;
      expect(row?.values.return).toBe(expected);
      expect(row?.sortValue).toBe(expected);
    }
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
    sortWindow: 14,
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
        sortWindow: 5,
        sortDirection: 'desc',
      }),
      sortedInputs,
    );
    expect(result.rows[0]?.symbol).toBe('AAA');
    expect(result.rows[0]?.values.return).not.toBeUndefined();
    expect(result.rows[1]?.values.return).not.toBeUndefined();
  });
});

describe('screener frequency handling', () => {
  const bars = barsFromCloses([100, 110, 99, 108.9]);

  it('annualises the volatility field with the dataset frequency', () => {
    const daily = computeField('volatility', 2, bars, 'daily').current as number;
    const weekly = computeField('volatility', 2, bars, 'weekly').current as number;
    // Window closes [110, 99, 108.9] -> returns [-0.1, 0.1] -> sd sqrt(0.02).
    expect(daily).toBeCloseTo(Math.sqrt(0.02 * 252) * 100, 8);
    expect(weekly).toBeCloseTo(Math.sqrt(0.02 * 52) * 100, 8);
    expect(weekly).toBeCloseTo(daily * Math.sqrt(52 / 252), 8);
  });

  it('passes the dataset frequency into filter evaluation', () => {
    const weekly = dataset('ds-weekly', 'i1', 'weekly');
    const daily = dataset('ds-daily', 'i1', 'daily');
    const def = definition({
      universeDatasetIds: ['ds-weekly'],
      filters: [filter({ field: 'volatility', operator: 'lt', value: 150, window: 2 })],
    });
    const instrumentOne = instrument('i1', 'AAA');
    expect(evaluateScreener(def, [{ dataset: weekly, instrument: instrumentOne, bars }]).rows[0]?.passed).toBe(true);
    expect(evaluateScreener(def, [{ dataset: daily, instrument: instrumentOne, bars }]).rows[0]?.passed).toBe(false);
  });
});

describe('screener sort window', () => {
  const inputs: ScreenerInput[] = [
    { dataset: dataset('ds-a', 'inst-a'), instrument: instrument('inst-a', 'AAA'), bars: barsFromCloses([10, 30, 31]) },
    { dataset: dataset('ds-b', 'inst-b'), instrument: instrument('inst-b', 'BBB'), bars: barsFromCloses([10, 12, 25]) },
  ];
  const base = definition({
    filters: [filter({ field: 'price-vs-sma', operator: 'gt', value: -100, window: 2 })],
    sortBy: 'return',
    sortWindow: 1,
    sortDirection: 'desc',
  });

  it('orders by the sort window rather than a same-field filter window', () => {
    expect(evaluateScreener(base, inputs).rows.map((row) => row.symbol)).toEqual(['BBB', 'AAA']);
    expect(evaluateScreener({ ...base, sortWindow: 2 }, inputs).rows.map((row) => row.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('keeps ordering independent of filter windows', () => {
    const wideFilter = {
      ...base,
      filters: [filter({ field: 'price-vs-sma', operator: 'gt', value: -100, window: 50 })],
    };
    expect(evaluateScreener(wideFilter, inputs).rows.map((row) => row.symbol)).toEqual(['BBB', 'AAA']);
  });

  it('keeps the sort value separate from a same-field filter value', () => {
    const sameField = {
      ...base,
      filters: [filter({ field: 'return', operator: 'gt', value: -100, window: 2 })],
    };
    const result = evaluateScreener(sameField, inputs);
    expect(result.rows[0]?.symbol).toBe('BBB');
    expect(result.rows[0]?.values.return as number).toBeCloseTo(150, 5);
    expect(result.rows[0]?.sortValue as number).toBeCloseTo(108.333333, 5);
  });
});
