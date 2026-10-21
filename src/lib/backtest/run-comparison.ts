import type { BacktestConfig, BacktestResult, BacktestRun, Bar, Dataset } from '../../domain/types';
import { formatPercent, formatPrice } from '../format';
import { BACKTEST_ENGINE_VERSION, selectBacktestWindow } from './engine';
import { computeWindowFingerprint } from './research-runs';
import { describeStrategyRules } from './rule-catalog';

/**
 * Comparison is a read-only view over two immutable research-run snapshots.
 *
 * Nothing here runs the backtest engine. The only current-library work is an
 * explicit input inspection that hashes the stored window so a changed local
 * dataset can be disclosed without replacing the saved result.
 */

export type ComparisonMetricValueKind = 'percent' | 'ratio' | 'count';
export type ComparisonMetricDeltaKind = 'pp' | 'ratio' | 'count' | 'none';

export interface ComparisonMetricDefinition {
  key: keyof BacktestResult['metrics'];
  label: string;
  valueKind: ComparisonMetricValueKind;
  deltaKind: ComparisonMetricDeltaKind;
}

export interface MetricComparisonRow extends ComparisonMetricDefinition {
  leftValue: number | null;
  rightValue: number | null;
  delta: number | null;
}

/**
 * Absolute differences are only offered where subtraction has a stable
 * meaning. Profit factor is unbounded and undefined without losing trades, so
 * it is shown as a value only rather than as a misleading arithmetic delta.
 */
export const COMPARISON_METRICS: readonly ComparisonMetricDefinition[] = [
  { key: 'totalReturnPct', label: 'Total return', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'cagrPct', label: 'CAGR', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'annualisedVolatilityPct', label: 'Annualised volatility', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'maxDrawdownPct', label: 'Max drawdown', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'sharpe', label: 'Sharpe', valueKind: 'ratio', deltaKind: 'ratio' },
  { key: 'tradeCount', label: 'Trades', valueKind: 'count', deltaKind: 'count' },
  { key: 'winRatePct', label: 'Win rate', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'profitFactor', label: 'Profit factor', valueKind: 'ratio', deltaKind: 'none' },
  { key: 'averageTradePct', label: 'Average trade', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'exposurePct', label: 'Exposure', valueKind: 'percent', deltaKind: 'pp' },
  { key: 'benchmarkTotalReturnPct', label: 'Buy and hold', valueKind: 'percent', deltaKind: 'pp' },
];

const NUMERIC_TOLERANCE = 1e-9;

function readMetric(metrics: BacktestResult['metrics'], key: keyof BacktestResult['metrics']): number | null {
  const value = metrics[key] as number | null | undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numbersEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= NUMERIC_TOLERANCE + NUMERIC_TOLERANCE * Math.max(Math.abs(left), Math.abs(right));
}

export function compareRunMetrics(left: BacktestRun, right: BacktestRun): MetricComparisonRow[] {
  return COMPARISON_METRICS.map((definition) => {
    const leftValue = readMetric(left.metrics, definition.key);
    const rightValue = readMetric(right.metrics, definition.key);
    const rawDelta =
      definition.deltaKind === 'none' || leftValue === null || rightValue === null ? null : rightValue - leftValue;
    const delta = rawDelta !== null && Math.abs(rawDelta) <= NUMERIC_TOLERANCE ? 0 : rawDelta;
    return { ...definition, leftValue, rightValue, delta };
  });
}

export function runMetricsMatch(left: BacktestRun, right: BacktestRun): boolean {
  return COMPARISON_METRICS.every((definition) =>
    numbersEqual(readMetric(left.metrics, definition.key), readMetric(right.metrics, definition.key)),
  );
}

export function formatComparisonValue(kind: ComparisonMetricValueKind, value: number | null): string {
  if (value === null) return '--';
  switch (kind) {
    case 'percent':
      return formatPercent(value);
    case 'ratio':
      return value.toFixed(2);
    case 'count':
      return String(value);
  }
}

export function formatComparisonDelta(row: MetricComparisonRow): string {
  if (row.deltaKind === 'none') return 'n/a';
  if (row.delta === null) return '--';
  const sign = row.delta > 0 ? '+' : row.delta < 0 ? '-' : '';
  const absolute = Math.abs(row.delta);
  switch (row.deltaKind) {
    case 'pp':
      return `${sign}${absolute.toFixed(2)} pp`;
    case 'ratio':
      return `${sign}${absolute.toFixed(2)}`;
    case 'count':
      return `${sign}${absolute.toFixed(0)}`;
  }
}

