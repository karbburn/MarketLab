import { describe, expect, it } from 'vitest';
import { planDatasetDeletion, pruneWorkspacesToDatasets } from '../../src/lib/workspace/dataset-cleanup';
import type {
  BacktestConfig,
  ChartConfig,
  ScreenerDefinition,
  Watchlist,
  Workspace,
} from '../../src/domain/types';

function chart(id: string, datasetId: string, compareDatasetIds: string[] = []): ChartConfig {
  return {
    id,
    instrumentId: `i-${datasetId}`,
    datasetId,
    timeframe: '1D',
    chartType: 'candlestick',
    showVolume: true,
    priceScaleMode: 'normal',
    visibleRange: null,
    indicators: [],
    drawings: [],
    compareDatasetIds,
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

function watchlist(id: string, instrumentIds: string[]): Watchlist {
  return { id, name: id, instrumentIds, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' };
}

function screener(id: string, universeDatasetIds: string[]): ScreenerDefinition {
  return {
    id,
    name: id,
    schemaVersion: 1,
    universeDatasetIds,
    combinators: [],
    filters: [],
    cutoff: null,
    sortBy: 'symbol',
    sortWindow: 20,
    sortDirection: 'asc',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function backtest(id: string, datasetId: string): BacktestConfig {
  return {
    id,
    name: id,
    datasetId,
    startDate: null,
    endDate: null,
    initialCapital: 10_000,
    positionSizePct: 100,
    commissionBps: 0,
    slippageBps: 0,
    stopLossPct: null,
    takeProfitPct: null,
    entry: [],
    exit: [],
    entryLogic: 'AND',
    exitLogic: 'OR',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const emptyInput = {
  workspaces: [] as Workspace[],
  watchlists: [] as Watchlist[],
  screeners: [] as ScreenerDefinition[],
  backtests: [] as BacktestConfig[],
};

describe('planDatasetDeletion', () => {
  it('drops panels that used the dataset and removes only the emptied workspaces', () => {
    const shared = workspace('ws-shared', [chart('c1', 'd1'), chart('c2', 'd2')]);
    const onlyDeleted = workspace('ws-only', [chart('c3', 'd1')]);

    const result = planDatasetDeletion({
      ...emptyInput,
      datasetId: 'd1',
      workspaces: [shared, onlyDeleted],
    });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.id).toBe('ws-shared');
    expect(result.workspaces[0]?.charts.map((entry) => entry.id)).toEqual(['c2']);
    expect(result.removedWorkspaceIds).toEqual(['ws-only']);
  });

  it('strips the dataset from comparison overlays without dropping the panel', () => {
    const ws = workspace('ws1', [chart('c1', 'd2', ['d1', 'd3'])]);

    const result = planDatasetDeletion({ ...emptyInput, datasetId: 'd1', workspaces: [ws] });

    expect(result.removedWorkspaceIds).toEqual([]);
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual(['d3']);
    expect(result.workspaces[0]?.charts[0]?.datasetId).toBe('d2');
  });

  it('removes saved strategies that ran on the dataset and keeps the others', () => {
    const result = planDatasetDeletion({
      ...emptyInput,
      datasetId: 'd1',
      backtests: [backtest('bt1', 'd1'), backtest('bt2', 'd2')],
    });

    expect(result.removedBacktestIds).toEqual(['bt1']);
    expect(result.backtests.map((entry) => entry.id)).toEqual(['bt2']);
  });

  it('filters the removed instrument out of watchlists and drops only emptied ones', () => {
    const mixed = watchlist('wl-mixed', ['i1', 'i2']);
    const emptied = watchlist('wl-emptied', ['i1']);
    const alreadyEmpty = watchlist('wl-empty', []);

    const result = planDatasetDeletion({
      ...emptyInput,
      datasetId: 'd1',
      removedInstrumentId: 'i1',
      watchlists: [mixed, emptied, alreadyEmpty],
    });

    expect(result.watchlists.map((entry) => entry.id).sort()).toEqual(['wl-empty', 'wl-mixed']);
    expect(result.watchlists.find((entry) => entry.id === 'wl-mixed')?.instrumentIds).toEqual(['i2']);
    expect(result.removedWatchlistIds).toEqual(['wl-emptied']);
  });

  it('leaves watchlists untouched when no instrument was removed', () => {
    const wl = watchlist('wl1', ['i1']);

    const result = planDatasetDeletion({ ...emptyInput, datasetId: 'd1', watchlists: [wl] });

    expect(result.watchlists).toEqual([wl]);
    expect(result.removedWatchlistIds).toEqual([]);
  });

  it('filters the dataset out of saved screener universes', () => {
    const result = planDatasetDeletion({
      ...emptyInput,
      datasetId: 'd1',
      screeners: [screener('s1', ['d1', 'd2']), screener('s2', ['d2'])],
    });

    expect(result.screeners[0]?.universeDatasetIds).toEqual(['d2']);
    expect(result.screeners[1]?.universeDatasetIds).toEqual(['d2']);
  });

  it('returns the same records when nothing references the dataset', () => {
    const ws = workspace('ws1', [chart('c1', 'd2')]);
    const wl = watchlist('wl1', ['i2']);

    const result = planDatasetDeletion({ ...emptyInput, datasetId: 'd1', workspaces: [ws], watchlists: [wl] });

    expect(result.workspaces[0]).toBe(ws);
    expect(result.watchlists[0]).toBe(wl);
    expect(result.removedWorkspaceIds).toEqual([]);
    expect(result.removedWatchlistIds).toEqual([]);
    expect(result.removedBacktestIds).toEqual([]);
  });
});

describe('pruneWorkspacesToDatasets', () => {
  const valid = new Set(['d2']);

  it('drops panels and comparison overlays that resolve to no dataset', () => {
    const mixed = workspace('ws-mixed', [
      chart('c-dangling', 'd1'),
      chart('c-valid', 'd2', ['d1', 'd3', 'd2', 'd2']),
    ]);

    const result = pruneWorkspacesToDatasets([mixed], valid);

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.charts).toHaveLength(1);
    expect(result.workspaces[0]?.charts[0]?.id).toBe('c-valid');
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual([]);
    expect(result.removed).toEqual([
      { workspaceId: 'ws-mixed', removedChartIds: ['c-dangling'], workspaceRemoved: false },
    ]);
  });

  it('drops a workspace whose every panel is dangling', () => {
    const onlyDeleted = workspace('ws-only', [chart('c1', 'd1'), chart('c2', 'd9')]);

    const result = pruneWorkspacesToDatasets([onlyDeleted], valid);

    expect(result.workspaces).toEqual([]);
    expect(result.removed).toEqual([
      { workspaceId: 'ws-only', removedChartIds: ['c1', 'c2'], workspaceRemoved: true },
    ]);
  });

  it('keeps an untouched workspace by identity', () => {
    const untouched = workspace('ws1', [chart('c1', 'd2', ['d2'])]);

    const result = pruneWorkspacesToDatasets([untouched], valid);

    // A self-comparison is pruned, so this record does change; a genuinely
    // clean record below must stay the same object.
    expect(result.workspaces[0]?.charts[0]?.compareDatasetIds).toEqual([]);

    const clean = workspace('ws2', [chart('c2', 'd2', [])]);
    const second = pruneWorkspacesToDatasets([clean], valid);
    expect(second.workspaces[0]).toBe(clean);
    expect(second.removed).toEqual([]);
  });
});
