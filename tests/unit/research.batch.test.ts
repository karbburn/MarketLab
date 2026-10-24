import { describe, expect, it } from 'vitest';
import type { BacktestConfig, BacktestRun, Bar, Dataset, Instrument } from '../../src/domain/types';
import {
  MAX_SAVED_RESEARCH_RUNS,
  RESEARCH_MANIFEST_VERSION,
  RESEARCH_RUN_BATCH_KIND,
  RESEARCH_RUN_BATCH_VERSION,
  createBacktestRun,
  createResearchRunBatchManifest,
  createResearchRunManifest,
  parseResearchRunBatchManifest,
  parseResearchRunManifest,
  planResearchRunBatchImport,
  serialiseResearchRunBatchManifest,
  type ResearchRunBatchEntry,
  type ResearchRunImportReport,
} from '../../src/lib/backtest/research-runs';
import { runBacktest } from '../../src/lib/backtest/engine';
import { RESEARCH_RUN_SCHEMA_VERSION } from '../../src/lib/workspace/schema';

/**
 * Deterministic batch export/import suite.
 *
 * No network and no storage: every run is built from static bars, and the
 * planner is a pure function. The tests pin two things at once — that a batch
 * preserves each saved snapshot exactly, and that it can never overwrite an
 * existing run, exceed the library cap or mis-report a partial import.
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

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
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

let runSequence = 0;

async function savedRun(
  options: { id?: string; name?: string; data?: Dataset; createdAt?: string } = {},
): Promise<BacktestRun> {
  runSequence += 1;
  const series = bars();
  const data = options.data ?? dataset();
  const cfg = config();
  const result = runBacktest(series, cfg, data.frequency);
  return createBacktestRun({
    config: cfg,
    dataset: data,
    instrument: instrument(),
    bars: series,
    result,
    name: options.name ?? `Run ${runSequence}`,
    id: options.id ?? `run-${runSequence}`,
    createdAt: options.createdAt ?? `2024-04-${String(runSequence).padStart(2, '0')}T12:00:00.000Z`,
  });
}

function parseEntries(raw: unknown): ResearchRunBatchEntry[] {
  const parsed = parseResearchRunBatchManifest(raw);
  if (!parsed.ok) throw new Error(`fixture batch should parse: ${parsed.error}`);
  return parsed.entries;
}

function countsOf(report: ResearchRunImportReport) {
  return report.counts;
}

describe('research-run batch export', () => {
  it('wraps complete version-1 manifests without redefining the single manifest', async () => {
    const runs = [await savedRun({ id: 'run-a', name: 'Alpha' }), await savedRun({ id: 'run-b', name: 'Beta' })];
    const exportedAt = '2026-10-24T10:00:00.000Z';
    const batch = createResearchRunBatchManifest(runs, exportedAt);

    expect(batch.app).toBe('marketlab');
    expect(batch.kind).toBe(RESEARCH_RUN_BATCH_KIND);
    expect(batch.batchVersion).toBe(RESEARCH_RUN_BATCH_VERSION);
    expect(batch.containsInputData).toBe(false);
    expect(batch.runs).toHaveLength(2);

    // Each element is exactly what the individual export writes.
    expect(batch.runs[0]).toEqual(createResearchRunManifest(runs[0]!, exportedAt));
    for (const manifest of batch.runs) {
      expect(manifest.kind).toBe('research-run');
      expect(manifest.manifestVersion).toBe(RESEARCH_MANIFEST_VERSION);
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.containsInputData).toBe(false);
    }

    // The container is a different document: the individual parser refuses it.
    expect(parseResearchRunManifest(batch).ok).toBe(false);
    // And the batch parser refuses a single manifest.
    expect(parseResearchRunBatchManifest(createResearchRunManifest(runs[0]!)).ok).toBe(false);
  });

  it('preserves every recorded field, including provider provenance or its absence', async () => {
    const withProvider = await savedRun({
      id: 'run-provider',
      name: 'Provider run',
      data: dataset({ id: 'ds-provider', name: 'Yahoo series' }),
    });
    const legacy = await savedRun({
      id: 'run-legacy',
      name: 'Legacy run',
      data: dataset({ id: 'ds-legacy', name: 'CSV series', sourceKind: 'user-csv', provider: undefined }),
    });

    const batch = createResearchRunBatchManifest([withProvider, legacy]);
    const parsed = parseResearchRunBatchManifest(JSON.parse(JSON.stringify(batch)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const restored = parsed.entries.map((entry) => (entry.ok ? entry.manifest.run : null));
    expect(restored[0]).toEqual(withProvider);
    expect(restored[1]).toEqual(legacy);
    expect(restored[0]!.dataset.provider?.provider).toBe('yahoo-finance');
    expect(restored[1]!.dataset.provider).toBeUndefined();

    // No market data is carried: no bar entries and no `bars` key at any level.
    const text = serialiseResearchRunBatchManifest([withProvider, legacy]);
    expect(text).not.toContain('"bars"');
    expect(text).not.toContain('"open"');
    expect(JSON.parse(text).containsInputData).toBe(false);
  });

  it('exports a single run as a batch container, not as a masquerading single manifest', async () => {
    const run = await savedRun({ id: 'run-single', name: 'Only run' });
    const batch = createResearchRunBatchManifest([run]);
    expect(batch.kind).toBe(RESEARCH_RUN_BATCH_KIND);
    expect(batch.runs).toHaveLength(1);
    expect(batch.runs[0]!.run).toEqual(run);
    // An empty selection is representable but contains nothing.
    expect(createResearchRunBatchManifest([]).runs).toEqual([]);
  });
});

describe('research-run batch parsing', () => {
  it('reports an empty batch as valid with no entries', () => {
    const parsed = parseResearchRunBatchManifest({
      app: 'marketlab',
      kind: RESEARCH_RUN_BATCH_KIND,
      batchVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      runs: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.batch.runs).toEqual([]);
    expect(planResearchRunBatchImport([], parsed.entries).counts).toEqual({
      total: 0,
      imported: 0,
      duplicate: 0,
      overLimit: 0,
      invalid: 0,
    });
  });

  it('rejects container faults without touching the run list', async () => {
    const run = await savedRun();
    const valid = createResearchRunBatchManifest([run]);

    expect(parseResearchRunBatchManifest(null).ok).toBe(false);
    expect(parseResearchRunBatchManifest([]).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, app: 'other' }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, kind: 'backup' }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, batchVersion: 0.5 }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, batchVersion: '1' }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, batchVersion: undefined }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, batchVersion: 2 }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, containsInputData: true }).ok).toBe(false);
    expect(parseResearchRunBatchManifest({ ...valid, runs: 'nope' }).ok).toBe(false);

    // The version errors name the version rather than silently coercing it.
    const future = parseResearchRunBatchManifest({ ...valid, batchVersion: 7 });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toContain('version 7');
  });

  it('keeps valid siblings when one element is malformed and reports the bad one', async () => {
    const first = await savedRun({ id: 'run-first', name: 'First' });
    const third = await savedRun({ id: 'run-third', name: 'Third' });
    const broken = JSON.parse(JSON.stringify(createResearchRunManifest(first))) as {
      run: { id: string; name: string; dataset: { windowFingerprint: string } };
    };
    broken.run.id = 'run-broken';
    broken.run.name = 'Broken';
    broken.run.dataset.windowFingerprint = 'not-a-digest';

    const parsed = parseResearchRunBatchManifest({
      app: 'marketlab',
      kind: RESEARCH_RUN_BATCH_KIND,
      batchVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      runs: [createResearchRunManifest(first), broken, createResearchRunManifest(third)],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((entry) => entry.ok)).toEqual([true, false, true]);

    const report = planResearchRunBatchImport([], parsed.entries);
    expect(report.accepted.map((run) => run.id)).toEqual(['run-first', 'run-third']);
    expect(countsOf(report)).toEqual({ total: 3, imported: 2, duplicate: 0, overLimit: 0, invalid: 1 });
    const invalid = report.outcomes[1]!;
    expect(invalid.status).toBe('invalid');
    expect(invalid.name).toBe('Broken');
    expect(invalid.message).toContain('"Broken" was not imported');
    expect(invalid.message).toContain('fingerprint');
  });

  it('refuses a future run schema inside an otherwise valid batch', async () => {
    const run = await savedRun({ id: 'run-future', name: 'From the future' });
    const element = JSON.parse(JSON.stringify(createResearchRunManifest(run))) as {
      run: { schemaVersion: number };
    };
    element.run.schemaVersion = RESEARCH_RUN_SCHEMA_VERSION + 1;

    const parsed = parseResearchRunBatchManifest({
      app: 'marketlab',
      kind: RESEARCH_RUN_BATCH_KIND,
      batchVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      runs: [element],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = planResearchRunBatchImport([], parsed.entries);
    expect(report.accepted).toEqual([]);
    expect(report.outcomes[0]!.status).toBe('invalid');
    expect(report.outcomes[0]!.message).toContain('newer version');
  });

  it('refuses an element that claims to carry input data', async () => {
    const run = await savedRun();
    const element = { ...createResearchRunManifest(run), containsInputData: true };
    const parsed = parseResearchRunBatchManifest({
      app: 'marketlab',
      kind: RESEARCH_RUN_BATCH_KIND,
      batchVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      runs: [element],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = planResearchRunBatchImport([], parsed.entries);
    expect(report.accepted).toEqual([]);
    expect(report.outcomes[0]!.status).toBe('invalid');
  });
});

describe('research-run batch import planning', () => {
  async function entryOf(run: BacktestRun): Promise<ResearchRunBatchEntry> {
    const [entry] = parseEntries(createResearchRunBatchManifest([run]));
    return entry!;
  }

  it('imports new runs in file order and never includes an already-saved id', async () => {
    const existing = await savedRun({ id: 'run-existing', name: 'Existing' });
    const fresh = await savedRun({ id: 'run-new', name: 'Fresh' });
    const entries = await Promise.all([entryOf(existing), entryOf(fresh)]);

    const report = planResearchRunBatchImport([existing], entries);
    expect(report.accepted.map((run) => run.id)).toEqual(['run-new']);
    expect(report.accepted[0]).toEqual(fresh);
    expect(report.outcomes[0]).toMatchObject({ status: 'duplicate', id: 'run-existing', reason: 'existing' });
    expect(report.outcomes[0]!.message).toContain('already saved');
    expect(report.outcomes[1]).toMatchObject({ status: 'imported', id: 'run-new' });
    expect(countsOf(report)).toEqual({ total: 2, imported: 1, duplicate: 1, overLimit: 0, invalid: 0 });
  });

  it('keeps only the first copy of an id repeated inside the same batch', async () => {
    const run = await savedRun({ id: 'run-twice', name: 'Twice' });
    const [entry] = await Promise.all([entryOf(run)]);
    const report = planResearchRunBatchImport([], [entry!, entry!]);

    expect(report.accepted.map((entryRun) => entryRun.id)).toEqual(['run-twice']);
    expect(report.accepted[0]).toEqual(run);
    expect(report.outcomes[1]).toMatchObject({ status: 'duplicate', reason: 'this-file' });
    expect(report.outcomes[1]!.message).toContain('more than once in this file');
    expect(countsOf(report)).toEqual({ total: 2, imported: 1, duplicate: 1, overLimit: 0, invalid: 0 });
  });

  it('applies the 50-run cap across the batch without pruning or dropping silently', async () => {
    const existing = await Promise.all(
      Array.from({ length: MAX_SAVED_RESEARCH_RUNS - 1 }, (_, index) =>
        savedRun({ id: `run-existing-${index}`, name: `Existing ${index}` }),
      ),
    );
    const first = await savedRun({ id: 'run-fits', name: 'Fits' });
    const second = await savedRun({ id: 'run-over', name: 'Over' });
    const entries = await Promise.all([entryOf(first), entryOf(second)]);

    const report = planResearchRunBatchImport(existing, entries);
    expect(report.accepted.map((run) => run.id)).toEqual(['run-fits']);
    expect(report.outcomes[1]).toMatchObject({ status: 'over-limit', id: 'run-over' });
    expect(report.outcomes[1]!.message).toContain(String(MAX_SAVED_RESEARCH_RUNS));
    expect(countsOf(report)).toEqual({ total: 2, imported: 1, duplicate: 0, overLimit: 1, invalid: 0 });
    // Existing records are untouched and the cap is respected exactly.
    expect(existing).toHaveLength(MAX_SAVED_RESEARCH_RUNS - 1);
    expect(existing.length + report.accepted.length).toBe(MAX_SAVED_RESEARCH_RUNS);
  });

  it('reports every element exactly once and reconciles the counts', async () => {
    const existing = await savedRun({ id: 'run-dupe', name: 'Dupe' });
    const fresh = await savedRun({ id: 'run-fresh', name: 'Fresh' });
    const duplicate = await entryOf(existing);
    const imported = await entryOf(fresh);
    const invalid: ResearchRunBatchEntry = {
      ok: false,
      error: 'research run schema version is missing or invalid.',
      id: null,
      name: null,
    };

    const report = planResearchRunBatchImport([existing], [duplicate, invalid, imported]);
    expect(report.outcomes).toHaveLength(3);
    expect(report.outcomes.map((outcome) => outcome.index)).toEqual([0, 1, 2]);
    expect(report.outcomes[1]!.message).toContain('Run 2 was not imported');
    const { total, imported: importedCount, duplicate: duplicateCount, overLimit, invalid: invalidCount } = report.counts;
    expect(total).toBe(3);
    expect(importedCount + duplicateCount + overLimit + invalidCount).toBe(total);
  });

  it('is pure: planning the same entries twice yields the same report and never mutates inputs', async () => {
    const existing = await savedRun({ id: 'run-existing', name: 'Existing' });
    const fresh = await savedRun({ id: 'run-new', name: 'Fresh' });
    const entries = await Promise.all([entryOf(existing), entryOf(fresh)]);
    const snapshot = JSON.stringify({ existing, fresh });

    const first = planResearchRunBatchImport([existing], entries);
    const second = planResearchRunBatchImport([existing], entries);

    expect(first).toEqual(second);
    expect(JSON.stringify({ existing, fresh })).toBe(snapshot);
    expect(existing.name).toBe('Existing');
  });
});
