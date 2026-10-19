import type { Bar } from '../../domain/types';
import type { IndicatorDefinition } from '../../domain/indicators/types';
import { closes, ema, integerParam, numberParam, sma } from './core';
import { populationStdDev } from '../stats';

export const indicatorSma: IndicatorDefinition = {
  type: 'sma',
  name: 'Simple Moving Average',
  version: 1,
  placement: 'overlay',
  category: 'Trend',
  description: 'Arithmetic mean of the last N closes. No value is produced until a full window exists.',
  formula: 'SMA_t = (1/N) * Σ close_(t-i), i = 0..N-1',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 20, min: 1, max: 500, step: 1, integer: true }],
  outputs: [{ key: 'sma', label: 'SMA', kind: 'line', defaultColor: '#4f8cff' }],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 20);
    return { sma: sma(closes(bars), period) };
  },
};

export const indicatorEma: IndicatorDefinition = {
  type: 'ema',
  name: 'Exponential Moving Average',
  version: 1,
  placement: 'overlay',
  category: 'Trend',
  description: 'EMA seeded with the simple moving average of the first N closes, then alpha = 2/(N+1).',
  formula: 'EMA_t = close_t * α + EMA_(t-1) * (1 - α), α = 2/(N+1)',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 50, min: 1, max: 500, step: 1, integer: true }],
  outputs: [{ key: 'ema', label: 'EMA', kind: 'line', defaultColor: '#f59e0b' }],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 50);
    return { ema: ema(closes(bars), period) };
  },
};

export const indicatorBollinger: IndicatorDefinition = {
  type: 'bollinger',
  name: 'Bollinger Bands',
  version: 1,
  placement: 'overlay',
  category: 'Volatility',
  description: 'SMA centre with bands at ±multiplier population standard deviations (ddof = 0).',
  formula: 'Middle = SMA(N); Upper/Lower = Middle ± k * σ_population(N)',
  parameters: [
    { key: 'period', label: 'Period', defaultValue: 20, min: 2, max: 500, step: 1, integer: true },
    { key: 'multiplier', label: 'Std dev multiplier', defaultValue: 2, min: 0.1, max: 10, step: 0.1, integer: false },
  ],
  outputs: [
    { key: 'middle', label: 'Middle', kind: 'line', defaultColor: '#8b9bb4' },
    { key: 'upper', label: 'Upper', kind: 'band', bandWith: 'lower', defaultColor: '#4f8cff' },
    { key: 'lower', label: 'Lower', kind: 'band', bandWith: 'upper', defaultColor: '#4f8cff' },
  ],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 20, 2);
    const multiplier = numberParam(parameters, 'multiplier', 2, 0.1, 10);
    const values = closes(bars);
    const middle = sma(values, period);
    const upper = middle.slice();
    const lower = middle.slice();
    for (let i = period - 1; i < values.length; i += 1) {
      const window: number[] = [];
      for (let j = i - period + 1; j <= i; j += 1) window.push(values[j] as number);
      const deviation = populationStdDev(window) ?? 0;
      const centre = middle[i] as number;
      upper[i] = centre + multiplier * deviation;
      lower[i] = centre - multiplier * deviation;
    }
    return { middle, upper, lower };
  },
};

export function bollingerBands(bars: readonly Bar[], period = 20, multiplier = 2) {
  return indicatorBollinger.calculate(bars, { period, multiplier });
}
