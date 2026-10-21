import { describe, expect, it } from 'vitest';
import type { BacktestConfig, BacktestRun, Bar, Dataset } from '../../src/domain/types';
import {
  compareResearchRuns,
  compareRunAssumptions,
  compareRunConfigs,
  compareRunMetrics,
  compareRunWindows,
  formatComparisonDelta,
  formatComparisonValue,
  inspectResearchRunInputs,
  runMetricsMatch,
} from '../../src/lib/backtest/run-comparison';
import { computeWindowFingerprint } from '../../src/lib/backtest/research-runs';

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    id: 'bt-1',
    name: 'Momentum',
    datasetId: 'ds-1',
    startDate: null,
    endDate: null,
    initialCapital: 100_000,
    positionSizePct: 95,
    commissionBps: 5,
    slippageBps: 5,
    stopLossPct: 5,
    takeProfitPct: null,
    entry: [
      { id: 'entry-1', field: 'rsi', operator: 'lt', value: 35, window: 14 },
      { id: 'entry-2', field: 'price-vs-sma', operator: 'gt', value: 0, window: 50 },
    ],
    exit: [{ id: 'exit-1', field: 'rsi', operator: 'gt', value: 65, window: 14 }],
    entryLogic: 'AND',
    exitLogic: 'AND',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseDataset(overrides: Partial<BacktestRun['dataset']> = {}): BacktestRun['dataset'] {
  return {
    datasetId: 'ds-1',
    instrumentId: 'inst-1',
    instrumentSymbol: 'TST',
    datasetName: 'Test series',
    frequency: 'daily',
    contentHash: 'sha256:aaaa',
    windowFingerprint: 'sha256:window-a',
    windowStart: '2024-01-01',
    windowEnd: '2024-03-31',
    barCount: 64,
    ...overrides,
  };
}

function baseMetrics(overrides: Partial<BacktestRun['metrics']> = {}): BacktestRun['metrics'] {
  return {
    totalReturnPct: 12.5,
    cagrPct: 8.2,
    annualisedVolatilityPct: 14.3,
    maxDrawdownPct: 6.4,
    sharpe: 0.57,
    tradeCount: 8,
    winRatePct: 62.5,
    profitFactor: 1.8,
    averageTradePct: 1.2,
    exposurePct: 35.4,
    benchmarkTotalReturnPct: 10.1,
    ...overrides,
  };
}

function savedRun(
  overrides: {
    id?: string;
    name?: string;
    createdAt?: string;
    engineVersion?: string;
    config?: Partial<BacktestConfig>;
    dataset?: Partial<BacktestRun['dataset']>;
    metrics?: Partial<BacktestRun['metrics']>;
    assumptions?: string[];
  } = {},
): BacktestRun {
  return {
    id: overrides.id ?? 'run-a',
    schemaVersion: 1,
    name: overrides.name ?? 'Momentum A',
    createdAt: overrides.createdAt ?? '2024-03-01T12:00:00.000Z',
    engineVersion: overrides.engineVersion ?? '1.0.0',
    config: baseConfig(overrides.config),
    dataset: baseDataset(overrides.dataset),
    assumptions: overrides.assumptions ?? ['Fills at the next open.', 'Long only.'],
    metrics: baseMetrics(overrides.metrics),
    trades: [],
  };
}

function row(rows: ReturnType<typeof compareRunMetrics>, key: keyof BacktestRun['metrics']) {
  const found = rows.find((entry) => entry.key === key);
  if (!found) throw new Error(`Missing metric row ${key}`);
  return found;
}

