import type { Bar, DateString, Frequency } from '../../domain/types';
import {
  covariance,
  excessKurtosis,
  mean,
  pearsonCorrelation,
  quantile,
  sampleStdDev,
  skewness,
} from '../stats';
import { yearsBetween } from '../date';

export const TRADING_DAYS_PER_YEAR = 252;

/**
 * Observations per calendar year for each supported stored frequency. All
 * annualisers take the frequency of the bars they are given; assuming 252 for a
 * weekly or monthly series overstates volatility and Sharpe by a wide margin.
 */
export function periodsPerYear(frequency: Frequency = 'daily'): number {
  switch (frequency) {
    case 'daily':
      return 252;
    case 'weekly':
      return 52;
    case 'monthly':
      return 12;
  }
}

/** A step that cannot produce a return is `null`, never a dropped array slot. */
export type ReturnValue = number | null;

/** Returns the finite values of a return series, preserving their order. */
export function usableReturns(returns: readonly ReturnValue[]): number[] {
  return returns.filter((value): value is number => value !== null && Number.isFinite(value));
}

/**
 * Pairs two return series position by position, dropping a step when either
 * side is unusable. Alignment is from the end, matching the previous
 * beta/correlation convention when the series have different lengths.
 */
export function pairedReturns(
  left: readonly ReturnValue[],
  right: readonly ReturnValue[],
): { left: number[]; right: number[] } {
  const length = Math.min(left.length, right.length);
  const leftStart = left.length - length;
  const rightStart = right.length - length;
  const pairedLeft: number[] = [];
  const pairedRight: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const a = left[leftStart + index];
    const b = right[rightStart + index];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    pairedLeft.push(a);
    pairedRight.push(b);
  }
  return { left: pairedLeft, right: pairedRight };
}

export interface CloseSeries {
  dates: DateString[];
  closes: number[];
}

export function toCloseSeries(bars: readonly Bar[]): CloseSeries {
  return {
    dates: bars.map((bar) => bar.date),
    closes: bars.map((bar) => bar.close),
  };
}

/**
 * Simple (arithmetic) period-over-period returns. The result always has
 * `closes.length - 1` entries; a step whose previous close is unusable is
 * `null`, so consumers can keep returns aligned with dates by position.
 */
export function simpleReturns(closes: readonly number[]): ReturnValue[] {
  const output: ReturnValue[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1];
    const current = closes[i];
    if (previous == null || current == null || !Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
      output.push(null);
      continue;
    }
    output.push(current / previous - 1);
  }
  return output;
}

export function returnsFromBars(bars: readonly Bar[]): ReturnValue[] {
  return simpleReturns(bars.map((bar) => bar.close));
}

export function cumulativeReturnPct(returns: readonly ReturnValue[]): number | null {
  const usable = usableReturns(returns);
  if (usable.length === 0) return null;
  let growth = 1;
  for (const value of usable) growth *= 1 + value;
  return (growth - 1) * 100;
}

export function totalReturnPct(bars: readonly Bar[]): number | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last || first.close === 0) return null;
  return (last.close / first.close - 1) * 100;
}

/**
 * Compound annual growth rate. Uses calendar years between the first and last
 * session dates (365.25 days per year); returns null for spans under 30 days
 * where the annualisation would be meaningless.
 */
export function cagrPct(bars: readonly Bar[]): number | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last || first.close === 0) return null;
  const years = yearsBetween(first.date, last.date);
  if (!Number.isFinite(years) || years <= 30 / 365.25) return null;
  const growth = last.close / first.close;
  if (growth <= 0) return null;
  return (growth ** (1 / years) - 1) * 100;
}

export function annualisedVolatilityPct(
  returns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): number | null {
  const sd = sampleStdDev(usableReturns(returns));
  if (sd === null) return null;
  return sd * Math.sqrt(periodsPerYear(frequency)) * 100;
}

export function annualisedReturnPct(
  returns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): number | null {
  const m = mean(usableReturns(returns));
  if (m === null) return null;
  return m * periodsPerYear(frequency) * 100;
}

/** Sharpe ratio with an assumed risk-free rate of zero. */
export function sharpeRatio(
  returns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): number | null {
  const annualReturn = annualisedReturnPct(returns, frequency);
  const annualVol = annualisedVolatilityPct(returns, frequency);
  if (annualReturn === null || annualVol === null || annualVol === 0) return null;
  return annualReturn / annualVol;
}

/**
 * Downside deviation: the root-mean-square of shortfalls below the zero target,
 * taken over all usable observations and annualised like the rest of this module.
 */
export function downsideDeviation(
  returns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): number | null {
  const usable = usableReturns(returns);
  if (usable.length === 0) return null;
  let acc = 0;
  for (const value of usable) {
    const shortfall = Math.min(value, 0);
    acc += shortfall * shortfall;
  }
  return Math.sqrt(acc / usable.length) * Math.sqrt(periodsPerYear(frequency));
}

