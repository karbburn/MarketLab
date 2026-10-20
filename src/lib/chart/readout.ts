import type { Bar } from '../../domain/types';

export interface HoverReadout {
  hoverBar: Bar | null;
  previousBar: Bar | null;
}

/**
 * Resolves the bar under the crosshair and the bar it is compared against.
 *
 * The fallback to the last two bars is for the no-hover case only: hovering the
 * first bar has no previous bar, so its change is unknown rather than measured
 * against the penultimate session.
 */
export function hoverBars(bars: readonly Bar[], index: number | null): HoverReadout {
  if (index === null) {
    return {
      hoverBar: (bars[bars.length - 1] as Bar | undefined) ?? null,
      previousBar: (bars[bars.length - 2] as Bar | undefined) ?? null,
    };
  }
  return {
    hoverBar: bars[index] ?? null,
    previousBar: index > 0 ? (bars[index - 1] ?? null) : null,
  };
}

/** Session change, or `null` when either bar is missing or the prior close is zero. */
export function changePercent(current: Bar | null, previous: Bar | null): number | null {
  if (current === null || previous === null || previous.close === 0) return null;
  return ((current.close - previous.close) / previous.close) * 100;
}
