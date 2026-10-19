import type { Bar } from '../../domain/types';
import type { IndicatorDefinition } from '../../domain/indicators/types';
import { emptySeries, integerParam, rollingExtreme } from './core';
import type { Series } from './core';

export interface IchimokuOutput {
  conversion: Series;
  base: Series;
  spanA: Series;
  spanB: Series;
  lagging: Series;
}

/**
 * Ichimoku Cloud.
 *
 * Leading spans are displaced forward by `displacement` bars: spanA[index] is
 * the value computed at `index - displacement`, so the plotted line sits ahead
 * of its inputs. The lagging span at index `i` is the close at `i + displacement`,
 * so it trails the current bar. Values that would fall outside the series are
 * left unavailable rather than wrapped.
 */
export function ichimoku(
  bars: readonly Bar[],
  conversionPeriod: number,
  basePeriod: number,
  spanPeriod: number,
  displacement: number,
): IchimokuOutput {
  const length = bars.length;
  const conversionRaw: Series = emptySeries(length);
  const baseRaw: Series = emptySeries(length);
  const spanARaw: Series = emptySeries(length);
  const spanBRaw: Series = emptySeries(length);

  const highConversion = rollingExtreme(bars, conversionPeriod, 'high');
  const lowConversion = rollingExtreme(bars, conversionPeriod, 'low');
  const highBase = rollingExtreme(bars, basePeriod, 'high');
  const lowBase = rollingExtreme(bars, basePeriod, 'low');
  const highSpan = rollingExtreme(bars, spanPeriod, 'high');
  const lowSpan = rollingExtreme(bars, spanPeriod, 'low');

  for (let i = 0; i < length; i += 1) {
    const hc = highConversion[i];
    const lc = lowConversion[i];
    if (hc != null && lc != null) conversionRaw[i] = (hc + lc) / 2;
    const hb = highBase[i];
    const lb = lowBase[i];
    if (hb != null && lb != null) baseRaw[i] = (hb + lb) / 2;
    const hs = highSpan[i];
    const ls = lowSpan[i];
    if (hs != null && ls != null) spanBRaw[i] = (hs + ls) / 2;
    const conversion = conversionRaw[i];
    const base = baseRaw[i];
    if (conversion != null && base != null) spanARaw[i] = (conversion + base) / 2;
  }

  const spanA: Series = emptySeries(length);
  const spanB: Series = emptySeries(length);
  const lagging: Series = emptySeries(length);
  for (let i = 0; i < length; i += 1) {
    const source = i - displacement;
    if (source >= 0) {
      spanA[i] = spanARaw[source] ?? null;
      spanB[i] = spanBRaw[source] ?? null;
    }
    const ahead = i + displacement;
    lagging[i] = ahead < length ? (bars[ahead] as Bar).close : null;
  }

  return { conversion: conversionRaw, base: baseRaw, spanA, spanB, lagging };
}

export const indicatorIchimoku: IndicatorDefinition = {
  type: 'ichimoku',
  name: 'Ichimoku Cloud',
  version: 1,
  placement: 'overlay',
  category: 'Trend',
  description: 'Conversion, base, displaced leading spans A/B and a lagging close line. Displacement is plotted, not silently ignored.',
  formula: 'Tenkan = (maxH + minL)/2; Kijun = (maxH + minL)/2; SenkouA = (Tenkan+Kijun)/2; SenkouB = (maxH+minL)/2',
  parameters: [
    { key: 'conversion', label: 'Conversion period', defaultValue: 9, min: 2, max: 200, step: 1, integer: true },
    { key: 'base', label: 'Base period', defaultValue: 26, min: 2, max: 400, step: 1, integer: true },
    { key: 'span', label: 'Span B period', defaultValue: 52, min: 2, max: 400, step: 1, integer: true },
    { key: 'displacement', label: 'Displacement', defaultValue: 26, min: 0, max: 200, step: 1, integer: true },
  ],
  outputs: [
    { key: 'conversion', label: 'Conversion', kind: 'line', defaultColor: '#4f8cff' },
    { key: 'base', label: 'Base', kind: 'line', defaultColor: '#ef5a5a' },
    { key: 'spanA', label: 'Leading span A', kind: 'line', defaultColor: '#2ec27e' },
    { key: 'spanB', label: 'Leading span B', kind: 'line', defaultColor: '#f59e0b' },
    { key: 'lagging', label: 'Lagging span', kind: 'line', defaultColor: '#8b9bb4' },
  ],
  calculate(bars, parameters) {
    const result = ichimoku(
      bars,
      integerParam(parameters, 'conversion', 9, 2),
      integerParam(parameters, 'base', 26, 2),
      integerParam(parameters, 'span', 52, 2),
      integerParam(parameters, 'displacement', 26, 0),
    );
    return {
      conversion: result.conversion,
      base: result.base,
      spanA: result.spanA,
      spanB: result.spanB,
      lagging: result.lagging,
    };
  },
};
