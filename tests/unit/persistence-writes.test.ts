import { describe, expect, it } from 'vitest';
import type { BacktestConfig, BacktestRun, Bar, Dataset, Instrument, Workspace } from '../../src/domain/types';
import { createResearchRunManifest, createBacktestRun, MAX_SAVED_RESEARCH_RUNS, type ResearchRunBatchEntry } from '../../src/lib/backtest/research-runs';
import { runBacktest } from '../../src/lib/backtest/engine';
import { createMemoryAdapter } from '../../src/lib/persistence/db';
import { persistResearchRun, persistResearchRunImport, persistResearchRunUpdate } from '../../src/lib/persistence/research-run-writes';
import { persistWorkspaceUpdate } from '../../src/lib/persistence/workspace-writes';

/**
 * Storage-boundary regression suite for Programme 6.
 *
 * Each case seeds the adapter as if another tab had already committed, then
 * calls the write helper with this tab's (possibly stale) view. The helper must
 * trust storage, not the caller.
 */

function bars(count = 40): Bar[] {
  const result: Bar[] = [];
  const start = new Date('2024-01-01T00:00:00.000Z');
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const open = close;
    close = 100 + Math.sin(index / 3) * 6 + index * 0.4;
    result.push({
      date: date.toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1_000 + index * 10,
    });
  }
  return result;
}

function dataset(): Dataset {
  const series = bars();
  return {
    id: 'ds-1',
    instrumentId: 'inst-1',
    name: 'Test series',
    sourceKind: 'user-csv',
    sourceDescription: 'unit test',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: series[0]?.date ?? '2024-01-01',
    lastDate: series[series.length - 1]?.date ?? '2024-02-09',
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
  };
}

function instrument(): Instrument {
  return { id: 'inst-1', symbol: 'TST', displayName: 'Test', assetType: 'equity', currency: 'USD' };
}

function strategy(): BacktestConfig {
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
  };
}

function workspace(id: string, updatedAt: string): Workspace {
  return {
    id,
    name: id,
    schemaVersion: 1,
    layout: 'single',
    charts: [
      {
        id: `${id}-chart`,
        instrumentId: 'inst-1',
        datasetId: 'ds-1',
        timeframe: '1D',
        chartType: 'candlestick',
        showVolume: true,
        priceScaleMode: 'normal',
        visibleRange: null,
        indicators: [],
        drawings: [],
        compareDatasetIds: [],
      },
    ],
    linkGroups: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt,
  };
}

async function baseRun(): Promise<BacktestRun> {
  const series = bars();
  const config = strategy();
  const data = dataset();
  const result = runBacktest(series, config, data.frequency);
  return createBacktestRun({
    config,
    dataset: data,
    instrument: instrument(),
    bars: series,
    result,
    name: 'Base',
    id: 'run-base',
    createdAt: '2024-03-01T12:00:00.000Z',
  });
}

function cloneRun(base: BacktestRun, id: string, name = id): BacktestRun {
  return { ...structuredClone(base), id, name };
}

function entryOf(run: BacktestRun): ResearchRunBatchEntry {
  return { ok: true, manifest: createResearchRunManifest(run, '2026-10-25T00:00:00.000Z') };
}

describe('workspace update persistence', () => {
  it('writes a revision that is at least as new as the stored one', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('workspaces', workspace('ws1', '2024-01-01T00:00:01.000Z'));

    const outcome = await persistWorkspaceUpdate(adapter, workspace('ws1', '2024-01-01T00:00:01.000Z'));
    expect(outcome).toBe('saved');
    expect((await adapter.get<Workspace>('workspaces', 'ws1'))?.updatedAt).toBe('2024-01-01T00:00:01.000Z');
  });

  it('refuses to overwrite a newer revision committed by another tab', async () => {
    const adapter = createMemoryAdapter();
    const newer = workspace('ws1', '2024-01-01T00:00:05.000Z');
    await adapter.put('workspaces', newer);

    const outcome = await persistWorkspaceUpdate(adapter, workspace('ws1', '2024-01-01T00:00:02.000Z'));
    expect(outcome).toBe('conflict');
    expect(await adapter.get<Workspace>('workspaces', 'ws1')).toEqual(newer);
  });

  it('does not recreate a workspace that another tab deleted', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('workspaces', workspace('ws1', '2024-01-01T00:00:01.000Z'));
    await adapter.remove('workspaces', 'ws1');

    // The stale tab still holds the record and edits it after the deletion.
    const outcome = await persistWorkspaceUpdate(adapter, workspace('ws1', '2024-01-01T00:00:09.000Z'));
    expect(outcome).toBe('deleted');
    expect(await adapter.get<Workspace>('workspaces', 'ws1')).toBeUndefined();
  });
});

