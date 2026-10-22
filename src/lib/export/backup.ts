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
} from '../../domain/types';
import {
  backtestConfigSchema,
  barSchema,
  datasetSchema,
  instrumentSchema,
  parseBacktestRun,
  parseChartTemplate,
  parseWorkspace,
  preferencesSchema,
  screenerDefinitionSchema,
} from '../workspace/schema';
import { resolveSortWindow } from '../screener/fields';
import { validateBarEntries } from '../validation/dataset';

export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupBundle {
  app: 'marketlab';
  schemaVersion: number;
  exportedAt: string;
  instruments: Instrument[];
  datasets: Dataset[];
  bars: Array<{ id: string; bars: Bar[] }>;
  workspaces: Workspace[];
  watchlists: Watchlist[];
  preferences: UserPreferences | null;
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
  /** Optional so backups written before templates existed still parse. */
  chartTemplates?: ChartTemplate[];
  /** Optional so backups written before saved research runs existed still parse. */
  researchRuns?: BacktestRun[];
}

export interface BackupInput {
  instruments: readonly Instrument[];
  datasets: readonly Dataset[];
  bars: ReadonlyArray<{ id: string; bars: Bar[] }>;
  workspaces: readonly Workspace[];
  watchlists: readonly Watchlist[];
  preferences: UserPreferences | null;
  screeners: readonly ScreenerDefinition[];
  backtests: readonly BacktestConfig[];
  chartTemplates?: readonly ChartTemplate[];
  researchRuns?: readonly BacktestRun[];
}

export function createBackup(input: BackupInput): BackupBundle {
  return {
    app: 'marketlab',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    instruments: [...input.instruments],
    datasets: [...input.datasets],
    bars: input.bars.map((entry) => ({ id: entry.id, bars: [...entry.bars] })),
    workspaces: [...input.workspaces],
    watchlists: [...input.watchlists],
    preferences: input.preferences,
    screeners: [...input.screeners],
    backtests: [...input.backtests],
    chartTemplates: [...(input.chartTemplates ?? [])],
    researchRuns: [...(input.researchRuns ?? [])],
  };
}

