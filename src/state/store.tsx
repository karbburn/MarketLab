import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BacktestConfig,
  BacktestRun,
  Bar,
  ChartTemplate,
  Dataset,
  Instrument,
  ScreenerDefinition,
  UserPreferences,
  Watchlist,
  Workspace,
} from '../domain/types';
import { createPersistence, type PersistenceAdapter, type PersistenceTransaction, type StoreName } from '../lib/persistence/db';
import { describeCleanup, removeSyntheticData } from '../lib/migration/remove-synthetic';
import { APP_SCHEMA_VERSION, DEFAULT_PREFERENCES, createWatchlist, createWorkspace } from './defaults';
import { createId } from '../lib/id';
import { mergeBackup, isEmptyReplaceRestore, type BackupBundle } from '../lib/export/backup';
import { normaliseCompareSelections } from '../lib/workspace/compare-selections';
import { resolveSortWindow } from '../lib/screener/fields';
import { planDatasetDeletion } from '../lib/workspace/dataset-cleanup';
import { describeDatasetBundleProblem } from '../lib/validation/dataset-bundle';
import { planResearchRunSave, withResearchRunName, RESEARCH_RUN_SCHEMA_VERSION } from '../lib/backtest/research-runs';
import { parseBacktestRun } from '../lib/workspace/schema';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface DatasetBundle {
  instrument: Instrument;
  dataset: Dataset;
  bars: Bar[];
}

export interface AppState {
  status: 'loading' | 'ready';
  /** Set when the initial read fails so the shell can say so instead of showing an empty library. */
  loadError: string | null;
  adapterKind: 'indexeddb' | 'memory';
  instruments: Instrument[];
  datasets: Dataset[];
  barsByDataset: Record<string, Bar[]>;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  watchlists: Watchlist[];
  preferences: UserPreferences;
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
  chartTemplates: ChartTemplate[];
  backtestRuns: BacktestRun[];
  toasts: Toast[];
}

export interface StoreActions {
  /**
   * Stores a dataset (and its instrument/bars). `silent` suppresses the
   * per-dataset toast, which a bulk download replaces with its own summary.
   */
  importDataset(bundle: DatasetBundle, options?: { silent?: boolean }): Promise<void>;
  deleteDataset(datasetId: string): Promise<void>;
  createWorkspaceFromBase(input: { name: string; datasetId: string; instrumentId: string; layout?: Workspace['layout'] }): Promise<string | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  updateWorkspace(workspaceId: string, updater: (workspace: Workspace) => Workspace): Promise<void>;
  updateChart(workspaceId: string, chartId: string, updater: (chart: import('../domain/types').ChartConfig) => import('../domain/types').ChartConfig): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  setActiveWorkspace(workspaceId: string): Promise<void>;
  saveWatchlist(watchlist: Watchlist): Promise<void>;
  createWatchlistNamed(name: string, instrumentIds?: string[]): Promise<string>;
  deleteWatchlist(watchlistId: string): Promise<void>;
  saveScreener(definition: ScreenerDefinition): Promise<void>;
  deleteScreener(screenerId: string): Promise<void>;
  saveBacktest(config: BacktestConfig): Promise<void>;
  deleteBacktest(backtestId: string): Promise<void>;
  saveChartTemplate(template: ChartTemplate): Promise<void>;
  deleteChartTemplate(templateId: string): Promise<void>;
  /** Saves an immutable run; resolves false and reports why when it cannot. */
  saveBacktestRun(run: BacktestRun): Promise<boolean>;
  /** Changes only the run's display name; recorded inputs and outputs stay intact. */
  renameBacktestRun(runId: string, name: string): Promise<boolean>;
  deleteBacktestRun(runId: string): Promise<void>;
  setPreferences(partial: Partial<UserPreferences>): Promise<void>;
  restoreBackup(bundle: BackupBundle, mode: 'merge' | 'replace'): Promise<void>;
  resetAll(): Promise<void>;
  notify(kind: ToastKind, message: string): void;
  dismissToast(id: string): void;
}

interface StoreValue {
  state: AppState;
  actions: StoreActions;
}

const StoreContext = createContext<StoreValue | null>(null);

type PreferencesRecord = UserPreferences & { id: string };
type BarsRecord = { id: string; bars: Bar[] };
type SettingsRecord = { id: string; schemaVersion: number; installedAt: string; syntheticDataRemovedAt?: string | null };

const EMPTY_STATE: AppState = {
  status: 'loading',
  loadError: null,
  adapterKind: 'memory',
  instruments: [],
  datasets: [],
  barsByDataset: {},
  workspaces: [],
  activeWorkspaceId: null,
  watchlists: [],
  preferences: DEFAULT_PREFERENCES,
  screeners: [],
  backtests: [],
  chartTemplates: [],
  backtestRuns: [],
  toasts: [],
};

const LOAD_STORES: StoreName[] = [
  'instruments',
  'datasets',
  'bars',
  'workspaces',
  'watchlists',
  'screeners',
  'backtests',
  'chartTemplates',
  'researchRuns',
  'preferences',
  'settings',
];

interface LoadedSnapshot {
  instruments: Instrument[];
  datasets: Dataset[];
  barsByDataset: Record<string, Bar[]>;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  watchlists: Watchlist[];
  preferences: UserPreferences;
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
  chartTemplates: ChartTemplate[];
  backtestRuns: BacktestRun[];
}

