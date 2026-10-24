import { z } from 'zod';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestRun,
  BacktestTrade,
  Bar,
  Dataset,
  Frequency,
  Instrument,
} from '../../domain/types';
import { createId } from '../id';
import { parseBacktestRun, RESEARCH_RUN_SCHEMA_VERSION } from '../workspace/schema';
import { BACKTEST_ASSUMPTIONS, BACKTEST_ENGINE_VERSION, runBacktest, selectBacktestWindow } from './engine';
import { resolveRunDataset } from './run-datasets';

export { RESEARCH_RUN_SCHEMA_VERSION };

/** Bounded storage: a new run is refused rather than silently pruning an old one. */
export const MAX_SAVED_RESEARCH_RUNS = 50;

/**
 * Fingerprints are versioned. A newer canonicalisation can therefore be told
 * apart from a genuine input change instead of being reported as one.
 */
export const WINDOW_FINGERPRINT_VERSION = 'marketlab-window-v1';

/** Manifest files hold one run and never carry market data. */
export const RESEARCH_MANIFEST_VERSION = 1;

/**
 * Deterministic verification tolerance.
 *
 * Re-running the frozen engine on identical bars in the same build reproduces
 * every number bit for bit. The tolerance exists only to absorb floating-point
 * differences between JavaScript runtimes; it is deliberately tight.
 */
export const VERIFICATION_TOLERANCE = { absolute: 1e-9, relative: 1e-9 } as const;

export type ResearchRunStatus = 'match' | 'mismatch' | 'inputs-changed' | 'engine-changed' | 'dataset-missing';

export interface ResearchRunVerification {
  status: ResearchRunStatus;
  datasetAvailable: boolean;
  inputsChanged: boolean;
  engineChanged: boolean;
  /** Fingerprint of the window in the current library, when it could be computed. */
  windowFingerprint: string | null;
  /** Present when the engine was executed; absent when inputs changed and the caller did not opt in. */
  result: BacktestResult | null;
  /** Why the inputs or the engine differ from the saved run. */
  notes: string[];
  /** How the freshly computed outputs differ from the saved outputs. */
  differences: string[];
}

export interface CreateBacktestRunInput {
  config: BacktestConfig;
  dataset: Dataset;
  instrument: Instrument | undefined;
  /** The whole dataset; the run window is selected with the engine's own rule. */
  bars: readonly Bar[];
  result: BacktestResult;
  name?: string;
  id?: string;
  createdAt?: string;
}

/**
 * Copies a configuration so a saved run never aliases the editable draft.
 */
function snapshotConfig(config: BacktestConfig): BacktestConfig {
  return {
    ...config,
    entry: config.entry.map((rule) => ({ ...rule })),
    exit: config.exit.map((rule) => ({ ...rule })),
  };
}

function snapshotTrades(trades: readonly BacktestTrade[]): BacktestTrade[] {
  return trades.map((trade) => ({ ...trade }));
}

function canonicalBar(bar: Bar): string {
  return [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume ?? ''].join('|');
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is unavailable, so the dataset fingerprint cannot be computed.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A cryptographic fingerprint of the exact bars in a run window.
 *
 * This identifies the inputs while they remain in the library. It cannot
 * recreate deleted data, and it is not a signature: a malicious editor of a
 * manifest can rewrite both the fingerprint and the outputs.
 */
export async function computeWindowFingerprint(bars: readonly Bar[], frequency: Frequency): Promise<string> {
  const body = [WINDOW_FINGERPRINT_VERSION, frequency, ...bars.map(canonicalBar)].join('\n');
  return `sha256:${await sha256Hex(body)}`;
}

export async function createBacktestRun(input: CreateBacktestRunInput): Promise<BacktestRun> {
  const windowBars = selectBacktestWindow(input.bars, input.config.startDate, input.config.endDate);
  if (windowBars.length === 0) {
    throw new Error('A research run needs at least one session in its window.');
  }
  const name = (input.name ?? input.config.name).trim();
  if (!name) {
    throw new Error('A research run needs a name.');
  }
  const first = windowBars[0] as Bar;
  const last = windowBars[windowBars.length - 1] as Bar;
  return {
    id: input.id ?? createId('run'),
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    name,
    createdAt: input.createdAt ?? new Date().toISOString(),
    engineVersion: BACKTEST_ENGINE_VERSION,
    config: snapshotConfig(input.config),
    dataset: {
      datasetId: input.dataset.id,
      instrumentId: input.dataset.instrumentId,
      instrumentSymbol: input.instrument?.symbol ?? '',
      datasetName: input.dataset.name,
      frequency: input.dataset.frequency,
      contentHash: input.dataset.contentHash,
      windowFingerprint: await computeWindowFingerprint(windowBars, input.dataset.frequency),
      windowStart: first.date,
      windowEnd: last.date,
      barCount: windowBars.length,
    },
    assumptions: [...BACKTEST_ASSUMPTIONS],
    metrics: { ...input.result.metrics },
    trades: snapshotTrades(input.result.trades),
  };
}

const METRIC_KEYS = [
  'totalReturnPct',
  'cagrPct',
  'annualisedVolatilityPct',
  'maxDrawdownPct',
  'sharpe',
  'tradeCount',
  'winRatePct',
  'profitFactor',
  'averageTradePct',
  'exposurePct',
  'benchmarkTotalReturnPct',
] as const satisfies ReadonlyArray<keyof BacktestResult['metrics']>;

const TRADE_NUMERIC_KEYS = ['entryPrice', 'exitPrice', 'quantity', 'grossPnl', 'costs', 'netPnl', 'returnPct'] as const;
const TRADE_EXACT_KEYS = ['entryDate', 'exitDate', 'exitReason', 'barsHeld'] as const;

function nearlyEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= VERIFICATION_TOLERANCE.absolute + VERIFICATION_TOLERANCE.relative * Math.max(Math.abs(left), Math.abs(right));
}

