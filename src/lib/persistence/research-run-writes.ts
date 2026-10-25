import type { BacktestRun } from '../../domain/types';
import {
  planResearchRunBatchImport,
  planResearchRunSave,
  type ResearchRunBatchEntry,
  type ResearchRunImportReport,
  type ResearchRunSaveDecision,
} from '../backtest/research-runs';
import type { PersistenceAdapter } from './db';

/**
 * Saves one immutable run against the library that is stored right now.
 *
 * Planning and writing share one transaction, so two tabs (or two saves that
 * land before React commits) cannot both pass the duplicate/cap checks and
 * write past the bound. The report describes what this transaction did.
 */
export async function persistResearchRun(
  adapter: PersistenceAdapter,
  run: BacktestRun,
): Promise<ResearchRunSaveDecision> {
  return adapter.transaction(['researchRuns'], async (tx) => {
    const stored = await tx.list<BacktestRun>('researchRuns');
    const decision = planResearchRunSave(stored, run);
    if (!decision.ok) return decision;
    await tx.put('researchRuns', run);
    return { ok: true };
  });
}

/**
 * Imports a batch against the stored library in one transaction.
 *
 * The accepted set is planned from `tx.list`, not from a render snapshot, and
 * written by the same transaction. A partial write cannot leave a half-applied
 * import, and every "imported" outcome corresponds to a durable record.
 */
export async function persistResearchRunImport(
  adapter: PersistenceAdapter,
  entries: readonly ResearchRunBatchEntry[],
): Promise<ResearchRunImportReport> {
  return adapter.transaction(['researchRuns'], async (tx) => {
    const stored = await tx.list<BacktestRun>('researchRuns');
    const report = planResearchRunBatchImport(stored, entries);
    if (report.accepted.length > 0) await tx.putMany('researchRuns', report.accepted);
    return report;
  });
}

/**
 * Rewrites an existing run (the name edit is the only mutable field).
 *
 * Run content is immutable, so this is not a general upsert: a missing stored
 * record means another tab deleted the run, and renaming must not resurrect it.
 */
export async function persistResearchRunUpdate(
  adapter: PersistenceAdapter,
  run: BacktestRun,
): Promise<'saved' | 'deleted'> {
  return adapter.transaction(['researchRuns'], async (tx) => {
    const stored = await tx.get<BacktestRun>('researchRuns', run.id);
    if (!stored) return 'deleted';
    await tx.put('researchRuns', run);
    return 'saved';
  });
}