describe('research run persistence', () => {
  it('writes a run when the stored library has room', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();

    const decision = await persistResearchRun(adapter, cloneRun(base, 'run-1', 'First'));
    expect(decision).toEqual({ ok: true });
    expect((await adapter.get<BacktestRun>('researchRuns', 'run-1'))?.name).toBe('First');
  });

  it('refuses the run that would exceed the cap, based on stored records', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    const stored = Array.from({ length: MAX_SAVED_RESEARCH_RUNS }, (_, index) => cloneRun(base, `run-${index}`));
    await adapter.putMany('researchRuns', stored);

    const decision = await persistResearchRun(adapter, cloneRun(base, 'run-over-cap'));
    expect(decision).toMatchObject({ ok: false, reason: 'limit' });
    expect(await adapter.list('researchRuns')).toHaveLength(MAX_SAVED_RESEARCH_RUNS);
  });

  it('does not overwrite a run id already stored by another tab', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    const original = cloneRun(base, 'run-1', 'Original');
    await adapter.put('researchRuns', original);

    const decision = await persistResearchRun(adapter, cloneRun(base, 'run-1', 'Replacement'));
    expect(decision).toMatchObject({ ok: false, reason: 'duplicate' });
    expect((await adapter.get<BacktestRun>('researchRuns', 'run-1'))?.name).toBe('Original');
  });

  it('imports only what fits and never exceeds the stored cap', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    const stored = Array.from({ length: MAX_SAVED_RESEARCH_RUNS - 5 }, (_, index) => cloneRun(base, `run-${index}`));
    await adapter.putMany('researchRuns', stored);
    const incoming = Array.from({ length: 10 }, (_, index) => entryOf(cloneRun(base, `run-new-${index}`)));

    const report = await persistResearchRunImport(adapter, incoming);
    expect(report.counts).toMatchObject({ total: 10, imported: 5, overLimit: 5, duplicate: 0, invalid: 0 });
    const after = await adapter.list<BacktestRun>('researchRuns');
    expect(after).toHaveLength(MAX_SAVED_RESEARCH_RUNS);
    expect(after.map((run) => run.id)).toEqual(expect.arrayContaining(['run-new-0', 'run-new-4']));
    expect(after.some((run) => run.id === 'run-new-5')).toBe(false);
  });

  it('reports duplicates against stored records and leaves them untouched', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    const stored = cloneRun(base, 'run-existing', 'Stored name');
    await adapter.put('researchRuns', stored);
    const incoming = [
      entryOf(cloneRun(base, 'run-existing', 'Imported name')),
      entryOf(cloneRun(base, 'run-fresh', 'Fresh')),
    ];

    const report = await persistResearchRunImport(adapter, incoming);
    expect(report.counts).toMatchObject({ total: 2, imported: 1, duplicate: 1 });
    expect(report.outcomes[0]).toMatchObject({ status: 'duplicate', reason: 'existing' });
    expect((await adapter.get<BacktestRun>('researchRuns', 'run-existing'))?.name).toBe('Stored name');
    expect((await adapter.get<BacktestRun>('researchRuns', 'run-fresh'))?.name).toBe('Fresh');
  });
});

describe('research run rename persistence', () => {
  it('writes the new name over the stored record', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    await adapter.put('researchRuns', cloneRun(base, 'run-1', 'Before'));

    const outcome = await persistResearchRunUpdate(adapter, cloneRun(base, 'run-1', 'After'));
    expect(outcome).toBe('saved');
    expect((await adapter.get<BacktestRun>('researchRuns', 'run-1'))?.name).toBe('After');
  });

  it('does not resurrect a run another tab deleted', async () => {
    const adapter = createMemoryAdapter();
    const base = await baseRun();
    await adapter.put('researchRuns', cloneRun(base, 'run-1', 'Before'));
    await adapter.remove('researchRuns', 'run-1');

    const outcome = await persistResearchRunUpdate(adapter, cloneRun(base, 'run-1', 'After'));
    expect(outcome).toBe('deleted');
    expect(await adapter.get<BacktestRun>('researchRuns', 'run-1')).toBeUndefined();
    expect(await adapter.list('researchRuns')).toEqual([]);
  });
});
