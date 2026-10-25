import { describe, expect, it } from 'vitest';
import type { Bar } from '../../src/domain/types';
import { createBarDateIndex } from '../../src/lib/chart/bar-date-index';

function bar(date: string): Bar {
  return { date, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

describe('createBarDateIndex', () => {
  it('maps every session date to its array position', () => {
    const bars = [bar('2024-01-02'), bar('2024-01-03'), bar('2024-01-04')];
    const index = createBarDateIndex(bars);
    expect(index.get('2024-01-02')).toBe(0);
    expect(index.get('2024-01-03')).toBe(1);
    expect(index.get('2024-01-04')).toBe(2);
  });

  it('keeps the first position when a date appears twice, matching findIndex', () => {
    const bars = [bar('2024-01-02'), bar('2024-01-02'), bar('2024-01-03')];
    expect(createBarDateIndex(bars).get('2024-01-02')).toBe(0);
  });

  it('leaves an unknown session undefined instead of snapping to a neighbour', () => {
    const index = createBarDateIndex([bar('2024-01-02'), bar('2024-01-04')]);
    expect(index.get('2024-01-03')).toBeUndefined();
    expect(index.get('2024-01-04')).toBe(1);
  });

  it('handles an empty series', () => {
    expect(createBarDateIndex([]).size).toBe(0);
  });
});
