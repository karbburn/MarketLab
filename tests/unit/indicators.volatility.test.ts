import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import { adx, atr, indicatorAdx, indicatorAtr, trueRange } from '../../src/lib/indicators/volatility';

function makeBar(index: number, open: number, high: number, low: number, close: number): Bar {
  return { date: `2024-01-${String(index + 1).padStart(2, '0')}`, open, high, low, close, volume: 1000 };
}

describe('trueRange', () => {
  it('uses high - low for the first bar', () => {
    const bars = [makeBar(0, 9, 10, 8, 9)];
    expect(trueRange(bars)[0]).toBe(2);
  });

  it('uses the largest of the three candidate ranges from the second bar', () => {
    const bars = [
      makeBar(0, 9, 10, 8, 9),
      makeBar(1, 10.5, 11, 7, 10.5), // max(|11-9|=2, |7-9|=2, 4) = 4
      makeBar(2, 11, 12, 11, 11.5), // prevClose 10.5 -> max(1, 1.5, 0.5) = 1.5
    ];
    expect(trueRange(bars)).toEqual([2, 4, 1.5]);
  });
});

describe('atr', () => {
  it('seeds with the mean true range and smooths with Wilder factors', () => {
    const bars = [
      makeBar(0, 9, 10, 8, 9),
      makeBar(1, 10.5, 11, 7, 10.5),
      makeBar(2, 11, 12, 11, 11.5),
    ];
    // tr = [2, 4, 1.5]; seed at index 1 = (2+4)/2 = 3; index 2 = (3*1 + 1.5)/2 = 2.25
    const output = atr(bars, 2);
    expect(output[0]).toBeNull();
    expect(output[1] as number).toBeCloseTo(3, 10);
    expect(output[2] as number).toBeCloseTo(2.25, 10);
  });

  it('is exposed through the indicator definition', () => {
    const bars = Array.from({ length: 6 }, (_, i) => makeBar(i, 10, 11 + i, 9 - i, 10.5));
    const outputs = indicatorAtr.calculate(bars, { period: 3 });
    expect(outputs.atr).toHaveLength(6);
    expect(outputs.atr?.[2]).not.toBeNull();
    expect(outputs.atr?.[1]).toBeNull();
  });
});

describe('adx', () => {
  const bars = Array.from({ length: 15 }, (_, i) => {
    const close = 100 + i * 1.5;
    const high = close + 2 + (i % 3);
    const low = close - 2 - (i % 2);
    return makeBar(i, close, high, low, close);
  });

  it('produces three series of the input length', () => {
    const result = adx(bars, 3);
    expect(result.adx).toHaveLength(15);
    expect(result.plusDi).toHaveLength(15);
    expect(result.minusDi).toHaveLength(15);
  });

  it('starts +DI/-DI at the period index and ADX at 2 * period - 1', () => {
    const result = adx(bars, 3);
    expect(result.plusDi[2]).toBeNull();
    expect(result.plusDi[3]).not.toBeNull();
    expect(result.adx[4]).toBeNull();
    expect(result.adx[5]).not.toBeNull();
  });

  it('keeps every defined ADX, +DI and -DI value non-negative', () => {
    const result = adx(bars, 3);
    for (const series of [result.adx, result.plusDi, result.minusDi]) {
      for (const value of series) {
        if (value != null) expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is exposed through the indicator definition', () => {
    const outputs = indicatorAdx.calculate(bars, { period: 3 });
    expect(outputs.adx).toHaveLength(15);
    expect(outputs.plusDi).toHaveLength(15);
    expect(outputs.minusDi).toHaveLength(15);
  });
});