/**
 * Reads one consistent snapshot and applies the same clean-up/migration rules
 * on first load and after a cross-tab change. The read is a single read-only
 * transaction so another tab cannot commit between stores and produce a mix.
 * Exported so the migration's atomicity can be tested with a stub adapter.
 */
export async function loadState(adapter: PersistenceAdapter): Promise<{ snapshot: LoadedSnapshot; notice: string | null }> {
  const { instruments, datasets, barRecords, workspaces, watchlists, screeners, backtests, chartTemplates, backtestRuns, preferencesRecords, settings } =
    await adapter.transaction(
      LOAD_STORES,
      async (tx) => {
        const [instruments, datasets, barRecords, workspaces, watchlists, screeners, backtests, chartTemplates, backtestRuns, preferencesRecords, settings] = await Promise.all([
          tx.list<Instrument>('instruments'),
          tx.list<Dataset>('datasets'),
          tx.list<BarsRecord>('bars'),
          tx.list<Workspace>('workspaces'),
          tx.list<Watchlist>('watchlists'),
          tx.list<ScreenerDefinition>('screeners'),
          tx.list<BacktestConfig>('backtests'),
          tx.list<ChartTemplate>('chartTemplates'),
          tx.list<BacktestRun>('researchRuns'),
          tx.list<PreferencesRecord>('preferences'),
          tx.list<SettingsRecord>('settings'),
        ]);
        return { instruments, datasets, barRecords, workspaces, watchlists, screeners, backtests, chartTemplates, backtestRuns, preferencesRecords, settings };
      },
      { mode: 'readonly', notify: false },
    );

  const barsByDataset: Record<string, Bar[]> = {};
  for (const record of barRecords) barsByDataset[record.id] = record.bars;

  let preferences = preferencesRecords[0] ? stripPreferenceId(preferencesRecords[0]) : DEFAULT_PREFERENCES;

  // Records are validated on every write, but storage can also carry a run that
  // predates a validation rule or was corrupted out-of-band. Future-version
  // records are only quarantined (a newer build may need them); anything else
  // that fails the schema is dropped from state and from storage, mirroring
  // how the migration removes records it can never serve.
  const validatedRuns: BacktestRun[] = [];
  let droppedRunCount = 0;
  let futureRunCount = 0;
  const droppedRunIds: string[] = [];
  for (const record of backtestRuns) {
    const parsed = parseBacktestRun(record);
    if (parsed.ok) {
      validatedRuns.push(parsed.value);
      continue;
    }
    const version = (record as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === 'number' && Number.isInteger(version) && version > RESEARCH_RUN_SCHEMA_VERSION) {
      futureRunCount += 1;
      continue;
    }
    droppedRunCount += 1;
    droppedRunIds.push(record.id);
  }
  if (droppedRunIds.length > 0) {
    // One best-effort transaction; a failure here leaves the records on disk
    // undropped and the next load retries, which stays safe because the
    // snapshot below already excludes them either way.
    try {
      await adapter.transaction(['researchRuns'], async (tx) => {
        for (const runId of droppedRunIds) await tx.remove('researchRuns', runId);
      }, { notify: false });
    } catch {
      // Excluded from state regardless; persistence cleanup is retried next load.
    }
  }

  // Remove the bundled demo series, if an earlier build left them behind.
  const cleanup = removeSyntheticData({ instruments, datasets, workspaces, watchlists, screeners, backtests });
  if (cleanup.changed) {
    const migrationPreferences =
      preferences.defaultWorkspaceId && cleanup.removedWorkspaceIds.includes(preferences.defaultWorkspaceId)
        ? ({ ...preferences, defaultWorkspaceId: null } as UserPreferences)
        : null;
    if (migrationPreferences) preferences = migrationPreferences;
    // The whole migration is one transaction: a quota or connection failure
    // rolls everything back instead of leaving, for example, a dataset whose
    // bars were already removed. The next load retries the untouched migration.
    await adapter.transaction(LOAD_STORES, async (tx) => {
      if (migrationPreferences) {
        await tx.put<PreferencesRecord>('preferences', { id: 'preferences', ...migrationPreferences });
      }
      for (const datasetId of cleanup.removedDatasetIds) {
        await tx.remove('datasets', datasetId);
        await tx.remove('bars', datasetId);
      }
      for (const instrumentId of cleanup.removedInstrumentIds) await tx.remove('instruments', instrumentId);
      for (const workspaceId of cleanup.removedWorkspaceIds) await tx.remove('workspaces', workspaceId);
      for (const watchlistId of cleanup.removedWatchlistIds) await tx.remove('watchlists', watchlistId);
      for (const backtestId of cleanup.removedBacktestIds) await tx.remove('backtests', backtestId);
      await tx.putMany('workspaces', cleanup.workspaces);
      await tx.putMany('watchlists', cleanup.watchlists);
      await tx.putMany('screeners', cleanup.screeners);
      await tx.put<SettingsRecord>('settings', {
        id: 'app',
        schemaVersion: APP_SCHEMA_VERSION,
        installedAt: installedAt(settings),
        syntheticDataRemovedAt: new Date().toISOString(),
      });
    });
  } else if (!settings.some((record) => record.id === 'app')) {
    await adapter.put<SettingsRecord>('settings', {
      id: 'app',
      schemaVersion: APP_SCHEMA_VERSION,
      installedAt: new Date().toISOString(),
      syntheticDataRemovedAt: null,
    });
  }

  const nextInstruments = cleanup.changed ? cleanup.instruments : instruments;
  const nextDatasets = cleanup.changed ? cleanup.datasets : datasets;
  const nextWorkspaces = cleanup.changed ? cleanup.workspaces : workspaces;
  const nextWatchlists = cleanup.changed ? cleanup.watchlists : watchlists;
  const nextScreeners = (cleanup.changed ? cleanup.screeners : screeners).map((screener) => ({
    ...screener,
    sortWindow: resolveSortWindow(screener.sortBy, screener.sortWindow),
  }));
  const nextBacktests = cleanup.changed ? cleanup.backtests : backtests;

  // Comparison overlays reference datasets by id, so drop any selection
  // whose dataset no longer exists before the first render.
  const comparisons = normaliseCompareSelections(nextWorkspaces, new Set(nextDatasets.map((dataset) => dataset.id)));
  const sanitisedWorkspaces = comparisons.workspaces;
  if (comparisons.changed) {
    await adapter.transaction(['workspaces'], (tx) => tx.putMany('workspaces', sanitisedWorkspaces), { notify: false });
  }

  // Set the attribute before the first child render so the charts read the
  // persisted palette on mount.
  applyThemeAttribute(preferences.theme);
  return {
    snapshot: {
      instruments: nextInstruments,
      datasets: nextDatasets,
      barsByDataset: cleanup.changed ? keepBars(barsByDataset, cleanup.removedDatasetIds) : barsByDataset,
      workspaces: sanitisedWorkspaces,
      activeWorkspaceId: resolveActiveWorkspaceId(sanitisedWorkspaces, preferences),
      watchlists: nextWatchlists,
      preferences,
      screeners: nextScreeners,
      backtests: nextBacktests,
      chartTemplates,
      backtestRuns: validatedRuns,
    },
    notice: buildLoadNotice(cleanup.changed ? describeCleanup(cleanup) : null, droppedRunCount, futureRunCount),
  };
}

