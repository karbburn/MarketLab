import { describe, expect, it } from 'vitest';
import { createMemoryAdapter, type PersistenceAdapter } from '../../src/lib/persistence/db';
import { loadState } from '../../src/state/store';
import type { BacktestRun } from '../../src/domain/types';
import { RESEARCH_RUN_SCHEMA_VERSION } from '../../src/lib/workspace/schema';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function validRun(id: string): BacktestRun {
  return {
    id,
    schemaVersion: 1,
    name: 'Saved run',
    createdAt: '2024-04-02T00:00:00.000Z',
    engineVersion: '1.0.0',
    config: {
      id: 'bt-1',
      name: 'Saved run',
      datasetId: 'ds-1',
      startDate: null,
      endDate: null,
      initialCapital: 100_000,
      positionSizePct: 100,
      commissionBps: 0,
      slippageBps: 0,
      stopLossPct: null,
      takeProfitPct: null,
      entry: [],
      exit: [],
      entryLogic: 'AND',
      exitLogic: 'AND',
      execution: 'next-open',
      createdAt: '2024-04-02T00:00:00.000Z',
      updatedAt: '2024-04-02T00:00:00.000Z',
    },
    dataset: {
      datasetId: 'ds-1',
      instrumentId: 'inst-1',
      instrumentSymbol: 'TST',
      datasetName: 'Test series',
      frequency: 'daily',
      contentHash: 'fnv1a-test',
      windowFingerprint: FINGERPRINT,
      windowStart: '2024-01-01',
      windowEnd: '2024-03-31',
      barCount: 64,
    },
    assumptions: ['Fills at the next open.'],
    metrics: {
      totalReturnPct: 1,
      cagrPct: null,
      annualisedVolatilityPct: 1,
      maxDrawdownPct: 1,
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
}

function invalidRun(): Record<string, unknown> {
  // Same shape, but the window fingerprint is not a SHA-256 digest.
  const run = validRun('run-invalid');
  return {
    ...run,
    name: 'Corrupt record',
    dataset: { ...run.dataset, windowFingerprint: 'not-a-hash' },
  };
}

function futureRun(): Record<string, unknown> {
  // Always one version ahead of this build, so the fixture stays a genuinely
  // future record as the global schema version advances.
  return { ...validRun('run-future'), name: 'From a newer build', schemaVersion: RESEARCH_RUN_SCHEMA_VERSION + 1 };
}

describe('loadState research-run validation', () => {
  it('keeps valid runs, drops records that fail the schema, and quarantines future versions', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('researchRuns', validRun('run-valid') as unknown as { id: string });
    await adapter.put('researchRuns', invalidRun() as unknown as { id: string });
    await adapter.put('researchRuns', futureRun() as unknown as { id: string });

    const { snapshot, notice } = await loadState(adapter);

    expect(snapshot.backtestRuns.map((run) => run.id)).toEqual(['run-valid']);

    const remaining = (await adapter.list<BacktestRun>('researchRuns')).map((run) => run.id).sort();
    expect(remaining).toEqual(['run-future', 'run-valid']);
    expect(notice).toContain('run could not be validated');
    expect(notice).toContain('newer version of MarketLab');
  });

  it('is silent for a library whose runs all validate', async () => {
    const adapter = createMemoryAdapter();
    await adapter.put('researchRuns', validRun('run-valid') as unknown as { id: string });

    const { snapshot, notice } = await loadState(adapter);
    expect(snapshot.backtestRuns.map((run) => run.id)).toEqual(['run-valid']);
    expect(notice).toBeNull();
  });

  it('still excludes a dropped record from state when the persistence cleanup fails', async () => {
    const base = createMemoryAdapter();
    await base.put('researchRuns', invalidRun() as unknown as { id: string });
    const failing: PersistenceAdapter = {
      ...base,
      transaction: async (stores, operation, options) => {
        if (stores.includes('researchRuns' as never) && options?.mode !== 'readonly') {
          // The cleanup transaction cannot write; the read-only load transaction must.
          throw new Error('cleanup read-only contended');
        }
        return base.transaction(stores, operation, options);
      },
    };

    const { snapshot } = await loadState(failing);
    expect(snapshot.backtestRuns).toEqual([]);
  });
});
