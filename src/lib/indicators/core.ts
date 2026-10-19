import type { Bar } from '../../domain/types';
import type { IndicatorValues } from '../../domain/indicators/types';

export type Series = IndicatorValues[];

export function closes(bars: readonly Bar[]): number[] {
  return bars.map((bar) => bar.close);
}

export function emptySeries(length: number): Series {
  return new Array<IndicatorValues>(length).fill(null);
}

export function sma(values: readonly number[], period: number): Series {
  const output = emptySeries(values.length);
  if (period <= 0) return output;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) output[i] = sum / period;
  }
  return output;
}

/**
 * Exponential moving average.
 *
 * Seed: the simple moving average of the first `period` observations. Smoothing
 * constant: `alpha = 2 / (period + 1)`. The first available output is therefore
 * at index `period - 1`.
 */
export function ema(values: readonly number[], period: number): Series {
  const output = emptySeries(values.length);
  if (period <= 0 || values.length < period) return output;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] as number;
  let previous = seed / period;
  output[period - 1] = previous;
  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] as number) * alpha + previous * (1 - alpha);
    output[i] = previous;
  }
  return output;
}

/** EMA over a series that may begin with `null` warm-up values. */
export function emaOfSeries(values: Series, period: number): Series {
  const output = emptySeries(values.length);
  if (period <= 0) return output;
  const start = values.findIndex((value) => value !== null);
  if (start < 0) return output;
  const seedEnd = start + period - 1;
  if (seedEnd >= values.length) return output;
  let seed = 0;
  for (let i = start; i <= seedEnd; i += 1) seed += values[i] as number;
  const alpha = 2 / (period + 1);
  let previous = seed / period;
  output[seedEnd] = previous;
  for (let i = seedEnd + 1; i < values.length; i += 1) {
    const value = values[i];
    if (value == null) {
      output[i] = null;
      continue;
    }
    previous = value * alpha + previous * (1 - alpha);
    output[i] = previous;
  }
  return output;
}

export function rollingExtreme(
  bars: readonly Bar[],
  period: number,
  field: 'high' | 'low',
): Array<number | null> {
  const output: Array<number | null> = new Array(bars.length).fill(null);
  if (period <= 0) return output;
  for (let i = period - 1; i < bars.length; i += 1) {
    let extreme = field === 'high' ? -Infinity : Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      const value = (bars[j] as Bar)[field];
      extreme = field === 'high' ? Math.max(extreme, value) : Math.min(extreme, value);
    }
    output[i] = extreme;
  }
  return output;
}

/** SMA over a series that may begin with `null` warm-up values. */
export function smaOfSeries(values: Series, period: number): Series {
  const output = emptySeries(values.length);
  if (period <= 0) return output;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    let valid = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const value = values[j];
      if (value == null) {
        valid = false;
        break;
      }
      sum += value;
    }
    output[i] = valid ? sum / period : null;
  }
  return output;
}

/** Normalises a raw parameter value to a safe integer within bounds. */
export function integerParam(parameters: Record<string, number>, key: string, fallback: number, min = 1, max = 500): number {
  const raw = parameters[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function numberParam(parameters: Record<string, number>, key: string, fallback: number, min = 0, max = 100): number {
  const raw = parameters[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(min, Math.min(max, value));
}
