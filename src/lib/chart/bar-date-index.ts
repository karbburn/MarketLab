import type { Bar } from '../../domain/types';

/**
 * Session date to array position for the bars currently rendered in a panel.
 *
 * Bars are unique by session, and the first occurrence wins so the lookup
 * matches what `Array.findIndex` returned before this index existed.
 */
export function createBarDateIndex(bars: readonly Bar[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (let position = 0; position < bars.length; position += 1) {
    const date = (bars[position] as Bar).date;
    if (!index.has(date)) index.set(date, position);
  }
  return index;
}
