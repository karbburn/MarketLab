/**
 * Decides how to open an already-stored dataset in the chart workspace.
 *
 * Pure so both the command palette and the historical screener share one rule
 * and it can be unit-tested without a store:
 *
 * 1. If the dataset is already shown by a panel, activate that workspace and
 *    change nothing - opening the same series twice would leave a duplicate.
 * 2. Otherwise re-point the active workspace's first panel, which is the
 *    existing "carry this dataset into the chart" behaviour.
 *
 * The caller performs the plan through the store actions.
 */

import type { Workspace } from '../../domain/types';

export type DatasetActivationPlan =
  | { kind: 'activate-workspace'; workspaceId: string }
  | { kind: 'repoint-chart'; workspaceId: string; chartId: string }
  | { kind: 'unavailable'; reason: 'unknown-dataset' | 'no-workspace' | 'no-chart' };

export interface DatasetActivationInput {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string | null;
  datasetId: string;
  /**
   * Ids that still exist locally. When supplied, an id outside the set is a
   * stale reference (deleted between render and activation) and is refused
   * rather than re-pointing a panel at a dataset that is not stored.
   */
  knownDatasetIds?: ReadonlySet<string>;
}

export function planDatasetActivation(input: DatasetActivationInput): DatasetActivationPlan {
  if (input.knownDatasetIds && !input.knownDatasetIds.has(input.datasetId)) {
    return { kind: 'unavailable', reason: 'unknown-dataset' };
  }

  const active =
    input.workspaces.find((workspace) => workspace.id === input.activeWorkspaceId) ?? input.workspaces[0] ?? null;

  if (active && active.charts.some((chart) => chart.datasetId === input.datasetId)) {
    return { kind: 'activate-workspace', workspaceId: active.id };
  }

  const existing = input.workspaces.find((workspace) =>
    workspace.charts.some((chart) => chart.datasetId === input.datasetId),
  );
  if (existing) return { kind: 'activate-workspace', workspaceId: existing.id };

  if (!active) return { kind: 'unavailable', reason: 'no-workspace' };
  const chart = active.charts[0];
  if (!chart) return { kind: 'unavailable', reason: 'no-chart' };
  return { kind: 'repoint-chart', workspaceId: active.id, chartId: chart.id };
}
