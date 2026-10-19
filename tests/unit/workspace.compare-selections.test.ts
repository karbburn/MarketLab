import { describe, expect, it } from 'vitest';
import type { ChartConfig, Workspace } from '../../src/domain/types';
import { normaliseCompareSelections } from '../../src/lib/workspace/compare-selections';

function chart(id: string, compareDatasetIds: unknown): ChartConfig {
  return {
    id,
    instrumentId: `inst_${id}`,
    datasetId: `ds_${id}`,
    timeframe: '1D',
    chartType: 'candlestick',
    showVolume: true,
    priceScaleMode: 'normal',
    visibleRange: null,
    indicators: [],
    drawings: [],
    compareDatasetIds: compareDatasetIds as string[],
  };
}

function workspace(id: string, charts: ChartConfig[]): Workspace {
  return {
    id,
    name: id,
    schemaVersion: 1,
    layout: 'single',
    charts,
    linkGroups: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('normaliseCompareSelections', () => {
  it('gives older charts an empty selection array', () => {
    const stale = chart('a', undefined);
    const result = normaliseCompareSelections([workspace('ws', [stale])], new Set(['ds_a']));
    expect(result.changed).toBe(true);
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual([]);
  });

  it('drops ids whose dataset no longer exists', () => {
    const first = chart('a', ['ds_b', 'ds_deleted', 'ds_c']);
    const result = normaliseCompareSelections([workspace('ws', [first])], new Set(['ds_a', 'ds_b', 'ds_c']));
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual(['ds_b', 'ds_c']);
    expect(result.changed).toBe(true);
  });

  it('drops a self-reference and duplicate ids', () => {
    const first = chart('a', ['ds_a', 'ds_b', 'ds_b']);
    const result = normaliseCompareSelections([workspace('ws', [first])], new Set(['ds_a', 'ds_b']));
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual(['ds_b']);
  });

  it('is idempotent and reports no change when everything is valid', () => {
    const first = chart('a', ['ds_b']);
    const original = workspace('ws', [first]);
    const result = normaliseCompareSelections([original], new Set(['ds_a', 'ds_b']));
    expect(result.changed).toBe(false);
    expect(result.workspaces[0]).toBe(original);
    const again = normaliseCompareSelections(result.workspaces, new Set(['ds_a', 'ds_b']));
    expect(again.changed).toBe(false);
    expect(again.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual(['ds_b']);
  });

  it('keeps selections on unaffected panels when another panel loses its dataset', () => {
    const workspaces = [workspace('ws', [chart('a', ['ds_b']), chart('b', ['ds_a'])])];
    const result = normaliseCompareSelections(workspaces, new Set(['ds_a', 'ds_b']));
    expect(result.changed).toBe(false);
    expect(result.workspaces[0]?.charts.map((entry) => entry.compareDatasetIds)).toEqual([['ds_b'], ['ds_a']]);
  });

  it('leaves every panel empty when the library is empty', () => {
    const result = normaliseCompareSelections([workspace('ws', [chart('a', ['ds_b'])])], new Set());
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual([]);
  });
});
