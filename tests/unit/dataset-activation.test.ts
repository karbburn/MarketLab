import { describe, expect, it } from 'vitest';
import type { ChartConfig, Workspace } from '../../src/domain/types';
import { planDatasetActivation } from '../../src/lib/workspace/dataset-activation';

function chart(id: string, datasetId: string): ChartConfig {
  return {
    id,
    instrumentId: `inst_${datasetId}`,
    datasetId,
    timeframe: '1D',
    chartType: 'candlestick',
    showVolume: true,
    priceScaleMode: 'normal',
    visibleRange: null,
    indicators: [],
    drawings: [],
    compareDatasetIds: [],
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

describe('planDatasetActivation', () => {
  it('re-points the first chart of the active workspace', () => {
    const plan = planDatasetActivation({
      workspaces: [workspace('ws_a', [chart('chart_1', 'ds_aapl')])],
      activeWorkspaceId: 'ws_a',
      datasetId: 'ds_msft',
    });
    expect(plan).toEqual({ kind: 'repoint-chart', workspaceId: 'ws_a', chartId: 'chart_1' });
  });

  it('falls back to the first workspace when none is marked active', () => {
    const plan = planDatasetActivation({
      workspaces: [workspace('ws_a', [chart('chart_1', 'ds_aapl')])],
      activeWorkspaceId: null,
      datasetId: 'ds_msft',
    });
    expect(plan).toEqual({ kind: 'repoint-chart', workspaceId: 'ws_a', chartId: 'chart_1' });
  });

  it('activates the workspace that already shows the dataset instead of duplicating it', () => {
    const plan = planDatasetActivation({
      workspaces: [workspace('ws_a', [chart('chart_1', 'ds_aapl')]), workspace('ws_b', [chart('chart_2', 'ds_msft')])],
      activeWorkspaceId: 'ws_a',
      datasetId: 'ds_msft',
    });
    expect(plan).toEqual({ kind: 'activate-workspace', workspaceId: 'ws_b' });
  });

  it('leaves the active workspace untouched when its own chart already shows the dataset', () => {
    const plan = planDatasetActivation({
      workspaces: [workspace('ws_a', [chart('chart_1', 'ds_aapl')])],
      activeWorkspaceId: 'ws_a',
      datasetId: 'ds_aapl',
    });
    expect(plan).toEqual({ kind: 'activate-workspace', workspaceId: 'ws_a' });
  });

  it('refuses a dataset that is no longer in the local library', () => {
    const plan = planDatasetActivation({
      workspaces: [workspace('ws_a', [chart('chart_1', 'ds_aapl')])],
      activeWorkspaceId: 'ws_a',
      datasetId: 'ds_deleted',
      knownDatasetIds: new Set(['ds_aapl']),
    });
    expect(plan).toEqual({ kind: 'unavailable', reason: 'unknown-dataset' });
  });

  it('reports an empty application rather than inventing a panel', () => {
    const noWorkspaces = planDatasetActivation({ workspaces: [], activeWorkspaceId: null, datasetId: 'ds_aapl' });
    expect(noWorkspaces).toEqual({ kind: 'unavailable', reason: 'no-workspace' });

    const noCharts = planDatasetActivation({
      workspaces: [workspace('ws_a', [])],
      activeWorkspaceId: 'ws_a',
      datasetId: 'ds_aapl',
    });
    expect(noCharts).toEqual({ kind: 'unavailable', reason: 'no-chart' });
  });
});
