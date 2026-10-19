/**
 * Removal of the bundled synthetic demo series.
 *
 * MarketLab used to seed six deterministic, locally generated demo instruments
 * (ATX, NRG, FNX, HLX, QTM, MLAB-IDX) on first run. They were never real
 * market data, and they are no longer created: the application now works on
 * real historical bars downloaded through the local market-data service or
 * imported from a CSV file.
 *
 * Browsers that ran an earlier build still hold those demo records in
 * IndexedDB. This module computes exactly what has to go and what has to
 * stay, so the removal can be applied on load without touching a single
 * imported, downloaded or user-created record.
 *
 * Rules:
 * - Only datasets that are recognised as demo series are removed. A dataset is
 *   recognised by its `bundled-sample` source kind, or by an instrument that is
 *   flagged as synthetic. Imported CSVs and provider downloads never match.
 * - Bars of a removed dataset are removed with it; nothing else is touched.
 * - An instrument is removed only when it belonged to a removed dataset and no
 *   surviving dataset still uses it.
 * - Panels pointing at a removed dataset are dropped. A workspace that is left
 *   without any panel is removed as well, because a workspace without a panel
 *   cannot render anything.
 * - Watchlists lose the removed instruments. A watchlist that only held demo
 *   instruments is removed; a watchlist that was already empty is kept.
 * - Saved screens keep their filters but lose the removed datasets from their
 *   universe; a screen with an empty universe is still a valid saved screen.
 * - Saved strategies that ran on a removed dataset are removed, because they
 *   can no longer be simulated.
 *
 * The function is pure and idempotent: running it again on its own output
 * changes nothing.
 */

import type {
  BacktestConfig,
  Dataset,
  Instrument,
  ScreenerDefinition,
  Watchlist,
  Workspace,
} from '../../domain/types';

/**
 * The source kind the bundled demo series used. It is no longer created, but
 * the value stays in the type union so older stored data and older backups
 * still validate instead of failing to load.
 */
export const LEGACY_SAMPLE_SOURCE = 'bundled-sample';

/** True when a dataset is one of the bundled demo series. */
export function isSyntheticDataset(dataset: Dataset, instrument: Instrument | undefined): boolean {
  if (dataset.sourceKind === LEGACY_SAMPLE_SOURCE) return true;
  return instrument?.metadata?.synthetic === true;
}

export interface SyntheticCleanupInput {
  instruments: readonly Instrument[];
  datasets: readonly Dataset[];
  workspaces: readonly Workspace[];
  watchlists: readonly Watchlist[];
  screeners: readonly ScreenerDefinition[];
  backtests: readonly BacktestConfig[];
}

export interface SyntheticCleanupResult {
  /** True when at least one demo dataset was found and something was removed. */
  changed: boolean;
  removedDatasetIds: string[];
  removedInstrumentIds: string[];
  removedWorkspaceIds: string[];
  removedWatchlistIds: string[];
  removedBacktestIds: string[];
  instruments: Instrument[];
  datasets: Dataset[];
  workspaces: Workspace[];
  watchlists: Watchlist[];
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
}

/**
 * Computes the removal of the bundled demo series. Returns the input untouched
 * when there is nothing to remove, so it is safe to call on every load.
 */
export function removeSyntheticData(input: SyntheticCleanupInput): SyntheticCleanupResult {
  const instrumentsById = new Map(input.instruments.map((instrument) => [instrument.id, instrument]));

  const removedDatasetIds: string[] = [];
  const datasets: Dataset[] = [];
  for (const dataset of input.datasets) {
    if (isSyntheticDataset(dataset, instrumentsById.get(dataset.instrumentId))) removedDatasetIds.push(dataset.id);
    else datasets.push(dataset);
  }

  if (removedDatasetIds.length === 0) {
    return {
      changed: false,
      removedDatasetIds: [],
      removedInstrumentIds: [],
      removedWorkspaceIds: [],
      removedWatchlistIds: [],
      removedBacktestIds: [],
      instruments: [...input.instruments],
      datasets: [...input.datasets],
      workspaces: [...input.workspaces],
      watchlists: [...input.watchlists],
      screeners: [...input.screeners],
      backtests: [...input.backtests],
    };
  }

  const removedDatasetIdSet = new Set(removedDatasetIds);
  const survivingInstrumentIds = new Set(datasets.map((dataset) => dataset.instrumentId));
  const demoInstrumentIds = new Set(
    input.datasets.filter((dataset) => removedDatasetIdSet.has(dataset.id)).map((dataset) => dataset.instrumentId),
  );
  const removedInstrumentIds = [...demoInstrumentIds].filter((id) => !survivingInstrumentIds.has(id));
  const removedInstrumentIdSet = new Set(removedInstrumentIds);

  const instruments = input.instruments.filter((instrument) => !removedInstrumentIdSet.has(instrument.id));

  const removedWorkspaceIds: string[] = [];
  const workspaces: Workspace[] = [];
  for (const workspace of input.workspaces) {
    const charts = workspace.charts.filter((chart) => !removedDatasetIdSet.has(chart.datasetId));
    if (charts.length === 0) {
      removedWorkspaceIds.push(workspace.id);
      continue;
    }
    workspaces.push(charts.length === workspace.charts.length ? workspace : { ...workspace, charts });
  }

  const removedWatchlistIds: string[] = [];
  const watchlists: Watchlist[] = [];
  for (const watchlist of input.watchlists) {
    const instrumentIds = watchlist.instrumentIds.filter((id) => !removedInstrumentIdSet.has(id));
    if (instrumentIds.length === 0) {
      // Only drop a watchlist that the removal emptied. A watchlist the user
      // left empty on purpose is not demo data and stays.
      if (watchlist.instrumentIds.length > 0) {
        removedWatchlistIds.push(watchlist.id);
        continue;
      }
      watchlists.push(watchlist);
      continue;
    }
    watchlists.push(instrumentIds.length === watchlist.instrumentIds.length ? watchlist : { ...watchlist, instrumentIds });
  }

  const screeners: ScreenerDefinition[] = input.screeners.map((screener) => {
    const universeDatasetIds = screener.universeDatasetIds.filter((id) => !removedDatasetIdSet.has(id));
    return universeDatasetIds.length === screener.universeDatasetIds.length
      ? screener
      : { ...screener, universeDatasetIds };
  });

  const removedBacktestIds: string[] = [];
  const backtests: BacktestConfig[] = [];
  for (const backtest of input.backtests) {
    if (removedDatasetIdSet.has(backtest.datasetId)) {
      removedBacktestIds.push(backtest.id);
      continue;
    }
    backtests.push(backtest);
  }

  return {
    changed: true,
    removedDatasetIds,
    removedInstrumentIds,
    removedWorkspaceIds,
    removedWatchlistIds,
    removedBacktestIds,
    instruments,
    datasets,
    workspaces,
    watchlists,
    screeners,
    backtests,
  };
}

/** A short, honest summary of what a cleanup removed. */
export function describeCleanup(result: SyntheticCleanupResult): string {
  if (!result.changed) return 'No bundled demo data was found.';
  const parts = [`${result.removedDatasetIds.length} demo dataset(s)`];
  if (result.removedWorkspaceIds.length > 0) parts.push(`${result.removedWorkspaceIds.length} workspace(s)`);
  if (result.removedWatchlistIds.length > 0) parts.push(`${result.removedWatchlistIds.length} watchlist(s)`);
  if (result.removedBacktestIds.length > 0) parts.push(`${result.removedBacktestIds.length} saved strateg(y/ies)`);
  return `Removed ${parts.join(' and ')}. Your imported and downloaded data was kept.`;
}