function buildLoadNotice(cleanupNotice: string | null, droppedRunCount: number, futureRunCount: number): string | null {
  const parts: string[] = [];
  if (cleanupNotice) parts.push(cleanupNotice);
  if (droppedRunCount > 0) {
    parts.push(
      droppedRunCount === 1
        ? '1 saved research run could not be validated with this build and was removed from the library.'
        : `${droppedRunCount} saved research runs could not be validated with this build and were removed from the library.`,
    );
  }
  if (futureRunCount > 0) {
    parts.push(
      futureRunCount === 1
        ? '1 saved research run was written by a newer version of MarketLab and is kept on disk but hidden here.'
        : `${futureRunCount} saved research runs were written by a newer version of MarketLab and are kept on disk but hidden here.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const adapter = useAdapter();
  // Latest committed state for async actions, which must not build a record
  // from the render-time snapshot (that snapshot can be several writes stale).
  const stateRef = useRef(state);
  const preferencesRef = useRef(state.preferences);
  const workspacesRef = useRef(state.workspaces);
  // Writes are serialised per record so a slow write cannot overwrite a newer
  // one, and so consecutive updates compose instead of racing.
  const writeQueues = useRef(new Map<string, Promise<unknown>>());

  useEffect(() => {
    stateRef.current = state;
    preferencesRef.current = state.preferences;
    workspacesRef.current = state.workspaces;
  }, [state]);

  const enqueue = <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = writeQueues.current.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    writeQueues.current.set(key, next);
    void next
      .finally(() => {
        if (writeQueues.current.get(key) === next) writeQueues.current.delete(key);
      })
      .catch(() => undefined);
    return next;
  };

  const notify = (kind: ToastKind, message: string) => {
    const toast: Toast = { id: createId('toast'), kind, message };
    setState((previous) => ({ ...previous, toasts: [...previous.toasts, toast] }));
    setTimeout(() => {
      setState((previous) => ({ ...previous, toasts: previous.toasts.filter((entry) => entry.id !== toast.id) }));
    }, kind === 'error' ? 9000 : 5000);
  };

  // Load everything once, then remove the bundled demo series from any browser
  // that still holds them. Nothing is seeded: the library starts empty and
  // fills from real downloads or CSV imports.
  useEffect(() => {
    if (!adapter) return;
    let cancelled = false;
    loadState(adapter)
      .then(({ snapshot, notice }) => {
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          ...snapshot,
          status: 'ready',
          adapterKind: adapter.kind,
          loadError: null,
        }));
        if (notice) notify('info', notice);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Keep the app usable, but never present a failed read as an empty library.
        const message = error instanceof Error ? error.message : 'Local storage could not be read.';
        setState((previous) => ({
          ...previous,
          status: 'ready',
          loadError: `Local data could not be read: ${message}`,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  /**
   * Re-reads the committed library, used after a failed write and when another
   * tab reports a change. Pending local writes settle first so their result is
   * part of the snapshot rather than being undone by it.
   */
  const refreshFromStorage = useCallback(async () => {
    if (!adapter) return;
    await Promise.allSettled([...writeQueues.current.values()]);
    try {
      const { snapshot } = await loadState(adapter);
      setState((previous) => ({
        ...previous,
        ...snapshot,
        status: 'ready',
        adapterKind: adapter.kind,
        loadError: null,
      }));
    } catch {
      // Keep the current view; a transient read failure must not look like an
      // empty library. The next write/notification retries the read.
    }
  }, [adapter]);

  useEffect(() => {
    if (!adapter?.subscribe) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = adapter.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshFromStorage();
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [adapter, refreshFromStorage]);


  // Apply the theme to the document element.
  useEffect(() => {
    applyThemeAttribute(state.preferences.theme);
  }, [state.preferences.theme]);

  const actions: StoreActions = {
    async importDataset(bundle, options) {
      if (!adapter) return;
      const problem = describeDatasetBundleProblem(bundle);
      if (problem) throw new Error(problem);

      // The library starts empty, so the first real dataset gets a workspace
      // of its own; otherwise the chart page would have nothing to render.
      let nextActiveWorkspaceId = stateRef.current.activeWorkspaceId;
      let nextWorkspaces = workspacesRef.current;
      let createdWorkspace: Workspace | null = null;
      if (nextWorkspaces.length === 0) {
        const preferences = preferencesRef.current;
        const workspace = createWorkspace({
          name: 'Primary',
          layout: 'single',
          base: {
            instrumentId: bundle.instrument.id,
            datasetId: bundle.dataset.id,
            showVolume: preferences.showVolumeByDefault,
            chartType: preferences.defaultChartType,
            timeframe: preferences.defaultTimeframe,
          },
        });
        createdWorkspace = workspace;
        nextWorkspaces = [workspace];
        nextActiveWorkspaceId = workspace.id;
      }

      // Instrument, dataset, bars and the optional first workspace form one
      // unit: a quota failure cannot leave a dataset pointing at missing bars.
      await adapter.transaction(['instruments', 'datasets', 'bars', 'workspaces'], async (tx) => {
        await tx.put('instruments', bundle.instrument);
        await tx.put('datasets', bundle.dataset);
        await tx.put<BarsRecord>('bars', { id: bundle.dataset.id, bars: bundle.bars });
        if (createdWorkspace) await tx.put('workspaces', createdWorkspace);
      });

      if (createdWorkspace) workspacesRef.current = nextWorkspaces;
      setState((previous) => {
        const instruments = upsertById(previous.instruments, bundle.instrument);
        const datasets = upsertById(previous.datasets, bundle.dataset);
        return {
          ...previous,
          instruments,
          datasets,
          barsByDataset: { ...previous.barsByDataset, [bundle.dataset.id]: bundle.bars },
          workspaces: nextWorkspaces,
          activeWorkspaceId: nextActiveWorkspaceId,
        };
      });
      if (!options?.silent) {
        notify('success', `Imported ${bundle.dataset.name} (${bundle.bars.length} sessions).`);
      }
    },

    async deleteDataset(datasetId) {
      if (!adapter) return;
      const before = stateRef.current;
      const dataset = before.datasets.find((entry) => entry.id === datasetId);
      let removedInstrumentId: string | null = null;
      if (dataset) {
        const stillUsed = before.datasets.some((entry) => entry.id !== datasetId && entry.instrumentId === dataset.instrumentId);
        if (!stillUsed) removedInstrumentId = dataset.instrumentId;
      }

      const latest = stateRef.current;
      // Compute every reference that has to go before touching storage, so the
      // cleanup matches the bundled-sample migration instead of leaving saved
      // strategies and watchlist rows pointing at data that no longer exists.
      const plan = planDatasetDeletion({
        datasetId,
        removedInstrumentId,
        // workspacesRef also sees writes that are queued but not rendered yet.
        workspaces: workspacesRef.current,
        watchlists: latest.watchlists,
        screeners: latest.screeners,
        backtests: latest.backtests,
      });
      const barsByDataset = { ...latest.barsByDataset };
      delete barsByDataset[datasetId];

      // Set the in-memory workspace view before touching storage so a queued
      // chart write sees the cleaned plan and cannot resurrect a removed panel.
      await Promise.allSettled([...writeQueues.current.values()]);
      workspacesRef.current = plan.workspaces;

      try {
        await adapter.transaction(
          ['datasets', 'bars', 'instruments', 'workspaces', 'watchlists', 'backtests', 'screeners'],
          async (tx) => {
            await tx.remove('datasets', datasetId);
            await tx.remove('bars', datasetId);
            if (removedInstrumentId) await tx.remove('instruments', removedInstrumentId);

            // Persist the cleanup, not only the React state: otherwise the next
            // load resurrects panels, screens, strategies and watchlist rows
            // that point at the removed dataset.
            for (const workspaceId of plan.removedWorkspaceIds) await tx.remove('workspaces', workspaceId);
            for (const watchlistId of plan.removedWatchlistIds) await tx.remove('watchlists', watchlistId);
            for (const backtestId of plan.removedBacktestIds) await tx.remove('backtests', backtestId);
            await tx.putMany('workspaces', plan.workspaces);
            await tx.putMany('watchlists', plan.watchlists);
            await tx.putMany('screeners', plan.screeners);
          },
        );
      } catch (error) {
        notify('error', `Could not remove the dataset: ${errorMessage(error)}`);
        await refreshFromStorage();
        return;
      }

      setState((previous) => ({
        ...previous,
        datasets: previous.datasets.filter((entry) => entry.id !== datasetId),
        instruments: removedInstrumentId
          ? previous.instruments.filter((entry) => entry.id !== removedInstrumentId)
          : previous.instruments,
        barsByDataset,
        workspaces: plan.workspaces,
        activeWorkspaceId: plan.workspaces.some((workspace) => workspace.id === previous.activeWorkspaceId)
          ? previous.activeWorkspaceId
          : plan.workspaces[0]?.id ?? null,
        watchlists: plan.watchlists,
        screeners: plan.screeners,
        backtests: plan.backtests,
      }));
      notify('info', 'Dataset removed.');
    },

    async createWorkspaceFromBase({ name, datasetId, instrumentId, layout }) {
      if (!adapter) return null;
      const preferences = preferencesRef.current;
      const workspace = createWorkspace({
        name,
        layout,
        base: {
          instrumentId,
          datasetId,
          showVolume: preferences.showVolumeByDefault,
          chartType: preferences.defaultChartType,
          timeframe: preferences.defaultTimeframe,
        },
      });
      await adapter.put('workspaces', workspace);
      workspacesRef.current = [...workspacesRef.current, workspace];
      setState((previous) => ({ ...previous, workspaces: [...previous.workspaces, workspace], activeWorkspaceId: workspace.id }));
      notify('success', `Created workspace "${workspace.name}".`);
      return workspace.id;
    },

    async saveWorkspace(workspace) {
      if (!adapter) return;
      const updated = { ...workspace, updatedAt: new Date().toISOString() };
      // Keep the ref in step with state before the write. updateWorkspace builds
      // its next record from this ref, so a save that skipped it would be
      // reverted by the next chart edit.
      workspacesRef.current = upsertById(workspacesRef.current, updated);
      setState((previous) => ({ ...previous, workspaces: upsertById(previous.workspaces, updated) }));
      try {
        const saved = await enqueue(`workspace:${updated.id}`, async () => {
          // Persist the current record, so a save queued behind an edit does not
          // write the stale snapshot it was called with.
          const current = workspacesRef.current.find((entry) => entry.id === updated.id);
          if (!current) return true;
          return persistWorkspaceIfNewer(adapter, current);
        });
        if (!saved) {
          notify('warning', 'That workspace changed in another tab. Showing the saved version.');
          await refreshFromStorage();
        }
      } catch (error) {
        notify('error', `Could not save the workspace: ${errorMessage(error)}`);
      }
    },

    async updateWorkspace(workspaceId, updater) {
      if (!adapter) return;
      // Apply the edit to the in-memory workspace straight away, so a control
      // the user just touched reflects the change before the write lands.
      // Otherwise a controlled input is re-rendered from the stale value and
      // the click appears to have done nothing.
      const existing = workspacesRef.current.find((workspace) => workspace.id === workspaceId);
      if (!existing) return;
      const updated = { ...updater(existing), updatedAt: new Date().toISOString() };
      workspacesRef.current = upsertById(workspacesRef.current, updated);
      setState((previous) => ({ ...previous, workspaces: upsertById(previous.workspaces, updated) }));
      try {
        const saved = await enqueue(`workspace:${workspaceId}`, async () => {
          // Persist whatever the workspace holds when the write runs, so queued
          // edits compose instead of replacing each other with stale snapshots.
          // A delete queued behind this write wins: do not re-insert the record.
          const current = workspacesRef.current.find((workspace) => workspace.id === workspaceId);
          if (!current) return true;
          return persistWorkspaceIfNewer(adapter, current);
        });
        if (!saved) {
          // The other tab has a newer revision. Keep the optimistic view only
          // until the re-read lands, then show what is actually stored.
          notify('warning', 'That workspace changed in another tab. Showing the saved version.');
          await refreshFromStorage();
        }
      } catch (error) {
        // The optimistic edit stays on screen; say that it was not persisted
        // rather than leaving an unhandled rejection behind every call site.
        notify('error', `Could not save the workspace: ${errorMessage(error)}`);
      }
    },

    async updateChart(workspaceId, chartId, updater) {
      await actions.updateWorkspace(workspaceId, (workspace) => ({
        ...workspace,
        charts: workspace.charts.map((chart) => (chart.id === chartId ? updater(chart) : chart)),
      }));
    },

    async deleteWorkspace(workspaceId) {
      if (!adapter) return;
      try {
        await enqueue(`workspace:${workspaceId}`, async () => {
          await adapter.remove('workspaces', workspaceId);
          workspacesRef.current = workspacesRef.current.filter((workspace) => workspace.id !== workspaceId);
          setState((previous) => {
            const workspaces = previous.workspaces.filter((workspace) => workspace.id !== workspaceId);
            return {
              ...previous,
              workspaces,
              activeWorkspaceId:
                previous.activeWorkspaceId === workspaceId ? workspaces[0]?.id ?? null : previous.activeWorkspaceId,
            };
          });
        });
        notify('info', 'Workspace deleted.');
      } catch (error) {
        notify('error', `Could not delete the workspace: ${errorMessage(error)}`);
      }
    },

    async setActiveWorkspace(workspaceId) {
      setState((previous) => ({ ...previous, activeWorkspaceId: workspaceId }));
    },

    async saveWatchlist(watchlist) {
      if (!adapter) return;
      try {
        const updated = { ...watchlist, updatedAt: new Date().toISOString() };
        await adapter.put('watchlists', updated);
        setState((previous) => ({ ...previous, watchlists: upsertById(previous.watchlists, updated) }));
      } catch (error) {
        notify('error', `Could not save the watchlist: ${errorMessage(error)}`);
      }
    },

    async createWatchlistNamed(name, instrumentIds = []) {
      if (!adapter) return '';
      try {
        const watchlist = createWatchlist(name, instrumentIds);
        await adapter.put('watchlists', watchlist);
        setState((previous) => ({ ...previous, watchlists: [...previous.watchlists, watchlist] }));
        return watchlist.id;
      } catch (error) {
        notify('error', `Could not create the watchlist: ${errorMessage(error)}`);
        return '';
      }
    },

    async deleteWatchlist(watchlistId) {
      if (!adapter) return;
      try {
        await adapter.remove('watchlists', watchlistId);
        setState((previous) => ({ ...previous, watchlists: previous.watchlists.filter((entry) => entry.id !== watchlistId) }));
      } catch (error) {
        notify('error', `Could not delete the watchlist: ${errorMessage(error)}`);
      }
    },

    async saveScreener(definition) {
      if (!adapter) return;
      try {
        const updated = { ...definition, updatedAt: new Date().toISOString() };
        await adapter.put('screeners', updated);
        setState((previous) => ({ ...previous, screeners: upsertById(previous.screeners, updated) }));
        notify('success', `Saved screen "${updated.name}".`);
      } catch (error) {
        notify('error', `Could not save the screen: ${errorMessage(error)}`);
      }
    },

    async deleteScreener(screenerId) {
      if (!adapter) return;
      try {
        await adapter.remove('screeners', screenerId);
        setState((previous) => ({ ...previous, screeners: previous.screeners.filter((entry) => entry.id !== screenerId) }));
      } catch (error) {
        notify('error', `Could not delete the screen: ${errorMessage(error)}`);
      }
    },

    async saveBacktest(config) {
      if (!adapter) return;
      try {
        const updated = { ...config, updatedAt: new Date().toISOString() };
        await adapter.put('backtests', updated);
        setState((previous) => ({ ...previous, backtests: upsertById(previous.backtests, updated) }));
        notify('success', `Saved strategy "${updated.name}".`);
      } catch (error) {
        notify('error', `Could not save the strategy: ${errorMessage(error)}`);
      }
    },

    async deleteBacktest(backtestId) {
      if (!adapter) return;
      try {
        await adapter.remove('backtests', backtestId);
        setState((previous) => ({ ...previous, backtests: previous.backtests.filter((entry) => entry.id !== backtestId) }));
      } catch (error) {
        notify('error', `Could not delete the strategy: ${errorMessage(error)}`);
      }
    },

    async saveChartTemplate(template) {
      if (!adapter) return;
      try {
        const updated = { ...template, updatedAt: new Date().toISOString() };
        await adapter.put('chartTemplates', updated);
        setState((previous) => ({ ...previous, chartTemplates: upsertById(previous.chartTemplates, updated) }));
        notify('success', `Saved template "${updated.name}".`);
      } catch (error) {
        notify('error', `Could not save the template: ${errorMessage(error)}`);
      }
    },

    async deleteChartTemplate(templateId) {
      if (!adapter) return;
      try {
        await adapter.remove('chartTemplates', templateId);
        setState((previous) => ({
          ...previous,
          chartTemplates: previous.chartTemplates.filter((entry) => entry.id !== templateId),
        }));
      } catch (error) {
        notify('error', `Could not delete the template: ${errorMessage(error)}`);
      }
    },

    async saveBacktestRun(run) {
      if (!adapter) return false;
      const parsed = parseBacktestRun(run);
      if (!parsed.ok) {
        notify('error', `The research run is invalid: ${parsed.error}`);
        return false;
      }
      const decision = planResearchRunSave(stateRef.current.backtestRuns, parsed.value);
      if (!decision.ok) {
        notify('error', decision.message);
        return false;
      }
      try {
        await adapter.put('researchRuns', parsed.value);
        setState((previous) => ({ ...previous, backtestRuns: upsertById(previous.backtestRuns, parsed.value) }));
        notify('success', `Saved research run "${parsed.value.name}".`);
        return true;
      } catch (error) {
        notify('error', `Could not save the research run: ${errorMessage(error)}`);
        return false;
      }
    },

    async renameBacktestRun(runId, name) {
      if (!adapter) return false;
      const existing = stateRef.current.backtestRuns.find((entry) => entry.id === runId);
      if (!existing) {
        notify('error', 'That research run is no longer saved.');
        return false;
      }
      let renamed: BacktestRun;
      try {
        renamed = withResearchRunName(existing, name);
      } catch (error) {
        notify('error', errorMessage(error));
        return false;
      }
      const parsed = parseBacktestRun(renamed);
      if (!parsed.ok) {
        notify('error', `The research run is invalid: ${parsed.error}`);
        return false;
      }
      try {
        await adapter.put('researchRuns', parsed.value);
        setState((previous) => ({ ...previous, backtestRuns: upsertById(previous.backtestRuns, parsed.value) }));
        notify('success', `Renamed research run to "${parsed.value.name}".`);
        return true;
      } catch (error) {
        notify('error', `Could not rename the research run: ${errorMessage(error)}`);
        return false;
      }
    },

    async deleteBacktestRun(runId) {
      if (!adapter) return;
      try {
        await adapter.remove('researchRuns', runId);
        setState((previous) => ({ ...previous, backtestRuns: previous.backtestRuns.filter((entry) => entry.id !== runId) }));
      } catch (error) {
        notify('error', `Could not delete the research run: ${errorMessage(error)}`);
      }
    },

    async setPreferences(partial) {
      if (!adapter) return;
      // Paint the new palette before React re-renders the charts.
      applyThemeAttribute(partial.theme ?? preferencesRef.current.theme);
      try {
        await enqueue('preferences', async () => {
          const preferences = { ...preferencesRef.current, ...partial };
          await adapter.put<PreferencesRecord>('preferences', { id: 'preferences', ...preferences });
          preferencesRef.current = preferences;
          setState((previous) => ({ ...previous, preferences }));
        });
      } catch (error) {
        // The write, not the preference, failed: undo the painted theme before
        // the store's own effect re-reads the persisted value, and say so.
        applyThemeAttribute(preferencesRef.current.theme);
        notify('error', `Could not save the preference: ${errorMessage(error)}`);
      }
    },

    async restoreBackup(bundle, mode) {
      if (!adapter) return;
      const base = mode === 'replace' ? EMPTY_STATE : stateRef.current;
      const merged = mergeBackup(
        {
          instruments: base.instruments,
          datasets: base.datasets,
          barsByDataset: base.barsByDataset,
          workspaces: base.workspaces,
          watchlists: base.watchlists,
          screeners: base.screeners,
          backtests: base.backtests,
          chartTemplates: base.chartTemplates,
          researchRuns: base.backtestRuns,
        },
        bundle,
      );
      // Restored workspaces may carry comparison ids that the merge remapped or
      // that the restored library does not contain; normalise before persisting.
      const comparisons = normaliseCompareSelections(merged.workspaces, new Set(merged.datasets.map((dataset) => dataset.id)));
      merged.workspaces = comparisons.workspaces;

      // An entity-free backup applied as "replace" would delete the whole
      // library and still report success. Deleting everything is the explicit
      // reset action, not something a valid but empty file should do.
      if (mode === 'replace' && isEmptyReplaceRestore({ local: stateRef.current, merged })) {
        notify(
          'error',
          'This backup contains no datasets or workspaces, so it was not restored. Your local library is unchanged.',
        );
        return;
      }

      const barRecords = Object.entries(merged.barsByDataset).map(([id, bars]) => ({ id, bars }));
      // A queued workspace write must build from the restored set before the
      // transaction commits, otherwise it could re-insert a pruned record.
      await Promise.allSettled([...writeQueues.current.values()]);
      workspacesRef.current = merged.workspaces;
      const nextPreferences = bundle.preferences ?? preferencesRef.current;
      preferencesRef.current = nextPreferences;
      try {
        // One transaction across every store: either the whole restore lands or
        // none of it does. Pruning happens inside it, so a quota failure cannot
        // erase the previous library before the replacement is written.
        await adapter.transaction(
          ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'chartTemplates', 'researchRuns', 'preferences'],
          async (tx) => {
            const previousDatasetIds = mode === 'replace'
              ? (await tx.list<{ id: string }>('datasets')).map((record) => record.id)
              : [];
            await tx.putMany('instruments', merged.instruments);
            await tx.putMany('datasets', merged.datasets);
            await tx.putMany<BarsRecord>('bars', barRecords);
            await tx.putMany('workspaces', merged.workspaces);
            await tx.putMany('watchlists', merged.watchlists);
            await tx.putMany('screeners', merged.screeners);
            await tx.putMany('backtests', merged.backtests);
            await tx.putMany('chartTemplates', merged.chartTemplates);
            await tx.putMany('researchRuns', merged.researchRuns);
            if (mode === 'replace') {
              await removeRecordsNotIn(tx, 'instruments', merged.instruments);
              await removeRecordsNotIn(tx, 'datasets', merged.datasets);
              const keptBarIds = new Set(barRecords.map((record) => record.id));
              for (const id of previousDatasetIds) {
                if (!keptBarIds.has(id)) await tx.remove('bars', id);
              }
              await removeRecordsNotIn(tx, 'workspaces', merged.workspaces);
              await removeRecordsNotIn(tx, 'watchlists', merged.watchlists);
              await removeRecordsNotIn(tx, 'screeners', merged.screeners);
              await removeRecordsNotIn(tx, 'backtests', merged.backtests);
              await removeRecordsNotIn(tx, 'chartTemplates', merged.chartTemplates);
              await removeRecordsNotIn(tx, 'researchRuns', merged.researchRuns);
            }
            if (bundle.preferences) {
              await tx.put<PreferencesRecord>('preferences', { id: 'preferences', ...bundle.preferences });
            }
          },
        );
      } catch (error) {
        // Do not update memory or claim success: re-read the committed library so
        // the refs and the screen cannot keep a restore that was rolled back.
        notify('error', `The backup could not be restored: ${errorMessage(error)}`);
        await refreshFromStorage();
        return;
      }
      if (bundle.preferences) applyThemeAttribute(bundle.preferences.theme);

      setState((previous) => ({
        ...previous,
        status: 'ready',
        adapterKind: adapter.kind,
        instruments: merged.instruments,
        datasets: merged.datasets,
        barsByDataset: merged.barsByDataset,
        workspaces: merged.workspaces,
        activeWorkspaceId:
          previous.activeWorkspaceId && merged.workspaces.some((workspace) => workspace.id === previous.activeWorkspaceId)
            ? previous.activeWorkspaceId
            : merged.workspaces[0]?.id ?? null,
        watchlists: merged.watchlists,
        screeners: merged.screeners,
        backtests: merged.backtests,
        chartTemplates: merged.chartTemplates,
        backtestRuns: merged.researchRuns,
        preferences: nextPreferences,
      }));

      notify(
        'success',
        mode === 'replace'
          ? 'Backup restored (replaced local data).'
          : merged.duplicateDatasets > 0
            ? `Backup merged. ${merged.duplicateDatasets} already-stored series were not duplicated.`
            : 'Backup merged into local data.',
      );
    },

    async resetAll() {
      if (!adapter) return;
      // Make queued workspace writes see an empty library, then let them settle
      // before clearing, so a write that started earlier cannot re-insert a
      // workspace after the reset.
      workspacesRef.current = [];
      await Promise.allSettled([...writeQueues.current.values()]);
      try {
        await adapter.transaction(
          ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'chartTemplates', 'researchRuns', 'settings'],
          async (tx) => {
            for (const store of ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'chartTemplates', 'researchRuns', 'settings'] as StoreName[]) {
              await tx.clear(store);
            }
            await tx.put<SettingsRecord>('settings', {
              id: 'app',
              schemaVersion: APP_SCHEMA_VERSION,
              installedAt: new Date().toISOString(),
              syntheticDataRemovedAt: null,
            });
          },
        );
      } catch (error) {
        notify('error', `Local data could not be reset: ${errorMessage(error)}`);
        await refreshFromStorage();
        return;
      }
      setState((previous) => ({
        ...EMPTY_STATE,
        status: 'ready',
        adapterKind: adapter.kind,
        preferences: previous.preferences,
        toasts: previous.toasts,
      }));
      notify('info', 'All local data was deleted.');
    },

    notify,

    dismissToast(id) {
      setState((previous) => ({ ...previous, toasts: previous.toasts.filter((toast) => toast.id !== id) }));
    },
  };

  const value: StoreValue = { state, actions };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

function useAdapter(): PersistenceAdapter | null {
  const [adapter, setAdapter] = useState<PersistenceAdapter | null>(null);
  useEffect(() => {
    let cancelled = false;
    createPersistence().then((created) => {
      if (!cancelled) setAdapter(created);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return adapter;
}

function stripPreferenceId(record: PreferencesRecord): UserPreferences {
  const { id: _id, ...preferences } = record;
  void _id;
  return preferences;
}

function applyThemeAttribute(theme: UserPreferences['theme']): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

/** Prefers the stored default workspace, falling back to the first one. */
function resolveActiveWorkspaceId(workspaces: readonly Workspace[], preferences: UserPreferences): string | null {
  const preferred = preferences.defaultWorkspaceId;
  if (preferred && workspaces.some((workspace) => workspace.id === preferred)) return preferred;
  return workspaces[0]?.id ?? null;
}

function upsertById<T extends { id: string }>(list: readonly T[], value: T): T[] {
  const index = list.findIndex((entry) => entry.id === value.id);
  if (index === -1) return [...list, value];
  const next = [...list];
  next[index] = value;
  return next;
}

/** Drops the bars of the removed datasets and keeps every other series. */
function keepBars(barsByDataset: Record<string, Bar[]>, removedDatasetIds: readonly string[]): Record<string, Bar[]> {
  const removed = new Set(removedDatasetIds);
  const next: Record<string, Bar[]> = {};
  for (const [id, bars] of Object.entries(barsByDataset)) {
    if (!removed.has(id)) next[id] = bars;
  }
  return next;
}

/** The install timestamp of an existing app record, or now for a fresh one. */
function installedAt(settings: readonly SettingsRecord[]): string {
  const existing = settings.find((record) => record.id === 'app');
  const value = (existing as { installedAt?: string; seededAt?: string } | undefined)?.installedAt
    ?? (existing as { seededAt?: string } | undefined)?.seededAt;
  return value ?? new Date().toISOString();
}

/**
 * Writes a workspace only when its timestamp is at least as new as the stored
 * revision. Returns false when another tab already committed a newer edit.
 */
async function persistWorkspaceIfNewer(adapter: PersistenceAdapter, workspace: Workspace): Promise<boolean> {
  return adapter.transaction(['workspaces'], async (tx) => {
    const stored = await tx.get<Workspace>('workspaces', workspace.id);
    if (stored && stored.updatedAt > workspace.updatedAt) return false;
    await tx.put('workspaces', workspace);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'the local store rejected the write';
}

/**
 * Removes every record in `store` whose id is not in `keep`.
 *
 * Used by a replace-mode restore inside the same transaction that wrote the
 * backup, so a failure rolls the pruning back with the writes.
 */
async function removeRecordsNotIn<T extends { id: string }>(
  tx: PersistenceTransaction,
  store: StoreName,
  keep: readonly T[],
): Promise<void> {
  const keepIds = new Set(keep.map((entry) => entry.id));
  const stored = await tx.list<{ id: string }>(store);
  for (const record of stored) {
    if (!keepIds.has(record.id)) await tx.remove(store, record.id);
  }
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside StoreProvider.');
  return context;
}

