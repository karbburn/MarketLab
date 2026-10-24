import { describe, expect, it } from 'vitest';
import type { BacktestConfig, BacktestRun, Bar, Dataset, Instrument } from '../../src/domain/types';
import {
  createBacktestRun,
  parseResearchRunManifest,
  serialiseResearchRunManifest,
} from '../../src/lib/backtest/research-runs';
import { runBacktest } from '../../src/lib/backtest/engine';
import { compareRunProvenance, formatRunTimestamp } from '../../src/lib/backtest/run-comparison';
import { RESEARCH_RUN_SCHEMA_VERSION, parseBacktestRun } from '../../src/lib/workspace/schema';

/**
 * Schema-version-2 provenance tests: the save-time provider snapshot, v1
 * tolerance, manifest round-trip and the comparison rows. No test touches the
 * network; every value is static fixture data.
 */

function bars(count = 40): Bar[] {
  const out: Bar[] = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    const open = close;
    close = 100 + index;
    out.push({ date, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1_000 });
  }
  return out;
}

function config(): BacktestConfig {
  return {
    id: 'bt-1',
    name: 'Provenance',
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
  };
}

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  const series = bars();
  return {
    id: 'ds-1',
    instrumentId: 'inst-1',
    name: 'Test series',
    sourceKind: 'provider-download',
    sourceDescription: 'Yahoo Finance download',
    frequency: 'daily',
    timezone: 'America/New_York',
    firstDate: series[0]!.date,
    lastDate: series[series.length - 1]!.date,
    rowCount: series.length,
    importedAt: '2024-02-10T00:00:00.000Z',
    contentHash: 'fnv1a-test',
    hasVolume: true,
    validation: {
      acceptedRows: series.length,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
    provider: {
      provider: 'yahoo-finance',
      providerSymbol: 'TST',
      exchange: 'NMS',
      exchangeName: 'NasdaqGS',
      instrumentType: 'EQUITY',
      interval: '1d',
      adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
      retrievedAt: '2024-02-09T20:00:00.000Z',
      timezone: 'America/New_York',
      requestedRange: { start: '2024-01-01', end: '2024-02-10' },
      sourceNotes: ['Yahoo Finance data may be delayed.'],
      corporateActions: [],
    },
    ...overrides,
  };
}

function instrument(): Instrument {
  return { id: 'inst-1', symbol: 'TST', displayName: 'Test', assetType: 'equity', currency: 'USD' };
}

async function savedRun(data: Dataset = dataset()): Promise<BacktestRun> {
  const series = bars();
  const cfg = config();
  const result = runBacktest(series, cfg, data.frequency);
  return createBacktestRun({
    config: cfg,
    dataset: data,
    instrument: instrument(),
    bars: series,
    result,
    name: 'Provenance run',
    id: 'run-1',
    createdAt: '2024-03-01T12:00:00.000Z',
  });
}

