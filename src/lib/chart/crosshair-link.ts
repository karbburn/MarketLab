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
  if (timeframe === '1D') return bars.find((bar) => bar.date === sourceDate) ?? null;
  const key = periodKeyForDate(sourceDate, timeframe);
  if (!key) return null;
  return (
    bars.find((bar) => (bar.bucket ?? periodKeyForDate(bar.date, timeframe)) === key) ?? null
  );
}