/** Sortino ratio with an assumed target return of zero. */
export function sortinoRatio(
  returns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): number | null {
  const annualReturn = annualisedReturnPct(returns, frequency);
  const downside = downsideDeviation(returns, frequency);
  if (annualReturn === null || downside === null || downside === 0) return null;
  return annualReturn / (downside * 100);
}

export function maxDrawdownPct(equity: readonly number[]): number | null {
  if (equity.length === 0) return null;
  let peak = equity[0] as number;
  let worst = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (value / peak - 1) * 100;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** Ulcer index: RMS of percentage drawdowns. A drawdown-pain measure. */
export function ulcerIndexPct(equity: readonly number[]): number | null {
  if (equity.length === 0) return null;
  let peak = equity[0] as number;
  let acc = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    const drawdown = peak > 0 ? (value / peak - 1) * 100 : 0;
    acc += drawdown ** 2;
  }
  return Math.sqrt(acc / equity.length);
}

export function calmarRatio(bars: readonly Bar[]): number | null {
  const cagr = cagrPct(bars);
  const drawdown = maxDrawdownPct(bars.map((bar) => bar.close));
  if (cagr === null || drawdown === null || drawdown === 0) return null;
  return cagr / Math.abs(drawdown);
}

/** Historical (non-parametric) Value at Risk as a positive loss percentage. */
export function historicalVarPct(returns: readonly ReturnValue[], confidence = 0.95): number | null {
  const usable = usableReturns(returns);
  if (usable.length < 20) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const value = quantile(sorted, 1 - confidence);
  if (value === null) return null;
  return Math.max(0, -value * 100);
}

/** Historical Conditional VaR (expected shortfall) as a positive loss percentage. */
export function historicalCvarPct(returns: readonly ReturnValue[], confidence = 0.95): number | null {
  const usable = usableReturns(returns);
  if (usable.length < 20) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const threshold = quantile(sorted, 1 - confidence);
  if (threshold === null) return null;
  const tail = sorted.filter((value) => value <= threshold);
  const tailMean = mean(tail);
  if (tailMean === null) return null;
  return Math.max(0, -tailMean * 100);
}

export interface BetaAlpha {
  beta: number | null;
  alphaPct: number | null;
  correlation: number | null;
  rSquared: number | null;
}

export function betaAlpha(
  assetReturns: readonly ReturnValue[],
  benchmarkReturns: readonly ReturnValue[],
  frequency: Frequency = 'daily',
): BetaAlpha {
  const paired = pairedReturns(assetReturns, benchmarkReturns);
  const asset = paired.left;
  const benchmark = paired.right;
  const variance = covariance(benchmark, benchmark);
  const cov = covariance(asset, benchmark);
  const correlation = pearsonCorrelation(asset, benchmark);
  if (variance === null || cov === null || variance === 0) {
    return { beta: null, alphaPct: null, correlation, rSquared: correlation === null ? null : correlation ** 2 };
  }
  const beta = cov / variance;
  const assetMean = mean(asset);
  const benchmarkMean = mean(benchmark);
  const alphaPct =
    assetMean === null || benchmarkMean === null
      ? null
      : (assetMean - beta * benchmarkMean) * periodsPerYear(frequency) * 100;
  return { beta, alphaPct, correlation, rSquared: correlation === null ? null : correlation ** 2 };
}

export interface QuantSummary {
  firstDate: DateString | null;
  lastDate: DateString | null;
  sessions: number;
  totalReturnPct: number | null;
  cagrPct: number | null;
  annualisedVolatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number | null;
  ulcerIndexPct: number | null;
  calmar: number | null;
  var95Pct: number | null;
  cvar95Pct: number | null;
  bestDayPct: number | null;
  worstDayPct: number | null;
  positiveDayRatePct: number | null;
  skewness: number | null;
  excessKurtosis: number | null;
}

export function summarise(bars: readonly Bar[], frequency: Frequency = 'daily'): QuantSummary {
  const closes = bars.map((bar) => bar.close);
  const rawReturns = simpleReturns(closes);
  const returns = usableReturns(rawReturns);
  const up = returns.filter((value) => value > 0).length;
  return {
    firstDate: bars[0]?.date ?? null,
    lastDate: bars[bars.length - 1]?.date ?? null,
    sessions: bars.length,
    totalReturnPct: totalReturnPct(bars),
    cagrPct: cagrPct(bars),
    annualisedVolatilityPct: annualisedVolatilityPct(returns, frequency),
    sharpe: sharpeRatio(returns, frequency),
    sortino: sortinoRatio(returns, frequency),
    maxDrawdownPct: maxDrawdownPct(closes),
    ulcerIndexPct: ulcerIndexPct(closes),
    calmar: calmarRatio(bars),
    var95Pct: historicalVarPct(returns, 0.95),
    cvar95Pct: historicalCvarPct(returns, 0.95),
    bestDayPct: returns.length ? Math.max(...returns) * 100 : null,
    worstDayPct: returns.length ? Math.min(...returns) * 100 : null,
    positiveDayRatePct: returns.length ? (up / returns.length) * 100 : null,
    skewness: skewness(returns),
    excessKurtosis: excessKurtosis(returns),
  };
}
