import { describe, expect, it } from 'vitest';
import { changePercent, hoverBars } from '../../src/lib/chart/readout';
import type { Bar } from '../../src/domain/types';

function bar(date: string, close: number): Bar {
  return { date: date as Bar['date'], open: close, high: close, low: close, close, volume: null };
}

const BARS = [bar('2026-10-12', 100), bar('2026-10-13', 102), bar('2026-10-14', 99), bar('2026-10-15', 105)];

describe('hoverBars', () => {
  it('reports no previous bar when the first bar is hovered', () => {
    const readout = hoverBars(BARS, 0);
    expect(readout.hoverBar?.date).toBe('2026-10-12');
    expect(readout.previousBar).toBeNull();
    expect(changePercent(readout.hoverBar, readout.previousBar)).toBeNull();
  });

  it('compares a hovered bar with the bar immediately before it', () => {
    const readout = hoverBars(BARS, 2);
    expect(readout.hoverBar?.close).toBe(99);
    expect(readout.previousBar?.close).toBe(102);
    expect(changePercent(readout.hoverBar, readout.previousBar)).toBeCloseTo(((99 - 102) / 102) * 100, 10);
  });

  it('follows the last two bars when nothing is hovered', () => {
    const readout = hoverBars(BARS, null);
    expect(readout.hoverBar?.date).toBe('2026-10-15');
    expect(readout.previousBar?.date).toBe('2026-10-14');
    expect(changePercent(readout.hoverBar, readout.previousBar)).toBeCloseTo(((105 - 99) / 99) * 100, 10);
  });

  it('has no readout for an empty series or an index past the end', () => {
    expect(hoverBars([], null)).toEqual({ hoverBar: null, previousBar: null });
    expect(hoverBars([bar('2026-10-15', 105)], 0).previousBar).toBeNull();
    expect(hoverBars(BARS, 99)).toEqual({ hoverBar: null, previousBar: null });
  });

  it('treats a zero previous close as an unknown change', () => {
    const zero = [bar('2026-10-14', 0), bar('2026-10-15', 105)];
    expect(changePercent(hoverBars(zero, 1).hoverBar, hoverBars(zero, 1).previousBar)).toBeNull();
  });
});
