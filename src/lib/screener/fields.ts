import type { Bar, Frequency, ScreenerField } from '../../domain/types';
import { closes, ema, sma } from '../indicators/core';
import { rsi } from '../indicators/momentum';
import { volumeSma } from '../indicators/volume';
import { annualisedVolatilityPct, maxDrawdownPct, simpleReturns } from '../quant/metrics';

/**
 * Conventional window for each field when it is used as a sort key. Sorting is
 * independent of filtering, so it must not inherit an unrelated filter's period.
 */
export function defaultFieldWindow(field: ScreenerField): number {
  switch (field) {
    case 'close':
      return 1;
    case 'rsi':
      return 14;
    case 'price-vs-sma':
    case 'price-vs-ema':
      return 50;
    default:
      return 20;
  }
}

/**
 * Resolves the persisted sort window, falling back to the field default when a
 * older record predates the field or carries an invalid value.
 */
export function resolveSortWindow(sortBy: string, sortWindow: unknown): number {
  if (typeof sortWindow === 'number' && Number.isInteger(sortWindow) && sortWindow > 0 && sortWindow <= 500) {
    return sortWindow;
  }
  return sortBy === 'symbol' ? 20 : defaultFieldWindow(sortBy as ScreenerField);
}

export interface FieldReading {
  /** Value at the most recent session in the window. */
  current: number | null;
  /** Value one session earlier, used for cross operators. */
  previous: number | null;
}

function pctChange(closes: readonly number[], endIndex: number, window: number): number | null {
  const start = endIndex - window;
  if (start < 0) return null;
  const from = closes[start];
  const to = closes[endIndex];
  if (from == null || to == null || from === 0) return null;
  return (to / from - 1) * 100;
}

function distancePct(closes: readonly number[], level: readonly (number | null)[], endIndex: number): number | null {
  const close = closes[endIndex];
  const reference = level[endIndex];
  if (close == null || reference == null || reference === 0) return null;
  return ((close - reference) / reference) * 100;
}

function volatilityAt(bars: readonly Bar[], endIndex: number, window: number, frequency: Frequency): number | null {
  const start = endIndex - window;
  if (start < 0) return null;
  const slice = bars.slice(start, endIndex + 1).map((bar) => bar.close);
  return annualisedVolatilityPct(simpleReturns(slice), frequency);
}

function drawdownAt(bars: readonly Bar[], endIndex: number, window: number): number | null {
  const start = endIndex - window;
  if (start < 0) return null;
  const slice = bars.slice(start, endIndex + 1).map((bar) => bar.close);
  return maxDrawdownPct(slice);
}

function relativeVolumeAt(bars: readonly Bar[], endIndex: number, window: number): number | null {
  const series = volumeSma(bars, window);
  const volume = bars[endIndex]?.volume;
  const baseline = series[endIndex];
  if (volume == null || baseline == null || baseline <= 0) return null;
  return volume / baseline;
}

/**
 * Computes a screener field at the last bar and at the previous bar. Fields are
 * always derived from the bars in the window; nothing is extrapolated beyond the
 * supplied data, and `null` propagates instead of being replaced by zero.
 */
export function computeField(
  field: ScreenerField,
  window: number,
  bars: readonly Bar[],
  frequency: Frequency = 'daily',
): FieldReading {
  const last = bars.length - 1;
  if (last < 1) return { current: null, previous: null };
  const closeValues = closes(bars);
  const at = (endIndex: number): number | null => {
    if (endIndex < 0) return null;
    switch (field) {
      case 'close':
        return closeValues[endIndex] ?? null;
      case 'return':
        return pctChange(closeValues, endIndex, window);
      case 'price-vs-sma':
        return distancePct(closeValues, sma(closeValues, window), endIndex);
      case 'price-vs-ema':
        return distancePct(closeValues, ema(closeValues, window), endIndex);
      case 'rsi':
        return rsi(closeValues, window)[endIndex] ?? null;
      case 'volatility':
        return volatilityAt(bars, endIndex, window, frequency);
      case 'max-drawdown':
        return drawdownAt(bars, endIndex, window);
      case 'relative-volume':
        return relativeVolumeAt(bars, endIndex, window);
    }
  };
  return { current: at(last), previous: at(last - 1) };
}
