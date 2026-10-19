import type { Bar } from '../../domain/types';
import type { IndicatorDefinition } from '../../domain/indicators/types';
import { emptySeries, integerParam } from './core';
import type { Series } from './core';

export function trueRange(bars: readonly Bar[]): Series {
  const output = emptySeries(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i] as Bar;
    if (i === 0) {
      output[i] = bar.high - bar.low;
      continue;
    }
    const previousClose = (bars[i - 1] as Bar).close;
    output[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }
  return output;
}

/**
 * Average True Range with Wilder smoothing.
 *
 * Seed: the simple mean of the first `period` true ranges (first bar's true
 * range is `high - low`). First available value is index `period - 1`.
 */
export function atr(bars: readonly Bar[], period: number): Series {
  const tr = trueRange(bars);
  const output = emptySeries(bars.length);
  if (period <= 0 || bars.length < period) return output;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += tr[i] as number;
  let previous = seed / period;
  output[period - 1] = previous;
  for (let i = period; i < bars.length; i += 1) {
    previous = (previous * (period - 1) + (tr[i] as number)) / period;
    output[i] = previous;
  }
  return output;
}

export const indicatorAtr: IndicatorDefinition = {
  type: 'atr',
  name: 'Average True Range',
  version: 1,
  placement: 'pane',
  category: 'Volatility',
  description: "Wilder's ATR. True range uses the previous close except on the first bar, which uses high - low.",
  formula: 'TR = max(H-L, |H-prevC|, |L-prevC|); ATR = Wilder smooth(TR)',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 14, min: 1, max: 200, step: 1, integer: true }],
  outputs: [{ key: 'atr', label: 'ATR', kind: 'line', defaultColor: '#f59e0b' }],
  calculate(bars, parameters) {
    return { atr: atr(bars, integerParam(parameters, 'period', 14, 1)) };
  },
};

interface DirectionalMovement {
  plusDm: Series;
  minusDm: Series;
  atr: Series;
}

function directionalMovement(bars: readonly Bar[], period: number): DirectionalMovement {
  const length = bars.length;
  const rawPlus = emptySeries(length);
  const rawMinus = emptySeries(length);
  const tr = trueRange(bars);
  for (let i = 1; i < length; i += 1) {
    const upMove = (bars[i] as Bar).high - (bars[i - 1] as Bar).high;
    const downMove = (bars[i - 1] as Bar).low - (bars[i] as Bar).low;
    rawPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    rawMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const smooth = (series: Series): Series => {
    const output = emptySeries(length);
    if (length <= period) return output;
    let seed = 0;
    for (let i = 1; i <= period; i += 1) seed += (series[i] as number) ?? 0;
    let previous = seed;
    output[period] = previous;
    for (let i = period + 1; i < length; i += 1) {
      previous = previous - previous / period + ((series[i] as number) ?? 0);
      output[i] = previous;
    }
    return output;
  };
  const atrSeries = emptySeries(length);
  if (length > period) {
    let seed = 0;
    for (let i = 1; i <= period; i += 1) seed += (tr[i] as number) ?? 0;
    let previous = seed;
    atrSeries[period] = previous;
    for (let i = period + 1; i < length; i += 1) {
      previous = previous - previous / period + ((tr[i] as number) ?? 0);
      atrSeries[i] = previous;
    }
  }
  return { plusDm: smooth(rawPlus), minusDm: smooth(rawMinus), atr: atrSeries };
}

export interface AdxOutput {
  adx: Series;
  plusDi: Series;
  minusDi: Series;
}

/** ADX with Wilder smoothing and Wilder DI/ADX seeding. */
export function adx(bars: readonly Bar[], period: number): AdxOutput {
  const length = bars.length;
  const plusDi = emptySeries(length);
  const minusDi = emptySeries(length);
  const dx = emptySeries(length);
  const adxSeries = emptySeries(length);
  const dm = directionalMovement(bars, period);
  for (let i = 0; i < length; i += 1) {
    const atrValue = dm.atr[i];
    const plus = dm.plusDm[i];
    const minus = dm.minusDm[i];
    if (atrValue == null || plus == null || minus == null || atrValue === 0) continue;
    const pdi = (100 * plus) / atrValue;
    const mdi = (100 * minus) / atrValue;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }
  const firstDx = period;
  const firstAdx = firstDx + period - 1;
  if (firstAdx >= length) return { adx: adxSeries, plusDi, minusDi };
  let seed = 0;
  for (let i = firstDx; i <= firstAdx; i += 1) seed += (dx[i] as number) ?? 0;
  let previous = seed / period;
  adxSeries[firstAdx] = previous;
  for (let i = firstAdx + 1; i < length; i += 1) {
    const value = dx[i] ?? 0;
    previous = (previous * (period - 1) + value) / period;
    adxSeries[i] = previous;
  }
  return { adx: adxSeries, plusDi, minusDi };
}

export const indicatorAdx: IndicatorDefinition = {
  type: 'adx',
  name: 'Average Directional Index',
  version: 1,
  placement: 'pane',
  category: 'Trend',
  description: 'Wilder directional movement, +DI/-DI and ADX. Warm-up is roughly 2 * period observations.',
  formula: 'ADX = Wilder smooth(DX); DX = 100 * |+DI - -DI| / (+DI + -DI)',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 14, min: 2, max: 200, step: 1, integer: true }],
  outputs: [
    { key: 'adx', label: 'ADX', kind: 'line', defaultColor: '#4f8cff' },
    { key: 'plusDi', label: '+DI', kind: 'line', defaultColor: '#2ec27e' },
    { key: 'minusDi', label: '-DI', kind: 'line', defaultColor: '#ef5a5a' },
  ],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 14, 2);
    const result = adx(bars, period);
    return { adx: result.adx, plusDi: result.plusDi, minusDi: result.minusDi };
  },
};
