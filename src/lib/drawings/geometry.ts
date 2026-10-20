import type { Bar, Drawing, DrawingAnchor, DrawingType } from '../../domain/types';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** How many anchors a drawing type needs before it is considered complete. */
export function anchorsRequired(type: DrawingType): number {
  switch (type) {
    case 'horizontal-line':
    case 'vertical-line':
    case 'text':
      return 1;
    default:
      return 2;
  }
}

export function isDrawingComplete(drawing: Pick<Drawing, 'type' | 'anchors'>): boolean {
  return drawing.anchors.length >= anchorsRequired(drawing.type);
}

export function drawingPriceBounds(anchors: readonly DrawingAnchor[]): { low: number; high: number } | null {
  if (anchors.length === 0) return null;
  const first = anchors[0] as DrawingAnchor;
  let low = first.price;
  let high = first.price;
  for (const anchor of anchors) {
    if (anchor.price < low) low = anchor.price;
    if (anchor.price > high) high = anchor.price;
  }
  return { low, high };
}

export function drawingDateBounds(anchors: readonly DrawingAnchor[]): { from: string; to: string } | null {
  if (anchors.length === 0) return null;
  let from = (anchors[0] as DrawingAnchor).date;
  let to = from;
  for (const anchor of anchors) {
    if (anchor.date < from) from = anchor.date;
    if (anchor.date > to) to = anchor.date;
  }
  return { from, to };
}

export interface PriceRangeInfo {
  from: number;
  to: number;
  delta: number;
  pct: number;
}

/** Measured-move readout for a two-anchor selection. */
export function priceRangeInfo(drawing: Pick<Drawing, 'anchors'>): PriceRangeInfo | null {
  const first = drawing.anchors[0];
  const second = drawing.anchors[1];
  if (!first || !second || first.price === 0) return null;
  const delta = second.price - first.price;
  return { from: first.price, to: second.price, delta, pct: (delta / Math.abs(first.price)) * 100 };
}

/**
 * Fibonacci retracement price for a level, measured from the first anchor to the
 * second. Level 0 sits at the first anchor, level 1 at the second.
 */
export function fibPriceAt(first: DrawingAnchor, second: DrawingAnchor, level: number): number {
  return first.price + (second.price - first.price) * level;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projectedX = start.x + t * dx;
  const projectedY = start.y + t * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-pixel radius around a selected drawing's anchor handle. */
export const ANCHOR_HIT_TOLERANCE_PX = 8;

/** How close a pointer has to be to an OHLC value before magnet mode snaps. */
export const MAGNET_SNAP_TOLERANCE_PX = 12;

/**
 * Returns the index of the closest visible anchor handle within `tolerance`.
 * `null` entries mean an anchor could not be projected at the current zoom.
 */
export function hitTestDrawingAnchor(
  screenAnchors: readonly (ScreenPoint | null)[],
  point: ScreenPoint,
  tolerance = ANCHOR_HIT_TOLERANCE_PX,
): number | null {
  let bestIndex: number | null = null;
  let bestDistance = tolerance;
  for (let index = 0; index < screenAnchors.length; index += 1) {
    const anchor = screenAnchors[index];
    if (!anchor) continue;
    const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    if (distance <= bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

/** Replaces one anchor while leaving the rest of the drawing untouched. */
export function replaceDrawingAnchor(
  anchors: DrawingAnchor[],
  index: number,
  next: DrawingAnchor,
): DrawingAnchor[] {
  const current = anchors[index];
  if (!current) return anchors;
  if (current.date === next.date && current.price === next.price) return anchors;
  const updated = [...anchors];
  updated[index] = { date: next.date, price: next.price };
  return updated;
}

/** The open, high, low or close value closest to the pointer's raw price. */
export function nearestOhlcPrice(
  price: number,
  bar: Pick<Bar, 'open' | 'high' | 'low' | 'close'>,
): number {
  let closest = bar.open;
  let closestDistance = Math.abs(bar.open - price);
  for (const candidate of [bar.high, bar.low, bar.close]) {
    const distance = Math.abs(candidate - price);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Snaps a raw price to the nearest OHLC value when the two are close enough on
 * screen. The pixel check keeps the gesture usable under linear and log scales,
 * where equal price distances do not map to equal screen distances.
 */
export function snapPriceToBar(
  price: number,
  bar: Pick<Bar, 'open' | 'high' | 'low' | 'close'>,
  priceToY: (value: number) => number | null,
  tolerance = MAGNET_SNAP_TOLERANCE_PX,
): number {
  const candidate = nearestOhlcPrice(price, bar);
  if (candidate === price) return price;
  const rawY = priceToY(price);
  const candidateY = priceToY(candidate);
  if (rawY === null || candidateY === null) return price;
  if (Math.abs(rawY - candidateY) > tolerance) return price;
  return candidate;
}

/**
 * Hit-tests a drawing against a screen point. The caller supplies the screen
 * positions of each anchor, so this helper stays independent of the chart engine
 * and can be unit tested directly.
 */
export function hitTestDrawing(screenAnchors: readonly ScreenPoint[], type: DrawingType, point: ScreenPoint, tolerance = 6): boolean {
  if (screenAnchors.length === 0) return false;
  if (screenAnchors.length === 1) {
    const anchor = screenAnchors[0] as ScreenPoint;
    return Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance * 2;
  }
  if (type === 'horizontal-line') {
    const anchor = screenAnchors[0] as ScreenPoint;
    return Math.abs(point.y - anchor.y) <= tolerance;
  }
  if (type === 'vertical-line') {
    const anchor = screenAnchors[0] as ScreenPoint;
    return Math.abs(point.x - anchor.x) <= tolerance;
  }
  for (let i = 0; i < screenAnchors.length - 1; i += 1) {
    const start = screenAnchors[i] as ScreenPoint;
    const end = screenAnchors[i + 1] as ScreenPoint;
    if (type === 'rectangle') {
      const minX = Math.min(start.x, end.x) - tolerance;
      const maxX = Math.max(start.x, end.x) + tolerance;
      const minY = Math.min(start.y, end.y) - tolerance;
      const maxY = Math.max(start.y, end.y) + tolerance;
      const nearEdge =
        Math.abs(point.x - minX) <= tolerance ||
        Math.abs(point.x - maxX) <= tolerance ||
        Math.abs(point.y - minY) <= tolerance ||
        Math.abs(point.y - maxY) <= tolerance;
      if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY && nearEdge) return true;
      continue;
    }
    if (distanceToSegment(point, start, end) <= tolerance) return true;
  }
  return false;
}

export function sortAnchorsByDate(anchors: readonly DrawingAnchor[]): DrawingAnchor[] {
  return [...anchors].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
