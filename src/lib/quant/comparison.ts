import type { Bar } from '../../domain/types';
import { pearsonCorrelation } from '../stats';
import { simpleReturns } from './metrics';

export interface AlignedSeries {
  dates: string[];
  /** One close array per input series, each the same length as `dates`. */
  closes: number[][];
}

/**
 * Aligns multiple bar series on the dates they have in common.
 *
 * A date is only included when every series provides a bar for it, so no value
 * is ever forward-filled or interpolated. Series with no overlap produce an
 * empty alignment rather than an approximation.
 */
export function alignOnCommonDates(series: ReadonlyArray<readonly Bar[]>): AlignedSeries {
  if (series.length === 0) return { dates: [], closes: [] };
  const maps = series.map((bars) => new Map(bars.map((bar) => [bar.date, bar.close])));
  const first = series[0] ?? [];
  const dates = first.map((bar) => bar.date).filter((date) => maps.every((map) => map.has(date)));
  const closes = maps.map((map) => dates.map((date) => map.get(date) as number));
  return { dates, closes };
}

export interface NormalisedSeries {
  dates: string[];
  /** Percentage change from the first common close, indexed to 0 at the start. */
  values: number[];
}

export function normalisedPerformance(dates: readonly string[], closes: readonly number[]): NormalisedSeries {
  const base = closes[0];
  if (base === undefined || base === 0) return { dates: [...dates], values: [] };
  return { dates: [...dates], values: closes.map((value) => (value / base - 1) * 100) };
}

export interface CorrelationMatrix {
  labels: string[];
  /** Symmetric matrix of Pearson correlations; diagonal is 1 when computable. */
  values: Array<Array<number | null>>;
}

export function correlationMatrix(labels: readonly string[], closes: ReadonlyArray<readonly number[]>): CorrelationMatrix {
  const returns = closes.map((series) => simpleReturns(series));
  const size = labels.length;
  const values: Array<Array<number | null>> = [];
  for (let i = 0; i < size; i += 1) {
    const row: Array<number | null> = [];
    for (let j = 0; j < size; j += 1) {
      if (i === j) {
        row.push(1);
        continue;
      }
      row.push(pearsonCorrelation(returns[i] as number[], returns[j] as number[]));
    }
    values.push(row);
  }
  return { labels: [...labels], values };
}

export interface RollingStatPoint {
  date: string;
  value: number | null;
}

/** Rolling annualised volatility (in percent) over a fixed window of sessions. */
export function rollingVolatilityPct(
  dates: readonly string[],
  closes: readonly number[],
  window: number,
): RollingStatPoint[] {
  const returns = simpleReturns(closes);
  const output: RollingStatPoint[] = dates.map((date) => ({ date, value: null }));
  for (let i = window; i <= returns.length; i += 1) {
    const slice = returns.slice(i - window, i);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    output[i] = { date: dates[i] as string, value: Math.sqrt(variance) * Math.sqrt(252) * 100 };
  }
  return output;
}

/** Rolling drawdown from the running peak, in percent (always <= 0). */
export function rollingDrawdownPct(dates: readonly string[], closes: readonly number[]): RollingStatPoint[] {
  let peak = closes[0] ?? 0;
  return dates.map((date, index) => {
    const close = closes[index] as number;
    if (close > peak) peak = close;
    return { date, value: peak > 0 ? (close / peak - 1) * 100 : null };
  });
}