export function serialiseBackup(bundle: BackupBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses an imported backup defensively.
 *
 * Only the top-level shape is required; each array is filtered to entries that
 * pass the same schemas the application writes, and workspaces pass the full
 * schema check. Rows that fail are reported instead of being written, so a
 * corrupt file cannot half-load or persist a record the UI cannot render.
 */
export function parseBackup(
  input: unknown,
): { ok: true; value: BackupBundle; skipped: string[] } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: 'The file is not a JSON object.' };
  if (input.app !== 'marketlab') return { ok: false, error: 'This file was not exported by MarketLab.' };
  const version = typeof input.schemaVersion === 'number' ? input.schemaVersion : 0;
  if (version > BACKUP_SCHEMA_VERSION) {
    return { ok: false, error: `The backup uses schema ${version}, which is newer than this build supports.` };
  }

  const skipped: string[] = [];
  const arrayOf = <T,>(key: string, guard: (value: unknown) => value is T): T[] => {
    const raw = input[key];
    if (!Array.isArray(raw)) {
      if (raw !== undefined) skipped.push(key);
      return [];
    }
    const kept: T[] = [];
    for (const entry of raw) {
      if (guard(entry)) kept.push(entry);
      else skipped.push(`${key}:${(entry as { id?: string } | null)?.id ?? 'unknown'}`);
    }
    return kept;
  };

  function isBar(value: unknown): value is Bar {
    const parsed = barSchema.safeParse(value);
    if (!parsed.success) return false;
    const bar = parsed.data;
    // The schema checks the shape; the import path additionally refuses
    // non-positive prices and negative volume, and restored data must not be
    // able to bypass that rule.
    return (
      bar.open > 0 &&
      bar.high > 0 &&
      bar.low > 0 &&
      bar.close > 0 &&
      (bar.volume === null || bar.volume >= 0)
    );
  }

  const isInstruments = (value: unknown): value is Instrument => instrumentSchema.safeParse(value).success;
  const isDatasets = (value: unknown): value is Dataset => datasetSchema.safeParse(value).success;
  /**
   * Restored bars must satisfy the same series rules as the CSV and provider
   * ingest paths. A backup is a file on disk, so a duplicate session, an
   * out-of-order row or a high below the low would otherwise reach charts,
   * screeners and backtests without ever passing the importer. The shared
   * validator is reused so restore cannot drift from ingest, and a series that
   * fails is dropped whole rather than silently shortened.
   */
  function isBars(value: unknown): value is { id: string; bars: Bar[] } {
    if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.bars)) return false;
    if (!value.bars.every((bar) => isBar(bar))) return false;
    // An entry with no bars is left to the dataset check below, as before.
    if (value.bars.length === 0) return true;
    const checked = validateBarEntries({
      rows: value.bars.map((bar, index) => ({ ...bar, rowNumber: index + 1 })),
      duplicatePolicy: 'reject',
    });
    return checked.fatalErrors.length === 0 && checked.summary.rejectedRows === 0 && checked.summary.sortCorrections === 0;
  }
  const isWatchlists = (value: unknown): value is Watchlist => isRecord(value) && typeof value.id === 'string' && Array.isArray(value.instrumentIds);
  const isScreeners = (value: unknown): value is ScreenerDefinition => screenerDefinitionSchema.safeParse(value).success;
  const isBacktests = (value: unknown): value is BacktestConfig => backtestConfigSchema.safeParse(value).success;
  const isChartTemplates = (value: unknown): value is ChartTemplate => parseChartTemplate(value).ok;
  const isResearchRuns = (value: unknown): value is BacktestRun => parseBacktestRun(value).ok;

  const workspaces: Workspace[] = [];
  if (Array.isArray(input.workspaces)) {
    for (const entry of input.workspaces) {
      const parsed = parseWorkspace(entry);
      if (parsed.ok) workspaces.push(parsed.value);
      else skipped.push(`workspaces:${(entry as { id?: string } | null)?.id ?? 'unknown'}`);
    }
  } else if (input.workspaces !== undefined) {
    skipped.push('workspaces');
  }

  const instruments = arrayOf('instruments', isInstruments);
  const datasets = arrayOf('datasets', isDatasets);
  const bars = arrayOf('bars', isBars);
  const watchlists = arrayOf('watchlists', isWatchlists);
  const screeners = arrayOf('screeners', isScreeners).map((screener) => ({
    ...screener,
    sortWindow: resolveSortWindow(screener.sortBy, screener.sortWindow),
  }));
  const backtests = arrayOf('backtests', isBacktests);
  const chartTemplates = arrayOf('chartTemplates', isChartTemplates);
  const researchRuns = arrayOf('researchRuns', isResearchRuns);

  // Datasets whose bars are missing, or whose instrument is missing, are dropped
  // with a note rather than loaded in a broken state.
  const instrumentIds = new Set(instruments.map((instrument) => instrument.id));
  const barsById = new Set(bars.map((entry) => entry.id));
  const usableDatasets = datasets.filter((dataset) => {
    if (!instrumentIds.has(dataset.instrumentId)) {
      skipped.push(`datasets:${dataset.id} (missing instrument)`);
      return false;
    }
    if (!barsById.has(dataset.id)) {
      skipped.push(`datasets:${dataset.id} (missing bars)`);
      return false;
    }
    return true;
  });
  const usableDatasetIds = new Set(usableDatasets.map((dataset) => dataset.id));
  const usableBars = bars.filter((entry) => usableDatasetIds.has(entry.id));

  // Preferences are optional, but when present they must be a complete record:
  // a half-written theme/chart-type pair is what makes the first render throw.
  let preferences: UserPreferences | null = null;
  if (input.preferences !== undefined && input.preferences !== null) {
    const parsed = preferencesSchema.safeParse(input.preferences);
    if (parsed.success) preferences = parsed.data;
    else skipped.push('preferences');
  }

  return {
    ok: true,
    skipped,
    value: {
      app: 'marketlab',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: typeof input.exportedAt === 'string' ? input.exportedAt : new Date().toISOString(),
      instruments,
      datasets: usableDatasets,
      bars: usableBars,
      workspaces,
      watchlists,
      preferences,
      screeners,
      backtests,
      chartTemplates,
      researchRuns,
    },
  };
}

export interface LocalEntities {
  instruments: readonly Instrument[];
  datasets: readonly Dataset[];
  barsByDataset: Readonly<Record<string, Bar[]>>;
  workspaces: readonly Workspace[];
  watchlists: readonly Watchlist[];
  screeners: readonly ScreenerDefinition[];
  backtests: readonly BacktestConfig[];
  chartTemplates?: readonly ChartTemplate[];
  researchRuns?: readonly BacktestRun[];
}

export interface MergeResult {
  instruments: Instrument[];
  datasets: Dataset[];
  barsByDataset: Record<string, Bar[]>;
  workspaces: Workspace[];
  watchlists: Watchlist[];
  screeners: ScreenerDefinition[];
  backtests: BacktestConfig[];
  chartTemplates: ChartTemplate[];
  researchRuns: BacktestRun[];
  /** Entries whose id already existed and were overwritten. */
  overwritten: number;
  /** Datasets skipped because an identical series (same content hash) is already stored. */
  duplicateDatasets: number;
  /** Panels re-pointed at the already-stored equivalent of a skipped dataset. */
  remappedPanels: number;
}

