import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  alignOnCommonDates,
  correlationMatrix,
  normalisedPerformance,
} from '../../src/lib/quant/comparison';

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

  it('returns no values when the base close is zero', () => {
    expect(normalisedPerformance(['d1'], [0]).values).toEqual([]);
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

  it('returns null off-diagonal correlations when there are too few observations', () => {
    const matrix = correlationMatrix(['a', 'b'], [[1, 2], [3, 4]]);
    expect(matrix.values[0]?.[1]).toBeNull();
    expect(matrix.values[1]?.[0]).toBeNull();
    expect(matrix.values[0]?.[0]).toBe(1);
  });
});
