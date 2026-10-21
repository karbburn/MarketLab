import { describe, expect, it } from 'vitest';
import type { ChartConfig, ChartTemplate } from '../../src/domain/types';
import { applyChartTemplate, createChartTemplate } from '../../src/lib/chart/templates';
import { createBackup, mergeBackup, parseBackup } from '../../src/lib/export/backup';
import { STORE_NAMES } from '../../src/lib/persistence/db';
import { CHART_TEMPLATE_SCHEMA_VERSION, parseChartTemplate } from '../../src/lib/workspace/schema';

function chart(): ChartConfig {
  return {
    id: 'chart-1',
    instrumentId: 'inst-1',
    datasetId: 'ds-1',
    timeframe: '1D',
    chartType: 'candlestick',
    showVolume: true,
    priceScaleMode: 'normal',
    visibleRange: { from: '2024-01-02', to: '2024-02-01' },
    indicators: [
      {
        id: 'ind-live',
        type: 'sma',
        version: 1,
        parameters: { period: 20 },
        visible: true,
        placement: 'overlay',
        style: { color: '#3fb8a3', lineWidth: 2 },
      },
    ],
    drawings: [
      {
        id: 'drawing-1',
        type: 'horizontal-line',
        anchors: [{ date: '2024-01-05', price: 100 }],
        visible: true,
        locked: false,
        style: { color: '#ffffff', lineWidth: 1.5 },
      },
    ],
    compareDatasetIds: ['ds-2'],
  };
}

