import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  anchoredVwap,
  obv,
  relativeVolume,
  volumeSma,
} from '../../src/lib/indicators/volume';

function makeBar(index: number, open: number, high: number, low: number, close: number, volume: number | null): Bar {
  return { date: `2024-01-${String(index + 1).padStart(2, '0')}`, open, high, low, close, volume };
}

describe('anchoredVwap', () => {
  it('matches a hand-computed cumulative typical-price / volume ratio', () => {
    // typical prices: 9, 11, 10
    // i=0: (9*100)/100 = 9
    // i=1: (900 + 11*200)/300 = 3100/300 = 10.3333
    // i=2: (3100 + 10*100)/400 = 4100/400 = 10.25
    const bars = [
      makeBar(0, 9, 10, 8, 9, 100),
      makeBar(1, 11, 12, 10, 11, 200),
      makeBar(2, 10, 11, 9, 10, 100),
    ];
    const vwap = anchoredVwap(bars);
    expect(vwap[0] as number).toBeCloseTo(9, 10);
    expect(vwap[1] as number).toBeCloseTo(10.3333, 3);
    expect(vwap[2] as number).toBeCloseTo(10.25, 10);
  });

  it('keeps a point unavailable when volume is missing rather than treating it as zero', () => {
    const bars = [
      makeBar(0, 9, 10, 8, 9, 100),
      makeBar(1, 11, 12, 10, 11, null),
      makeBar(2, 10, 11, 9, 10, 100),
    ];
    const vwap = anchoredVwap(bars);
    expect(vwap[1]).toBeNull();
    // The missing bar contributes nothing; cumulative sum stays at bar 0.
    expect(vwap[2] as number).toBeCloseTo((900 + 1000) / 200, 6);
  });
});

describe('obv', () => {
  it('adds volume on up closes, subtracts on down closes and skips equal closes', () => {
    const volumes = [5, 10, 20, 3, 7];
    const closes = [10, 11, 11, 9, 12];
    const bars = closes.map((close, index) => makeBar(index, close, close + 1, close - 1, close, volumes[index] as number));
    // i=0: 0; i=1: +10 = 10; i=2 equal -> 10; i=3: -3 = 7; i=4: +7 = 14
    expect(obv(bars)).toEqual([0, 10, 10, 7, 14]);
  });

  it('leaves a gap when volume is missing', () => {
    const bars = [
      makeBar(0, 10, 11, 9, 10, 5),
      makeBar(1, 11, 12, 10, 11, null),
      makeBar(2, 12, 13, 11, 12, 7),
    ];
    const output = obv(bars);
    expect(output[1]).toBeNull();
    // The missing bar contributes no volume but its close (11) is still the
    // reference for the next bar, so bar 2 (close 12) adds 7.
    expect(output[2]).toBe(7);
  });
});

describe('volumeSma / relativeVolume', () => {
  it('averages the trailing window of volumes', () => {
    const volumes = [10, 20, 30, 40];
    const bars = volumes.map((volume, index) => makeBar(index, 10, 11, 9, 10, volume));
    expect(volumeSma(bars, 2)).toEqual([null, 15, 25, 35]);
  });

  it('computes relative volume as volume divided by the volume SMA', () => {
    const volumes = [10, 20, 30, 40];
    const bars = volumes.map((volume, index) => makeBar(index, 10, 11, 9, 10, volume));
    const rel = relativeVolume(bars, 2);
    expect(rel[0]).toBeNull();
    expect(rel[1] as number).toBeCloseTo(20 / 15, 10);
    expect(rel[2] as number).toBeCloseTo(30 / 25, 10);
    expect(rel[3] as number).toBeCloseTo(40 / 35, 10);
  });

  it('resets the rolling window when a volume gap is encountered', () => {
    const bars = [
      makeBar(0, 10, 11, 9, 10, 10),
      makeBar(1, 10, 11, 9, 10, 20),
      makeBar(2, 10, 11, 9, 10, null),
      makeBar(3, 10, 11, 9, 10, 40),
    ];
    const baseline = volumeSma(bars, 2);
    expect(baseline[0]).toBeNull();
    expect(baseline[1]).toBe(15);
    expect(baseline[2]).toBeNull();
    expect(baseline[3]).toBeNull();
    const rel = relativeVolume(bars, 2);
    expect(rel[3]).toBeNull();
  });
});
