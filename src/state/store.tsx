import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BacktestConfig,
  Bar,
  Dataset,
  Instrument,
  ScreenerDefinition,
  UserPreferences,
  Watchlist,
  Workspace,
} from '../domain/types';
import { createPersistence, type PersistenceAdapter, type StoreName } from '../lib/persistence/db';
import { describeCleanup, removeSyntheticData, type SyntheticCleanupResult } from '../lib/migration/remove-synthetic';
import { APP_SCHEMA_VERSION, DEFAULT_PREFERENCES, createWatchlist, createWorkspace } from './defaults';
import { createId } from '../lib/id';
import { mergeBackup, type BackupBundle } from '../lib/export/backup';
import { normaliseCompareSelections } from '../lib/workspace/compare-selections';

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
  toasts: [],
};

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
    (async () => {
      const [instruments, datasets, barRecords, workspaces, watchlists, screeners, backtests, preferencesRecords, settings] = await Promise.all([
        adapter.list<Instrument>('instruments'),
        adapter.list<Dataset>('datasets'),
        adapter.list<BarsRecord>('bars'),
        adapter.list<Workspace>('workspaces'),
        adapter.list<Watchlist>('watchlists'),
        adapter.list<ScreenerDefinition>('screeners'),
        adapter.list<BacktestConfig>('backtests'),
        adapter.list<PreferencesRecord>('preferences'),
        adapter.list<SettingsRecord>('settings'),
      ]);
      if (cancelled) return;

      const barsByDataset: Record<string, Bar[]> = {};
      for (const record of barRecords) barsByDataset[record.id] = record.bars;

      let preferences = preferencesRecords[0]
        ? stripPreferenceId(preferencesRecords[0])
        : DEFAULT_PREFERENCES;

      // Remove the bundled demo series, if an earlier build left them behind.
      const cleanup = removeSyntheticData({ instruments, datasets, workspaces, watchlists, screeners, backtests });
      if (cleanup.changed) {
        if (preferences.defaultWorkspaceId && cleanup.removedWorkspaceIds.includes(preferences.defaultWorkspaceId)) {
          preferences = { ...preferences, defaultWorkspaceId: null };
          await adapter.put<PreferencesRecord>('preferences', { id: 'preferences', ...preferences });
        }
        await persistCleanup(adapter, cleanup);
        await adapter.put<SettingsRecord>('settings', {
          id: 'app',
          schemaVersion: APP_SCHEMA_VERSION,
          installedAt: installedAt(settings),
          syntheticDataRemovedAt: new Date().toISOString(),
        });
      } else if (!settings.some((record) => record.id === 'app')) {
        await adapter.put<SettingsRecord>('settings', {
          id: 'app',
          schemaVersion: APP_SCHEMA_VERSION,
          installedAt: new Date().toISOString(),
          syntheticDataRemovedAt: null,
        });
      }
      if (cancelled) return;

      const nextInstruments = cleanup.changed ? cleanup.instruments : instruments;
      const nextDatasets = cleanup.changed ? cleanup.datasets : datasets;
      const nextWorkspaces = cleanup.changed ? cleanup.workspaces : workspaces;
      const nextWatchlists = cleanup.changed ? cleanup.watchlists : watchlists;
      const nextScreeners = cleanup.changed ? cleanup.screeners : screeners;
      const nextBacktests = cleanup.changed ? cleanup.backtests : backtests;

      // Comparison overlays reference datasets by id, so drop any selection
      // whose dataset no longer exists before the first render.
      const comparisons = normaliseCompareSelections(nextWorkspaces, new Set(nextDatasets.map((dataset) => dataset.id)));
      const sanitisedWorkspaces = comparisons.workspaces;
      if (comparisons.changed) await adapter.putMany('workspaces', sanitisedWorkspaces);

      // Set the attribute before the first child render so the charts read
      // the persisted palette on mount.
      applyThemeAttribute(preferences.theme);
      setState((previous) => ({
        ...previous,
        status: 'ready',
        adapterKind: adapter.kind,
        instruments: nextInstruments,
        datasets: nextDatasets,
        barsByDataset: cleanup.changed ? keepBars(barsByDataset, cleanup.removedDatasetIds) : barsByDataset,
        workspaces: sanitisedWorkspaces,
        activeWorkspaceId: resolveActiveWorkspaceId(sanitisedWorkspaces, preferences),
        watchlists: nextWatchlists,
        preferences,
        screeners: nextScreeners,
        backtests: nextBacktests,
        loadError: null,
      }));
      if (cleanup.changed) notify('info', describeCleanup(cleanup));
    })().catch((error: unknown) => {
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

  // Apply the theme to the document element.
  useEffect(() => {
    applyThemeAttribute(state.preferences.theme);
  }, [state.preferences.theme]);

  const actions: StoreActions = {
    async importDataset(bundle, options) {
      if (!adapter) return;
      await adapter.put('instruments', bundle.instrument);
      await adapter.put('datasets', bundle.dataset);
      await adapter.put<BarsRecord>('bars', { id: bundle.dataset.id, bars: bundle.bars });

      // The library starts empty, so the first real dataset gets a workspace
      // of its own; otherwise the chart page would have nothing to render.
      let nextActiveWorkspaceId = stateRef.current.activeWorkspaceId;
      let nextWorkspaces = workspacesRef.current;
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
        await adapter.put('workspaces', workspace);
        nextWorkspaces = [workspace];
        workspacesRef.current = nextWorkspaces;
        nextActiveWorkspaceId = workspace.id;
      }

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
      await adapter.remove('datasets', datasetId);
      await adapter.remove('bars', datasetId);
      let instrumentRemoved = false;
      if (dataset) {
        const stillUsed = before.datasets.some((entry) => entry.id !== datasetId && entry.instrumentId === dataset.instrumentId);
        if (!stillUsed) {
          await adapter.remove('instruments', dataset.instrumentId);
          instrumentRemoved = true;
        }
      }

      const latest = stateRef.current;
      // workspacesRef also sees writes that are queued but not rendered yet.
      const latestWorkspaces = workspacesRef.current;
      const barsByDataset = { ...latest.barsByDataset };
      delete barsByDataset[datasetId];
      const workspaces = latestWorkspaces
        .map((workspace) => ({
          ...workspace,
          charts: workspace.charts
            .filter((chart) => chart.datasetId !== datasetId)
            .map((chart) => ({
              ...chart,
              // A removed dataset must not survive as a comparison overlay.
              compareDatasetIds: (chart.compareDatasetIds ?? []).filter((id) => id !== datasetId),
            })),
        }))
        .filter((workspace) => workspace.charts.length > 0);
      const screeners = latest.screeners.map((screener) => ({
        ...screener,
        universeDatasetIds: screener.universeDatasetIds.filter((id) => id !== datasetId),
      }));
      // Persist the cleanup, not only the React state: otherwise the next load
      // resurrects panels and screens that point at the removed dataset.
      const removedWorkspaces = latestWorkspaces.filter(
        (workspace) => !workspaces.some((entry) => entry.id === workspace.id),
      );
      for (const workspace of removedWorkspaces) await adapter.remove('workspaces', workspace.id);
      await adapter.putMany('workspaces', workspaces);
      await adapter.putMany('screeners', screeners);
      workspacesRef.current = workspaces;

      setState((previous) => ({
        ...previous,
        datasets: previous.datasets.filter((entry) => entry.id !== datasetId),
        instruments: instrumentRemoved && dataset
          ? previous.instruments.filter((entry) => entry.id !== dataset.instrumentId)
          : previous.instruments,
        barsByDataset,
        workspaces,
        activeWorkspaceId: workspaces.some((workspace) => workspace.id === previous.activeWorkspaceId)
          ? previous.activeWorkspaceId
          : workspaces[0]?.id ?? null,
        screeners,
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
      await adapter.put('workspaces', updated);
      setState((previous) => ({ ...previous, workspaces: upsertById(previous.workspaces, updated) }));
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
      await enqueue(`workspace:${workspaceId}`, async () => {
        // Persist whatever the workspace holds when the write runs, so queued
        // edits compose instead of replacing each other with stale snapshots.
        // A delete queued behind this write wins: do not re-insert the record.
        const current = workspacesRef.current.find((workspace) => workspace.id === workspaceId);
        if (!current) return;
        await adapter.put('workspaces', current);
      });
    },

    async updateChart(workspaceId, chartId, updater) {
      await actions.updateWorkspace(workspaceId, (workspace) => ({
        ...workspace,
        charts: workspace.charts.map((chart) => (chart.id === chartId ? updater(chart) : chart)),
      }));
    },

    async deleteWorkspace(workspaceId) {
      if (!adapter) return;
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
    },

    async setActiveWorkspace(workspaceId) {
      setState((previous) => ({ ...previous, activeWorkspaceId: workspaceId }));
    },

    async saveWatchlist(watchlist) {
      if (!adapter) return;
      const updated = { ...watchlist, updatedAt: new Date().toISOString() };
      await adapter.put('watchlists', updated);
      setState((previous) => ({ ...previous, watchlists: upsertById(previous.watchlists, updated) }));
    },

    async createWatchlistNamed(name, instrumentIds = []) {
      if (!adapter) return '';
      const watchlist = createWatchlist(name, instrumentIds);
      await adapter.put('watchlists', watchlist);
      setState((previous) => ({ ...previous, watchlists: [...previous.watchlists, watchlist] }));
      return watchlist.id;
    },

    async deleteWatchlist(watchlistId) {
      if (!adapter) return;
      await adapter.remove('watchlists', watchlistId);
      setState((previous) => ({ ...previous, watchlists: previous.watchlists.filter((entry) => entry.id !== watchlistId) }));
    },

    async saveScreener(definition) {
      if (!adapter) return;
      const updated = { ...definition, updatedAt: new Date().toISOString() };
      await adapter.put('screeners', updated);
      setState((previous) => ({ ...previous, screeners: upsertById(previous.screeners, updated) }));
      notify('success', `Saved screen "${updated.name}".`);
    },

    async deleteScreener(screenerId) {
      if (!adapter) return;
      await adapter.remove('screeners', screenerId);
      setState((previous) => ({ ...previous, screeners: previous.screeners.filter((entry) => entry.id !== screenerId) }));
    },

    async saveBacktest(config) {
      if (!adapter) return;
      const updated = { ...config, updatedAt: new Date().toISOString() };
      await adapter.put('backtests', updated);
      setState((previous) => ({ ...previous, backtests: upsertById(previous.backtests, updated) }));
      notify('success', `Saved strategy "${updated.name}".`);
    },

    async deleteBacktest(backtestId) {
      if (!adapter) return;
      await adapter.remove('backtests', backtestId);
      setState((previous) => ({ ...previous, backtests: previous.backtests.filter((entry) => entry.id !== backtestId) }));
    },

    async setPreferences(partial) {
      if (!adapter) return;
      // Paint the new palette before React re-renders the charts.
      applyThemeAttribute(partial.theme ?? preferencesRef.current.theme);
      await enqueue('preferences', async () => {
        const preferences = { ...preferencesRef.current, ...partial };
        await adapter.put<PreferencesRecord>('preferences', { id: 'preferences', ...preferences });
        preferencesRef.current = preferences;
        setState((previous) => ({ ...previous, preferences }));
      });
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
        },
        bundle,
      );
      // Restored workspaces may carry comparison ids that the merge remapped or
      // that the restored library does not contain; normalise before persisting.
      const comparisons = normaliseCompareSelections(merged.workspaces, new Set(merged.datasets.map((dataset) => dataset.id)));
      merged.workspaces = comparisons.workspaces;

      if (mode === 'replace') {
        for (const store of ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests'] as StoreName[]) {
          await adapter.clear(store);
        }
      }
      // Persist exactly what was merged, so storage and memory cannot drift apart
      // and a later reload cannot resurrect an entry that was skipped.
      await adapter.putMany('instruments', merged.instruments);
      await adapter.putMany('datasets', merged.datasets);
      await adapter.putMany<BarsRecord>(
        'bars',
        Object.entries(merged.barsByDataset).map(([id, bars]) => ({ id, bars })),
      );
      await adapter.putMany('workspaces', merged.workspaces);
      await adapter.putMany('watchlists', merged.watchlists);
      await adapter.putMany('screeners', merged.screeners);
      await adapter.putMany('backtests', merged.backtests);
      if (bundle.preferences) {
        await adapter.put<PreferencesRecord>('preferences', { id: 'preferences', ...bundle.preferences });
        applyThemeAttribute(bundle.preferences.theme);
      }

      const nextPreferences = bundle.preferences ?? preferencesRef.current;
      workspacesRef.current = merged.workspaces;
      preferencesRef.current = nextPreferences;
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
      for (const store of ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'settings'] as StoreName[]) {
        await adapter.clear(store);
      }
      await adapter.put<SettingsRecord>('settings', {
        id: 'app',
        schemaVersion: APP_SCHEMA_VERSION,
        installedAt: new Date().toISOString(),
        syntheticDataRemovedAt: null,
      });
      workspacesRef.current = [];
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
 * Writes the removal of the bundled demo series to storage. Only the records
 * that the cleanup touched are removed or rewritten; imported, downloaded and
 * user-created records are left exactly as they are.
 */
async function persistCleanup(adapter: PersistenceAdapter, cleanup: SyntheticCleanupResult): Promise<void> {
  for (const datasetId of cleanup.removedDatasetIds) {
    await adapter.remove('datasets', datasetId);
    await adapter.remove('bars', datasetId);
  }
  for (const instrumentId of cleanup.removedInstrumentIds) await adapter.remove('instruments', instrumentId);
  for (const workspaceId of cleanup.removedWorkspaceIds) await adapter.remove('workspaces', workspaceId);
  for (const watchlistId of cleanup.removedWatchlistIds) await adapter.remove('watchlists', watchlistId);
  for (const backtestId of cleanup.removedBacktestIds) await adapter.remove('backtests', backtestId);
  await adapter.putMany('workspaces', cleanup.workspaces);
  await adapter.putMany('watchlists', cleanup.watchlists);
  await adapter.putMany('screeners', cleanup.screeners);
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside StoreProvider.');
  return context;
}