describe('research run comparison metrics', () => {
  it('computes descriptive deltas in percentage points, counts and ratios', () => {
    const left = savedRun();
    const right = savedRun({
      id: 'run-b',
      metrics: {
        totalReturnPct: 16.5,
        tradeCount: 11,
        sharpe: 0.91,
        maxDrawdownPct: 7.9,
      },
    });

    const total = row(compareRunMetrics(left, right), 'totalReturnPct');
    expect(total.leftValue).toBe(12.5);
    expect(total.rightValue).toBe(16.5);
    expect(total.delta).toBeCloseTo(4);
    expect(formatComparisonDelta(total)).toBe('+4.00 pp');

    const trades = row(compareRunMetrics(left, right), 'tradeCount');
    expect(trades.delta).toBe(3);
    expect(formatComparisonDelta(trades)).toBe('+3');

    const sharpe = row(compareRunMetrics(left, right), 'sharpe');
    expect(sharpe.delta).toBeCloseTo(0.34);
    expect(formatComparisonDelta(sharpe)).toBe('+0.34');
  });

  it('keeps unavailable values unavailable instead of turning them into zero', () => {
    const left = savedRun({ metrics: { cagrPct: null, profitFactor: null, winRatePct: null } });
    const right = savedRun({ id: 'run-b', metrics: { cagrPct: 9.4, profitFactor: null, winRatePct: 50 } });
    const metrics = compareRunMetrics(left, right);

    const cagr = row(metrics, 'cagrPct');
    expect(cagr.leftValue).toBeNull();
    expect(cagr.delta).toBeNull();
    expect(formatComparisonValue(cagr.valueKind, cagr.leftValue)).toBe('--');
    expect(formatComparisonDelta(cagr)).toBe('--');

    const profitFactor = row(metrics, 'profitFactor');
    expect(profitFactor.leftValue).toBeNull();
    expect(profitFactor.delta).toBeNull();
    expect(formatComparisonValue(profitFactor.valueKind, profitFactor.leftValue)).toBe('--');
    expect(formatComparisonDelta(profitFactor)).toBe('n/a');
  });

  it('treats an absent metric the same as a null one and does not claim a match', () => {
    const left = savedRun();
    const right = {
      ...savedRun({ id: 'run-b' }),
      metrics: { ...baseMetrics(), sharpe: undefined },
    } as unknown as BacktestRun;

    const metrics = compareRunMetrics(left, right);
    const sharpe = row(metrics, 'sharpe');
    expect(sharpe.rightValue).toBeNull();
    expect(sharpe.delta).toBeNull();
    expect(runMetricsMatch(left, right)).toBe(false);
  });

  it('leaves profit factor without an absolute delta while still showing its values', () => {
    const metrics = compareRunMetrics(savedRun(), savedRun({ id: 'run-b', metrics: { profitFactor: 2.4 } }));
    const profitFactor = row(metrics, 'profitFactor');
    expect(profitFactor.leftValue).toBe(1.8);
    expect(profitFactor.rightValue).toBe(2.4);
    expect(profitFactor.delta).toBeNull();
    expect(profitFactor.deltaKind).toBe('none');
  });
});

