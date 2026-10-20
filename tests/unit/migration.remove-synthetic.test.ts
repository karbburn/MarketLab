import { describe, expect, it } from 'vitest';
import type {
  BacktestConfig,
  Dataset,
  Instrument,
  ScreenerDefinition,
  Watchlist,
  Workspace,
} from '../../src/domain/types';
import { isSyntheticDataset, removeSyntheticData } from '../../src/lib/migration/remove-synthetic';

function instrument(id: string, symbol: string, extra: Partial<Instrument> = {}): Instrument {
  return {
    id,
    symbol,
    displayName: `${symbol} (Demo)`,
    assetType: 'equity',
    currency: 'USD',
    ...extra,
  };
}

function dataset(id: string, instrumentId: string, sourceKind: Dataset['sourceKind']): Dataset {
  return {
    id,
    instrumentId,
    name: `${id} - daily`,
    sourceKind,
    sourceDescription: 'test fixture',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2026-01-02',
    lastDate: '2026-01-05',
    rowCount: 2,
    importedAt: '2026-01-05T00:00:00.000Z',
    contentHash: `hash-${id}`,
    hasVolume: true,
    validation: {
      acceptedRows: 2,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
  };
}

function workspace(id: string, datasetIds: string[]): Workspace {
  return {
    id,
    name: id,
    schemaVersion: 1,
    layout: 'single',
    charts: datasetIds.map((datasetId, index) => ({
      id: `${id}-chart-${index}`,
      instrumentId: `inst-${datasetId}`,
      datasetId,
      timeframe: '1D',
      chartType: 'candlestick',
      showVolume: true,
      priceScaleMode: 'normal',
      visibleRange: null,
      indicators: [],
      drawings: [],
      compareDatasetIds: [],
    })),
    linkGroups: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function watchlist(id: string, instrumentIds: string[]): Watchlist {
  return {
    id,
    name: id,
    instrumentIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
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
    sortBy: 'return',
    sortWindow: 20,
    sortDirection: 'desc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function backtest(id: string, datasetId: string): BacktestConfig {
  return {
    id,
    name: id,
    datasetId,
    startDate: null,
    endDate: null,
    initialCapital: 100_000,
    positionSizePct: 95,
    commissionBps: 5,
    slippageBps: 5,
    stopLossPct: 8,
    takeProfitPct: null,
    entry: [],
    exit: [],
    entryLogic: 'AND',
    exitLogic: 'AND',
    execution: 'next-open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('removal of the bundled demo series', () => {
  it('leaves a library without demo series untouched', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst-aapl', 'AAPL')],
      datasets: [dataset('ds-aapl', 'inst-aapl', 'provider-download')],
      workspaces: [workspace('ws', ['ds-aapl'])],
      watchlists: [watchlist('wl', ['inst-aapl'])],
      screeners: [screener('scr', ['ds-aapl'])],
      backtests: [backtest('bt', 'ds-aapl')],
    });

    expect(result.changed).toBe(false);
    expect(result.datasets).toHaveLength(1);
    expect(result.instruments).toHaveLength(1);
    expect(result.workspaces).toHaveLength(1);
    expect(result.watchlists).toHaveLength(1);
    expect(result.screeners).toHaveLength(1);
    expect(result.backtests).toHaveLength(1);
  });

  it('removes the demo datasets and their instruments but keeps imported and downloaded series', () => {
    const result = removeSyntheticData({
      instruments: [
        instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }),
        instrument('inst-aapl', 'AAPL'),
        instrument('inst-msft', 'MSFT'),
      ],
      datasets: [
        dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'),
        dataset('ds_sample_nrg', 'inst_atx', 'bundled-sample'),
        dataset('ds-aapl', 'inst-aapl', 'user-csv'),
        dataset('ds-msft', 'inst-msft', 'provider-download'),
      ],
      workspaces: [],
      watchlists: [],
      screeners: [],
      backtests: [],
    });

    expect(result.changed).toBe(true);
    expect(result.removedDatasetIds).toEqual(['ds_sample_atx', 'ds_sample_nrg']);
    expect(result.removedInstrumentIds).toEqual(['inst_atx']);
    expect(result.datasets.map((entry) => entry.id)).toEqual(['ds-aapl', 'ds-msft']);
    expect(result.instruments.map((entry) => entry.id)).toEqual(['inst-aapl', 'inst-msft']);
  });

  it('recognises a demo series by its instrument even when the source kind differs', () => {
    const demo = dataset('ds-legacy', 'inst_atx', 'user-csv');
    expect(isSyntheticDataset(demo, instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }))).toBe(true);
    expect(isSyntheticDataset(demo, instrument('inst_atx', 'ATX'))).toBe(false);
  });

  it('drops panels that point at a removed dataset and keeps the surviving panels', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }), instrument('inst-aapl', 'AAPL')],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst-aapl', 'user-csv')],
      workspaces: [workspace('ws', ['ds_sample_atx', 'ds-aapl'])],
      watchlists: [],
      screeners: [],
      backtests: [],
    });

    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.charts.map((chart) => chart.datasetId)).toEqual(['ds-aapl']);
    expect(result.removedWorkspaceIds).toEqual([]);
  });

  it('removes a workspace that is left without any panel', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX', { metadata: { synthetic: true } })],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample')],
      workspaces: [workspace('ws', ['ds_sample_atx'])],
      watchlists: [],
      screeners: [],
      backtests: [],
    });

    expect(result.removedWorkspaceIds).toEqual(['ws']);
    expect(result.workspaces).toHaveLength(0);
  });

  it('empties watchlists of demo instruments and drops the ones it emptied', () => {
    const result = removeSyntheticData({
      instruments: [
        instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }),
        instrument('inst-aapl', 'AAPL'),
      ],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst-aapl', 'user-csv')],
      workspaces: [],
      watchlists: [watchlist('wl-demo', ['inst_atx']), watchlist('wl-mixed', ['inst_atx', 'inst-aapl']), watchlist('wl-empty', [])],
      screeners: [],
      backtests: [],
    });

    expect(result.removedWatchlistIds).toEqual(['wl-demo']);
    expect(result.watchlists.map((entry) => entry.id)).toEqual(['wl-mixed', 'wl-empty']);
    expect(result.watchlists[0]?.instrumentIds).toEqual(['inst-aapl']);
  });

  it('keeps saved screens but drops the removed datasets from their universe', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }), instrument('inst-aapl', 'AAPL')],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst-aapl', 'user-csv')],
      workspaces: [],
      watchlists: [],
      screeners: [screener('scr', ['ds_sample_atx', 'ds-aapl'])],
      backtests: [],
    });

    expect(result.screeners).toHaveLength(1);
    expect(result.screeners[0]?.universeDatasetIds).toEqual(['ds-aapl']);
  });

  it('removes saved strategies that ran on a removed dataset', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }), instrument('inst-aapl', 'AAPL')],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst-aapl', 'user-csv')],
      workspaces: [],
      watchlists: [],
      screeners: [],
      backtests: [backtest('bt-demo', 'ds_sample_atx'), backtest('bt-real', 'ds-aapl')],
    });

    expect(result.removedBacktestIds).toEqual(['bt-demo']);
    expect(result.backtests.map((entry) => entry.id)).toEqual(['bt-real']);
  });

  it('is idempotent: running it on its own output changes nothing', () => {
    const input = {
      instruments: [
        instrument('inst_atx', 'ATX', { metadata: { synthetic: true } }),
        instrument('inst-aapl', 'AAPL'),
      ],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst-aapl', 'user-csv')],
      workspaces: [workspace('ws', ['ds-aapl'])],
      watchlists: [watchlist('wl', ['inst-aapl'])],
      screeners: [screener('scr', ['ds-aapl'])],
      backtests: [backtest('bt', 'ds-aapl')],
    };

    const first = removeSyntheticData(input);
    const second = removeSyntheticData({
      instruments: first.instruments,
      datasets: first.datasets,
      workspaces: first.workspaces,
      watchlists: first.watchlists,
      screeners: first.screeners,
      backtests: first.backtests,
    });

    expect(second.changed).toBe(false);
    expect(second.datasets).toEqual(first.datasets);
    expect(second.instruments).toEqual(first.instruments);
    expect(second.workspaces).toEqual(first.workspaces);
    expect(second.watchlists).toEqual(first.watchlists);
    expect(second.screeners).toEqual(first.screeners);
    expect(second.backtests).toEqual(first.backtests);
  });

  it('keeps an instrument that a surviving dataset still uses', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX'), instrument('inst-aapl', 'AAPL')],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample'), dataset('ds-aapl', 'inst_atx', 'user-csv')],
      workspaces: [],
      watchlists: [],
      screeners: [],
      backtests: [],
    });

    expect(result.removedInstrumentIds).toEqual([]);
    expect(result.instruments).toHaveLength(2);
  });

  it('describes what it removed without claiming that real data was touched', () => {
    const result = removeSyntheticData({
      instruments: [instrument('inst_atx', 'ATX', { metadata: { synthetic: true } })],
      datasets: [dataset('ds_sample_atx', 'inst_atx', 'bundled-sample')],
      workspaces: [workspace('ws', ['ds_sample_atx'])],
      watchlists: [],
      screeners: [],
      backtests: [],
    });

    expect(result.removedDatasetIds).toHaveLength(1);
    expect(result.removedWorkspaceIds).toHaveLength(1);
  });
});
