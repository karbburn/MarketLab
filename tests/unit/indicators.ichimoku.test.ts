import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import { ichimoku, indicatorIchimoku } from '../../src/lib/indicators/ichimoku';

function makeBar(index: number, open: number, high: number, low: number, close: number): Bar {
  return { date: `2024-01-${String(index + 1).padStart(2, '0')}`, open, high, low, close, volume: 1000 };
}

// conversion = base = span = 1, displacement = 2 makes every raw line equal
// (high + low) / 2, so displacement behaviour is easy to verify by hand.
const bars = [
  makeBar(0, 8, 10, 6, 8), // raw 8
  makeBar(1, 9, 12, 7, 9), // raw 9.5
  makeBar(2, 10, 11, 8, 10), // raw 9.5
  makeBar(3, 11, 14, 9, 13), // raw 11.5
  makeBar(4, 12, 13, 10, 12), // raw 11.5
  makeBar(5, 13, 15, 11, 14), // raw 13
];

describe('ichimoku', () => {
  it('computes conversion and base from the window midpoint', () => {
    const result = ichimoku(bars, 1, 1, 1, 2);
    expect(result.conversion).toEqual([8, 9.5, 9.5, 11.5, 11.5, 13]);
    expect(result.base).toEqual([8, 9.5, 9.5, 11.5, 11.5, 13]);
  });

  it('displaces the leading spans forward by the displacement', () => {
    const result = ichimoku(bars, 1, 1, 1, 2);
    // spanA[i] = raw[i - 2] for i >= 2, null before that.
    expect(result.spanA).toEqual([null, null, 8, 9.5, 9.5, 11.5]);
    expect(result.spanB).toEqual([null, null, 8, 9.5, 9.5, 11.5]);
  });

  it('sets the lagging span to the close `displacement` bars ahead', () => {
    const result = ichimoku(bars, 1, 1, 1, 2);
    expect(result.lagging).toEqual([10, 13, 12, 14, null, null]);
  });

  it('never wraps out-of-range values; they stay null', () => {
    const result = ichimoku(bars, 1, 1, 1, 2);
    expect(result.spanA[0]).toBeNull();
    expect(result.spanA[1]).toBeNull();
    expect(result.lagging[4]).toBeNull();
    expect(result.lagging[5]).toBeNull();
  });

  it('is exposed through the indicator definition with every declared output', () => {
    const outputs = indicatorIchimoku.calculate(bars, {
      conversion: 1,
      base: 1,
      span: 1,
      displacement: 2,
    });
    expect(outputs.conversion).toHaveLength(bars.length);
    expect(outputs.base).toHaveLength(bars.length);
    expect(outputs.spanA).toHaveLength(bars.length);
    expect(outputs.spanB).toHaveLength(bars.length);
    expect(outputs.lagging).toHaveLength(bars.length);
    expect(outputs.lagging?.[0]).toBe(10);
  });
});