function canonicalRule(rule: BacktestConfig['entry'][number]): string {
  return JSON.stringify([rule.field, rule.operator, rule.value, rule.window, rule.secondaryWindow ?? null]);
}

function canonicalRuleSet(rules: BacktestConfig['entry']): string {
  return rules.map(canonicalRule).sort().join('\n');
}

function ruleSetChanged(left: BacktestConfig, right: BacktestConfig, side: 'entry' | 'exit'): boolean {
  return (
    left[`${side}Logic`] !== right[`${side}Logic`] ||
    canonicalRuleSet(left[side]) !== canonicalRuleSet(right[side])
  );
}

function describeRules(config: BacktestConfig, side: 'entry' | 'exit'): string {
  return `${config[`${side}Logic`]}: ${describeStrategyRules(config[side], config[`${side}Logic`])}`;
}

export interface ConfigComparisonRow {
  key: string;
  label: string;
  left: string;
  right: string;
  changed: boolean;
}

function configRow(
  key: string,
  label: string,
  left: string,
  right: string,
  changed = left !== right,
): ConfigComparisonRow {
  return { key, label, left, right, changed };
}

export function compareRunConfigs(left: BacktestRun, right: BacktestRun): ConfigComparisonRow[] {
  const a = left.config;
  const b = right.config;
  return [
    configRow('entry', 'Entry rules', describeRules(a, 'entry'), describeRules(b, 'entry'), ruleSetChanged(a, b, 'entry')),
    configRow('exit', 'Exit rules', describeRules(a, 'exit'), describeRules(b, 'exit'), ruleSetChanged(a, b, 'exit')),
    configRow('capital', 'Initial capital', formatPrice(a.initialCapital), formatPrice(b.initialCapital)),
    configRow('position', 'Position size', formatPercent(a.positionSizePct), formatPercent(b.positionSizePct)),
    configRow('commission', 'Commission', `${a.commissionBps} bps`, `${b.commissionBps} bps`),
    configRow('slippage', 'Slippage', `${a.slippageBps} bps`, `${b.slippageBps} bps`),
    configRow(
      'stop-loss',
      'Stop loss',
      a.stopLossPct === null ? 'None (disabled)' : formatPercent(a.stopLossPct),
      b.stopLossPct === null ? 'None (disabled)' : formatPercent(b.stopLossPct),
    ),
    configRow(
      'take-profit',
      'Take profit',
      a.takeProfitPct === null ? 'None (disabled)' : formatPercent(a.takeProfitPct),
      b.takeProfitPct === null ? 'None (disabled)' : formatPercent(b.takeProfitPct),
    ),
    configRow(
      'execution',
      'Fill timing',
      a.execution === 'next-open' ? 'Next session open' : a.execution,
      b.execution === 'next-open' ? 'Next session open' : b.execution,
    ),
  ];
}

export type WindowRelation = 'same' | 'overlap' | 'disjoint';

export interface WindowComparison {
  relation: WindowRelation;
  sameStart: boolean;
  sameEnd: boolean;
  sameBarCount: boolean;
  sameFingerprint: boolean;
  label: string;
  detail: string;
}

export function compareRunWindows(left: BacktestRun, right: BacktestRun): WindowComparison {
  const a = left.dataset;
  const b = right.dataset;
  const sameStart = a.windowStart === b.windowStart;
  const sameEnd = a.windowEnd === b.windowEnd;
  const sameBarCount = a.barCount === b.barCount;
  const sameFingerprint = a.windowFingerprint === b.windowFingerprint;
  const rangesOverlap = a.windowStart <= b.windowEnd && b.windowStart <= a.windowEnd;
  const relation: WindowRelation = sameStart && sameEnd && sameBarCount && sameFingerprint
    ? 'same'
    : rangesOverlap
      ? 'overlap'
      : 'disjoint';
  const label =
    relation === 'same'
      ? 'Same window'
      : sameStart && sameEnd
        ? 'Same dates, different bars'
        : relation === 'overlap'
          ? 'Overlapping windows'
          : 'Disjoint windows';
  const notes = [
    `Run A ${a.windowStart} to ${a.windowEnd} (${a.barCount} sessions)`,
    `Run B ${b.windowStart} to ${b.windowEnd} (${b.barCount} sessions)`,
  ];
  if (!sameBarCount) notes.push(`Session counts differ (${a.barCount} vs ${b.barCount}).`);
  if (!sameFingerprint) notes.push('Window fingerprints differ.');
  return { relation, sameStart, sameEnd, sameBarCount, sameFingerprint, label, detail: notes.join('. ') + '.' };
}

