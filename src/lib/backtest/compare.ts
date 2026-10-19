import type { ScreenerOperator } from '../../domain/types';

export type OperatorComparison = ScreenerOperator;

/** Compares a current/previous pair against a threshold with explicit cross semantics. */
export function compare(
  operator: ScreenerOperator,
  current: number | null,
  previous: number | null,
  threshold: number,
): boolean {
  if (current === null) return false;
  switch (operator) {
    case 'gt':
      return current > threshold;
    case 'gte':
      return current >= threshold;
    case 'lt':
      return current < threshold;
    case 'lte':
      return current <= threshold;
    case 'crosses-above':
      return previous !== null && previous <= threshold && current > threshold;
    case 'crosses-below':
      return previous !== null && previous >= threshold && current < threshold;
  }
}
