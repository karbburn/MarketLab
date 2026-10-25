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

  // Sort defensively: bucket open/close and the emitted order must not depend on
  // the caller's input order. Stored bars are already ascending, so the common
  // path only pays for one linear scan instead of sorting a copy.
  const ordered = isDateOrdered(bars) ? bars : [...bars].sort((a, b) => compareDates(a.date, b.date));

  // Bucket keys are monotonic for ascending dates, so the aggregation can stream
  // instead of retaining an array of member bars per bucket.
  const result: Bar[] = [];
  let bucketKey: string | undefined;
  let bucket: Bar | null = null;
  let volume = 0;
  let volumeComplete = true;

  const flush = () => {
    if (bucket) result.push({ ...bucket, volume: volumeComplete ? volume : null });
    bucket = null;
    volume = 0;
    volumeComplete = true;
  };

  for (const bar of ordered) {
    const key = timeframe === '1W' ? weekKey(bar.date) : monthKey(bar.date);
    if (key !== bucketKey) {
      flush();
      bucketKey = key;
      bucket = {
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        bucket: key,
      };
      volume = bar.volume ?? 0;
      volumeComplete = bar.volume !== null;
      continue;
    }
    const current = bucket as Bar;
    current.date = bar.date;
    current.close = bar.close;
    if (bar.high > current.high) current.high = bar.high;
    if (bar.low < current.low) current.low = bar.low;
    if (bar.volume === null) volumeComplete = false;
    else volume += bar.volume;
  }
  flush();
  return result;
}

function isDateOrdered(bars: readonly Bar[]): boolean {
  for (let index = 1; index < bars.length; index += 1) {
    if (compareDates((bars[index - 1] as Bar).date, (bars[index] as Bar).date) > 0) return false;
  }
  return true;
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

/**
 * Tags bars already stored at `timeframe` with the period bucket they cover.
 * Returns the input array unchanged when every bar already carries the correct
 * bucket (the common case for stored series). Exported for comparison code that
 * must align a native weekly/monthly series with an aggregated one by period
 * rather than by the particular session each series happens to end on.
 */
export function tagBarsAtTimeframe(bars: readonly Bar[], timeframe: Timeframe): readonly Bar[] {
  // Bars already at a native frequency usually carry no bucket at all, so the
  // rewrite would allocate a full copy of the series to change nothing. Stored
  // bars are treated as immutable by every reader, so the original array is
  // returned when it is already correct.
  let needsRewrite = false;
  for (const bar of bars) {
    if (bar.bucket !== periodBucket(bar, timeframe)) {
      needsRewrite = true;
      break;
    }
  }
  if (!needsRewrite) return bars;

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
export function barsForTimeframe(
  bars: readonly Bar[],
  dataset: Dataset,
  requested: Timeframe,
): readonly Bar[] {
  const timeframe = resolveTimeframe(dataset, requested);
  if (timeframeFrequency(timeframe) === dataset.frequency) return tagBarsAtTimeframe(bars, timeframe);
  // Only aggregation (daily -> weekly/monthly) is supported. Lower-frequency
  // data is never interpolated into higher-frequency bars.
  if (dataset.frequency === 'daily') return aggregateBars(bars, timeframe);
  return tagBarsAtTimeframe(bars, timeframe);
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
