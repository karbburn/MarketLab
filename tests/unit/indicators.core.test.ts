import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  closes,
  ema,
  emaOfSeries,
  emptySeries,
  integerParam,
  numberParam,
  rollingExtreme,
  sma,
  smaOfSeries,
} from '../../src/lib/indicators/core';

function makeBar(open: number, high: number, low: number, close: number, volume: number | null = null): Bar {
  return { date: '2024-01-01', open, high, low, close, volume };
}

describe('sma', () => {
  it('leaves warm-up positions null and averages a full window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns an empty series for zero length input', () => {
    expect(sma([], 3)).toEqual([]);
  });

  it('returns all null for a non-positive period', () => {
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null]);
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first period observations then smooths', () => {
    // seed = mean(1, 3, 2) = 2; alpha = 2/4 = 0.5
    // i=3: 8*0.5 + 2*0.5 = 5
    // i=4: 5*0.5 + 5*0.5 = 5
    expect(ema([1, 3, 2, 8, 5], 3)).toEqual([null, null, 2, 5, 5]);
  });

  it('returns all null when there are fewer observations than the period', () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe('rollingExtreme', () => {
  const bars = [
    makeBar(2, 3, 1, 2.5),
    makeBar(4, 5, 2, 4.5),
    makeBar(3.5, 4, 0.5, 3),
    makeBar(5, 6, 2, 5.5),
  ];

  it('returns the rolling maximum high', () => {
    expect(rollingExtreme(bars, 2, 'high')).toEqual([null, 5, 5, 6]);
  });

  it('returns the rolling minimum low', () => {
    expect(rollingExtreme(bars, 2, 'low')).toEqual([null, 1, 0.5, 0.5]);
  });
});

describe('smaOfSeries', () => {
  it('propagates nulls inside a window instead of treating them as zero', () => {
    // window 0..1 -> contains null -> null
    // 2..3 -> (2+4)/2 = 3; 4..5 -> (4+6)/2 = 5
    // index 4 window [6, null] -> null; index 5 window [null, 10] -> null
    expect(smaOfSeries([null, 2, 4, 6, null, 10], 2)).toEqual([null, null, 3, 5, null, null]);
  });
});

describe('emaOfSeries', () => {
  it('starts from the first non-null value and skips null observations', () => {
    // first non-null at index 1, seed window 1..2 -> (1+2)/2 = 1.5; alpha = 2/3
    // i=3: 3*(2/3) + 1.5*(1/3) = 2.5
    // i=4: 4*(2/3) + 2.5*(1/3) = 3.5
    const result = emaOfSeries([null, 1, 2, 3, 4], 2);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(1.5, 10);
    expect(result[3]).toBeCloseTo(2.5, 10);
    expect(result[4]).toBeCloseTo(3.5, 10);
  });
});

describe('emptySeries / closes', () => {
  it('builds a fixed length all-null series', () => {
    expect(emptySeries(3)).toEqual([null, null, null]);
  });

  it('extracts closes in bar order', () => {
    const bars = [makeBar(1, 2, 0.5, 1.75), makeBar(2, 3, 1.5, 2.25)];
    expect(closes(bars)).toEqual([1.75, 2.25]);
  });
});

describe('integerParam', () => {
  it('uses the fallback when the value is missing or not finite', () => {
    expect(integerParam({}, 'period', 20)).toBe(20);
    expect(integerParam({ period: Number.NaN }, 'period', 20)).toBe(20);
    expect(integerParam({ period: Number.POSITIVE_INFINITY }, 'period', 20)).toBe(20);
  });

  it('clamps below the minimum and above the maximum', () => {
    expect(integerParam({ period: 0 }, 'period', 20, 2, 200)).toBe(2);
    expect(integerParam({ period: 1000 }, 'period', 20, 2, 200)).toBe(200);
  });

  it('rounds fractional values', () => {
    expect(integerParam({ period: 3.6 }, 'period', 20)).toBe(4);
    expect(integerParam({ period: 3.4 }, 'period', 20)).toBe(3);
  });
});

describe('numberParam', () => {
  it('uses the fallback and stays unrounded', () => {
    expect(numberParam({}, 'multiplier', 2, 0.1, 10)).toBe(2);
    expect(numberParam({ multiplier: 1.25 }, 'multiplier', 2, 0.1, 10)).toBe(1.25);
  });

  it('clamps to the declared bounds', () => {
    expect(numberParam({ multiplier: 0.05 }, 'multiplier', 2, 0.1, 10)).toBe(0.1);
    expect(numberParam({ multiplier: 99 }, 'multiplier', 2, 0.1, 10)).toBe(10);
  });

  it('falls back for non-finite values', () => {
    expect(numberParam({ multiplier: Number.NaN }, 'multiplier', 2, 0.1, 10)).toBe(2);
  });
});