export interface AssumptionComparison {
  same: boolean;
  shared: string[];
  onlyLeft: string[];
  onlyRight: string[];
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function compareRunAssumptions(left: BacktestRun, right: BacktestRun): AssumptionComparison {
  const rightSet = new Set(right.assumptions);
  const leftSet = new Set(left.assumptions);
  const shared = uniqueInOrder(left.assumptions.filter((assumption) => rightSet.has(assumption)));
  const onlyLeft = uniqueInOrder(left.assumptions.filter((assumption) => !rightSet.has(assumption)));
  const onlyRight = uniqueInOrder(right.assumptions.filter((assumption) => !leftSet.has(assumption)));
  return { same: onlyLeft.length === 0 && onlyRight.length === 0, shared, onlyLeft, onlyRight };
}

export interface ProvenanceComparisonRow {
  key: string;
  label: string;
  left: string;
  right: string;
  changed: boolean;
  mono?: boolean;
}

function provenanceRow(
  key: string,
  label: string,
  left: string,
  right: string,
  mono = false,
): ProvenanceComparisonRow {
  return { key, label, left, right, changed: left !== right, mono };
}

export function formatRunTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : `${parsed.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function compareRunProvenance(left: BacktestRun, right: BacktestRun): ProvenanceComparisonRow[] {
  const a = left.dataset;
  const b = right.dataset;
  return [
    provenanceRow('saved', 'Saved', formatRunTimestamp(left.createdAt), formatRunTimestamp(right.createdAt)),
    provenanceRow(
      'instrument',
      'Instrument',
      a.instrumentSymbol || a.instrumentId,
      b.instrumentSymbol || b.instrumentId,
    ),
    provenanceRow('dataset', 'Dataset', a.datasetName, b.datasetName),
    provenanceRow('dataset-record', 'Dataset record', a.datasetId, b.datasetId, true),
    provenanceRow('frequency', 'Frequency', a.frequency, b.frequency),
    provenanceRow('content-hash', 'Content hash', a.contentHash, b.contentHash, true),
    provenanceRow(
      'window',
      'Window',
      `${a.windowStart} to ${a.windowEnd}`,
      `${b.windowStart} to ${b.windowEnd}`,
      true,
    ),
    provenanceRow('sessions', 'Sessions', String(a.barCount), String(b.barCount)),
    provenanceRow('fingerprint', 'Window fingerprint', a.windowFingerprint, b.windowFingerprint, true),
    provenanceRow('engine', 'Engine version', left.engineVersion, right.engineVersion, true),
    provenanceRow(
      'assumptions',
      'Recorded assumptions',
      `${left.assumptions.length} statements`,
      `${right.assumptions.length} statements`,
    ),
  ];
}

export type ComparisonSeverity = 'warning' | 'note' | 'match';

export interface ComparisonFinding {
  id: string;
  severity: Exclude<ComparisonSeverity, 'match'>;
  title: string;
  detail: string;
}

export interface ComparisonSummary {
  severity: ComparisonSeverity;
  label: string;
  detail: string;
}

export interface ResearchRunComparison {
  sameRecord: boolean;
  sameDatasetContent: boolean;
  sameDatasetRecord: boolean;
  sameWindow: boolean;
  sameEngine: boolean;
  sameAssumptions: boolean;
  inputsComparable: boolean;
  metricsMatch: boolean;
  missingDatasetSides: Array<'A' | 'B'>;
  window: WindowComparison;
  metrics: MetricComparisonRow[];
  config: ConfigComparisonRow[];
  provenance: ProvenanceComparisonRow[];
  assumptions: AssumptionComparison;
  changedConfigFields: string[];
  findings: ComparisonFinding[];
  summary: ComparisonSummary;
}

export interface CompareResearchRunsOptions {
  /** Dataset ids currently in the local library. Omit when availability is unknown. */
  availableDatasetIds?: readonly string[];
}

function datasetIdentityDifferences(left: BacktestRun, right: BacktestRun): string[] {
  const fields: string[] = [];
  if (left.dataset.contentHash !== right.dataset.contentHash) fields.push('content hash');
  if (left.dataset.frequency !== right.dataset.frequency) fields.push('frequency');
  if (left.dataset.instrumentId !== right.dataset.instrumentId) fields.push('instrument');
  return fields;
}

function summarize(comparison: Omit<ResearchRunComparison, 'summary'>): ComparisonSummary {
  if (comparison.sameRecord) {
    return {
      severity: 'note',
      label: 'Same record',
      detail: 'The same saved run is selected on both sides. Choose a different run on one side to compare two snapshots.',
    };
  }
  if (!comparison.inputsComparable) {
    return {
      severity: 'warning',
      label: 'Not directly comparable',
      detail: 'Read the material differences before using the metric deltas. The saved runs do not describe the same inputs.',
    };
  }
  if (comparison.missingDatasetSides.length > 0) {
    const sides = comparison.missingDatasetSides.join(' and ');
    return {
      severity: 'warning',
      label: 'Snapshot-only inputs',
      detail: `The recorded input identity matches, but the dataset for run ${sides} is not in the local library. Snapshots remain readable; the current dataset cannot be checked.`,
    };
  }
  if (comparison.changedConfigFields.length > 0) {
    return {
      severity: 'note',
      label: 'Different strategies',
      detail: 'Inputs, window and engine match. Strategy settings differ, so deltas describe different configurations rather than an isolated effect.',
    };
  }
  return {
    severity: 'match',
    label: 'Like-for-like inputs',
    detail: comparison.metricsMatch
      ? 'Inputs, window, engine and strategy settings match. The recorded metric deltas are zero.'
      : 'Inputs, window, engine and strategy settings match, but the recorded outputs differ. Verify both runs before trusting either.',
  };
}

export function compareResearchRuns(
  left: BacktestRun,
  right: BacktestRun,
  options: CompareResearchRunsOptions = {},
): ResearchRunComparison {
  const sameRecord = left.id === right.id;
  const sameDatasetContent = datasetIdentityDifferences(left, right).length === 0;
  const sameDatasetRecord = left.dataset.datasetId === right.dataset.datasetId;
  const window = compareRunWindows(left, right);
  const sameWindow = window.relation === 'same';
  const sameEngine = left.engineVersion === right.engineVersion;
  const assumptions = compareRunAssumptions(left, right);
  const metrics = compareRunMetrics(left, right);
  const config = compareRunConfigs(left, right);
  const changedConfigFields = config.filter((row) => row.changed).map((row) => row.label);
  const metricsMatch = runMetricsMatch(left, right);
  const inputsComparable = sameDatasetContent && sameWindow && sameEngine && assumptions.same;

  const available = options.availableDatasetIds ? new Set(options.availableDatasetIds) : null;
  const missingDatasetSides: Array<'A' | 'B'> = [];
  if (available) {
    if (!available.has(left.dataset.datasetId)) missingDatasetSides.push('A');
    if (!sameRecord && !available.has(right.dataset.datasetId)) missingDatasetSides.push('B');
  }

  const findings: ComparisonFinding[] = [];
  if (sameRecord) {
    findings.push({
      id: 'same-record',
      severity: 'note',
      title: 'One saved record, shown twice',
      detail: 'Every field matches because both sides point at the same immutable snapshot.',
    });
  }

  for (const side of missingDatasetSides) {
    const run = side === 'A' ? left : right;
    findings.push({
      id: `dataset-missing-${side}`,
      severity: 'warning',
      title: `Run ${side} dataset is not in the library`,
      detail: `"${run.dataset.datasetName}" is unavailable, so its current window cannot be checked. The saved snapshot and its metrics remain readable.`,
    });
  }

  if (!sameDatasetContent) {
    const fields = datasetIdentityDifferences(left, right);
    findings.push({
      id: 'dataset-content',
      severity: 'warning',
      title: 'Different market data',
      detail: `The saved dataset identity differs in ${fields.join(', ')}. These results do not describe the same price series.`,
    });
  } else if (!sameDatasetRecord) {
    findings.push({
      id: 'dataset-record',
      severity: 'note',
      title: 'Different library records, matching content',
      detail: 'The dataset record ids differ, but the saved content hash, frequency and instrument match.',
    });
  }

  if (!sameWindow) {
    findings.push({
      id: 'window',
      severity: 'warning',
      title: 'Different backtest windows',
      detail: `${window.detail} Returns, CAGR, drawdown and trade statistics cover different periods.`,
    });
  }

  if (!sameEngine) {
    findings.push({
      id: 'engine',
      severity: 'warning',
      title: 'Different engine versions',
      detail: `Run A was recorded on engine ${left.engineVersion}; Run B on ${right.engineVersion}. Execution methodology can differ between versions.`,
    });
  }

  if (!assumptions.same) {
    findings.push({
      id: 'assumptions',
      severity: 'warning',
      title: 'Different execution assumptions',
      detail: 'The recorded assumption lists are not identical. The runs were not produced under the same stated rules.',
    });
  }

  if (changedConfigFields.length > 0) {
    const shown = changedConfigFields.slice(0, 5).join(', ');
    const more = changedConfigFields.length > 5 ? ` and ${changedConfigFields.length - 5} more` : '';
    findings.push({
      id: 'configuration',
      severity: 'note',
      title: 'Different strategy settings',
      detail: `Changed: ${shown}${more}. The metric deltas describe different strategies, not an isolated effect.`,
    });
  }

  const unavailableMetrics = metrics
    .filter((row) => row.leftValue === null || row.rightValue === null)
    .map((row) => row.label);
  if (unavailableMetrics.length > 0) {
    findings.push({
      id: 'unavailable-metrics',
      severity: 'note',
      title: 'Some metrics are unavailable',
      detail: `${uniqueInOrder(unavailableMetrics).join(', ')} could not be compared because at least one side has no recorded value. Their deltas remain blank.`,
    });
  }

  if (!sameRecord && inputsComparable && changedConfigFields.length === 0 && !metricsMatch) {
    findings.push({
      id: 'same-inputs-different-outputs',
      severity: 'warning',
      title: 'Same inputs, different recorded outputs',
      detail: 'The snapshots share their input window, engine and strategy settings but record different metrics. Use Rerun and verify in Research runs before trusting either.',
    });
  } else if (!sameRecord && inputsComparable && changedConfigFields.length === 0 && metricsMatch) {
    findings.push({
      id: 'like-for-like',
      severity: 'note',
      title: 'Like-for-like snapshots',
      detail: 'Dataset window, engine, execution assumptions and strategy settings match, and every recorded metric agrees.',
    });
  }
  if (!sameRecord && missingDatasetSides.length > 0) {
    findings.push({
      id: 'no-current-check',
      severity: 'note',
      title: 'Current inputs cannot be checked',
      detail: 'Comparison reads the saved records only. Import the same series to re-check the stored window fingerprint.',
    });
  }

  const withoutSummary = {
    sameRecord,
    sameDatasetContent,
    sameDatasetRecord,
    sameWindow,
    sameEngine,
    sameAssumptions: assumptions.same,
    inputsComparable,
    metricsMatch,
    missingDatasetSides,
    window,
    metrics,
    config,
    provenance: compareRunProvenance(left, right),
    assumptions,
    changedConfigFields,
    findings,
  };
  return { ...withoutSummary, summary: summarize(withoutSummary) };
}

export type ResearchRunInputStatus =
  | 'match'
  | 'missing-dataset'
  | 'inputs-changed'
  | 'engine-changed'
  | 'unavailable';

export interface ResearchRunInputInspection {
  status: ResearchRunInputStatus;
  datasetAvailable: boolean;
  inputsChanged: boolean;
  engineChanged: boolean;
  windowFingerprint: string | null;
  currentEngineVersion: string;
  notes: string[];
}

export interface InspectResearchRunInputsInput {
  run: BacktestRun;
  dataset: Dataset | undefined;
  bars: readonly Bar[] | undefined;
}

/**
 * Checks a saved run's inputs against the current library without executing
 * the strategy. This is deliberately narrower than `verifyBacktestRun`, which
 * also compares outputs and is only run on explicit user action.
 */
export async function inspectResearchRunInputs(
  input: InspectResearchRunInputsInput,
): Promise<ResearchRunInputInspection> {
  const { run, dataset, bars } = input;
  const currentEngineVersion = BACKTEST_ENGINE_VERSION;
  const engineChanged = run.engineVersion !== currentEngineVersion;
  if (!dataset || !bars) {
    return {
      status: 'missing-dataset',
      datasetAvailable: false,
      inputsChanged: false,
      engineChanged,
      windowFingerprint: null,
      currentEngineVersion,
      notes: ['The dataset this run used is not in the library, so its inputs cannot be reproduced.'],
    };
  }

  let windowFingerprint: string | null = null;
  try {
    const windowBars = selectBacktestWindow(bars, run.config.startDate, run.config.endDate);
    windowFingerprint = await computeWindowFingerprint(windowBars, dataset.frequency);
  } catch (error) {
    return {
      status: 'unavailable',
      datasetAvailable: true,
      inputsChanged: false,
      engineChanged,
      windowFingerprint: null,
      currentEngineVersion,
      notes: [error instanceof Error ? error.message : 'The current window fingerprint could not be computed.'],
    };
  }

  const notes: string[] = [];
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
  if (engineChanged) {
    notes.push(`Engine version changed from ${run.engineVersion} to ${currentEngineVersion}.`);
  }
  return {
    status: inputsChanged ? 'inputs-changed' : engineChanged ? 'engine-changed' : 'match',
    datasetAvailable: true,
    inputsChanged,
    engineChanged,
    windowFingerprint,
    currentEngineVersion,
    notes,
  };
}
