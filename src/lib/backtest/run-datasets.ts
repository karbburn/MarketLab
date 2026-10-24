import type { BacktestRun, Dataset, Instrument } from '../../domain/types';

export type RunDatasetBasis = 'stored-id' | 'matching-content' | 'missing';

export interface RunDatasetResolution {
  /** The dataset that can stand in for the run's inputs, or null when none qualifies. */
  dataset: Dataset | null;
  basis: RunDatasetBasis;
}

/**
 * Finds the library dataset that represents a saved run's inputs.
 *
 * The stored dataset id is the first answer and needs no further checks. When
 * that id is no longer in the library, a unique content-identical sibling can
 * still support checking and reproducing the run. Identity follows the backup
 * merge rule (`backup.ts`): the content hash alone is not an identity, because
 * an index and a fund tracking it can share a short identical window, so a
 * candidate must also preserve the recorded instrument identity (by symbol,
 * or by the pinned instrument id) and the dataset frequency.
 *
 * Ambiguity is refused rather than resolved silently. A run whose recorded
 * symbol is empty and whose sibling search yields several candidates stays
 * `missing`, because no honest claim can single one record out.
 */
export function resolveRunDataset(
  run: BacktestRun,
  datasets: readonly Dataset[],
  instrumentsById: ReadonlyMap<string, Instrument>,
): RunDatasetResolution {
  const byId = datasets.find((entry) => entry.id === run.dataset.datasetId);
  if (byId) return { dataset: byId, basis: 'stored-id' };

  const runSymbol = run.dataset.instrumentSymbol.trim();
  const candidates = datasets.filter((dataset) => {
    if (!dataset.contentHash || dataset.contentHash !== run.dataset.contentHash) return false;
    if (dataset.frequency !== run.dataset.frequency) return false;
    if (dataset.instrumentId === run.dataset.instrumentId) return true;
    if (!runSymbol) return false;
    const instrument = instrumentsById.get(dataset.instrumentId);
    return instrument !== undefined && instrument.symbol === runSymbol;
  });

  if (candidates.length === 1) {
    const candidate = candidates[0] as Dataset;
    return { dataset: candidate, basis: 'matching-content' };
  }
  return { dataset: null, basis: 'missing' };
}

/** Builds the id -> instrument map the resolver (and its callers) read from. */
export function indexInstrumentsById(instruments: readonly Instrument[]): ReadonlyMap<string, Instrument> {
  return new Map(instruments.map((instrument) => [instrument.id, instrument]));
}
