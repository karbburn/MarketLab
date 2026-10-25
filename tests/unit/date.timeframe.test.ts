import { describe, it, expect } from 'vitest';
import type { Bar, Dataset, Frequency } from '../../src/domain/types';
import {
  aggregateBars,
  availableTimeframes,
  barsForTimeframe,
  periodKeyForDate,
  resolveTimeframe,
  timeframeFrequency,
  timeframeLabel,
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

  it('accepts an ISO timestamp by its date prefix without converting zones', () => {
    expect(normaliseDate('2024-03-05T23:30:00-05:00')).toBe('2024-03-05');
    expect(normaliseDate('2024-03-05T00:00:00+10:00')).toBe('2024-03-05');
    expect(normaliseDate('2024-03-05 08:00:00')).toBe('2024-03-05');
  });

  it('rejects bare numbers and free-form dates instead of guessing', () => {
    expect(normaliseDate('5')).toBeNull();
    expect(normaliseDate('2024')).toBeNull();
    expect(normaliseDate('2024/03/05')).toBeNull();
    expect(normaliseDate('2024-2-3')).toBeNull();
    expect(normaliseDate('Mar 5, 2024')).toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(normaliseDate('2026-02-31')).toBeNull();
    expect(normaliseDate('2026-13-01')).toBeNull();
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

  it('matches the calendar-based reference implementation for every day 1990-2035', () => {
    // Guards the integer rewrite in weekKey: the key is a persisted/aggregation
    // identity, so it must not drift by a single day across year boundaries.
    const day = 86_400_000;
    let cursor = Date.UTC(1990, 0, 1);
    const end = Date.UTC(2035, 11, 31);
    while (cursor <= end) {
      const value = new Date(cursor).toISOString().slice(0, 10);
      const date = new Date(cursor);
      const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
      const monday = new Date(cursor - (weekday - 1) * day);
      const thursday = new Date(monday.getTime() + 3 * day);
      const year = thursday.getUTCFullYear();
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
      const firstThursday = new Date(jan4.getTime() + (4 - jan4Weekday) * day);
      const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * day));
      const expected = `${year}-W${String(week).padStart(2, '0')}`;
      if (weekKey(value) !== expected) {
        throw new Error(`weekKey(${value}) = ${weekKey(value)}, expected ${expected}`);
      }
      cursor += day;
    }
  });

  it('anchors ISO week 1 to the week containing January 4', () => {
    // These years start on Friday/Saturday, where anchoring to 1 January would
    // label every week one too high.
    expect(weekKey('2021-01-04')).toBe('2021-W01');
    expect(weekKey('2000-01-03')).toBe('2000-W01');
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
    expect(weekly[0]).toEqual({ date: '2024-01-05', open: 10, high: 16, low: 9, close: 15, volume: 1500, bucket: '2024-W01' });
    expect(weekly[1]).toEqual({ date: '2024-01-09', open: 15, high: 18, low: 14, close: 17, volume: 1300, bucket: '2024-W02' });
  });

  it('nulls the bucket volume when any input volume is null', () => {
    const weekly = aggregateBars(daily, '1W');
    expect(weekly[2]).toEqual({ date: '2024-01-16', open: 17, high: 20, low: 16, close: 19, volume: null, bucket: '2024-W03' });
  });

  it('returns a copy untouched for the daily timeframe', () => {
    const result = aggregateBars(daily, '1D');
    expect(result).toHaveLength(daily.length);
    expect(result[0]).toEqual(daily[0]);
    expect(result[0]).not.toBe(daily[0]);
  });

  it('sorts unordered input before bucketing', () => {
    const shuffled = [daily[4] as Bar, daily[0] as Bar, daily[2] as Bar, daily[1] as Bar, daily[3] as Bar, daily[8] as Bar, daily[5] as Bar, daily[6] as Bar, daily[7] as Bar];
    const weekly = aggregateBars(shuffled, '1W');
    expect(weekly.map((entry) => entry.date)).toEqual(['2024-01-05', '2024-01-09', '2024-01-16']);
    expect(weekly[0]).toEqual({ date: '2024-01-05', open: 10, high: 16, low: 9, close: 15, volume: 1500, bucket: '2024-W01' });
  });

  it('produces the same buckets from ordered and unordered input', () => {
    const shuffled = [daily[7] as Bar, daily[2] as Bar, daily[8] as Bar, daily[0] as Bar, daily[5] as Bar, daily[3] as Bar, daily[6] as Bar, daily[1] as Bar, daily[4] as Bar];
    expect(aggregateBars(shuffled, '1W')).toEqual(aggregateBars(daily, '1W'));
    expect(aggregateBars([...daily].reverse(), '1M')).toEqual(aggregateBars(daily, '1M'));
  });

  it('never mutates or sorts the caller-owned array, even when it is frozen', () => {
    const frozen = Object.freeze(daily.map((entry) => Object.freeze({ ...entry })));
    const weekly = aggregateBars(frozen, '1W');
    expect(weekly.map((entry) => entry.date)).toEqual(['2024-01-05', '2024-01-09', '2024-01-16']);
    // Aggregated bars are fresh objects; the stored sessions stay untouched.
    expect(weekly[0]).not.toBe(frozen[0]);
    expect(frozen[0]).toEqual(daily[0]);
  });
});

