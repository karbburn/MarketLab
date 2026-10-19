import { describe, expect, it } from 'vitest';
import type { Bar } from '../../src/domain/types';
import { WATCHLIST_CONTEXT_SESSIONS, watchlistContext } from '../../src/lib/watchlist-context';

function bar(
  date: string,
  close: number,
  high: number,
  low: number,
  volume: number | null,
): Bar {
  return { date, open: close, high, low, close, volume };
}

describe('watchlistContext', () => {
  it('uses only the trailing 30 sessions for volume and range', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 10; i += 1) {
      bars.push(bar(`2020-01-${String(i + 1).padStart(2, '0')}`, 999, 1000, 1, 999_999));
    }
    for (let i = 0; i < 30; i += 1) {
      bars.push(bar(`2020-02-${String(i + 1).padStart(2, '0')}`, 95 + i, 100 + i, 90 + i, 1000 + i));
    }

    const context = watchlistContext(bars);

    expect(context.sessions).toBe(WATCHLIST_CONTEXT_SESSIONS);
    expect(context.lastClose).toBe(124);
    expect(context.changePct).toBeCloseTo((1 / 123) * 100, 10);
    expect(context.averageVolume).toBe(1014.5);
    expect(context.volumeSessions).toBe(30);
    expect(context.low).toBe(90);
    expect(context.high).toBe(129);
    expect(context.rangePct).toBeCloseTo((39 / 90) * 100, 10);
  });

  it('uses all available sessions when history is shorter than the window', () => {
    const bars = [
      bar('2026-10-01', 10, 11, 9, 100),
      bar('2026-10-02', 12, 13, 10, 300),
    ];

    const context = watchlistContext(bars);

    expect(context.sessions).toBe(2);
    expect(context.lastClose).toBe(12);
    expect(context.changePct).toBeCloseTo(20, 10);
    expect(context.averageVolume).toBe(200);
    expect(context.volumeSessions).toBe(2);
    expect(context.low).toBe(9);
    expect(context.high).toBe(13);
    expect(context.rangePct).toBeCloseTo((4 / 9) * 100, 10);
  });

  it('averages reported volume without treating missing volume as zero', () => {
    const bars = [
      bar('2026-10-01', 10, 11, 9, null),
      bar('2026-10-02', 11, 12, 10, 300),
      bar('2026-10-03', 12, 13, 11, null),
    ];

    const context = watchlistContext(bars);

    expect(context.averageVolume).toBe(300);
    expect(context.volumeSessions).toBe(1);
  });

  it('reports no average when the window has no volume at all', () => {
    const context = watchlistContext([bar('2026-10-01', 10, 11, 9, null)]);

    expect(context.averageVolume).toBeNull();
    expect(context.volumeSessions).toBe(0);
    expect(context.low).toBe(9);
    expect(context.high).toBe(11);
  });

  it('returns placeholders for an empty series', () => {
    expect(watchlistContext([])).toEqual({
      lastClose: null,
      changePct: null,
      averageVolume: null,
      volumeSessions: 0,
      low: null,
      high: null,
      rangePct: null,
      sessions: 0,
    });
  });

  it('has a null change when there is no usable previous close', () => {
    const single = watchlistContext([bar('2026-10-01', 10, 11, 9, 100)]);
    const zeroPrevious = watchlistContext([
      bar('2026-10-01', 0, 0, 0, 100),
      bar('2026-10-02', 10, 11, 9, 100),
    ]);

    expect(single.changePct).toBeNull();
    expect(zeroPrevious.changePct).toBeNull();
  });

  it('ignores negative volume values rather than averaging them', () => {
    const bars = [
      bar('2026-10-01', 10, 11, 9, -5),
      bar('2026-10-02', 11, 12, 10, 200),
    ];

    const context = watchlistContext(bars);

    expect(context.averageVolume).toBe(200);
    expect(context.volumeSessions).toBe(1);
  });
});
