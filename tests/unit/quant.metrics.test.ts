import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  annualisedReturnPct,
  annualisedVolatilityPct,
  betaAlpha,
  cagrPct,
  downsideDeviation,
  historicalCvarPct,
  historicalVarPct,
  maxDrawdownPct,
  periodsPerYear,
  sharpeRatio,
  simpleReturns,
  summarise,
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

  it('keeps a step whose previous close is zero as an unusable null slot', () => {
    // Length is preserved so returns stay positionally aligned with dates.
    expect(simpleReturns([0, 5])).toEqual([null]);
    expect(simpleReturns([10, 0, 11])).toEqual([-1, null]);
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

describe('downsideDeviation', () => {
  it('is the annualised root-mean-square of shortfalls over all observations', () => {
    // shortfalls: -0.10, -0.02, 0, 0 -> sqrt((0.01 + 0.0004) / 4) * sqrt(252)
    expect(downsideDeviation([-0.1, -0.02, 0.05, 0.03]) as number).toBeCloseTo(0.8094, 4);
  });

  it('returns null for an empty series and zero when no observation is negative', () => {
    expect(downsideDeviation([])).toBeNull();
    expect(downsideDeviation([0.01, 0.02])).toBe(0);
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

describe('frequency-aware annualisation', () => {
  // returns [0.01, -0.01]: sample sd = sqrt(0.0002) = 0.0141421356...
  // vol = sd * sqrt(P) * 100 = sqrt(0.0002 * P) * 100.
  const returns = [0.01, -0.01];

  it('maps the stored frequency to observations per year', () => {
    expect(periodsPerYear('daily')).toBe(252);
    expect(periodsPerYear('weekly')).toBe(52);
    expect(periodsPerYear('monthly')).toBe(12);
    expect(periodsPerYear()).toBe(252);
  });

  it('annualises volatility with the dataset frequency instead of always using 252', () => {
    expect(annualisedVolatilityPct(returns, 'daily') as number).toBeCloseTo(22.449944, 5);
    expect(annualisedVolatilityPct(returns, 'weekly') as number).toBeCloseTo(10.198039, 5);
    expect(annualisedVolatilityPct(returns, 'monthly') as number).toBeCloseTo(4.898979, 5);
  });

  it('annualises the arithmetic mean return with the same periods', () => {
    // mean = -0.005; annual return = mean * P * 100.
    expect(annualisedReturnPct([0.01, -0.02], 'daily') as number).toBeCloseTo(-126, 10);
    expect(annualisedReturnPct([0.01, -0.02], 'weekly') as number).toBeCloseTo(-26, 10);
    expect(annualisedReturnPct([0.01, -0.02], 'monthly') as number).toBeCloseTo(-6, 10);
  });

  it('annualises downside deviation with the dataset frequency', () => {
    // sqrt((0.1^2 + 0) / 2) * sqrt(P)
    expect(downsideDeviation([-0.1, 0.05], 'daily') as number).toBeCloseTo(Math.sqrt(1.26), 10);
    expect(downsideDeviation([-0.1, 0.05], 'weekly') as number).toBeCloseTo(Math.sqrt(0.26), 10);
    expect(downsideDeviation([-0.1, 0.05], 'monthly') as number).toBeCloseTo(Math.sqrt(0.06), 10);
  });

  it('ignores unusable null return slots in every annualiser', () => {
    expect(annualisedVolatilityPct([0.01, null, -0.01], 'weekly') as number).toBeCloseTo(10.198039, 5);
    expect(annualisedReturnPct([0.01, null, -0.02], 'weekly') as number).toBeCloseTo(-26, 10);
    expect(downsideDeviation([-0.1, null, 0.05], 'weekly') as number).toBeCloseTo(Math.sqrt(0.26), 10);
  });

  it('annualises alpha at the dataset frequency but leaves beta unchanged', () => {
    const asset = [0.02, 0.01, -0.01];
    const benchmark = [0.01, 0.02, -0.02];
    const daily = betaAlpha(asset, benchmark, 'daily');
    const weekly = betaAlpha(asset, benchmark, 'weekly');
    const monthly = betaAlpha(asset, benchmark, 'monthly');
    // cov / var(benchmark) = (8/15000) / (13/30000) = 8/13.
    expect(daily.beta as number).toBeCloseTo(8 / 13, 10);
    expect(weekly.beta as number).toBeCloseTo(daily.beta as number, 10);
    // mean(asset) - beta * mean(benchmark) = 0.06/13.
    expect(daily.alphaPct as number).toBeCloseTo(1512 / 13, 8);
    expect(weekly.alphaPct as number).toBeCloseTo(24, 8);
    expect(monthly.alphaPct as number).toBeCloseTo(72 / 13, 8);
  });

  it('summarises a weekly series with weekly annualisation', () => {
    // closes [100, 110, 99] -> returns [0.1, -0.1]; vol = sqrt(0.02 * 52) * 100.
    const summary = summarise(barsFromCloses([100, 110, 99]), 'weekly');
    expect(summary.annualisedVolatilityPct as number).toBeCloseTo(Math.sqrt(1.04) * 100, 8);
    expect(summary.totalReturnPct as number).toBeCloseTo(-1, 10);
    expect(summary.sessions).toBe(3);
  });

  it('excludes an unusable step from return statistics instead of counting it as zero', () => {
    const summary = summarise(barsFromCloses([100, 0, 110]), 'daily');
    expect(summary.totalReturnPct as number).toBeCloseTo(10, 10);
    // Only the first step is usable (-100%), so volatility needs two returns and is withheld.
    expect(summary.annualisedVolatilityPct).toBeNull();
    expect(summary.bestDayPct as number).toBeCloseTo(-100, 10);
    expect(summary.positiveDayRatePct as number).toBeCloseTo(0, 10);
  });
});
