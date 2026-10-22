import { describe, expect, it } from 'vitest';
import type { Bar } from '../../src/domain/types';
import { linkedBarForCrosshair } from '../../src/lib/chart/crosshair-link';

function bar(date: string, close: number, bucket?: string): Bar {
  return { date, open: close, high: close, low: close, close, volume: 1_000, ...(bucket ? { bucket } : {}) };
}

const daily = [
  bar('2024-01-03', 10),
  bar('2024-01-04', 11),
  bar('2024-01-05', 12),
  bar('2024-01-08', 13),
];

describe('linkedBarForCrosshair', () => {
  it('matches the exact session on a daily panel', () => {
    expect(linkedBarForCrosshair(daily, '2024-01-04', '1D')?.close).toBe(11);
  });

  it('returns null when a daily series did not trade that session', () => {
    // 2024-01-06 is a Saturday: the nearest sessions are Friday and Monday, and
    // neither is a substitute for the session the other panel is showing.
    expect(linkedBarForCrosshair(daily, '2024-01-06', '1D')).toBeNull();
    // A real session the panel simply has no bar for is also absent, not snapped.
    expect(linkedBarForCrosshair(daily, '2024-01-09', '1D')).toBeNull();
  });

  it('maps a daily session into the containing week of a weekly panel', () => {
    // The weekly bar ends on Thursday while the source session is Friday; both
    // belong to the same ISO week.
    const weekly = [bar('2024-01-04', 11, '2024-W01'), bar('2024-01-11', 13, '2024-W02')];
    expect(linkedBarForCrosshair(weekly, '2024-01-05', '1W')?.date).toBe('2024-01-04');
    expect(linkedBarForCrosshair(weekly, '2024-01-09', '1W')?.date).toBe('2024-01-11');
  });

  it('aligns a weekly source with a weekly panel that ends the week on another session', () => {
    const target = [bar('2024-01-04', 11), bar('2024-01-11', 13)];
    // Source weekly bar is dated Friday 2024-01-05; the target's bar for the same
    // week is dated Thursday 2024-01-04.
    expect(linkedBarForCrosshair(target, '2024-01-05', '1W')?.date).toBe('2024-01-04');
  });

  it('maps a daily session into the containing month of a monthly panel', () => {
    const monthly = [bar('2024-01-31', 12, '2024-01'), bar('2024-02-29', 15, '2024-02')];
    expect(linkedBarForCrosshair(monthly, '2024-02-14', '1M')?.date).toBe('2024-02-29');
    expect(linkedBarForCrosshair(monthly, '2024-01-02', '1M')?.date).toBe('2024-01-31');
  });

  it('maps a weekly source into a daily panel by its exact session only', () => {
    expect(linkedBarForCrosshair(daily, '2024-01-05', '1D')?.close).toBe(12);
    // The weekly bar's session date is not in the daily series: no substitute.
    expect(linkedBarForCrosshair(daily, '2024-01-12', '1D')).toBeNull();
  });

  it('shows nothing without a source session or without bars', () => {
    expect(linkedBarForCrosshair(daily, null, '1D')).toBeNull();
    expect(linkedBarForCrosshair([], '2024-01-04', '1D')).toBeNull();
    expect(linkedBarForCrosshair([], '2024-01-04', '1W')).toBeNull();
  });

  it('derives the target period from the bar date when a native bar has no bucket', () => {
    const nativeWeekly = [bar('2024-01-05', 12), bar('2024-01-12', 14)];
    expect(linkedBarForCrosshair(nativeWeekly, '2024-01-09', '1W')?.date).toBe('2024-01-12');
  });
});
