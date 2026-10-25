/**
 * Cleanup plan for deleting a dataset.
 *
 * A dataset can be referenced from more places than the chart panels that use
 * it directly: comparison overlays, saved screens, saved strategies and
 * watchlists. Deleting the dataset without cleaning those references leaves
 * records that can never resolve again (`Backtest` runs on a missing dataset,
 * watchlist rows silently vanish), so the same rules the bundled-sample
 * migration applies are applied here.
 *
 * The plan is pure: the store computes it, persists it, and only then updates
 * memory, which keeps the rules testable without a store harness.
 */

import type { BacktestConfig, ScreenerDefinition, Watchlist, Workspace } from '../../domain/types';

export interface DatasetDeletionInput {
  datasetId: string;
  /**
   * The instrument removed together with the dataset, when no surviving dataset
   * still uses it. Watchlist entries pointing at it must go too.
   */
  removedInstrumentId?: string | null;
  workspaces: readonly Workspace[];
  watchlists: readonly Watchlist[];
  screeners: readonly ScreenerDefinition[];
  backtests: readonly BacktestConfig[];
}

export interface DatasetDeletionResult {
  workspaces: Workspace[];
  removedWorkspaceIds: string[];
  watchlists: Watchlist[];
  removedWatchlistIds: string[];
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
  removedBacktestIds: string[];
}

export function planDatasetDeletion(input: DatasetDeletionInput): DatasetDeletionResult {
  const removedInstrumentId = input.removedInstrumentId ?? null;

  const removedWorkspaceIds: string[] = [];
  const workspaces: Workspace[] = [];
  for (const workspace of input.workspaces) {
    let changed = false;
    const charts = workspace.charts
      .filter((chart) => chart.datasetId !== input.datasetId)
      .map((chart) => {
        // A removed dataset must not survive as a comparison overlay either.
        const compareDatasetIds = (chart.compareDatasetIds ?? []).filter((id) => id !== input.datasetId);
        if (compareDatasetIds.length === (chart.compareDatasetIds ?? []).length) return chart;
        changed = true;
        return { ...chart, compareDatasetIds };
      });
    if (charts.length !== workspace.charts.length) changed = true;
    if (charts.length === 0) {
      // A workspace without a panel cannot render anything; the same rule the
      // bundled-sample migration uses.
      removedWorkspaceIds.push(workspace.id);
      continue;
    }
    workspaces.push(changed ? { ...workspace, charts } : workspace);
  }

  const removedWatchlistIds: string[] = [];
  const watchlists: Watchlist[] = [];
  for (const watchlist of input.watchlists) {
    if (removedInstrumentId === null) {
      watchlists.push(watchlist);
      continue;
    }
    const instrumentIds = watchlist.instrumentIds.filter((id) => id !== removedInstrumentId);
    if (instrumentIds.length === watchlist.instrumentIds.length) {
      watchlists.push(watchlist);
      continue;
    }
    if (instrumentIds.length === 0) {
      // Only drop a watchlist that this deletion emptied. A watchlist the user
      // left empty on purpose did not point at the deleted instrument.
      if (watchlist.instrumentIds.length > 0) {
        removedWatchlistIds.push(watchlist.id);
        continue;
      }
      watchlists.push(watchlist);
      continue;
    }
    watchlists.push({ ...watchlist, instrumentIds });
  }

  const screeners = input.screeners.map((screener) => {
    const universeDatasetIds = screener.universeDatasetIds.filter((id) => id !== input.datasetId);
    return universeDatasetIds.length === screener.universeDatasetIds.length
      ? screener
      : { ...screener, universeDatasetIds };
  });

  const removedBacktestIds: string[] = [];
  const backtests: BacktestConfig[] = [];
  for (const backtest of input.backtests) {
    if (backtest.datasetId === input.datasetId) {
      removedBacktestIds.push(backtest.id);
      continue;
    }
    backtests.push(backtest);
  }

  return {
    workspaces,
    removedWorkspaceIds,
    watchlists,
    removedWatchlistIds,
    screeners,
    backtests,
    removedBacktestIds,
  };
}

export interface PrunedWorkspaceReference {
  workspaceId: string;
  removedChartIds: string[];
  /** True when every panel was pruned, so the workspace itself is gone. */
  workspaceRemoved: boolean;
}

export interface WorkspaceDatasetPruneResult {
  workspaces: Workspace[];
  removed: PrunedWorkspaceReference[];
}

/**
 * Drops panels and comparison overlays whose dataset does not exist.
 *
 * Restore is the one path that can receive references and datasets from
 * different sources: a backup's dataset may be rejected (bad bars, missing
 * instrument, content-hash mismatch) while its workspace still names it. The
 * same rules as dataset deletion apply: a panel with no dataset cannot render,
 * and a workspace with no panels is removed. The result also reports what was
 * dropped so a pre-restore summary can say so instead of silently shrinking the
 * restored library.
 */
export function pruneWorkspacesToDatasets(
  workspaces: readonly Workspace[],
  validDatasetIds: ReadonlySet<string>,
): WorkspaceDatasetPruneResult {
  const removed: PrunedWorkspaceReference[] = [];
  const kept: Workspace[] = [];

  for (const workspace of workspaces) {
    const removedChartIds: string[] = [];
    const charts: Workspace['charts'] = [];
    let changed = false;

    for (const chart of workspace.charts) {
      if (!validDatasetIds.has(chart.datasetId)) {
        removedChartIds.push(chart.id);
        changed = true;
        continue;
      }
      const current = chart.compareDatasetIds ?? [];
      const compareDatasetIds = current.filter(
        (id, index) => validDatasetIds.has(id) && id !== chart.datasetId && current.indexOf(id) === index,
      );
      if (compareDatasetIds.length !== current.length) {
        changed = true;
        charts.push({ ...chart, compareDatasetIds });
      } else {
        charts.push(chart);
      }
    }

    if (charts.length === 0) {
      removed.push({ workspaceId: workspace.id, removedChartIds, workspaceRemoved: true });
      continue;
    }
    if (removedChartIds.length > 0) {
      removed.push({ workspaceId: workspace.id, removedChartIds, workspaceRemoved: false });
    }
    kept.push(changed ? { ...workspace, charts } : workspace);
  }

  return { workspaces: kept, removed };
}