describe('research run comparison identity and warnings', () => {
  it('identifies the same saved record on both sides', () => {
    const run = savedRun();
    const comparison = compareResearchRuns(run, run);
    expect(comparison.sameRecord).toBe(true);
    expect(comparison.inputsComparable).toBe(true);
    expect(comparison.metrics.every((entry) => entry.delta === 0 || entry.delta === null)).toBe(true);
    expect(comparison.findings.some((finding) => finding.id === 'same-record')).toBe(true);
    expect(comparison.summary.label).toBe('Same record');
  });

  it('handles identical snapshots from two records as a like-for-like comparison', () => {
    const comparison = compareResearchRuns(savedRun(), savedRun({ id: 'run-b', name: 'Momentum B' }));
    expect(comparison.sameRecord).toBe(false);
    expect(comparison.inputsComparable).toBe(true);
    expect(comparison.metricsMatch).toBe(true);
    expect(comparison.changedConfigFields).toEqual([]);
    expect(comparison.findings.some((finding) => finding.id === 'like-for-like')).toBe(true);
    expect(comparison.summary.label).toBe('Like-for-like inputs');
  });

  it('marks different market data as not directly comparable', () => {
    const comparison = compareResearchRuns(
      savedRun(),
      savedRun({ id: 'run-b', dataset: { contentHash: 'sha256:bbbb', frequency: 'weekly', instrumentId: 'inst-2' } }),
    );
    expect(comparison.sameDatasetContent).toBe(false);
    expect(comparison.inputsComparable).toBe(false);
    const finding = comparison.findings.find((entry) => entry.id === 'dataset-content');
    expect(finding?.severity).toBe('warning');
    expect(finding?.detail).toContain('content hash, frequency, instrument');
    expect(comparison.summary.label).toBe('Not directly comparable');
  });

  it('notes matching content stored under different dataset records', () => {
    const comparison = compareResearchRuns(
      savedRun(),
      savedRun({ id: 'run-b', dataset: { datasetId: 'ds-2' } }),
    );
    expect(comparison.sameDatasetContent).toBe(true);
    expect(comparison.sameDatasetRecord).toBe(false);
    expect(comparison.inputsComparable).toBe(true);
    expect(comparison.findings.some((finding) => finding.id === 'dataset-record')).toBe(true);
  });

  it('distinguishes same, overlapping and disjoint windows', () => {
    const same = compareRunWindows(savedRun(), savedRun({ id: 'run-b' }));
    expect(same.relation).toBe('same');
    expect(same.label).toBe('Same window');

    const overlap = compareRunWindows(
      savedRun(),
      savedRun({
        id: 'run-b',
        dataset: {
          windowStart: '2024-02-01',
          windowEnd: '2024-04-30',
          barCount: 63,
          windowFingerprint: 'sha256:window-b',
        },
      }),
    );
    expect(overlap.relation).toBe('overlap');
    expect(overlap.label).toBe('Overlapping windows');
    expect(overlap.detail).toContain('2024-01-01 to 2024-03-31');

    const disjoint = compareRunWindows(
      savedRun(),
      savedRun({
        id: 'run-b',
        dataset: {
          windowStart: '2023-01-01',
          windowEnd: '2023-03-31',
          barCount: 62,
          windowFingerprint: 'sha256:window-c',
        },
      }),
    );
    expect(disjoint.relation).toBe('disjoint');
    expect(disjoint.label).toBe('Disjoint windows');
  });

  it('does not call identical dates the same window when the stored bars differ', () => {
    const comparison = compareRunWindows(
      savedRun(),
      savedRun({ id: 'run-b', dataset: { windowFingerprint: 'sha256:other', barCount: 60 } }),
    );
    expect(comparison.relation).toBe('overlap');
    expect(comparison.label).toBe('Same dates, different bars');
    expect(comparison.sameFingerprint).toBe(false);
  });

  it('warns about a changed engine version or changed execution assumptions', () => {
    const engine = compareResearchRuns(savedRun(), savedRun({ id: 'run-b', engineVersion: '0.9.0' }));
    expect(engine.sameEngine).toBe(false);
    expect(engine.inputsComparable).toBe(false);
    expect(engine.findings.some((finding) => finding.id === 'engine')).toBe(true);

    const assumptions = compareResearchRuns(
      savedRun(),
      savedRun({ id: 'run-b', assumptions: ['Fills at the next open.', 'Long only.', 'New cost rule.'] }),
    );
    expect(assumptions.sameAssumptions).toBe(false);
    expect(assumptions.inputsComparable).toBe(false);
    expect(assumptions.findings.some((finding) => finding.id === 'assumptions')).toBe(true);
  });

  it('discloses missing datasets without blocking the saved snapshot', () => {
    const comparison = compareResearchRuns(savedRun(), savedRun({ id: 'run-b' }), {
      availableDatasetIds: [],
    });
    expect(comparison.missingDatasetSides).toEqual(['A', 'B']);
    expect(comparison.inputsComparable).toBe(true);
    expect(comparison.findings.some((finding) => finding.id === 'dataset-missing-A')).toBe(true);
    expect(comparison.summary.label).toBe('Snapshot-only inputs');
    expect(comparison.metrics[0]?.leftValue).toBe(12.5);
  });

  it('warns when identical inputs and settings record different outputs', () => {
    const comparison = compareResearchRuns(
      savedRun(),
      savedRun({ id: 'run-b', metrics: { totalReturnPct: 13.1 } }),
    );
    expect(comparison.inputsComparable).toBe(true);
    expect(comparison.changedConfigFields).toEqual([]);
    expect(comparison.metricsMatch).toBe(false);
    expect(comparison.findings.some((finding) => finding.id === 'same-inputs-different-outputs')).toBe(true);
    expect(comparison.summary.detail).toContain('recorded outputs differ');
  });

  it('does not mutate either saved record while comparing', () => {
    const left = savedRun();
    const right = savedRun({ id: 'run-b', metrics: { totalReturnPct: 30 }, config: { positionSizePct: 60 } });
    const before = JSON.stringify([left, right]);
    compareResearchRuns(left, right, { availableDatasetIds: ['ds-1'] });
    compareRunConfigs(left, right);
    compareRunAssumptions(left, right);
    expect(JSON.stringify([left, right])).toBe(before);
  });
});

