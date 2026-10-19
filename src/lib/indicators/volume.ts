import type { Bar } from '../../domain/types';
import type { IndicatorDefinition } from '../../domain/indicators/types';
import { emptySeries, integerParam, sma } from './core';
import type { Series } from './core';

/**
 * Anchored / cumulative VWAP.
 *
 * This is a cumulative calculation from the first available bar, not a session
 * VWAP. Daily-only data has no intraday session boundary, so the series is
 * labelled "Anchored VWAP" everywhere in the UI. Volume gaps keep the point
 * unavailable rather than treating missing volume as zero.
 */
export function anchoredVwap(bars: readonly Bar[]): Series {
  const output = emptySeries(bars.length);
  let priceVolume = 0;
  let volumeSum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i] as Bar;
    if (bar.volume === null || bar.volume <= 0) {
      output[i] = null;
      continue;
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    priceVolume += typical * bar.volume;
    volumeSum += bar.volume;
    output[i] = volumeSum > 0 ? priceVolume / volumeSum : null;
  }
  return output;
}

export const indicatorVwap: IndicatorDefinition = {
  type: 'vwap',
  name: 'Anchored VWAP',
  version: 1,
  placement: 'overlay',
  category: 'Volume',
  description: 'Cumulative volume-weighted average price from the start of the loaded series. Requires volume; not a session VWAP.',
  formula: 'VWAP_t = Σ(typicalPrice * volume) / Σ(volume)',
  parameters: [],
  outputs: [{ key: 'vwap', label: 'VWAP', kind: 'line', defaultColor: '#22d3ee' }],
  calculate(bars) {
    return { vwap: anchoredVwap(bars) };
  },
};

export function volumeSma(bars: readonly Bar[], period: number): Series {
  const output = emptySeries(bars.length);
  let recent: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const volume = (bars[i] as Bar).volume;
    if (volume === null) {
      recent = [];
      continue;
    }
    recent.push(volume);
    if (recent.length > period) recent = recent.slice(recent.length - period);
    output[i] = recent.length === period ? recent.reduce((a, b) => a + b, 0) / period : null;
  }
  return output;
}

export function relativeVolume(bars: readonly Bar[], period: number): Series {
  const baseline = volumeSma(bars, period);
  const output = emptySeries(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const volume = (bars[i] as Bar).volume;
    const base = baseline[i];
    output[i] = volume != null && base != null && base > 0 ? volume / base : null;
  }
  return output;
}

export const indicatorVolumeSma: IndicatorDefinition = {
  type: 'volume-sma',
  name: 'Volume SMA and Relative Volume',
  version: 1,
  placement: 'pane',
  category: 'Volume',
  description: 'Rolling average volume and volume divided by that average. Missing volume stays unavailable.',
  formula: 'VolumeSMA = SMA(volume, N); RelativeVolume = volume / VolumeSMA',
  parameters: [{ key: 'period', label: 'Period', defaultValue: 20, min: 2, max: 200, step: 1, integer: true }],
  outputs: [
    { key: 'volumeSma', label: 'Volume SMA', kind: 'line', defaultColor: '#8b9bb4' },
    { key: 'relativeVolume', label: 'Relative volume', kind: 'line', defaultColor: '#22d3ee' },
  ],
  calculate(bars, parameters) {
    const period = integerParam(parameters, 'period', 20, 2);
    return { volumeSma: volumeSma(bars, period), relativeVolume: relativeVolume(bars, period) };
  },
};

export function obv(bars: readonly Bar[]): Series {
  const output = emptySeries(bars.length);
  let cumulative = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i] as Bar;
    if (bar.volume === null) {
      output[i] = null;
      continue;
    }
    if (i > 0) {
      const previousClose = (bars[i - 1] as Bar).close;
      if (bar.close > previousClose) cumulative += bar.volume;
      else if (bar.close < previousClose) cumulative -= bar.volume;
      // Equal closes leave OBV unchanged by definition.
    }
    output[i] = cumulative;
  }
  return output;
}

export const indicatorObv: IndicatorDefinition = {
  type: 'obv',
  name: 'On-Balance Volume',
  version: 1,
  placement: 'pane',
  category: 'Volume',
  description: 'Cumulative signed volume. Equal closes do not change the series; missing volume leaves a gap.',
  formula: 'OBV_t = OBV_(t-1) + sign(close_t - close_(t-1)) * volume_t',
  parameters: [],
  outputs: [{ key: 'obv', label: 'OBV', kind: 'line', defaultColor: '#4f8cff' }],
  calculate(bars) {
    return { obv: obv(bars) };
  },
};

/** Kept for screener/quant reuse. */
export function simpleMovingAverage(values: readonly number[], period: number): Series {
  return sma(values, period);
}