describe('timeframe availability', () => {
  it('never offers a timeframe that cannot actually be produced', () => {
    expect(availableTimeframes('daily')).toEqual(['1D', '1W', '1M']);
    expect(availableTimeframes('weekly')).toEqual(['1W']);
    expect(availableTimeframes('monthly')).toEqual(['1M']);
  });

  it('resolves a disallowed request down to the source frequency, never up', () => {
    expect(resolveTimeframe(dataset('weekly'), '1D')).toBe('1W');
    expect(resolveTimeframe(dataset('weekly'), '1M')).toBe('1W');
    expect(resolveTimeframe(dataset('monthly'), '1D')).toBe('1M');
    expect(resolveTimeframe(dataset('monthly'), '1W')).toBe('1M');
    expect(resolveTimeframe(dataset('daily'), '1M')).toBe('1M');
    expect(resolveTimeframe(dataset('daily'), '1W')).toBe('1W');
  });

  it('does not synthesise daily bars from weekly data', () => {
    const weeklyBars = [bar('2024-01-05', 10, 16, 9, 15, 1500)];
    const result = barsForTimeframe(weeklyBars, dataset('weekly'), '1D');
    expect(result).toHaveLength(1);
    // The resolved timeframe is still weekly, so the bar is tagged with the
    // week it covers while its OHLC values are passed through untouched.
    expect(result[0]).toEqual({ ...weeklyBars[0], bucket: '2024-W01' });
    expect(timeframeFrequency('1W')).toBe('weekly');
  });

  it('never returns weekly bars labelled as another timeframe', () => {
    const weeklyBars = [bar('2024-01-05', 10, 16, 9, 15, 1500)];
    const result = barsForTimeframe(weeklyBars, dataset('weekly'), '1M');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ...weeklyBars[0], bucket: '2024-W01' });
    expect(timeframeLabel('1M', 'weekly')).toBe('Weekly');
  });

  it('tags a stored weekly or monthly series with the period it covers', () => {
    const weekly = barsForTimeframe([bar('2024-01-05', 10, 16, 9, 15, 1500)], dataset('weekly'), '1W');
    expect(weekly[0]?.bucket).toBe('2024-W01');
    const monthly = barsForTimeframe([bar('2024-01-31', 10, 16, 9, 15, 1500)], dataset('monthly'), '1M');
    expect(monthly[0]?.bucket).toBe('2024-01');
    // Daily bars keep their session date as the alignment key.
    const daily = barsForTimeframe([bar('2024-01-05', 10, 16, 9, 15, 1500)], dataset('daily'), '1D');
    expect(daily[0]?.bucket).toBeUndefined();
  });

  it('reuses stored daily bars without copying when no bucket rewrite is needed', () => {
    const stored = Object.freeze([Object.freeze(bar('2024-01-05', 10, 16, 9, 15, 1500))]);
    const view = barsForTimeframe(stored, dataset('daily'), '1D');
    expect(view).toBe(stored);
    expect(view[0]?.bucket).toBeUndefined();
  });

  it('adds a period bucket without mutating the stored series', () => {
    const stored = [bar('2024-01-05', 10, 16, 9, 15, 1500)];
    const weekly = barsForTimeframe(stored, dataset('weekly'), '1W');
    expect(weekly[0]).toEqual({ ...stored[0], bucket: '2024-W01' });
    expect(weekly[0]).not.toBe(stored[0]);
    expect(stored[0]?.bucket).toBeUndefined();
  });
});

describe('periodKeyForDate', () => {
  it('derives the same keys aggregation writes, and none for daily', () => {
    // Friday and the Thursday of the same week share a key.
    expect(periodKeyForDate('2024-01-05', '1W')).toBe(periodKeyForDate('2024-01-04', '1W'));
    expect(periodKeyForDate('2024-01-05', '1W')).toBe('2024-W01');
    expect(periodKeyForDate('2024-02-14', '1M')).toBe('2024-02');
    expect(periodKeyForDate('2024-02-14', '1D')).toBeUndefined();
  });
});
