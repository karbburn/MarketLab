import type { Workspace } from '../../domain/types';

/**
 * Normalises stored comparison selections.
 *
 * Comparison ids are dataset references, so they must never outlive the dataset
 * they point at. Every chart gets a real array (older workspaces stored none)
 * and ids that no longer resolve to a stored dataset are dropped. The function
 * is pure and idempotent: running it twice changes nothing.
 */
export function normaliseCompareSelections(
  workspaces: readonly Workspace[],
  validDatasetIds: ReadonlySet<string>,
): { workspaces: Workspace[]; changed: boolean } {
  let changed = false;

  const next = workspaces.map((workspace) => {
    let workspaceChanged = false;
    const charts = workspace.charts.map((chart) => {
      const stored: unknown = chart.compareDatasetIds;
      const current = Array.isArray(stored) ? (stored as string[]) : [];
      const valid = current.filter(
        (id, index) => validDatasetIds.has(id) && id !== chart.datasetId && current.indexOf(id) === index,
      );
      if (Array.isArray(stored) && valid.length === current.length) return chart;
      workspaceChanged = true;
      return { ...chart, compareDatasetIds: valid };
    });
    if (!workspaceChanged) return workspace;
    changed = true;
    return { ...workspace, charts };
  });

  return { workspaces: next, changed };
}
