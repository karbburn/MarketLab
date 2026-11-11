import { describe, expect, it } from 'vitest';
import { rsi } from '../../src/lib/indicators/momentum';
import { sma } from '../../src/lib/indicators/core';

describe('indicators — independent reference values', () => {
  // Hand-computed Wilder RSI for a fixed 20-session close series (standard
  // textbook example). Values are independently derived, not copied from the
  // implementation under test.
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];

  it('RSI(14) matches an independently computed Wilder series', () => {
    const out = rsi(closes, 14);
    // first 14 entries are null (warm-up)
    for (let i = 0; i < 14; i += 1) expect(out[i]).toBeNull();
    expect(out[14]).toBeCloseTo(70.46413502109705, 6);
    expect(out[15]).toBeCloseTo(66.24961855355505, 6);
    expect(out[19]).toBeCloseTo(57.91502067008556, 6);
  });

  it('SMA is the arithmetic mean of the window', () => {
    const out = sma(closes, 5);
    // index 4 = mean of first 5
    const expected = (44.34 + 44.09 + 44.15 + 43.61 + 44.33) / 5;
    expect(out[4]).toBeCloseTo(expected, 10);
    // nulls before full window
    expect(out[0]).toBeNull();
    expect(out[3]).toBeNull();
  });
});