function trimDifferences(differences: string[]): string[] {
  const limit = 12;
  if (differences.length <= limit) return differences;
  return [...differences.slice(0, limit), `…and ${differences.length - limit} more difference(s).`];
}

function compareTrades(saved: readonly BacktestTrade[], actual: readonly BacktestTrade[]): string[] {
  const differences: string[] = [];
  if (saved.length !== actual.length) {
    differences.push(`Trade count: saved ${saved.length}, rerun ${actual.length}.`);
  }
  const shared = Math.min(saved.length, actual.length);
  for (let index = 0; index < shared; index += 1) {
    const left = saved[index] as BacktestTrade;
    const right = actual[index] as BacktestTrade;
    for (const key of TRADE_EXACT_KEYS) {
      if (left[key] !== right[key]) {
        differences.push(`Trade ${index + 1} ${key}: saved ${String(left[key])}, rerun ${String(right[key])}.`);
      }
    }
    for (const key of TRADE_NUMERIC_KEYS) {
      if (!nearlyEqual(left[key], right[key])) {
        differences.push(`Trade ${index + 1} ${key}: saved ${left[key]}, rerun ${right[key]}.`);
      }
    }
  }
  return differences;
}

function compareOutputs(saved: BacktestResult['metrics'], savedTrades: readonly BacktestTrade[], result: BacktestResult): string[] {
  const differences: string[] = [];
  for (const key of METRIC_KEYS) {
    if (!nearlyEqual(saved[key], result.metrics[key])) {
      differences.push(`Metric ${key}: saved ${String(saved[key])}, rerun ${String(result.metrics[key])}.`);
    }
  }
  differences.push(...compareTrades(savedTrades, result.trades));
  return trimDifferences(differences);
}

export interface VerifyBacktestRunInput {
  run: BacktestRun;
  dataset: Dataset | undefined;
  bars: readonly Bar[] | undefined;
  /**
   * Re-run even though the input fingerprint no longer matches. The status
   * still reports `inputs-changed`: changed prices are disclosed, never
   * silently substituted.
   */
  allowChangedInputs?: boolean;
}

/**
 * Re-runs a saved run against the current library and compares the outputs.
 *
 * Precedence is deliberate: a missing dataset cannot be simulated at all, and
 * changed inputs make an "output mismatch" meaningless until the user opts into
 * a fresh simulation. The stored run is never modified by verification.
 */
