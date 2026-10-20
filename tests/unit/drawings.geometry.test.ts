import { describe, expect, it } from 'vitest';
import type { DrawingAnchor } from '../../src/domain/types';
import {
  ANCHOR_HIT_TOLERANCE_PX,
  MAGNET_SNAP_TOLERANCE_PX,
  hitTestDrawingAnchor,
  nearestOhlcPrice,
  replaceDrawingAnchor,
  snapPriceToBar,
} from '../../src/lib/drawings/geometry';

const bar = { open: 98, high: 102, low: 96, close: 100 };

function anchors(): DrawingAnchor[] {
  return [
    { date: '2026-01-02', price: 100 },
    { date: '2026-01-05', price: 110 },
  ];
}

describe('drawing anchor hit testing', () => {
  it('returns the nearest visible handle and preserves its original index', () => {
    const screenAnchors = [null, { x: 100, y: 50 }, { x: 200, y: 100 }];
    expect(hitTestDrawingAnchor(screenAnchors, { x: 104, y: 52 })).toBe(1);
    expect(hitTestDrawingAnchor(screenAnchors, { x: 197, y: 98 })).toBe(2);
  });

  it('ignores anchors outside the viewport and points beyond the tolerance', () => {
    const screenAnchors = [null, { x: 100, y: 50 }];
    expect(hitTestDrawingAnchor(screenAnchors, { x: 0, y: 0 })).toBeNull();
    expect(
      hitTestDrawingAnchor(screenAnchors, {
        x: 100 + ANCHOR_HIT_TOLERANCE_PX + 1,
        y: 50,
      }),
    ).toBeNull();
  });

  it('accepts a point on the tolerance boundary', () => {
    expect(
      hitTestDrawingAnchor([{ x: 50, y: 50 }], {
        x: 50 + ANCHOR_HIT_TOLERANCE_PX,
        y: 50,
      }),
    ).toBe(0);
  });

  it('prefers the closer of two overlapping handles', () => {
    const screenAnchors = [
      { x: 100, y: 100 },
      { x: 104, y: 100 },
    ];
    expect(hitTestDrawingAnchor(screenAnchors, { x: 103, y: 100 })).toBe(1);
    expect(hitTestDrawingAnchor(screenAnchors, { x: 101, y: 100 })).toBe(0);
  });
});

describe('drawing anchor replacement', () => {
  it('moves only the addressed anchor', () => {
    const current = anchors();
    const next = replaceDrawingAnchor(current, 0, { date: '2026-01-03', price: 104 });
    expect(next).not.toBe(current);
    expect(next[0]).toEqual({ date: '2026-01-03', price: 104 });
    expect(next[1]).toBe(current[1]);
  });

  it('returns the same array for an unchanged or missing anchor', () => {
    const current = anchors();
    expect(replaceDrawingAnchor(current, 0, { ...current[0]! })).toBe(current);
    expect(replaceDrawingAnchor(current, 5, { date: '2026-01-03', price: 104 })).toBe(current);
  });
});

describe('magnet snapping', () => {
  it('chooses the nearest OHLC value, not an arbitrary price', () => {
    expect(nearestOhlcPrice(97.9, bar)).toBe(98);
    expect(nearestOhlcPrice(101.8, bar)).toBe(102);
    expect(nearestOhlcPrice(96.2, bar)).toBe(96);
    expect(nearestOhlcPrice(99.9, bar)).toBe(100);
  });

  it('snaps within the screen-pixel tolerance', () => {
    const yForPrice = (price: number) => 500 - price;
    expect(snapPriceToBar(101.8, bar, yForPrice)).toBe(102);
    expect(snapPriceToBar(98.2, bar, yForPrice)).toBe(98);
  });

  it('keeps the raw price when the nearest OHLC value is too far away on screen', () => {
    const yForPrice = (price: number) => 500 - price;
    expect(snapPriceToBar(80, bar, yForPrice)).toBe(80);
    const tight = (price: number) => 500 - price * 30;
    expect(snapPriceToBar(101.5, bar, tight, MAGNET_SNAP_TOLERANCE_PX)).toBe(101.5);
  });

  it('keeps the raw price when the chart cannot project the price', () => {
    expect(snapPriceToBar(101.8, bar, () => null)).toBe(101.8);
  });
});
