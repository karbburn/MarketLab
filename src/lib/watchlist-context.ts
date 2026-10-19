import type { Bar } from '../domain/types';

/** Sessions used by the watchlist's volume and range context columns. */
export const WATCHLIST_CONTEXT_SESSIONS = 30;

export interface WatchlistContext {
  /** Last close in the stored series, or `null` when the series is empty. */
  lastClose: number | null;
  /** Percent change from the previous stored session, or `null` when unavailable. */
  changePct: number | null;
  /** Average volume over the context window; `null` when no session reports volume. */
  averageVolume: number | null;
  /** Sessions in the context window that reported a finite, non-negative volume. */
  volumeSessions: number;
  /** Lowest low in the context window, or `null` when the window is empty. */
  low: number | null;
  /** Highest high in the context window, or `null` when the window is empty. */
  high: number | null;
  /** High-low range as a percentage of the low, or `null` when undefined. */
  rangePct: number | null;
  /** Sessions actually in the context window (at most the requested count). */
  sessions: number;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Derives the watchlist's row context from stored bars. Volume and range use
 * the last `sessionCount` sessions; shorter histories use every session that
 * exists rather than inventing the missing ones. Missing volume is excluded
 * from the average instead of being treated as zero.
 */
export function watchlistContext(
  bars: readonly Bar[],
  sessionCount = WATCHLIST_CONTEXT_SESSIONS,
): WatchlistContext {
  const requested = Math.max(0, Math.floor(sessionCount));
  const window = requested === 0 ? [] : bars.slice(-requested);

  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const lastClose = last && finite(last.close) ? last.close : null;
  const changePct =
    lastClose !== null && previous && finite(previous.close) && previous.close !== 0
      ? ((lastClose - previous.close) / previous.close) * 100
      : null;

  let totalVolume = 0;
  let volumeSessions = 0;
  let low: number | null = null;
  let high: number | null = null;

  for (const bar of window) {
    if (finite(bar.volume) && bar.volume >= 0) {
      totalVolume += bar.volume;
      volumeSessions += 1;
    }
    if (finite(bar.low)) low = low === null ? bar.low : Math.min(low, bar.low);
    if (finite(bar.high)) high = high === null ? bar.high : Math.max(high, bar.high);
  }

  const averageVolume = volumeSessions === 0 ? null : totalVolume / volumeSessions;
  const rangePct = low !== null && high !== null && low > 0 ? ((high - low) / low) * 100 : null;

  return {
    lastClose,
    changePct,
    averageVolume,
    volumeSessions,
    low,
    high,
    rangePct,
    sessions: window.length,
  };
}
