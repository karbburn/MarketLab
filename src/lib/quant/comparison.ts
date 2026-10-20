import type { Bar, Frequency } from '../../domain/types';
import { pearsonCorrelation } from '../stats';
import { pairedReturns, periodsPerYear, simpleReturns, usableReturns, type ReturnValue } from './metrics';

export interface AlignedSeries {
  dates: string[];
  /** One close array per input series, each the same length as `dates`. */
  closes: number[][];
}

/** Alignment identity: an aggregation bucket when present, otherwise the session date. */
function alignmentKey(bar: Bar): string {
  return bar.bucket ?? bar.date;
}

/**
 * Aligns multiple bar series on the dates they have in common.
 *
 * A date is only included when every series provides a bar for it, so no value
 * is ever forward-filled or interpolated. Aggregated bars are matched on their
 * bucket key (`2024-W01`, `2024-08`) rather than their last-session date, so two
 * markets whose final session of a week or month differs still share the
 * period; the axis is still labelled with the first series' real session date.
 * Series with no overlap produce an empty alignment rather than an approximation.
 */
export function alignOnCommonDates(series: ReadonlyArray<readonly Bar[]>): AlignedSeries {
  if (series.length === 0) return { dates: [], closes: [] };
  const maps = series.map((bars) => new Map(bars.map((bar) => [alignmentKey(bar), bar.close])));
  const first = series[0] ?? [];
  const alignedBars = first.filter((bar) => maps.every((map) => map.has(alignmentKey(bar))));
  const dates = alignedBars.map((bar) => bar.date);
  const closes = maps.map((map) => alignedBars.map((bar) => map.get(alignmentKey(bar)) as number));
  return { dates, closes };
}

export interface NormalisedSeries {
  dates: string[];
  /** Percentage change from the first common close, indexed to 0 at the start. */
  values: number[];
}

export function normalisedPerformance(dates: readonly string[], closes: readonly number[]): NormalisedSeries {
  const base = closes[0];
  // Both arrays are empty on an unusable baseline so callers cannot plot dates
  // without values (or values without dates). The UI renders an explicit
  // unavailable state instead of a blank line.
  if (base === undefined || !Number.isFinite(base) || base <= 0) return { dates: [], values: [] };
  return { dates: [...dates], values: closes.map((value) => (value / base - 1) * 100) };
}

/** The fewest shared sessions a rebased comparison needs to mean anything. */
export const MIN_COMPARISON_SESSIONS = 2;

export interface ComparisonInputSeries {
  /** Stable identity, normally the dataset id. */
  key: string;
  /** Human label, normally the instrument symbol. */
  label: string;
  bars: readonly Bar[];
}

export interface ComparisonSeries {
  key: string;
  label: string;
  /**
   * Index values aligned to `dates`, rebased so the first shared session is
   * exactly 100. A +10% move from the baseline is 110.
   */
  values: number[];
}

export type ComparisonStatus =
  | 'ok'
  | 'no-series'
  | 'no-overlap'
  | 'insufficient-history'
  | 'invalid-baseline';

export interface ComparisonResult {
  status: ComparisonStatus;
  /** Shared sessions used as the x-axis, ascending. */
  dates: string[];
  /** One entry per input series, in input order; empty `values` unless `ok`. */
  series: ComparisonSeries[];
  /** First shared session, the 100 baseline, or null when there is no overlap. */
  baselineDate: string | null;
  minSessions: number;
}

/**
 * Rebases several bar series to a common index of 100 for relative comparison.
 *
 * The series are aligned with {@link alignOnCommonDates}, so a session is only
 * kept when every series provides a bar for it and nothing is ever
 * forward-filled or interpolated. The baseline is the first shared session
 * *within the window*, so observations before the comparison period can never
 * influence it (no look-ahead). Every failure mode is explicit rather than
 * approximated: no series, no shared session, too few shared sessions, or a
 * non-positive baseline close.
 */
export function rebasedComparison(
  inputs: readonly ComparisonInputSeries[],
  options: { from?: string; to?: string; minSessions?: number } = {},
): ComparisonResult {
  const minSessions = options.minSessions ?? MIN_COMPARISON_SESSIONS;
  if (inputs.length === 0) {
    return { status: 'no-series', dates: [], series: [], baselineDate: null, minSessions };
  }
  const windowed = inputs.map((input) => input.bars.filter((bar) => inWindow(bar.date, options.from, options.to)));
  const aligned = alignOnCommonDates(windowed);
  const emptySeries = inputs.map((input) => ({ key: input.key, label: input.label, values: [] as number[] }));

  if (aligned.dates.length === 0) {
    return { status: 'no-overlap', dates: [], series: emptySeries, baselineDate: null, minSessions };
  }
  if (aligned.dates.length < minSessions) {
    // The shared sessions are real and reported, but there are too few to rebase
    // honestly; `baselineDate` stays null because no baseline was used.
    return { status: 'insufficient-history', dates: aligned.dates, series: emptySeries, baselineDate: null, minSessions };
  }

  const series: ComparisonSeries[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const closes = aligned.closes[index] ?? [];
    const base = closes[0];
    const input = inputs[index] as ComparisonInputSeries;
    if (base === undefined || !Number.isFinite(base) || base <= 0) {
      return { status: 'invalid-baseline', dates: [], series: emptySeries, baselineDate: null, minSessions };
    }
    series.push({ key: input.key, label: input.label, values: closes.map((close) => (close / base) * 100) });
  }

  return {
    status: 'ok',
    dates: aligned.dates,
    series,
    baselineDate: aligned.dates[0] ?? null,
    minSessions,
  };
}

/** Inclusive ISO-date window test; an absent bound is open on that side. */
function inWindow(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && date < from) return false;
  if (to !== undefined && date > to) return false;
  return true;
}

export interface CorrelationMatrix {
  labels: string[];
  /** Symmetric matrix of Pearson correlations; diagonal is 1 when computable. */
  values: Array<Array<number | null>>;
}

export function correlationMatrix(labels: readonly string[], closes: ReadonlyArray<readonly number[]>): CorrelationMatrix {
  const returns: ReturnValue[][] = closes.map((series) => simpleReturns(series));
  const size = labels.length;
  const values: Array<Array<number | null>> = [];
  for (let i = 0; i < size; i += 1) {
    const row: Array<number | null> = [];
    for (let j = 0; j < size; j += 1) {
      if (i === j) {
        // Self-correlation is only 1 when the series can actually produce one;
        // a constant or too-short series has undefined correlation.
        const usable = usableReturns(returns[i] ?? []);
        row.push(pearsonCorrelation(usable, usable));
        continue;
      }
      const paired = pairedReturns(returns[i] ?? [], returns[j] ?? []);
      row.push(pearsonCorrelation(paired.left, paired.right));
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
  frequency: Frequency = 'daily',
): RollingStatPoint[] {
  const returns = simpleReturns(closes);
  const output: RollingStatPoint[] = dates.map((date) => ({ date, value: null }));
  // A sample standard deviation needs at least two observations. Returning the
  // all-null series is honest; 0/0 would inject NaN into chart coordinates.
  if (!Number.isInteger(window) || window < 2) return output;
  const scale = Math.sqrt(periodsPerYear(frequency)) * 100;
  for (let i = window; i <= returns.length && i < dates.length; i += 1) {
    const slice = returns.slice(i - window, i);
    // A window containing an unusable step is unavailable at that position; the
    // point is not shifted to a later date.
    if (slice.some((value) => value === null)) continue;
    const values = slice as number[];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    output[i] = { date: dates[i] as string, value: Math.sqrt(variance) * scale };
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