describe('research run schema v3', () => {
  it('declares schema version 3', () => {
    expect(RESEARCH_RUN_SCHEMA_VERSION).toBe(3);
  });

  it('snapshots provider provenance at save time', async () => {
    const run = await savedRun();
    expect(run.schemaVersion).toBe(3);
    expect(run.dataset.provider).toEqual({
      provider: 'yahoo-finance',
      adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
      exchange: 'NasdaqGS',
      currency: 'USD',
      timezone: 'America/New_York',
      requestedStart: '2024-01-01',
      requestedEnd: '2024-02-10',
      // The requested range matches the stored range, so coverage is complete.
      coverageStatus: 'complete',
      coverageDetail: null,
      retrievedAt: '2024-02-09T20:00:00.000Z',
    });
    // The snapshot must parse back through the v2 schema untouched.
    const parsed = parseBacktestRun(JSON.parse(JSON.stringify(run)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.dataset.provider) {
      expect(parsed.value.dataset.provider?.provider).toBe('yahoo-finance');
      expect(parsed.value.dataset.provider?.coverageStatus).toBe('complete');
    }
  });

  it('reports unverified coverage when the download has no requested range', async () => {
    const data = dataset();
    data.provider!.requestedRange = undefined;
    const run = await savedRun(data);
    expect(run.dataset.provider?.coverageStatus).toBe('unverified');
    expect(run.dataset.provider?.coverageDetail).toBeNull();
    expect(run.dataset.provider?.requestedStart).toBeNull();
    expect(run.dataset.provider?.requestedEnd).toBeNull();
  });

  it('omits the provider block for imported CSV datasets', async () => {
    const data = dataset({ sourceKind: 'user-csv', provider: undefined });
    const run = await savedRun(data);
    expect(run.dataset.provider).toBeUndefined();
    expect(parseBacktestRun(JSON.parse(JSON.stringify(run))).ok).toBe(true);
  });

  it('accepts a v2 numeric run and round-trips v3 null metrics', async () => {
    const run = await savedRun();

    const numeric = structuredClone(run);
    numeric.schemaVersion = 2;
    numeric.metrics.totalReturnPct = 1.5;
    numeric.metrics.annualisedVolatilityPct = 2.5;
    numeric.metrics.maxDrawdownPct = -3.5;
    numeric.metrics.exposurePct = 40;
    numeric.metrics.benchmarkTotalReturnPct = 0.5;
    expect(parseBacktestRun(numeric).ok).toBe(true);

    const nulled = structuredClone(run);
    nulled.metrics.totalReturnPct = null;
    nulled.metrics.annualisedVolatilityPct = null;
    nulled.metrics.maxDrawdownPct = null;
    nulled.metrics.exposurePct = null;
    nulled.metrics.benchmarkTotalReturnPct = null;
    const parsed = parseBacktestRun(nulled);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.metrics.totalReturnPct).toBeNull();
      expect(parsed.value.metrics.annualisedVolatilityPct).toBeNull();
      expect(parsed.value.metrics.maxDrawdownPct).toBeNull();
      expect(parsed.value.metrics.exposurePct).toBeNull();
      expect(parsed.value.metrics.benchmarkTotalReturnPct).toBeNull();
      // A measured trade count stays a number even when the curve metrics are
      // undefined.
      expect(parsed.value.metrics.tradeCount).toBe(run.metrics.tradeCount);
    }
  });

  it('parses a legacy v1 record unchanged and quarantines a future version', () => {
    const legacy = {
      id: 'run-legacy',
      schemaVersion: 1,
      name: 'Legacy run',
      createdAt: '2024-03-01T12:00:00.000Z',
      engineVersion: 'test-engine',
      config: config(),
      dataset: {
        datasetId: 'ds-1',
        instrumentId: 'inst-1',
        instrumentSymbol: 'TST',
        datasetName: 'Test series',
        frequency: 'daily',
        contentHash: 'fnv1a-test',
        windowFingerprint: `sha256:${'a'.repeat(64)}`,
        windowStart: '2024-01-01',
        windowEnd: '2024-02-09',
        barCount: 40,
      },
      assumptions: ['assumption'],
      metrics: {
        totalReturnPct: 1,
        cagrPct: null,
        annualisedVolatilityPct: 1,
        maxDrawdownPct: 0,
        sharpe: null,
        tradeCount: 0,
        winRatePct: null,
        profitFactor: null,
        averageTradePct: null,
        exposurePct: 0,
        benchmarkTotalReturnPct: 1,
      },
      trades: [],
    };
    const parsed = parseBacktestRun(legacy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.dataset.provider).toBeUndefined();
    }
    const future = { ...legacy, schemaVersion: RESEARCH_RUN_SCHEMA_VERSION + 1 };
    const rejected = parseBacktestRun(future);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain('newer version');
    }
  });

  it('round-trips the provider block through the export manifest', async () => {
    const run = await savedRun();
    const manifest = JSON.parse(serialiseResearchRunManifest(run)) as Record<string, unknown>;
    expect(manifest['manifestVersion']).toBe(1);
    const parsed = parseResearchRunManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.run.dataset.provider?.provider).toBe('yahoo-finance');
      expect(parsed.value.run.dataset.provider?.retrievedAt).toBe('2024-02-09T20:00:00.000Z');
    }
  });
});

describe('provenance comparison rows', () => {
  it('surfaces the source provider, adjustment, currency, range, coverage and retrieval', async () => {
    const providerRun = await savedRun();
    const tdProvider = dataset().provider!;
    const otherProvider = await savedRun(
      dataset({ provider: { ...tdProvider, provider: 'twelve-data', exchangeName: null, retrievedAt: '2024-02-09T21:00:00.000Z' } }),
    );
    const rows = compareRunProvenance(providerRun, otherProvider);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('source')?.left).toBe('yahoo-finance');
    expect(byKey.get('source')?.right).toBe('twelve-data');
    expect(byKey.get('source')?.changed).toBe(true);
    expect(byKey.get('adjustment')?.left).toBe('splits-applied, dividends not reinvested (as-traded OHLC)');
    expect(byKey.get('adjustment')?.changed).toBe(false);
    expect(byKey.get('currency')?.left).toBe('USD');
    expect(byKey.get('requested-range')?.left).toBe('2024-01-01 to 2024-02-10');
    expect(byKey.get('coverage')?.left).toBe('complete');
    expect(byKey.get('retrieved')?.right).toBe(formatRunTimestamp('2024-02-09T21:00:00.000Z'));
  });

  it('shows "Not recorded" for legacy runs without a provider snapshot', async () => {
    const providerRun = await savedRun();
    const legacy = { ...providerRun, id: 'run-legacy', dataset: { ...providerRun.dataset, provider: undefined } };
    const rows = compareRunProvenance(providerRun, legacy);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('source')?.right).toBe('Not recorded');
    expect(byKey.get('source')?.changed).toBe(true);
    expect(byKey.get('coverage')?.right).toBe('Not recorded');
    expect(byKey.get('retrieved')?.right).toBe('Not recorded');
    // Two legacy runs compared with each other show no source difference.
    const legacy2 = { ...legacy, id: 'run-legacy-2' };
    const legacyRows = compareRunProvenance(legacy, legacy2);
    expect(legacyRows.find((row) => row.key === 'source')?.changed).toBe(false);
  });
});
