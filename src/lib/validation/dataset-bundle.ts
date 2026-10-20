import type { Bar, Dataset, Instrument } from '../../domain/types';

export interface DatasetBundleLike {
  instrument: Instrument;
  dataset: Dataset;
  bars: Bar[];
}

/**
 * Rejects a dataset bundle whose metadata does not describe its bars. In-app
 * producers always agree; this guards restored or hand-built bundles before a
 * multi-store write can commit them.
 */
export function describeDatasetBundleProblem(bundle: DatasetBundleLike): string | null {
  const { instrument, dataset, bars } = bundle;
  if (dataset.instrumentId !== instrument.id) return 'The dataset does not belong to the supplied instrument.';
  if (bars.length === 0) return 'The dataset contains no sessions.';
  if (bars.length !== dataset.rowCount) {
    return `The dataset reports ${dataset.rowCount} rows but contains ${bars.length} sessions.`;
  }
  const first = bars[0] as Bar;
  const last = bars[bars.length - 1] as Bar;
  if (first.date !== dataset.firstDate || last.date !== dataset.lastDate) {
    return 'The dataset date range does not match its sessions.';
  }
  for (let index = 1; index < bars.length; index += 1) {
    if ((bars[index] as Bar).date <= (bars[index - 1] as Bar).date) {
      return 'The dataset sessions are not in strict date order.';
    }
  }
  return null;
}