describe('research run configuration comparison', () => {
  it('ignores rule ids and array order but reports real setting changes', () => {
    const left = savedRun();
    const right = savedRun({
      id: 'run-b',
      config: {
        entry: [
          { id: 'other-2', field: 'price-vs-sma', operator: 'gt', value: 0, window: 50 },
          { id: 'other-1', field: 'rsi', operator: 'lt', value: 35, window: 14 },
        ],
        initialCapital: 250_000,
        positionSizePct: 50,
        stopLossPct: null,
        takeProfitPct: 20,
        slippageBps: 12,
      },
    });
    const rows = compareRunConfigs(left, right);

    expect(rows.find((entry) => entry.key === 'entry')?.changed).toBe(false);
    expect(rows.find((entry) => entry.key === 'capital')?.changed).toBe(true);
    expect(rows.find((entry) => entry.key === 'position')?.changed).toBe(true);
    expect(rows.find((entry) => entry.key === 'stop-loss')?.right).toBe('None (disabled)');
    expect(rows.find((entry) => entry.key === 'take-profit')?.right).toBe('20.00%');
    expect(rows.find((entry) => entry.key === 'slippage')?.right).toBe('12 bps');

    const comparison = compareResearchRuns(left, right);
    expect(comparison.changedConfigFields).toEqual(
      expect.arrayContaining(['Initial capital', 'Position size', 'Slippage', 'Stop loss', 'Take profit']),
    );
    expect(comparison.findings.some((finding) => finding.id === 'configuration')).toBe(true);
    expect(comparison.summary.label).toBe('Different strategies');
  });

  it('detects a logic-only change even when the rules are identical', () => {
    const rows = compareRunConfigs(savedRun(), savedRun({ id: 'run-b', config: { entryLogic: 'OR' } }));
    const entry = rows.find((row) => row.key === 'entry');
    expect(entry?.changed).toBe(true);
    expect(entry?.left.startsWith('AND:')).toBe(true);
    expect(entry?.right.startsWith('OR:')).toBe(true);
  });

  it('treats assumption lists as sets for identity but preserves order for display', () => {
    const left = savedRun();
    const right = savedRun({ id: 'run-b', assumptions: ['Long only.', 'Fills at the next open.'] });
    const assumptions = compareRunAssumptions(left, right);
    expect(assumptions.same).toBe(true);
    expect(assumptions.shared).toEqual(['Fills at the next open.', 'Long only.']);
    expect(assumptions.onlyLeft).toEqual([]);
    expect(assumptions.onlyRight).toEqual([]);
  });
});

function buildBars(count = 40): Bar[] {
  const bars: Bar[] = [];
  const start = new Date('2024-01-01T00:00:00.000Z');
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const open = close;
    close = 100 + Math.sin(index / 3) * 6 + index * 0.4;
    bars.push({
      date: date.toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1_000 + index * 10,
    });
  }
  return bars;
}

function testDataset(overrides: Partial<Dataset> = {}): Dataset {
  const bars = buildBars();
  return {
    id: 'ds-1',
    instrumentId: 'inst-1',
    name: 'Test series',
    sourceKind: 'user-csv',
    sourceDescription: 'unit test',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: bars[0]?.date ?? '2024-01-01',
    lastDate: bars[bars.length - 1]?.date ?? '2024-02-09',
    rowCount: bars.length,
    importedAt: '2024-02-10T00:00:00.000Z',
    contentHash: 'sha256:aaaa',
    hasVolume: true,
    validation: {
      acceptedRows: bars.length,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
    ...overrides,
  };
}

describe('current input inspection', () => {
  it('matches the saved window without running the strategy', async () => {
    const bars = buildBars();
    const fingerprint = await computeWindowFingerprint(bars, 'daily');
    const run = savedRun({ dataset: { datasetId: 'ds-1', windowFingerprint: fingerprint } });
    const inspection = await inspectResearchRunInputs({ run, dataset: testDataset(), bars });
    expect(inspection.status).toBe('match');
    expect(inspection.datasetAvailable).toBe(true);
    expect(inspection.inputsChanged).toBe(false);
    expect(inspection.engineChanged).toBe(false);
    expect(inspection.windowFingerprint).toBe(fingerprint);
    expect(inspection).not.toHaveProperty('result');
  });

  it('reports changed bars as changed inputs', async () => {
    const bars = buildBars();
    const fingerprint = await computeWindowFingerprint(bars, 'daily');
    const run = savedRun({ dataset: { datasetId: 'ds-1', windowFingerprint: fingerprint } });
    const changed = bars.map((bar, index) => (index === 3 ? { ...bar, close: bar.close + 1 } : bar));
    const inspection = await inspectResearchRunInputs({ run, dataset: testDataset(), bars: changed });
    expect(inspection.status).toBe('inputs-changed');
    expect(inspection.inputsChanged).toBe(true);
    expect(inspection.notes.join(' ')).toContain('window fingerprint');
  });

  it('reports a missing dataset and an older engine without rerunning', async () => {
    const missing = await inspectResearchRunInputs({ run: savedRun(), dataset: undefined, bars: undefined });
    expect(missing.status).toBe('missing-dataset');
    expect(missing.datasetAvailable).toBe(false);
    expect(missing.windowFingerprint).toBeNull();

    const bars = buildBars();
    const fingerprint = await computeWindowFingerprint(bars, 'daily');
    const run = savedRun({ engineVersion: '0.9.0', dataset: { windowFingerprint: fingerprint } });
    const oldEngine = await inspectResearchRunInputs({ run, dataset: testDataset(), bars });
    expect(oldEngine.status).toBe('engine-changed');
    expect(oldEngine.engineChanged).toBe(true);
    expect(oldEngine.currentEngineVersion).toBe('1.0.0');
  });
});