describe('chart templates', () => {
  it('captures presentation and indicators without data, range, comparisons or drawings', () => {
    const template = createChartTemplate(chart(), 'Trend review');
    expect(template.chartType).toBe('candlestick');
    expect(template.indicators).toHaveLength(1);
    expect(template.schemaVersion).toBe(CHART_TEMPLATE_SCHEMA_VERSION);
    expect(JSON.stringify(template)).not.toContain('ds-1');
    expect(JSON.stringify(template)).not.toContain('inst-1');
    expect(template).not.toHaveProperty('datasetId');
    expect(template).not.toHaveProperty('visibleRange');
    expect(template).not.toHaveProperty('drawings');
    expect(template).not.toHaveProperty('compareDatasetIds');
  });

  it('detaches stored indicators from the live chart', () => {
    const source = chart();
    const template = createChartTemplate(source, 'Copy');
    template.indicators[0]!.parameters.period = 50;
    template.indicators[0]!.style.color = '#ff0000';
    expect(source.indicators[0]?.parameters.period).toBe(20);
    expect(source.indicators[0]?.style.color).toBe('#3fb8a3');
  });

  it('applies presentation and indicators while preserving the destination series and annotations', () => {
    const destination = chart();
    const template: ChartTemplate = {
      id: 'tpl-1',
      name: 'Weekly review',
      schemaVersion: 1,
      chartType: 'line',
      priceScaleMode: 'logarithmic',
      showVolume: false,
      timeframe: '1W',
      indicators: [
        {
          id: 'tpl-ind',
          type: 'ema',
          version: 1,
          parameters: { period: 50 },
          visible: false,
          placement: 'pane',
          style: { color: '#4f8cff' },
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const applied = applyChartTemplate(destination, template);
    expect(applied.id).toBe('chart-1');
    expect(applied.datasetId).toBe('ds-1');
    expect(applied.instrumentId).toBe('inst-1');
    expect(applied.visibleRange).toEqual({ from: '2024-01-02', to: '2024-02-01' });
    expect(applied.compareDatasetIds).toEqual(['ds-2']);
    expect(applied.drawings).toBe(destination.drawings);
    expect(applied.chartType).toBe('line');
    expect(applied.priceScaleMode).toBe('logarithmic');
    expect(applied.showVolume).toBe(false);
    expect(applied.timeframe).toBe('1W');
    expect(applied.indicators).toEqual([
      {
        id: expect.any(String),
        type: 'ema',
        version: 1,
        parameters: { period: 50 },
        visible: false,
        placement: 'pane',
        style: { color: '#4f8cff' },
      },
    ]);
    expect(applied.indicators[0]?.id).not.toBe('tpl-ind');
  });

  it('gives each application fresh indicator identities', () => {
    const template = createChartTemplate(chart(), 'Shared');
    const first = applyChartTemplate(chart(), template);
    const second = applyChartTemplate(chart(), template);
    expect(first.indicators[0]?.id).not.toBe(second.indicators[0]?.id);
    expect(first.indicators[0]?.parameters).not.toBe(second.indicators[0]?.parameters);
  });

  it('does not alias the template parameter or style objects on apply', () => {
    const template = createChartTemplate(chart(), 'Detached');
    const applied = applyChartTemplate(chart(), template);
    applied.indicators[0]!.parameters.period = 200;
    applied.indicators[0]!.style.color = '#000000';
    expect(template.indicators[0]?.parameters.period).toBe(20);
    expect(template.indicators[0]?.style.color).toBe('#3fb8a3');
  });
});

describe('chart template validation', () => {
  const template = createChartTemplate(chart(), 'Valid');

  it('accepts a captured template', () => {
    expect(parseChartTemplate(template).ok).toBe(true);
  });

  it('rejects a template written by a newer schema', () => {
    const result = parseChartTemplate({ ...template, schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it('rejects an unknown chart type instead of coercing it', () => {
    expect(parseChartTemplate({ ...template, chartType: 'hlc-area' }).ok).toBe(false);
  });

  it('rejects a template with a missing name', () => {
    expect(parseChartTemplate({ ...template, name: '' }).ok).toBe(false);
  });

  it('preserves an unknown indicator type, which the chart degrades at render time', () => {
    const result = parseChartTemplate({
      ...template,
      indicators: [{ ...template.indicators[0], type: 'future-indicator' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.indicators[0]?.type).toBe('future-indicator');
  });
});

describe('chart template persistence contracts', () => {
  it('registers a dedicated store without dropping existing stores', () => {
    expect(STORE_NAMES).toContain('chartTemplates');
    expect(STORE_NAMES).toEqual(
      expect.arrayContaining(['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests']),
    );
  });

  it('round-trips templates through a backup and merges by id', () => {
    const template = createChartTemplate(chart(), 'Round trip');
    const bundle = createBackup({
      instruments: [],
      datasets: [],
      bars: [],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
      chartTemplates: [template],
    });
    const parsed = parseBackup(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.chartTemplates).toEqual([template]);

    const merged = mergeBackup(
      {
        instruments: [],
        datasets: [],
        barsByDataset: {},
        workspaces: [],
        watchlists: [],
        screeners: [],
        backtests: [],
        chartTemplates: [{ ...template, name: 'Older' }],
      },
      bundle,
    );
    expect(merged.chartTemplates).toHaveLength(1);
    expect(merged.chartTemplates[0]?.name).toBe('Round trip');
  });

  it('loads a backup written before templates existed as an empty list', () => {
    const bundle = createBackup({
      instruments: [],
      datasets: [],
      bars: [],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
    });
    const legacy = { ...bundle } as Record<string, unknown>;
    delete legacy.chartTemplates;
    const parsed = parseBackup(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.chartTemplates).toEqual([]);
  });

  it('skips a malformed template in an imported backup without rejecting the file', () => {
    const bundle = createBackup({
      instruments: [],
      datasets: [],
      bars: [],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
      chartTemplates: [createChartTemplate(chart(), 'Good')],
    });
    const parsed = parseBackup({ ...bundle, chartTemplates: [...(bundle.chartTemplates ?? []), { id: 'bad' }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.chartTemplates).toHaveLength(1);
    expect(parsed.skipped).toContain('chartTemplates:bad');
  });

  it('skips a template written by a newer schema instead of applying it', () => {
    const template = createChartTemplate(chart(), 'Future');
    const bundle = createBackup({
      instruments: [],
      datasets: [],
      bars: [],
      workspaces: [],
      watchlists: [],
      preferences: null,
      screeners: [],
      backtests: [],
      chartTemplates: [{ ...template, schemaVersion: CHART_TEMPLATE_SCHEMA_VERSION + 1 }],
    });
    const parsed = parseBackup(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.chartTemplates).toEqual([]);
    expect(parsed.skipped).toContain(`chartTemplates:${template.id}`);
  });
});
