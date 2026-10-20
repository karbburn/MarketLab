import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  alignOnCommonDates,
  correlationMatrix,
  normalisedPerformance,
  rollingVolatilityPct,
} from '../../src/lib/quant/comparison';
import { aggregateBars } from '../../src/lib/timeframe';

function bars(dates: readonly string[], closes: readonly number[]): Bar[] {
  return dates.map((date, index) => {
    const close = closes[index] as number;
    return { date, open: close, high: close, low: close, close, volume: null };
  });
}

describe('alignOnCommonDates', () => {
  const seriesA = bars(['2024-01-01', '2024-01-02', '2024-01-03'], [1, 2, 3]);
  const seriesB = bars(['2024-01-02', '2024-01-03', '2024-01-04'], [20, 30, 40]);

  it('keeps only the dates every series provides and never forward-fills', () => {
    const aligned = alignOnCommonDates([seriesA, seriesB]);
    expect(aligned.dates).toEqual(['2024-01-02', '2024-01-03']);
    expect(aligned.closes[0]).toEqual([2, 3]);
    expect(aligned.closes[1]).toEqual([20, 30]);
  });

  it('produces an empty alignment when there is no overlap', () => {
    const other = bars(['2025-01-01'], [99]);
    const aligned = alignOnCommonDates([seriesA, other]);
    expect(aligned.dates).toEqual([]);
    expect(aligned.closes[0]).toEqual([]);
    expect(aligned.closes[1]).toEqual([]);
  });

  it('returns an empty result for no series at all', () => {
    expect(alignOnCommonDates([])).toEqual({ dates: [], closes: [] });
  });
});

describe('normalisedPerformance', () => {
  it('starts at zero and is the percentage change from the first close', () => {
    const result = normalisedPerformance(['d1', 'd2', 'd3'], [100, 110, 90]);
    expect(result.dates).toEqual(['d1', 'd2', 'd3']);
    expect(result.values[0]).toBe(0);
    expect(result.values[1] as number).toBeCloseTo(10, 10);
    expect(result.values[2] as number).toBeCloseTo(-10, 10);
  });

  it('returns no dates or values when the base close is not positive', () => {
    expect(normalisedPerformance(['d1', 'd2'], [0, 5])).toEqual({ dates: [], values: [] });
    expect(normalisedPerformance(['d1', 'd2'], [-1, 5])).toEqual({ dates: [], values: [] });
  });
});

describe('correlationMatrix', () => {
  it('has a diagonal of 1 and is symmetric', () => {
    const x = [100, 110, 132, 171.6];
    const y = [100, 90, 72, 50.4];
    const matrix = correlationMatrix(['x', 'y'], [x, y]);
    expect(matrix.labels).toEqual(['x', 'y']);
    expect(matrix.values[0]?.[0]).toBe(1);
    expect(matrix.values[1]?.[1]).toBe(1);
    // The two series are constructed so their returns are exact negatives.
    expect(matrix.values[0]?.[1] as number).toBeCloseTo(-1, 6);
    expect(matrix.values[1]?.[0]).toBe(matrix.values[0]?.[1]);
  });

  it('withholds self-correlation when the series cannot produce it', () => {
    const matrix = correlationMatrix(['a', 'b'], [[1, 2], [3, 4]]);
    expect(matrix.values[0]?.[1]).toBeNull();
    expect(matrix.values[1]?.[0]).toBeNull();
    expect(matrix.values[0]?.[0]).toBeNull();
    expect(matrix.values[1]?.[1]).toBeNull();
  });

  it('withholds the diagonal for a constant series but keeps it for a varying one', () => {
    const constant = [10, 10, 10, 10];
    const varying = [100, 110, 121, 133.1];
    const matrix = correlationMatrix(['constant', 'varying'], [constant, varying]);
    expect(matrix.values[0]?.[0]).toBeNull();
    expect(matrix.values[1]?.[1]).toBeCloseTo(1, 10);
  });
});

describe('rolling volatility alignment and frequency', () => {
  // returns [0.1, -0.1, 0.1]; with window 2 every interior window has sample sd sqrt(0.02).
  const dates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'];

  it('labels each rolling value with the end of the window it was computed from', () => {
    const points = rollingVolatilityPct(dates, [100, 110, 99, 108.9], 2, 'daily');
    expect(points[0]?.value).toBeNull();
    expect(points[1]?.value).toBeNull();
    expect(points[2]?.date).toBe('2024-01-03');
    expect(points[2]?.value as number).toBeCloseTo(Math.sqrt(0.02 * 252) * 100, 5);
    expect(points[3]?.date).toBe('2024-01-04');
    expect(points[3]?.value as number).toBeCloseTo(Math.sqrt(0.02 * 252) * 100, 5);
  });

  it('annualises the rolling window with the dataset frequency', () => {
    const points = rollingVolatilityPct(dates, [100, 110, 99, 108.9], 2, 'weekly');
    expect(points[2]?.value as number).toBeCloseTo(Math.sqrt(0.02 * 52) * 100, 8);
  });

  it('returns null slots instead of a shifted series when a step is unusable', () => {
    const points = rollingVolatilityPct(dates, [10, 11, 0, 12], 2, 'daily');
    expect(points[2]?.date).toBe('2024-01-03');
    expect(points[2]?.value as number).toBeCloseTo(Math.sqrt(0.605 * 252) * 100, 8);
    expect(points[3]?.date).toBe('2024-01-04');
    expect(points[3]?.value).toBeNull();
  });

  it('withholds rolling volatility when the window cannot produce a sample deviation', () => {
    expect(rollingVolatilityPct(dates, [100, 110, 99, 108.9], 1, 'daily').every((point) => point.value === null)).toBe(true);
    expect(rollingVolatilityPct(dates, [100, 110, 99, 108.9], 99, 'daily').every((point) => point.value === null)).toBe(true);
    expect(rollingVolatilityPct([], [], 2, 'daily')).toEqual([]);
  });
});

describe('alignOnCommonDates with aggregated buckets', () => {
  it('aligns week/month bars on the period key while labelling with real session dates', () => {
    const primary = aggregateBars(bars(['2024-01-01', '2024-01-02', '2024-01-05'], [100, 101, 104]), '1W');
    const candidate = aggregateBars(bars(['2024-01-02', '2024-01-04'], [200, 202]), '1W');
    // Both series cover ISO week 2024-W01 even though their last sessions differ.
    expect(primary[0]?.bucket).toBe('2024-W01');
    expect(candidate[0]?.bucket).toBe('2024-W01');
    const aligned = alignOnCommonDates([primary, candidate]);
    expect(aligned.dates).toEqual(['2024-01-05']);
    expect(aligned.closes).toEqual([[104], [202]]);
  });
});




