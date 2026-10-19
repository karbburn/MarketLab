import { describe, expect, it } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  alignOnCommonDates,
  normalisedPerformance,
  rebasedComparison,
  type ComparisonInputSeries,
} from '../../src/lib/quant/comparison';

function bars(dates: readonly string[], closes: readonly number[]): Bar[] {
  return dates.map((date, index) => {
    const close = closes[index] as number;
    return { date, open: close, high: close, low: close, close, volume: null };
  });
}

function series(key: string, dates: readonly string[], closes: readonly number[]): ComparisonInputSeries {
  return { key, label: key.toUpperCase(), bars: bars(dates, closes) };
}

function expectClose(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 10));
}

describe('rebasedComparison', () => {
  it('rebases different price levels to 100 so relative moves are comparable', () => {
    // A $40 stock and a $400 fund with identical percentage moves.
    const result = rebasedComparison([
      series('cheap', ['2024-01-02', '2024-01-03', '2024-01-04'], [40, 44, 36]),
      series('rich', ['2024-01-02', '2024-01-03', '2024-01-04'], [400, 440, 360]),
    ]);

    expect(result.status).toBe('ok');
    expect(result.baselineDate).toBe('2024-01-02');
    expectClose(result.series[0]?.values, [100, 110, 90]);
    expectClose(result.series[1]?.values, [100, 110, 90]);
  });

  it('computes the index as price / baseline * 100 with hand-checkable values', () => {
    const result = rebasedComparison([series('a', ['2024-02-01', '2024-02-02'], [250, 312.5])]);
    expect(result.series[0]?.values[0]).toBe(100);
    expect(result.series[0]?.values[1]).toBeCloseTo(125, 10);
  });

  it('aligns on actual dates and ignores array positions when start dates differ', () => {
    const result = rebasedComparison([
      series('a', ['2024-01-01', '2024-01-02', '2024-01-03'], [10, 11, 12]),
      series('b', ['2024-01-02', '2024-01-03', '2024-01-04'], [200, 220, 240]),
    ]);

    // Only the two shared dates survive; the first close of each is its own
    // baseline, not the other series' first observation.
    expect(result.dates).toEqual(['2024-01-02', '2024-01-03']);
    expect(result.baselineDate).toBe('2024-01-02');
    expectClose(result.series[0]?.values, [100, (12 / 11) * 100]);
    expectClose(result.series[1]?.values, [100, 110]);
  });

  it('drops sessions a series is missing instead of forward-filling them', () => {
    const result = rebasedComparison([
      series('a', ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'], [10, 11, 12, 13]),
      series('b', ['2024-01-01', '2024-01-03', '2024-01-04'], [20, 24, 26]),
    ]);

    expect(result.dates).toEqual(['2024-01-01', '2024-01-03', '2024-01-04']);
    expect(result.series[0]?.values).toEqual([100, 120, 130]);
    expect(result.series[1]?.values).toEqual([100, 120, 130]);
  });

  it('reports non-overlapping ranges explicitly and draws nothing', () => {
    const result = rebasedComparison([
      series('a', ['2024-01-01', '2024-01-02'], [10, 11]),
      series('b', ['2025-01-01', '2025-01-02'], [20, 21]),
    ]);

    expect(result.status).toBe('no-overlap');
    expect(result.dates).toEqual([]);
    expect(result.baselineDate).toBeNull();
    expect(result.series.every((entry) => entry.values.length === 0)).toBe(true);
  });

  it('reports insufficient shared history instead of drawing a single point', () => {
    const result = rebasedComparison([
      series('a', ['2024-01-01', '2024-01-02'], [10, 11]),
      series('b', ['2024-01-02', '2024-01-03'], [20, 21]),
    ]);

    expect(result.status).toBe('insufficient-history');
    expect(result.dates).toEqual(['2024-01-02']);
    expect(result.baselineDate).toBeNull();
    expect(result.series[0]?.values).toEqual([]);
  });

  it('honours a custom minimum session count', () => {
    const result = rebasedComparison(
      [series('a', ['2024-01-01', '2024-01-02'], [10, 11]), series('b', ['2024-01-01', '2024-01-02'], [20, 22])],
      { minSessions: 3 },
    );
    expect(result.status).toBe('insufficient-history');
  });

  it('returns no-series for an empty input', () => {
    expect(rebasedComparison([])).toEqual({
      status: 'no-series',
      dates: [],
      series: [],
      baselineDate: null,
      minSessions: 2,
    });
  });

  it('rejects a zero or negative baseline rather than dividing by it', () => {
    const zero = rebasedComparison([series('a', ['2024-01-02', '2024-01-03'], [0, 11])]);
    expect(zero.status).toBe('invalid-baseline');
    const negative = rebasedComparison([series('a', ['2024-01-02', '2024-01-03'], [-5, 11])]);
    expect(negative.status).toBe('invalid-baseline');
  });

  it('computes the baseline inside the window, never from earlier observations', () => {
    const input = [
      series('a', ['2024-01-01', '2024-01-02', '2024-01-03'], [50, 100, 110]),
      series('b', ['2024-01-01', '2024-01-02', '2024-01-03'], [200, 100, 95]),
    ];
    const full = rebasedComparison(input);
    expectClose(full.series[0]?.values, [100, 200, 220]);

    // Starting the comparison on 2024-01-02 must rebase to that close.
    const windowed = rebasedComparison(input, { from: '2024-01-02' });
    expect(windowed.baselineDate).toBe('2024-01-02');
    expectClose(windowed.series[0]?.values, [100, 110]);
    expectClose(windowed.series[1]?.values, [100, 95]);
  });

  it('treats the window bounds as inclusive', () => {
    const result = rebasedComparison([series('a', ['2024-01-01', '2024-01-02', '2024-01-03'], [10, 11, 12])], {
      from: '2024-01-02',
      to: '2024-01-02',
      minSessions: 1,
    });
    expect(result.dates).toEqual(['2024-01-02']);
    expect(result.series[0]?.values).toEqual([100]);
  });

  it('leaves the existing Quant Lab helpers unchanged', () => {
    // Regression guard: the shared-date alignment still intersects and the
    // Quant Lab percentage series still starts at zero.
    const aligned = alignOnCommonDates([bars(['2024-01-01', '2024-01-02'], [1, 2]), bars(['2024-01-02'], [20])]);
    expect(aligned.dates).toEqual(['2024-01-02']);
    const performance = normalisedPerformance(['2024-01-02', '2024-01-03'], [100, 90]);
    expect(performance.values[0]).toBe(0);
    expect(performance.values[1] as number).toBeCloseTo(-10, 10);
  });
});
