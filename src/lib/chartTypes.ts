import type { ChartType } from '../domain/types';

/**
 * Display order and labels for every chart-type selector.
 *
 * Kept in one place so the chart panel and the workspace-defaults selector
 * cannot drift apart (they previously each hard-coded the same list).
 */
export const CHART_TYPE_OPTIONS: ReadonlyArray<{ value: ChartType; label: string }> = [
  { value: 'candlestick', label: 'Candles' },
  { value: 'bar', label: 'Bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'baseline', label: 'Baseline' },
];
