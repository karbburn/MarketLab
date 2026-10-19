import type { Bar } from '../../domain/types';
import type { IndicatorDefinition } from '../../domain/indicators/types';
import { closes, ema, emaOfSeries, emptySeries, integerParam, rollingExtreme, smaOfSeries } from './core';
import type { Series } from './core';

/**
 * Wilder RSI.
 *
 * Average gain/loss are seeded with the simple mean of the first `period`
 * changes, then smoothed with `avg = (avg * (period - 1) + current) / period`.
 * First available value is index `period`. A zero average loss yields 100; a
 * flat series (zero gain and zero loss) yields a neutral 50 rather than NaN.
 */
export function rsi(values: readonly number[], period: number): Series {
  const output = emptySeries(values.length);
  if (period <= 0 || values.length <= period) return output;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  output[period] = computeRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    output[i] = computeRsi(avgGain, avgLoss);
  }
  return output;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export const indicatorRsi: IndicatorDefinition = {
  type: 'rsi',
  name: 'Relative Strength Index',
  version: 1,
  placement: 'pane',
  category: 'Momentum',
  description: "Wilder's RSI with a simple-mean seed. Bounded to 0..100; a flat series is neutral (50).",
  formula: 'RSI = 100 - 100 / (1 + avgGain / avgLoss), Wilder smoothing',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 14, min: 2, max: 200, step: 1, integer: true }],
  outputs: [{ key: 'rsi', label: 'RSI', kind: 'line', defaultColor: '#b07cff' }],
  calculate(bars, parameters) {
    return { rsi: rsi(closes(bars), integerParam(parameters, 'period', 14, 2)) };
  },
};

export const indicatorMacd: IndicatorDefinition = {
  type: 'macd',
  name: 'MACD',
  version: 1,
  placement: 'pane',
  category: 'Momentum',
  description: 'MACD line, signal line and histogram. Fast and slow EMAs share the seeded-EMA convention; signal is an EMA of the MACD line.',
  formula: 'MACD = EMA(fast) - EMA(slow); Signal = EMA(MACD, signal); Histogram = MACD - Signal',
  parameters: [
    { key: 'fast', label: 'Fast period', defaultValue: 12, min: 2, max: 200, step: 1, integer: true },
    { key: 'slow', label: 'Slow period', defaultValue: 26, min: 3, max: 400, step: 1, integer: true },
    { key: 'signal', label: 'Signal period', defaultValue: 9, min: 2, max: 200, step: 1, integer: true },
  ],
  outputs: [
    { key: 'macd', label: 'MACD', kind: 'line', defaultColor: '#4f8cff' },
    { key: 'signal', label: 'Signal', kind: 'line', defaultColor: '#f59e0b' },
    { key: 'histogram', label: 'Histogram', kind: 'histogram', defaultColor: '#8b9bb4' },
  ],
  calculate(bars, parameters) {
    const fast = integerParam(parameters, 'fast', 12, 1);
    const slowRaw = integerParam(parameters, 'slow', 26, 2);
    const slow = Math.max(slowRaw, fast + 1);
    const signalPeriod = integerParam(parameters, 'signal', 9, 1);
    const values = closes(bars);
    const fastEma = ema(values, fast);
    const slowEma = ema(values, slow);
    const macd = emptySeries(values.length);
    for (let i = 0; i < values.length; i += 1) {
      const f = fastEma[i];
      const s = slowEma[i];
      macd[i] = f != null && s != null ? f - s : null;
    }
    const signal = emaOfSeries(macd, signalPeriod);
    const histogram = emptySeries(values.length);
    for (let i = 0; i < values.length; i += 1) {
      const m = macd[i];
      const s = signal[i];
      histogram[i] = m != null && s != null ? m - s : null;
    }
    return { macd, signal, histogram };
  },
};

export const indicatorStochastic: IndicatorDefinition = {
  type: 'stochastic',
  name: 'Stochastic Oscillator',
  version: 1,
  placement: 'pane',
  category: 'Momentum',
  description: 'Raw %K over a high/low lookback, smoothed into %K and %D. A flat high/low range produces a neutral 50.',
  formula: '%K_raw = 100 * (close - lowestLow) / (highestHigh - lowestLow)',
  parameters: [
    { key: 'period', label: '%K period', defaultValue: 14, min: 2, max: 200, step: 1, integer: true },
    { key: 'kSmooth', label: '%K smoothing', defaultValue: 3, min: 1, max: 50, step: 1, integer: true },
    { key: 'dSmooth', label: '%D smoothing', defaultValue: 3, min: 1, max: 50, step: 1, integer: true },
  ],
  outputs: [
    { key: 'k', label: '%K', kind: 'line', defaultColor: '#4f8cff' },
    { key: 'd', label: '%D', kind: 'line', defaultColor: '#f59e0b' },
  ],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 14, 2);
    const kSmooth = integerParam(parameters, 'kSmooth', 3, 1);
    const dSmooth = integerParam(parameters, 'dSmooth', 3, 1);
    const highest = rollingExtreme(bars, period, 'high');
    const lowest = rollingExtreme(bars, period, 'low');
    const raw = emptySeries(bars.length);
    for (let i = 0; i < bars.length; i += 1) {
      const h = highest[i];
      const l = lowest[i];
      if (h == null || l == null) continue;
      const range = h - l;
      raw[i] = range === 0 ? 50 : ((100 * ((bars[i] as Bar).close - l)) / range);
    }
    const k = smaOfSeries(raw, kSmooth);
    const d = smaOfSeries(k, dSmooth);
    return { k, d };
  },
};
