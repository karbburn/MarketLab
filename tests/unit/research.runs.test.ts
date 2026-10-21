import { describe, expect, it } from 'vitest';
import type { BacktestConfig, BacktestRun, Bar, Dataset, Instrument } from '../../src/domain/types';
import {
  MAX_SAVED_RESEARCH_RUNS,
  computeWindowFingerprint,
  createBacktestRun,
  parseResearchRunManifest,
  planResearchRunImport,
  planResearchRunSave,
  serialiseResearchRunManifest,
  sortResearchRuns,
  verifyBacktestRun,
} from '../../src/lib/backtest/research-runs';
import { runBacktest, selectBacktestWindow } from '../../src/lib/backtest/engine';
import { describeStrategyRule, describeStrategyRules } from '../../src/lib/backtest/rule-catalog';
import { createBackup, mergeBackup, parseBackup } from '../../src/lib/export/backup';
import { STORE_NAMES, createMemoryAdapter } from '../../src/lib/persistence/db';
import { loadState } from '../../src/state/store';
import { RESEARCH_RUN_SCHEMA_VERSION, parseBacktestRun } from '../../src/lib/workspace/schema';

function buildsBars(count = 40): Bar[] {
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

function strategy(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    id: 'bt-1',
    name: 'Momentum',
    datasetId: 'ds-1',
    startDate: null,
    endDate: null,
    initialCapital: 10_000,
    positionSizePct: 95,
    commissionBps: 5,
    slippageBps: 5,
    stopLossPct: null,
    takeProfitPct: null,
    entry: [{ id: 'entry-1', field: 'price-vs-sma', operator: 'gt', value: -100, window: 2 }],
    exit: [{ id: 'exit-1', field: 'price-vs-sma', operator: 'gt', value: -100, window: 2 }],
    entryLogic: 'OR',
    exitLogic: 'OR',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  const bars = buildsBars();
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
    contentHash: 'fnv1a-test',
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

function instrument(): Instrument {
  return { id: 'inst-1', symbol: 'TST', displayName: 'Test', assetType: 'equity', currency: 'USD' };
}

async function savedRun(overrides: { bars?: Bar[]; config?: BacktestConfig; dataset?: Dataset } = {}): Promise<BacktestRun> {
  const bars = overrides.bars ?? buildsBars();
  const config = overrides.config ?? strategy();
  const data = overrides.dataset ?? dataset();
  const result = runBacktest(bars, config, data.frequency);
  return createBacktestRun({
    config,
    dataset: data,
    instrument: instrument(),
    bars,
    result,
    name: 'Saved run',
    id: 'run-1',
    createdAt: '2024-03-01T12:00:00.000Z',
  });
}

describe('window fingerprints', () => {
  it('are versioned SHA-256 digests that are stable for identical bars', async () => {
    const bars = buildsBars(10);
    const first = await computeWindowFingerprint(bars, 'daily');
    const second = await computeWindowFingerprint(bars.map((bar) => ({ ...bar })), 'daily');
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('change when a price, a volume or the frequency changes', async () => {
    const bars = buildsBars(10);
    const base = await computeWindowFingerprint(bars, 'daily');
    const changedClose = bars.map((bar, index) => (index === 5 ? { ...bar, close: bar.close + 0.01 } : bar));
    const changedVolume = bars.map((bar, index) => (index === 5 ? { ...bar, volume: null } : bar));
    expect(await computeWindowFingerprint(changedClose, 'daily')).not.toBe(base);
    expect(await computeWindowFingerprint(changedVolume, 'daily')).not.toBe(base);
    expect(await computeWindowFingerprint(bars, 'weekly')).not.toBe(base);
  });

  it('selects the same window the engine executes', () => {
    const bars = buildsBars(10);
    const selected = selectBacktestWindow(bars, bars[3]?.date ?? null, bars[7]?.date ?? null);
    expect(selected.map((bar) => bar.date)).toEqual(bars.slice(3, 8).map((bar) => bar.date));
  });
});

describe('saved rule descriptions', () => {
  it('describes a stored rule with the parameters that were run', () => {
    expect(
      describeStrategyRule({ id: 'r1', field: 'sma-cross', operator: 'crosses-above', value: 0, window: 20, secondaryWindow: 50 }),
    ).toBe('20-session SMA crosses above 50-session SMA');
    expect(
      describeStrategyRule({ id: 'r2', field: 'price-vs-sma', operator: 'lt', value: -2.5, window: 10 }),
    ).toBe('Price vs 10-session SMA less than -2.5%');
    expect(describeStrategyRules([], 'AND')).toBe('No rules');
  });
});

describe('createBacktestRun', () => {
  it('stores a detached configuration, dataset identity, metrics and trades without the equity curve', async () => {
    const bars = buildsBars();
    const config = strategy({ stopLossPct: 5 });
    const result = runBacktest(bars, config, 'daily');
    const data = dataset();

    const run = await createBacktestRun({
      config,
      dataset: data,
      instrument: instrument(),
      bars,
      result,
      name: 'Saved run',
      id: 'run-1',
      createdAt: '2024-03-01T12:00:00.000Z',
    });

    expect(run.schemaVersion).toBe(RESEARCH_RUN_SCHEMA_VERSION);
    expect(run.id).toBe('run-1');
    expect(run.dataset).toMatchObject({
      datasetId: 'ds-1',
      instrumentId: 'inst-1',
      instrumentSymbol: 'TST',
      contentHash: 'fnv1a-test',
      frequency: 'daily',
      barCount: bars.length,
      windowStart: bars[0]?.date,
      windowEnd: bars[bars.length - 1]?.date,
    });
    expect(run.dataset.windowFingerprint).toBe(await computeWindowFingerprint(bars, 'daily'));
    expect(run.metrics).toEqual(result.metrics);
    expect(run.trades).toEqual(result.trades);
    expect(run.assumptions.length).toBeGreaterThan(5);
    expect(run).not.toHaveProperty('equityCurve');
    expect(parseBacktestRun(run).ok).toBe(true);

    // Editing the live draft after saving cannot rewrite the snapshot.
    config.entry[0]!.value = 1234;
    config.name = 'Renamed';
    expect(run.config.entry[0]?.value).toBe(-100);
    expect(run.name).toBe('Saved run');
  });

  it('rejects an empty window instead of saving an unverifiable run', async () => {
    const bars = buildsBars();
    const config = strategy({ startDate: '2030-01-01', endDate: '2030-02-01' });
    const result = runBacktest(bars, config, 'daily');
    await expect(
      createBacktestRun({ config, dataset: dataset(), instrument: instrument(), bars, result }),
    ).rejects.toThrow(/at least one session/i);
  });
});

describe('verifyBacktestRun', () => {
  it('verifies an unchanged run and reproduces its trades', async () => {
    const run = await savedRun();
    const verification = await verifyBacktestRun({ run, dataset: dataset(), bars: buildsBars() });
    expect(verification.status).toBe('match');
    expect(verification.inputsChanged).toBe(false);
    expect(verification.engineChanged).toBe(false);
    expect(verification.differences).toEqual([]);
    expect(verification.result?.trades).toEqual(run.trades);
  });

  it('reports a missing dataset without running', async () => {
    const run = await savedRun();
    const verification = await verifyBacktestRun({ run, dataset: undefined, bars: undefined });
    expect(verification.status).toBe('dataset-missing');
    expect(verification.result).toBeNull();
    expect(verification.notes.join(' ')).toContain('not in the library');
  });

  it('refuses to simulate changed bars until the caller opts in', async () => {
    const run = await savedRun();
    const changed = buildsBars().map((bar, index) => (index === 2 ? { ...bar, close: bar.close + 1 } : bar));
    const blocked = await verifyBacktestRun({ run, dataset: dataset(), bars: changed });
    expect(blocked.status).toBe('inputs-changed');
    expect(blocked.result).toBeNull();
    expect(blocked.notes.join(' ')).toContain('window fingerprint');

    const forced = await verifyBacktestRun({ run, dataset: dataset(), bars: changed, allowChangedInputs: true });
    expect(forced.status).toBe('inputs-changed');
    expect(forced.result).not.toBeNull();
    expect(forced.differences.length).toBeGreaterThan(0);
  });

  it('reports a changed content hash even when the window bars are unchanged', async () => {
    const run = await savedRun();
    const verification = await verifyBacktestRun({ run, dataset: dataset({ contentHash: 'fnv1a-other' }), bars: buildsBars() });
    expect(verification.status).toBe('inputs-changed');
    expect(verification.notes.join(' ')).toContain('content hash');
  });

  it('reports an engine change after re-running', async () => {
    const run = await savedRun();
    const verification = await verifyBacktestRun({
      run: { ...run, engineVersion: '0.9.0' },
      dataset: dataset(),
      bars: buildsBars(),
    });
    expect(verification.status).toBe('engine-changed');
    expect(verification.engineChanged).toBe(true);
    expect(verification.result).not.toBeNull();
  });

  it('detects tampered outputs as a mismatch', async () => {
    const run = await savedRun();
    expect(run.trades.length).toBeGreaterThan(0);
    const tampered: BacktestRun = {
      ...run,
      trades: run.trades.map((trade, index) => (index === 0 ? { ...trade, netPnl: trade.netPnl + 5 } : trade)),
    };
    const verification = await verifyBacktestRun({ run: tampered, dataset: dataset(), bars: buildsBars() });
    expect(verification.status).toBe('mismatch');
    expect(verification.differences.some((difference) => difference.includes('netPnl'))).toBe(true);
  });
});

describe('research run manifests', () => {
  it('round-trips one run and declares that it holds no input data', async () => {
    const run = await savedRun();
    const text = serialiseResearchRunManifest(run);
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.containsInputData).toBe(false);
    expect(raw).not.toHaveProperty('bars');

    const parsed = parseResearchRunManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.run).toEqual(run);
  });

  it('rejects newer manifests, input-carrying manifests and newer runs', async () => {
    const run = await savedRun();
    const manifest = JSON.parse(serialiseResearchRunManifest(run)) as Record<string, unknown>;

    expect(parseResearchRunManifest({ ...manifest, manifestVersion: 2 }).ok).toBe(false);
    expect(parseResearchRunManifest({ ...manifest, containsInputData: true }).ok).toBe(false);
    expect(parseResearchRunManifest({ ...manifest, run: { ...run, schemaVersion: 99 } }).ok).toBe(false);
    expect(parseResearchRunManifest({ ...manifest, kind: 'backup' }).ok).toBe(false);
  });

  it('ignores unknown extras in the same manifest version', async () => {
    const run = await savedRun();
    const manifest = JSON.parse(serialiseResearchRunManifest(run)) as Record<string, unknown>;
    const parsed = parseResearchRunManifest({ ...manifest, futureField: { note: 'ignored' } });
    expect(parsed.ok).toBe(true);
  });
});

describe('research run storage planning', () => {
  it('registers a dedicated store without dropping existing stores', () => {
    expect(STORE_NAMES).toContain('researchRuns');
    expect(STORE_NAMES).toEqual(
      expect.arrayContaining(['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'chartTemplates']),
    );
  });

  it('loads saved runs on startup without rewriting them', async () => {
    const adapter = createMemoryAdapter();
    const run = await savedRun();
    await adapter.put('researchRuns', run);
    const { snapshot } = await loadState(adapter);
    expect(snapshot.backtestRuns).toEqual([run]);
  });

  it('refuses duplicates and refuses beyond the cap instead of pruning', async () => {
    const run = await savedRun();
    expect(planResearchRunSave([], run)).toEqual({ ok: true });
    const duplicate = planResearchRunSave([run], run);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toBe('duplicate');

    const full = Array.from({ length: MAX_SAVED_RESEARCH_RUNS }, (_, index) => ({ ...run, id: `run-${index}` }));
    const limited = planResearchRunSave(full, { ...run, id: 'run-new' });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.reason).toBe('limit');
  });

  it('skips ids already saved or repeated in an import and reports each', async () => {
    const run = await savedRun();
    const plan = planResearchRunImport(
      [{ ...run, id: 'existing' }],
      [{ ...run, id: 'existing' }, { ...run, id: 'new-1' }, { ...run, id: 'new-1' }],
    );
    expect(plan.accepted.map((entry) => entry.id)).toEqual(['new-1']);
    expect(plan.duplicateIds).toEqual(['existing', 'new-1']);
    expect(plan.overLimitIds).toEqual([]);
  });

  it('puts the newest run first with a stable tie-break', async () => {
    const run = await savedRun();
    const sorted = sortResearchRuns([
      { ...run, id: 'b', createdAt: '2024-01-01T00:00:00.000Z' },
      { ...run, id: 'a', createdAt: '2024-01-01T00:00:00.000Z' },
      { ...run, id: 'c', createdAt: '2024-02-01T00:00:00.000Z' },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('research runs in backups', () => {
  const base = {
    instruments: [],
    datasets: [],
    barsByDataset: {},
    workspaces: [],
    watchlists: [],
    screeners: [],
    backtests: [],
    chartTemplates: [],
    researchRuns: [],
  };

  it('round-trips runs through a backup', async () => {
    const run = await savedRun();
    const bundle = createBackup({
      ...base,
      preferences: null,
      bars: [],
      researchRuns: [run],
    });
    expect(bundle.researchRuns).toEqual([run]);
    const parsed = parseBackup(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.researchRuns).toEqual([run]);

    const merged = mergeBackup(base, parsed.value);
    expect(merged.researchRuns).toEqual([run]);
  });

  it('re-points a run when its dataset was deduplicated by content hash', async () => {
    const run = await savedRun();
    const data = dataset();
    const merged = mergeBackup(
      {
        ...base,
        instruments: [instrument()],
        datasets: [{ ...data, id: 'ds-new', instrumentId: 'inst-new' }],
      },
      {
        app: 'marketlab',
        schemaVersion: 1,
        exportedAt: '2024-03-01T00:00:00.000Z',
        instruments: [{ ...instrument(), id: 'inst-new' }],
        datasets: [data],
        bars: [{ id: 'ds-1', bars: buildsBars() }],
        workspaces: [],
        watchlists: [],
        preferences: null,
        screeners: [],
        backtests: [],
        researchRuns: [run],
      },
    );
    expect(merged.duplicateDatasets).toBe(1);
    expect(merged.researchRuns[0]?.dataset.datasetId).toBe('ds-new');
    expect(merged.researchRuns[0]?.dataset.instrumentId).toBe('inst-new');
  });

  it('skips and reports a run that fails the run schema', async () => {
    const bundle = createBackup({ ...base, preferences: null, bars: [], researchRuns: [] });
    const parsed = parseBackup({ ...JSON.parse(JSON.stringify(bundle)), researchRuns: [{ id: 'broken' }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.researchRuns ?? []).toEqual([]);
    expect(parsed.skipped).toContain('researchRuns:broken');
  });
});
