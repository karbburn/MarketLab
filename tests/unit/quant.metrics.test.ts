import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  cagrPct,
  historicalCvarPct,
  historicalVarPct,
  maxDrawdownPct,
  sharpeRatio,
  simpleReturns,
  totalReturnPct,
} from '../../src/lib/quant/metrics';

function bar(date: string, close: number): Bar {
  return { date, open: close, high: close, low: close, close, volume: null };
}

function barsFromCloses(closes: readonly number[]): Bar[] {
  return closes.map((close, index) => bar(`2024-01-${String(index + 1).padStart(2, '0')}`, close));
}

describe('simpleReturns', () => {
  it('has one fewer value than the input and computes period-over-period returns', () => {
    const returns = simpleReturns([100, 110, 99]);
    expect(returns).toHaveLength(2);
    expect(returns[0] as number).toBeCloseTo(0.1, 10);
    expect(returns[1] as number).toBeCloseTo(-0.1, 10);
  });

  it('skips a step whose previous close is zero', () => {
    expect(simpleReturns([0, 5])).toHaveLength(0);
  });

  it('returns an empty list for a single observation', () => {
    expect(simpleReturns([42])).toEqual([]);
  });
});

describe('totalReturnPct', () => {
  it('is the first-to-last close change in percent', () => {
    expect(totalReturnPct(barsFromCloses([100, 120, 150])) as number).toBeCloseTo(50, 10);
  });

  it('returns null for an empty series', () => {
    expect(totalReturnPct([])).toBeNull();
  });
});

describe('maxDrawdownPct', () => {
  it('finds the worst peak-to-trough decline on a hand-built equity path', () => {
    // peaks: 100, 120, 120, 120; trough at 90 -> (90/120 - 1) * 100 = -25
    expect(maxDrawdownPct([100, 120, 90, 110]) as number).toBeCloseTo(-25, 10);
  });

  it('is zero for a monotonically rising equity path', () => {
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });

  it('returns null for an empty series', () => {
    expect(maxDrawdownPct([])).toBeNull();
  });
});

describe('cagrPct', () => {
  it('returns null for a span shorter than 30 days', () => {
    const bars = [bar('2024-01-01', 100), bar('2024-01-15', 110)];
    expect(cagrPct(bars)).toBeNull();
  });

  it('annualises a long span over calendar years', () => {
    // 2024 is a leap year: 366 days between the two dates.
    // years = 366 / 365.25; cagr = (2 ** (1 / years) - 1) * 100 = 99.7161
    const bars = [bar('2024-01-01', 100), bar('2025-01-01', 200)];
    expect(cagrPct(bars) as number).toBeCloseTo(99.716, 2);
  });
});

describe('sharpeRatio', () => {
  it('returns null when the return volatility is zero', () => {
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBeNull();
  });

  it('returns null when there are not enough observations', () => {
    expect(sharpeRatio([])).toBeNull();
  });

  it('is positive for a steadily positive return stream', () => {
    const returns = [0.01, 0.012, 0.008, 0.015, 0.011];
    expect(sharpeRatio(returns) as number).toBeGreaterThan(0);
  });
});

describe('historical VaR and CVaR', () => {
  // 20 observations sorted ascending: -0.10, -0.06, then 18 zeros.
  const twenty = [-0.1, -0.06, ...Array.from({ length: 18 }, () => 0)];
  const nineteen = twenty.slice(0, 19);

  it('requires at least 20 observations', () => {
    expect(historicalVarPct(nineteen)).toBeNull();
    expect(historicalCvarPct(nineteen)).toBeNull();
    expect(historicalVarPct(twenty)).not.toBeNull();
    expect(historicalCvarPct(twenty)).not.toBeNull();
  });

  it('computes the 95 percent historical VaR as an interpolated quantile loss', () => {
    // position = 19 * 0.05 = 0.95 -> -0.10 + 0.04 * 0.95 = -0.062 -> loss 6.2 percent
    expect(historicalVarPct(twenty) as number).toBeCloseTo(6.2, 5);
  });

  it('computes CVaR as the mean of the tail at or below the VaR threshold', () => {
    // tail <= -0.062 contains only -0.10 -> loss 10 percent
    expect(historicalCvarPct(twenty) as number).toBeCloseTo(10, 5);
  });
});
