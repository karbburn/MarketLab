import { describe, expect, it } from 'vitest';
import type { DrawingAnchor } from '../../src/domain/types';
import {
  ANCHOR_HIT_TOLERANCE_PX,
  MAGNET_SNAP_TOLERANCE_PX,
  hitTestDrawingAnchor,
  nearestOhlcPrice,
  nudgeDrawingAnchor,
  replaceDrawingAnchor,
  snapPriceToBar,
  stackAxisTags,
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

describe('keyboard anchor nudging', () => {
  const sessions = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];

  it('moves to the next and previous rendered session', () => {
    const anchor = { date: '2026-01-05', price: 100 };
    expect(nudgeDrawingAnchor(anchor, sessions, { sessions: 1, price: 0 })).toEqual({
      date: '2026-01-06',
      price: 100,
    });
    expect(nudgeDrawingAnchor(anchor, sessions, { sessions: -1, price: 0 })).toEqual({
      date: '2026-01-02',
      price: 100,
    });
  });

  it('clamps at the first and last session without changing identity', () => {
    const first = { date: '2026-01-02', price: 100 };
    const last = { date: '2026-01-07', price: 100 };
    expect(nudgeDrawingAnchor(first, sessions, { sessions: -1, price: 0 })).toBe(first);
    expect(nudgeDrawingAnchor(last, sessions, { sessions: 5, price: 0 })).toBe(last);
  });

  it('starts from the nearest session when the stored date is no longer rendered', () => {
    // A Sunday between two sessions resolves forward to the next displayed bar.
    expect(nudgeDrawingAnchor({ date: '2026-01-04', price: 100 }, sessions, { sessions: 1, price: 0 })).toEqual({
      date: '2026-01-06',
      price: 100,
    });
  });

  it('applies price steps without binary floating-point drift', () => {
    const anchor = { date: '2026-01-05', price: 0.1 };
    expect(nudgeDrawingAnchor(anchor, sessions, { sessions: 0, price: 0.01 }).price).toBe(0.11);
    expect(nudgeDrawingAnchor(anchor, sessions, { sessions: 0, price: 0.02 }).price).toBe(0.12);
  });

  it('returns the same anchor when there is nothing to move', () => {
    const anchor = { date: '2026-01-05', price: 100 };
    expect(nudgeDrawingAnchor(anchor, sessions, { sessions: 0, price: 0 })).toBe(anchor);
    expect(nudgeDrawingAnchor(anchor, [], { sessions: 1, price: 0 })).toBe(anchor);
  });
});

describe('axis tag stacking', () => {
  it('collapses duplicate labels and orders tags by screen position', () => {
    const tags = stackAxisTags(
      [
        { key: 'second', y: 80, label: '110.00' },
        { key: 'first', y: 20, label: '100.00' },
        { key: 'duplicate', y: 24, label: '100.00' },
      ],
      200,
    );
    expect(tags.map((tag) => [tag.key, tag.label])).toEqual([
      ['first', '100.00'],
      ['second', '110.00'],
    ]);
  });

  it('pushes overlapping tags apart while keeping the axis order', () => {
    const tags = stackAxisTags(
      [
        { key: 'a', y: 100, label: '100.00' },
        { key: 'b', y: 101, label: '100.01' },
        { key: 'c', y: 102, label: '100.02' },
      ],
      300,
    );
    expect(tags.map((tag) => tag.key)).toEqual(['a', 'b', 'c']);
    expect(tags[1]!.y - tags[0]!.y).toBeGreaterThanOrEqual(18);
    expect(tags[2]!.y - tags[1]!.y).toBeGreaterThanOrEqual(18);
  });

  it('keeps every tag inside the axis height', () => {
    const tags = stackAxisTags(
      [
        { key: 'top', y: 0, label: '1.00' },
        { key: 'bottom', y: 100, label: '2.00' },
      ],
      100,
    );
    expect(tags[0]!.y).toBeGreaterThanOrEqual(9);
    expect(tags[1]!.y).toBeLessThanOrEqual(91);
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
