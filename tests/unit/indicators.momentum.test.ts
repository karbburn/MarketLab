import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  indicatorMacd,
  indicatorRsi,
  indicatorStochastic,
  rsi,
} from '../../src/lib/indicators/momentum';

function bar(index: number, open: number, high: number, low: number, close: number): Bar {
  return { date: `2024-01-${String(index + 1).padStart(2, '0')}`, open, high, low, close, volume: 1000 };
}

function barsFromCloses(values: readonly number[]): Bar[] {
  return values.map((close, index) => bar(index, close, close + 1, close - 1, close));
}

describe('rsi', () => {
  it('matches the input length and leaves warm-up positions null', () => {
    const output = rsi([10, 11, 10.5, 11.5, 12], 2);
    expect(output).toHaveLength(5);
    expect(output[0]).toBeNull();
    expect(output[1]).toBeNull();
    expect(output[2]).not.toBeNull();
  });

  it('returns 100 for a monotonically rising series with no losses', () => {
    expect(rsi([1, 2, 3, 4, 5], 2)).toEqual([null, null, 100, 100, 100]);
  });

  it('returns the neutral 50 for a flat series', () => {
    expect(rsi([5, 5, 5, 5, 5], 2)).toEqual([null, null, 50, 50, 50]);
  });

  it('computes Wilder-smoothed values against hand-derived numbers', () => {
    // seed window changes +1, -0.5 -> avgGain 0.5, avgLoss 0.25 -> 100 - 100/(1+2) = 66.6667
    // next change +1 -> avgGain 0.75, avgLoss 0.125 -> 100 - 100/7 = 85.7143
    // next change +0.5 -> avgGain 0.625, avgLoss 0.0625 -> 100 - 100/11 = 90.9091
    const output = rsi([10, 11, 10.5, 11.5, 12], 2);
    expect(output[2] as number).toBeCloseTo(66.6667, 3);
    expect(output[3] as number).toBeCloseTo(85.7143, 3);
    expect(output[4] as number).toBeCloseTo(90.9091, 3);
  });

  it('is exposed through the indicator definition with an output of equal length', () => {
    const bars = barsFromCloses([1, 2, 3, 4, 5]);
    const outputs = indicatorRsi.calculate(bars, { period: 2 });
    expect(outputs.rsi).toHaveLength(bars.length);
    expect(outputs.rsi?.[4]).toBe(100);
  });
});

describe('macd', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 2) * 3);
  const bars = barsFromCloses(closes);

  it('produces macd, signal and histogram arrays the same length as the input', () => {
    const outputs = indicatorMacd.calculate(bars, { fast: 3, slow: 5, signal: 3 });
    expect(outputs.macd).toHaveLength(bars.length);
    expect(outputs.signal).toHaveLength(bars.length);
    expect(outputs.histogram).toHaveLength(bars.length);
  });

  it('leaves macd null until the slow EMA is seeded (index slow - 1)', () => {
    const outputs = indicatorMacd.calculate(bars, { fast: 3, slow: 5, signal: 3 });
    expect(outputs.macd?.[3]).toBeNull();
    expect(outputs.macd?.[4]).not.toBeNull();
  });

  it('keeps the histogram equal to macd minus signal wherever both are defined', () => {
    const outputs = indicatorMacd.calculate(bars, { fast: 3, slow: 5, signal: 3 });
    const { macd, signal, histogram } = outputs;
    let checked = 0;
    for (let i = 0; i < bars.length; i += 1) {
      const m = macd?.[i];
      const s = signal?.[i];
      const h = histogram?.[i];
      if (m != null && s != null) {
        expect(h as number).toBeCloseTo(m - s, 10);
        checked += 1;
      } else {
        expect(h).toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('stochastic', () => {
  it('matches the input length and leaves the %K / %D warm-up null', () => {
    const bars = [
      bar(0, 7, 10, 5, 7),
      bar(1, 11, 12, 8, 11),
      bar(2, 10, 11, 9, 10),
    ];
    const outputs = indicatorStochastic.calculate(bars, { period: 2, kSmooth: 1, dSmooth: 1 });
    expect(outputs.k).toHaveLength(3);
    expect(outputs.d).toHaveLength(3);
    expect(outputs.k?.[0]).toBeNull();
    expect(outputs.d?.[0]).toBeNull();
  });

  it('computes raw %K from the highest high and lowest low of the window', () => {
    // index 1: window high 12, low 5, close 11 -> 100*(11-5)/(12-5) = 85.7143
    // index 2: window high 12, low 8, close 10 -> 100*(10-8)/(12-8) = 50
    const bars = [
      bar(0, 7, 10, 5, 7),
      bar(1, 11, 12, 8, 11),
      bar(2, 10, 11, 9, 10),
    ];
    const outputs = indicatorStochastic.calculate(bars, { period: 2, kSmooth: 1, dSmooth: 1 });
    expect(outputs.k?.[1] as number).toBeCloseTo(85.7143, 3);
    expect(outputs.k?.[2] as number).toBeCloseTo(50, 10);
    expect(outputs.d?.[1] as number).toBeCloseTo(85.7143, 3);
  });

  it('returns the neutral 50 when the window high equals the window low', () => {
    const bars = [bar(0, 10, 10, 10, 10), bar(1, 10, 10, 10, 10), bar(2, 10, 10, 10, 10)];
    const outputs = indicatorStochastic.calculate(bars, { period: 2, kSmooth: 1, dSmooth: 1 });
    expect(outputs.k?.[1]).toBe(50);
    expect(outputs.k?.[2]).toBe(50);
  });
});