export async function verifyBacktestRun(input: VerifyBacktestRunInput): Promise<ResearchRunVerification> {
  const { run, dataset, bars } = input;
  const notes: string[] = [];
  if (!dataset || !bars) {
    return {
      status: 'dataset-missing',
      datasetAvailable: false,
      inputsChanged: false,
      engineChanged: false,
      windowFingerprint: null,
      result: null,
      notes: ['The dataset this run used is not in the library, so its inputs cannot be reproduced.'],
      differences: [],
    };
  }

  const windowBars = selectBacktestWindow(bars, run.config.startDate, run.config.endDate);
  const windowFingerprint = await computeWindowFingerprint(windowBars, dataset.frequency);

  if (dataset.contentHash !== run.dataset.contentHash) {
    notes.push(`Dataset content hash changed from ${run.dataset.contentHash} to ${dataset.contentHash}.`);
  }
  if (dataset.frequency !== run.dataset.frequency) {
    notes.push(`Dataset frequency changed from ${run.dataset.frequency} to ${dataset.frequency}.`);
  }
  if (dataset.instrumentId !== run.dataset.instrumentId) {
    notes.push(`Dataset instrument changed from ${run.dataset.instrumentId} to ${dataset.instrumentId}.`);
  }
  if (windowFingerprint !== run.dataset.windowFingerprint) {
    notes.push('The bars in this run window no longer match the saved window fingerprint.');
  }
  const inputsChanged = notes.length > 0;
  const engineChanged = run.engineVersion !== BACKTEST_ENGINE_VERSION;
  if (engineChanged) {
    notes.push(`Engine version changed from ${run.engineVersion} to ${BACKTEST_ENGINE_VERSION}.`);
  }

  if (inputsChanged && !input.allowChangedInputs) {
    return {
      status: 'inputs-changed',
      datasetAvailable: true,
      inputsChanged,
      engineChanged,
      windowFingerprint,
      result: null,
      notes,
      differences: [],
    };
  }

  const result = runBacktest(bars, run.config, dataset.frequency);
  const differences = compareOutputs(run.metrics, run.trades, result);
  const status: ResearchRunStatus = inputsChanged
    ? 'inputs-changed'
    : engineChanged
      ? 'engine-changed'
      : differences.length > 0
        ? 'mismatch'
        : 'match';

  return {
    status,
    datasetAvailable: true,
    inputsChanged,
    engineChanged,
    windowFingerprint,
    result,
    notes,
    differences,
  };
}

/* -------------------------------------------------------------------------- */
/* Export manifest and storage planning                                        */
/* -------------------------------------------------------------------------- */

export interface ResearchRunManifest {
  app: 'marketlab';
  kind: 'research-run';
  manifestVersion: number;
  exportedAt: string;
  containsInputData: false;
  run: BacktestRun;
}

const manifestEnvelopeSchema = z.object({
  app: z.literal('marketlab'),
  kind: z.literal('research-run'),
  manifestVersion: z.number().int().nonnegative(),
  exportedAt: z.string(),
  containsInputData: z.literal(false),
  run: z.unknown(),
});

export function createResearchRunManifest(run: BacktestRun, exportedAt = new Date().toISOString()): ResearchRunManifest {
  return {
    app: 'marketlab',
    kind: 'research-run',
    manifestVersion: RESEARCH_MANIFEST_VERSION,
    exportedAt,
    containsInputData: false,
    run,
  };
}

export function serialiseResearchRunManifest(run: BacktestRun): string {
  return JSON.stringify(createResearchRunManifest(run), null, 2);
}

/**
 * Parses one exported research run.
 *
 * A newer manifest or a newer run schema is rejected rather than downgraded.
 * Unknown extra keys in the same version are ignored by the zod object schemas,
 * so a build can add a field without making older builds fail. The file is
 * required to declare `containsInputData: false`; a manifest carrying bars is
 * not accepted by this build.
 */
export function parseResearchRunManifest(
  input: unknown,
): { ok: true; value: ResearchRunManifest } | { ok: false; error: string } {
  if (input && typeof input === 'object' && 'manifestVersion' in input) {
    const version = (input as { manifestVersion?: unknown }).manifestVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      return { ok: false, error: 'The research manifest version is missing or invalid.' };
    }
    if (version > RESEARCH_MANIFEST_VERSION) {
      return { ok: false, error: `This research manifest uses version ${version}, which is newer than this build supports.` };
    }
  }
  const envelope = manifestEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: envelope.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; '),
    };
  }
  const run = parseBacktestRun(envelope.data.run);
  if (!run.ok) return { ok: false, error: run.error };
  return {
    ok: true,
    value: {
      app: 'marketlab',
      kind: 'research-run',
      manifestVersion: RESEARCH_MANIFEST_VERSION,
      exportedAt: envelope.data.exportedAt,
      containsInputData: false,
      run: run.value,
    },
  };
}

export type ResearchRunSaveDecision =
  | { ok: true }
  | { ok: false; reason: 'duplicate' | 'limit'; message: string };

