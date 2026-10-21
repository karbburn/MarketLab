import type { ChartConfig, ChartTemplate, IndicatorInstance } from '../../domain/types';
import { createId } from '../id';
import { CHART_TEMPLATE_SCHEMA_VERSION } from '../workspace/schema';

/**
 * Copies one indicator instance with a fresh identity and detached parameter and
 * style objects, so a stored template never aliases a live chart.
 */
function cloneIndicator(instance: IndicatorInstance): IndicatorInstance {
  return {
    ...instance,
    id: createId('ind'),
    parameters: { ...instance.parameters },
    style: { ...instance.style },
  };
}

/** Captures presentation and indicators from a chart. Data and drawings stay out. */
export function createChartTemplate(chart: ChartConfig, name: string, now = new Date().toISOString()): ChartTemplate {
  return {
    id: createId('tpl'),
    name: name.trim() || 'Untitled template',
    schemaVersion: CHART_TEMPLATE_SCHEMA_VERSION,
    chartType: chart.chartType,
    priceScaleMode: chart.priceScaleMode,
    showVolume: chart.showVolume,
    timeframe: chart.timeframe,
    indicators: chart.indicators.map(cloneIndicator),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Applies a template to one panel.
 *
 * The dataset, instrument, visible range, comparisons and drawings of the
 * destination are deliberately preserved. Indicators are deep-cloned with fresh
 * ids, so applying the same template to two panels cannot share identities.
 */
export function applyChartTemplate(chart: ChartConfig, template: ChartTemplate): ChartConfig {
  return {
    ...chart,
    chartType: template.chartType,
    priceScaleMode: template.priceScaleMode,
    showVolume: template.showVolume,
    timeframe: template.timeframe,
    indicators: template.indicators.map(cloneIndicator),
  };
}
