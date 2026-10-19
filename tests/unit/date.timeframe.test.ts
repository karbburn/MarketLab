import { describe, it, expect } from 'vitest';
import type { Bar, Dataset, Frequency } from '../../src/domain/types';
import {
  aggregateBars,
  availableTimeframes,
  barsForTimeframe,
  resolveTimeframe,
  timeframeFrequency,
} from '../../src/lib/timeframe';
import { normaliseDate, weekKey } from '../../src/lib/date';

function bar(date: string, open: number, high: number, low: number, close: number, volume: number | null): Bar {
  return { date, open, high, low, close, volume };
}

function dataset(frequency: Frequency): Dataset {
  return {
    id: 'ds',
    instrumentId: 'inst',
    name: 'test',
    sourceKind: 'bundled-sample',
    sourceDescription: 'test fixture',
    frequency,
    timezone: 'UTC',
    firstDate: '2024-01-01',
    lastDate: '2024-01-16',
    rowCount: 9,
    importedAt: '2024-01-16T00:00:00.000Z',
    contentHash: 'hash',
    hasVolume: true,
    validation: {
      acceptedRows: 9,
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

describe('normaliseDate', () => {
  it('accepts an ISO session date unchanged', () => {
    expect(normaliseDate('2024-03-05')).toBe('2024-03-05');
  });

  it('rejects an ambiguous numeric date where both parts are <= 12', () => {
    expect(normaliseDate('05/03/2024')).toBeNull();
  });

  it('accepts a numeric date once one part can only be the day', () => {
    expect(normaliseDate('13/03/2024')).toBe('2024-03-13');
    expect(normaliseDate('05/13/2024')).toBe('2024-05-13');
  });

  it('rejects empty and unparseable input', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate('   ')).toBeNull();
    expect(normaliseDate('not-a-date')).toBeNull();
  });
});

describe('weekKey', () => {
  it('buckets from Monday, so a Monday and the following Sunday share a key', () => {
    expect(weekKey('2024-01-01')).toBe('2024-W01');
    expect(weekKey('2024-01-07')).toBe('2024-W01');
  });

  it('advances to the next week on the following Monday', () => {
    expect(weekKey('2024-01-08')).toBe('2024-W02');
  });

  it('uses the ISO week-year for a Monday that falls in the next calendar year', () => {
    // Monday 2024-12-30 belongs to ISO week 2025-W01.
    expect(weekKey('2024-12-30')).toBe('2025-W01');
  });

  it('places a known Thursday in the expected week', () => {
    expect(weekKey('2024-02-29')).toBe('2024-W09');
  });
});

describe('aggregateBars weekly OHLCV invariants', () => {
  const daily: Bar[] = [
    bar('2024-01-01', 10, 12, 9, 11, 100),
    bar('2024-01-02', 11, 13, 10, 12, 200),
    bar('2024-01-03', 12, 14, 11, 13, 300),
    bar('2024-01-04', 13, 15, 12, 14, 400),
    bar('2024-01-05', 14, 16, 13, 15, 500),
    bar('2024-01-08', 15, 17, 14, 16, 600),
    bar('2024-01-09', 16, 18, 15, 17, 700),
    bar('2024-01-15', 17, 19, 16, 18, null),
    bar('2024-01-16', 18, 20, 17, 19, 100),
  ];

  it('buckets by Monday-based week and keeps the last session date', () => {
    const weekly = aggregateBars(daily, '1W');
    expect(weekly).toHaveLength(3);
    expect(weekly.map((entry) => entry.date)).toEqual(['2024-01-05', '2024-01-09', '2024-01-16']);
  });

  it('takes open from the first bar, high/low extremes, close from the last and sums volume', () => {
    const weekly = aggregateBars(daily, '1W');
    expect(weekly[0]).toEqual({ date: '2024-01-05', open: 10, high: 16, low: 9, close: 15, volume: 1500 });
    expect(weekly[1]).toEqual({ date: '2024-01-09', open: 15, high: 18, low: 14, close: 17, volume: 1300 });
  });

  it('nulls the bucket volume when any input volume is null', () => {
    const weekly = aggregateBars(daily, '1W');
    expect(weekly[2]).toEqual({ date: '2024-01-16', open: 17, high: 20, low: 16, close: 19, volume: null });
  });

  it('returns a copy untouched for the daily timeframe', () => {
    const result = aggregateBars(daily, '1D');
    expect(result).toHaveLength(daily.length);
    expect(result[0]).toEqual(daily[0]);
    expect(result[0]).not.toBe(daily[0]);
  });
});

describe('timeframe availability', () => {
  it('never offers a higher-frequency timeframe than the dataset provides', () => {
    expect(availableTimeframes('daily')).toEqual(['1D', '1W', '1M']);
    expect(availableTimeframes('weekly')).toEqual(['1W', '1M']);
    expect(availableTimeframes('monthly')).toEqual(['1M']);
  });

  it('resolves a disallowed request down to the source frequency, never up', () => {
    expect(resolveTimeframe(dataset('weekly'), '1D')).toBe('1W');
    expect(resolveTimeframe(dataset('monthly'), '1D')).toBe('1M');
    expect(resolveTimeframe(dataset('monthly'), '1W')).toBe('1M');
    expect(resolveTimeframe(dataset('daily'), '1M')).toBe('1M');
    expect(resolveTimeframe(dataset('daily'), '1W')).toBe('1W');
  });

  it('does not synthesise daily bars from weekly data', () => {
    const weeklyBars = [bar('2024-01-05', 10, 16, 9, 15, 1500)];
    const result = barsForTimeframe(weeklyBars, dataset('weekly'), '1D');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(weeklyBars[0]);
    expect(timeframeFrequency('1W')).toBe('weekly');
  });
});