export function mergeById<T extends { id: string }>(base: readonly T[], incoming: readonly T[]): T[] {
  const map = new Map(base.map((entry) => [entry.id, entry]));
  for (const entry of incoming) map.set(entry.id, entry);
  return [...map.values()];
}

/**
 * Merges a backup into the entities already stored on this device.
 *
 * Merging is by id, with one deliberate exception: a dataset whose content hash
 * already exists locally counts as the same series even when its id differs
 * (which happens after a local reset, since ids are regenerated). Those datasets
 * are skipped, and any panel or watchlist entry that referenced them is
 * re-pointed at the stored equivalent. A restore therefore never duplicates the
 * sample set and never leaves a panel pointing at a dataset that was not written.
 */
export function mergeBackup(base: LocalEntities, bundle: BackupBundle): MergeResult {
  const baseIds = {
    instruments: new Set(base.instruments.map((entry) => entry.id)),
    datasets: new Set(base.datasets.map((entry) => entry.id)),
    workspaces: new Set(base.workspaces.map((entry) => entry.id)),
    watchlists: new Set(base.watchlists.map((entry) => entry.id)),
    screeners: new Set(base.screeners.map((entry) => entry.id)),
    backtests: new Set(base.backtests.map((entry) => entry.id)),
    chartTemplates: new Set((base.chartTemplates ?? []).map((entry) => entry.id)),
    researchRuns: new Set((base.researchRuns ?? []).map((entry) => entry.id)),
  };
  let overwritten = 0;

  const instrumentById = new Map<string, Instrument>();
  for (const instrument of [...base.instruments, ...bundle.instruments]) instrumentById.set(instrument.id, instrument);

  // Content alone is not identity: an index and an ETF tracking it can share an
  // identical short window. Only treat a hash match as the same series when the
  // symbol and currency also agree, so a restore never re-points a panel at a
  // different instrument.
  const seriesKey = (dataset: Dataset): string | null => {
    const instrument = instrumentById.get(dataset.instrumentId);
    if (!instrument || !dataset.contentHash) return null;
    return `${dataset.contentHash}\u0000${instrument.symbol}\u0000${instrument.currency}`;
  };

  const hashToLocal = new Map<string, Dataset>();
  for (const dataset of base.datasets) {
    const key = seriesKey(dataset);
    if (key) hashToLocal.set(key, dataset);
  }

  const acceptedDatasets: Dataset[] = [];
  const datasetRemap = new Map<string, string>();
  let duplicateDatasets = 0;

  for (const dataset of bundle.datasets) {
    if (baseIds.datasets.has(dataset.id)) {
      acceptedDatasets.push(dataset);
      overwritten += 1;
      continue;
    }
    const key = seriesKey(dataset);
    const equivalent = key ? hashToLocal.get(key) : undefined;
    if (equivalent) {
      datasetRemap.set(dataset.id, equivalent.id);
      duplicateDatasets += 1;
      continue;
    }
    acceptedDatasets.push(dataset);
    if (key) hashToLocal.set(key, dataset);
  }

  const resolved = new Map<string, Dataset>();
  for (const dataset of base.datasets) resolved.set(dataset.id, dataset);
  for (const dataset of acceptedDatasets) resolved.set(dataset.id, dataset);

  const referencedInstruments = new Set(acceptedDatasets.map((dataset) => dataset.instrumentId));
  const acceptedInstruments = bundle.instruments.filter(
    (instrument) => referencedInstruments.has(instrument.id) || baseIds.instruments.has(instrument.id),
  );
  overwritten += acceptedInstruments.filter((instrument) => baseIds.instruments.has(instrument.id)).length;

  const instrumentRemap = new Map<string, string>();
  for (const [skippedId, keptId] of datasetRemap) {
    const source = bundle.datasets.find((dataset) => dataset.id === skippedId);
    const target = resolved.get(keptId);
    if (source && target && source.instrumentId !== target.instrumentId) {
      instrumentRemap.set(source.instrumentId, target.instrumentId);
    }
  }

  let remappedPanels = 0;
  const acceptedWorkspaces = bundle.workspaces.map((workspace) => ({
    ...workspace,
    charts: workspace.charts.map((chart) => {
      const replacement = datasetRemap.get(chart.datasetId);
      const datasetId = replacement ?? chart.datasetId;
      const storedComparisons = chart.compareDatasetIds ?? [];
      // Comparison overlays are dataset references too: remap them through the
      // same duplicate-series resolution and drop a self-reference or a repeat.
      const compareDatasetIds = storedComparisons
        .map((id) => datasetRemap.get(id) ?? id)
        .filter((id, index, list) => id !== datasetId && list.indexOf(id) === index);
      const comparisonsChanged =
        compareDatasetIds.length !== storedComparisons.length ||
        compareDatasetIds.some((id, index) => id !== storedComparisons[index]);
      if (replacement) remappedPanels += 1;
      if (!replacement && !comparisonsChanged) return chart;
      return {
        ...chart,
        datasetId,
        instrumentId: replacement
          ? resolved.get(datasetId)?.instrumentId ?? chart.instrumentId
          : chart.instrumentId,
        compareDatasetIds,
      };
    }),
  }));
  overwritten += acceptedWorkspaces.filter((workspace) => baseIds.workspaces.has(workspace.id)).length;

  const acceptedWatchlists = bundle.watchlists.map((watchlist) => ({
    ...watchlist,
    instrumentIds: [...new Set(watchlist.instrumentIds.map((id) => instrumentRemap.get(id) ?? id))],
  }));
  overwritten += acceptedWatchlists.filter((watchlist) => baseIds.watchlists.has(watchlist.id)).length;

  const acceptedScreeners = bundle.screeners.map((screener) => ({
    ...screener,
    universeDatasetIds: [...new Set(screener.universeDatasetIds.map((id) => datasetRemap.get(id) ?? id))],
  }));
  const acceptedBacktests = bundle.backtests.map((backtest) => {
    const replacement = datasetRemap.get(backtest.datasetId);
    return replacement ? { ...backtest, datasetId: replacement } : backtest;
  });

  // A saved run names its dataset by id. When the same series is already stored
  // under another id, re-point the run so it can still be verified after the
  // restore instead of reporting a missing dataset.
  const acceptedResearchRuns = (bundle.researchRuns ?? []).map((run) => {
    const replacement = datasetRemap.get(run.dataset.datasetId);
    if (!replacement) return run;
    const target = resolved.get(replacement);
    return {
      ...run,
      config: {
        ...run.config,
        datasetId: replacement,
      },
      dataset: {
        ...run.dataset,
        datasetId: replacement,
        instrumentId: target?.instrumentId ?? run.dataset.instrumentId,
      },
    };
  });

  overwritten += bundle.screeners.filter((entry) => baseIds.screeners.has(entry.id)).length;
  overwritten += bundle.backtests.filter((entry) => baseIds.backtests.has(entry.id)).length;
  const acceptedChartTemplates = bundle.chartTemplates ?? [];
  overwritten += acceptedChartTemplates.filter((entry) => baseIds.chartTemplates.has(entry.id)).length;
  overwritten += acceptedResearchRuns.filter((entry) => baseIds.researchRuns.has(entry.id)).length;

  const acceptedDatasetIds = new Set(acceptedDatasets.map((dataset) => dataset.id));
  const barsByDataset: Record<string, Bar[]> = { ...base.barsByDataset };
  for (const entry of bundle.bars) {
    if (acceptedDatasetIds.has(entry.id)) barsByDataset[entry.id] = entry.bars;
  }

  return {
    instruments: mergeById(base.instruments, acceptedInstruments),
    datasets: mergeById(base.datasets, acceptedDatasets),
    barsByDataset,
    workspaces: mergeById(base.workspaces, acceptedWorkspaces),
    watchlists: mergeById(base.watchlists, acceptedWatchlists),
    screeners: mergeById(base.screeners, acceptedScreeners),
    backtests: mergeById(base.backtests, acceptedBacktests),
    chartTemplates: mergeById(base.chartTemplates ?? [], acceptedChartTemplates),
    researchRuns: mergeById(base.researchRuns ?? [], acceptedResearchRuns),
    overwritten,
    duplicateDatasets,
    remappedPanels,
  };
}

/**
 * True when a replace-mode restore would erase a non-empty library while the
 * backup itself carries no restorable datasets or workspaces.
 *
 * A backup with no entities is a valid export, but applying it as "replace" is
 * indistinguishable from deleting the whole library, and there is nothing in
 * the file to show for it afterwards. The caller refuses the restore and points
 * the user at the explicit reset action instead.
 */
export function isEmptyReplaceRestore(input: {
  local: { datasets: readonly unknown[]; workspaces: readonly unknown[] };
  merged: { datasets: readonly unknown[]; workspaces: readonly unknown[] };
}): boolean {
  const localHasData = input.local.datasets.length > 0 || input.local.workspaces.length > 0;
  const mergedHasData = input.merged.datasets.length > 0 || input.merged.workspaces.length > 0;
  return localHasData && !mergedHasData;
}

