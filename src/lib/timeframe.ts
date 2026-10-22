import type { Bar, Dataset, Frequency, Timeframe } from '../domain/types';
import { compareDates, monthKey, weekKey } from './date';

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
  // Sort defensively: bucket open/close and the emitted order must not depend on
  // the caller's input order.
  const ordered = [...bars].sort((a, b) => compareDates(a.date, b.date));
  for (const bar of ordered) {
    const key = timeframe === '1W' ? weekKey(bar.date) : monthKey(bar.date);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(bar);
    else buckets.set(key, [bar]);
  }

  const result: Bar[] = [];
  for (const [key, bucket] of buckets.entries()) {
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
      bucket: key,
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
      return ['1W'];
    case 'monthly':
      return ['1M'];
  }
}

export function resolveTimeframe(dataset: Dataset, requested: Timeframe): Timeframe {
  const available = availableTimeframes(dataset.frequency);
  if (available.includes(requested)) return requested;
  return available[0] as Timeframe;
}

/**
 * Period key a session date falls into at `timeframe`, matching the keys
 * {@link aggregateBars} writes. Daily bars have no period of their own.
 *
 * This is also how a linked panel maps a crosshair from another panel: the source
 * panel knows a session date, and a weekly or monthly panel needs the key of the
 * period containing it, not the date the source happens to be showing.
 */
export function periodKeyForDate(date: string, timeframe: Timeframe): string | undefined {
  if (timeframe === '1D') return undefined;
  return timeframe === '1W' ? weekKey(date) : monthKey(date);
}

/**
 * Period key for a bar that is already at `timeframe`, matching what
 * {@link aggregateBars} would write.
 *
 * Aggregated bars carry their bucket. A series stored natively at the target
 * frequency never went through aggregation, so its bars have no bucket; deriving
 * the key from the session date lets a native weekly/monthly series be aligned
 * with an aggregated one by the period it covers rather than by whichever
 * session each series happens to end on.
 */
function periodBucket(bar: Bar, timeframe: Timeframe): string | undefined {
  return bar.bucket ?? periodKeyForDate(bar.date, timeframe);
}

/** Copies bars at `timeframe`, tagging each with the period bucket it covers. */
function atTimeframe(bars: readonly Bar[], timeframe: Timeframe): Bar[] {
  return bars.map((bar) => {
    const bucket = periodBucket(bar, timeframe);
    return bucket === undefined ? { ...bar } : { ...bar, bucket };
  });
}

/**
 * Returns the bars a panel should draw for the requested timeframe, resolved
 * against the dataset's own frequency. Bars are tagged with the period bucket
 * of the returned timeframe so comparisons can align on periods.
 */
export function barsForTimeframe(bars: readonly Bar[], dataset: Dataset, requested: Timeframe): Bar[] {
  const timeframe = resolveTimeframe(dataset, requested);
  if (timeframeFrequency(timeframe) === dataset.frequency) return atTimeframe(bars, timeframe);
  // Only aggregation (daily -> weekly/monthly) is supported. Lower-frequency
  // data is never interpolated into higher-frequency bars.
  if (dataset.frequency === 'daily') return aggregateBars(bars, timeframe);
  return atTimeframe(bars, timeframe);
}

export function timeframeLabel(timeframe: Timeframe, source: Frequency): string {
  const available = availableTimeframes(source);
  // Label what the bars actually are: a request that cannot be produced is
  // resolved to the source frequency before it reaches this function.
  const effective = available.includes(timeframe) ? timeframe : (available[0] as Timeframe);
  const aggregated = source === 'daily' && effective !== '1D';
  switch (effective) {
    case '1D':
      return 'Daily';
    case '1W':
      return aggregated ? 'Weekly (aggregated from daily)' : 'Weekly';
    case '1M':
      return aggregated ? 'Monthly (aggregated from daily)' : 'Monthly';
  }
}
