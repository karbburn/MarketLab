import type { Bar, Dataset, Frequency, Timeframe } from '../domain/types';
import { monthKey, weekKey } from './date';

export const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M'];

export function isTimeframe(value: unknown): value is Timeframe {
  return value === '1D' || value === '1W' || value === '1M';
}

export function timeframeFrequency(timeframe: Timeframe): Frequency {
  switch (timeframe) {
    case '1D':
      return 'daily';
    case '1W':
      return 'weekly';
    case '1M':
      return 'monthly';
  }
}

/**
 * Aggregates daily bars into weekly (Monday-based) or monthly buckets.
 *
 * Rules: open = first open, high = max high, low = min low, close = last close,
 * volume = sum of the bucket's volumes. If any bar in a bucket has no volume the
 * bucket volume is `null`, because a partial sum would be misleading. Partial
 * buckets at the start/end of the series are retained as-is; missing buckets are
 * never synthesised.
 */
export function aggregateBars(bars: readonly Bar[], timeframe: Timeframe): Bar[] {
  if (timeframe === '1D') return bars.map((bar) => ({ ...bar }));

  const buckets = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = timeframe === '1W' ? weekKey(bar.date) : monthKey(bar.date);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(bar);
    else buckets.set(key, [bar]);
  }

  const result: Bar[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 0) continue;
    const first = bucket[0] as Bar;
    const last = bucket[bucket.length - 1] as Bar;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    let volumeComplete = first.volume !== null;
    for (const bar of bucket) {
      if (bar.high > high) high = bar.high;
      if (bar.low < low) low = bar.low;
      if (bar.volume === null) volumeComplete = false;
      else volume += bar.volume;
    }
    result.push({
      date: last.date,
      open: first.open,
      high,
      low,
      close: last.close,
      volume: volumeComplete ? volume : null,
    });
  }
  return result;
}

/** Returns the next-higher timeframe available for a source frequency. */
export function availableTimeframes(frequency: Frequency): Timeframe[] {
  switch (frequency) {
    case 'daily':
      return ['1D', '1W', '1M'];
    case 'weekly':
      return ['1W', '1M'];
    case 'monthly':
      return ['1M'];
  }
}

export function resolveTimeframe(dataset: Dataset, requested: Timeframe): Timeframe {
  const available = availableTimeframes(dataset.frequency);
  if (available.includes(requested)) return requested;
  return available[0] as Timeframe;
}

export function barsForTimeframe(bars: readonly Bar[], dataset: Dataset, requested: Timeframe): Bar[] {
  const timeframe = resolveTimeframe(dataset, requested);
  if (timeframeFrequency(timeframe) === dataset.frequency) return bars.map((bar) => ({ ...bar }));
  // Only aggregation (daily -> weekly/monthly) is supported. Lower-frequency
  // data is never interpolated into higher-frequency bars.
  if (dataset.frequency === 'daily') return aggregateBars(bars, timeframe);
  return bars.map((bar) => ({ ...bar }));
}

export function timeframeLabel(timeframe: Timeframe, source: Frequency): string {
  const aggregated = source === 'daily' && timeframe !== '1D';
  switch (timeframe) {
    case '1D':
      return 'Daily';
    case '1W':
      return aggregated ? 'Weekly (aggregated from daily)' : 'Weekly';
    case '1M':
      return aggregated ? 'Monthly (aggregated from daily)' : 'Monthly';
  }
}
