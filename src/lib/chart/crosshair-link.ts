import type { Bar, Timeframe } from '../../domain/types';
import { periodKeyForDate } from '../timeframe';

/**
 * Resolves the bar that a linked panel should point at for a crosshair coming
 * from another panel.
 *
 * A daily panel requires the exact session: if the other market did not trade
 * that date there is no bar, and no nearby session is substituted. Weekly and
 * monthly panels match the period containing the source date, so two series that
 * end the same week on different sessions still line up, and a daily hover lands
 * on the containing week or month bar. `null` means "show nothing", never
 * "show the closest bar".
 */
export function linkedBarForCrosshair(
  bars: readonly Bar[],
  sourceDate: string | null,
  timeframe: Timeframe,
): Bar | null {
  if (!sourceDate) return null;
  if (timeframe === '1D') {
    // Single pass map; O(n) once instead of a predicate scan per lookup.
    const byDate = new Map<string, Bar>();
    for (const bar of bars) byDate.set(bar.date, bar);
    return byDate.get(sourceDate) ?? null;
  }
  const key = periodKeyForDate(sourceDate, timeframe);
  if (!key) return null;
  const byPeriod = new Map<string, Bar>();
  for (const bar of bars) {
    const period = bar.bucket ?? periodKeyForDate(bar.date, timeframe);
    if (period && !byPeriod.has(period)) byPeriod.set(period, bar);
  }
  return byPeriod.get(key) ?? null;
}
