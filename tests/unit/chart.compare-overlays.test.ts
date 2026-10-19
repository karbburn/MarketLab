import { describe, expect, it } from 'vitest';
import type { Bar, Dataset } from '../../src/domain/types';
import {
  COMPARISON_COLORS,
  COMPARISON_METHOD_NOTE,
  comparisonEligibility,
  comparisonLineStyle,
  prepareComparison,
  type ComparisonTarget,
} from '../../src/lib/chart/compare-overlays';

function bars(dates: readonly string[], closes: readonly number[]): Bar[] {
  return dates.map((date, index) => {
    const close = closes[index] as number;
    return { date, open: close, high: close, low: close, close, volume: 1000 };
  });
}

function dataset(id: string, frequency: Dataset['frequency'] = 'daily'): Dataset {
  return {
    id,
    instrumentId: `inst_${id}`,
    name: id,
    sourceKind: 'user-csv',
    sourceDescription: 'test',
    frequency,
    timezone: 'UTC',
    firstDate: '2024-01-01',
    lastDate: '2024-01-05',
    rowCount: 3,
    importedAt: '2024-01-01T00:00:00.000Z',
    contentHash: id,
    hasVolume: true,
    validation: {
      acceptedRows: 3,
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

function target(id: string, closes: readonly number[], frequency: Dataset['frequency'] = 'daily'): ComparisonTarget {
  return {
    datasetId: id,
    label: id.toUpperCase(),
    dataset: dataset(id, frequency),
    bars: bars(['2024-01-01', '2024-01-02', '2024-01-03'], closes),
  };
}

describe('prepareComparison', () => {
  it('draws the primary first and each comparison in a distinct colour and line style', () => {
    const result = prepareComparison({
      primary: target('aapl', [100, 110, 120]),
      candidates: [target('msft', [300, 330, 360]), target('qqq', [400, 400, 420])],
      timeframe: '1D',
    });

    expect(result.status).toBe('ok');
    expect(result.lines.map((line) => line.datasetId)).toEqual(['aapl', 'msft', 'qqq']);
    expect(result.lines.map((line) => line.primary)).toEqual([true, false, false]);
    expect(result.lines.map((line) => line.color)).toEqual(COMPARISON_COLORS.slice(0, 3));
    expect(new Set(result.lines.map((line) => line.lineStyle)).size).toBe(3);
    const primaryPoints = result.lines[0]?.points ?? [];
    expect(primaryPoints.map((point) => point.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    expect(primaryPoints[0]?.value).toBe(100);
    expect(primaryPoints[1]?.value).toBeCloseTo(110, 10);
    expect(primaryPoints[2]?.value).toBeCloseTo(120, 10);
  });

  it('states the baseline date and the method note', () => {
    const result = prepareComparison({
      primary: target('aapl', [100, 110, 120]),
      candidates: [target('msft', [300, 330, 360])],
      timeframe: '1D',
    });
    expect(result.baselineDate).toBe('2024-01-01');
    expect(result.message).toContain('2024-01-01');
    expect(result.methodNote).toBe(COMPARISON_METHOD_NOTE);
    expect(result.methodNote).toMatch(/first session shared/i);
    expect(result.methodNote).toMatch(/forward-filled/i);
  });

  it('excludes a lower-frequency series instead of stretching it onto a daily panel', () => {
    const weekly = target('weekly', [100, 101, 102], 'weekly');
    const result = prepareComparison({
      primary: target('aapl', [100, 110, 120]),
      candidates: [weekly],
      timeframe: '1D',
    });

    expect(result.lines.map((line) => line.datasetId)).toEqual(['aapl']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toMatch(/weekly/i);
  });

  it('aggregates daily comparisons to the panel timeframe', () => {
    const dates = [
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-08',
      '2024-01-09',
      '2024-01-10',
      '2024-01-11',
      '2024-01-12',
    ];
    const primary: ComparisonTarget = {
      ...target('aapl', [100]),
      bars: bars(dates, [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]),
    };
    const candidate: ComparisonTarget = {
      ...target('msft', [100]),
      bars: bars(dates, [200, 200, 200, 200, 200, 202, 202, 202, 202, 202]),
    };
    const result = prepareComparison({ primary, candidates: [candidate], timeframe: '1W' });

    expect(result.timeframe).toBe('1W');
    expect(result.status).toBe('ok');
    // Two Monday-based weeks, each dated by its last session.
    const primaryPoints = result.lines[0]?.points ?? [];
    const candidatePoints = result.lines[1]?.points ?? [];
    expect(primaryPoints.map((point) => point.date)).toEqual(['2024-01-05', '2024-01-12']);
    expect(primaryPoints[0]?.value).toBe(100);
    expect(primaryPoints[1]?.value).toBeCloseTo((190 / 140) * 100, 10);
    expect(candidatePoints.map((point) => point.date)).toEqual(['2024-01-05', '2024-01-12']);
    expect(candidatePoints[0]?.value).toBe(100);
    expect(candidatePoints[1]?.value).toBeCloseTo(101, 10);
  });

  it('reports an empty stored series instead of inventing one', () => {
    const empty: ComparisonTarget = { ...target('empty', []), bars: [] };
    const result = prepareComparison({
      primary: target('aapl', [100, 110, 120]),
      candidates: [empty],
      timeframe: '1D',
    });
    expect(result.excluded[0]?.reason).toMatch(/no stored sessions/i);
  });

  it('propagates a non-overlapping selection as a stated empty state', () => {
    const later: ComparisonTarget = {
      ...target('later', [10, 11, 12]),
      bars: bars(['2025-01-01', '2025-01-02', '2025-01-03'], [10, 11, 12]),
    };
    const result = prepareComparison({
      primary: target('aapl', [100, 110, 120]),
      candidates: [later],
      timeframe: '1D',
    });
    expect(result.status).toBe('no-overlap');
    expect(result.lines).toEqual([]);
    expect(result.message).toMatch(/no trading session is shared/i);
  });
});

describe('comparisonEligibility', () => {
  it('allows daily data on every panel timeframe', () => {
    expect(comparisonEligibility('daily', '1D').eligible).toBe(true);
    expect(comparisonEligibility('daily', '1W').eligible).toBe(true);
    expect(comparisonEligibility('daily', '1M').eligible).toBe(true);
  });

  it('allows weekly only on weekly and monthly only on monthly', () => {
    expect(comparisonEligibility('weekly', '1W').eligible).toBe(true);
    expect(comparisonEligibility('weekly', '1D').eligible).toBe(false);
    expect(comparisonEligibility('monthly', '1M').eligible).toBe(true);
    expect(comparisonEligibility('monthly', '1W').eligible).toBe(false);
  });

  it('cycles line styles so colour is not the only distinction', () => {
    const styles = [0, 1, 2, 3, 4].map(comparisonLineStyle);
    expect(styles[0]).toBe('solid');
    expect(styles[1]).toBe('dashed');
    expect(styles[4]).toBe('solid');
  });
});