/** Saving is append-only: a run id is never overwritten and the cap never prunes. */
export function planResearchRunSave(existing: readonly BacktestRun[], run: BacktestRun): ResearchRunSaveDecision {
  if (existing.some((entry) => entry.id === run.id)) {
    return { ok: false, reason: 'duplicate', message: 'That research run is already saved. Saved runs are immutable.' };
  }
  if (existing.length >= MAX_SAVED_RESEARCH_RUNS) {
    return {
      ok: false,
      reason: 'limit',
      message: `The research library is full (${MAX_SAVED_RESEARCH_RUNS} runs). Delete a run before saving another.`,
    };
  }
  return { ok: true };
}

export interface ResearchRunImportPlan {
  accepted: BacktestRun[];
  duplicateIds: string[];
  overLimitIds: string[];
}

/** Import skips ids that already exist (or repeat in the file) and reports them. */
export function planResearchRunImport(existing: readonly BacktestRun[], incoming: readonly BacktestRun[]): ResearchRunImportPlan {
  const known = new Set(existing.map((run) => run.id));
  const accepted: BacktestRun[] = [];
  const duplicateIds: string[] = [];
  const overLimitIds: string[] = [];
  for (const run of incoming) {
    if (known.has(run.id)) {
      duplicateIds.push(run.id);
      continue;
    }
    if (existing.length + accepted.length >= MAX_SAVED_RESEARCH_RUNS) {
      overLimitIds.push(run.id);
      continue;
    }
    accepted.push(run);
    known.add(run.id);
  }
  return { accepted, duplicateIds, overLimitIds };
}

/** Newest first, with a stable tie-break so the list does not reshuffle. */
export function sortResearchRuns(runs: readonly BacktestRun[]): BacktestRun[] {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

/**
 * Returns a run with only its display name changed.
 *
 * A name is library metadata, not a recorded input or output. The id, saved
 * time, configuration, dataset identity and fingerprints, engine version,
 * assumptions, metrics and trades are carried through untouched. Callers still
 * parse and persist the result, so an invalid rename never reaches storage.
 */
export function withResearchRunName(run: BacktestRun, name: string): BacktestRun {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A research run needs a name.');
  return trimmed === run.name ? run : { ...run, name: trimmed };
}

/**
 * Plans turning a saved run back into an editable draft.
 *
 * The returned configuration is a deep copy with a fresh id, so the editor can
 * never alias the immutable run and saving it creates a new record. Loading is
 * refused when the run's dataset is gone from the library and no
 * content-identical sibling is available: showing its rules against a different
 * series would imply a reproduction that cannot happen.
 *
 * When the stored dataset id is absent but a unique content-identical sibling
 * is available (same bars, same instrument identity and frequency, per
 * `resolveRunDataset`), the draft targets that sibling and `repointed` names
 * the substitution so the caller can disclose it. The run's dataset block is
 * canonical: a stale `config.datasetId` carried by an older backup never wins.
 */
export interface ResearchRunLoadRepoint {
  savedDatasetId: string;
  targetDatasetId: string;
}

export type ResearchRunLoadPlan =
  | { ok: true; config: BacktestConfig; repointed: ResearchRunLoadRepoint | null }
  | { ok: false; message: string };

export function planResearchRunLoad(
  run: BacktestRun,
  datasets: readonly Dataset[],
  instrumentsById: ReadonlyMap<string, Instrument>,
  nextConfigId: string,
): ResearchRunLoadPlan {
  if (datasets.some((dataset) => dataset.id === run.dataset.datasetId)) {
    return {
      ok: true,
      config: {
        ...snapshotConfig(run.config),
        id: nextConfigId,
        datasetId: run.dataset.datasetId,
      },
      repointed: null,
    };
  }
  const resolution = resolveRunDataset(run, datasets, instrumentsById);
  if (resolution.basis !== 'matching-content' || resolution.dataset === null) {
    return {
      ok: false,
      message: `The dataset "${run.dataset.datasetName}" this run used is not in the library, and no stored series verifiably represents its inputs, so research run "${run.name}" cannot be loaded.`,
    };
  }
  return {
    ok: true,
    config: {
      ...snapshotConfig(run.config),
      id: nextConfigId,
      datasetId: resolution.dataset.id,
    },
    repointed: { savedDatasetId: run.dataset.datasetId, targetDatasetId: resolution.dataset.id },
  };
}
