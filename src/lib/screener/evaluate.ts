import type { Bar, Dataset, Instrument, ScreenerDefinition, ScreenerField } from '../../domain/types';
import { compare } from '../backtest/compare';
import { compareDates } from '../date';
import { computeField, resolveSortWindow } from './fields';

export interface ScreenerInput {
  dataset: Dataset;
  instrument: Instrument;
  bars: readonly Bar[];
}

export interface ScreenerRow {
  datasetId: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  currency: string;
  assetType: Instrument['assetType'];
  asOf: string | null;
  values: Partial<Record<ScreenerField, number | null>>;
  /** Value used for ordering, computed with the definition's sort window. */
  sortValue?: number | null;
  passed: boolean;
}

export interface ScreenerRunResult {
  rows: ScreenerRow[];
  matchedCount: number;
  evaluatedCount: number;
}

function truncate(bars: readonly Bar[], cutoff: string | null): readonly Bar[] {
  if (!cutoff) return bars;
  return bars.filter((bar) => compareDates(bar.date, cutoff) <= 0);
}

/**
 * Runs a screener definition over a universe.
 *
 * Combinators join adjacent filters: `combinators[i]` connects `filters[i]` and
 * `filters[i + 1]`. With a single filter the combinator list may be empty. A
 * filter whose field cannot be computed is treated as not matched, never as
 * matched by default.
 */
export function evaluateScreener(definition: ScreenerDefinition, inputs: readonly ScreenerInput[]): ScreenerRunResult {
  const rows: ScreenerRow[] = [];

  for (const input of inputs) {
    const bars = truncate(input.bars, definition.cutoff);
    const asOf = bars.length ? (bars[bars.length - 1] as Bar).date : null;
    const values: Partial<Record<ScreenerField, number | null>> = {};
    const filterResults: boolean[] = [];
    // Filter and sort fields are persisted separately and may name the same
    // field with the same window; read each distinct field/window once.
    const readings = new Map<string, ReturnType<typeof computeField>>();
    const read = (field: ScreenerField, window: number) => {
      const key = `${field}:${window}`;
      let reading = readings.get(key);
      if (!reading) {
        reading = computeField(field, window, bars, input.dataset.frequency);
        readings.set(key, reading);
      }
      return reading;
    };

    for (const filter of definition.filters) {
      const reading = read(filter.field, filter.window);
      values[filter.field] = reading.current;
      filterResults.push(compare(filter.operator, reading.current, reading.previous, filter.value));
    }

    // The Sort-by control offers fields independently of the filter list, so the
    // sort field is always computed even when a filter uses the same field. The
    // persisted sort window controls ordering; filter windows never leak into it.
    const sortField = definition.sortBy === 'symbol' ? null : (definition.sortBy as ScreenerField);
    const sortWindow = sortField ? resolveSortWindow(sortField, definition.sortWindow) : 0;
    const sortValue = sortField ? read(sortField, sortWindow).current : null;
    // Keep the historical row shape: a sort-only field is also exposed in
    // `values`, but ordering always uses `sortValue` so a same-field filter's
    // window cannot leak into it.
    if (sortField && !(sortField in values)) values[sortField] = sortValue;

    rows.push({
      datasetId: input.dataset.id,
      instrumentId: input.instrument.id,
      symbol: input.instrument.symbol,
      displayName: input.instrument.displayName,
      currency: input.instrument.currency,
      assetType: input.instrument.assetType,
      asOf,
      values,
      sortValue,
      passed: combine(filterResults, definition.combinators),
    });
  }

  rows.sort((a, b) => compareRows(a, b, definition.sortBy, definition.sortDirection));

  return {
    rows,
    matchedCount: rows.filter((row) => row.passed).length,
    evaluatedCount: rows.length,
  };
}

function combine(results: readonly boolean[], combinators: ReadonlyArray<'AND' | 'OR'>): boolean {
  if (results.length === 0) return true;
  let accumulator = results[0] as boolean;
  for (let i = 1; i < results.length; i += 1) {
    const combinator = combinators[i - 1] ?? 'AND';
    const next = results[i] as boolean;
    accumulator = combinator === 'AND' ? accumulator && next : accumulator || next;
  }
  return accumulator;
}

function compareRows(a: ScreenerRow, b: ScreenerRow, sortBy: string, direction: 'asc' | 'desc'): number {
  if (sortBy === 'symbol') return direction === 'asc' ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
  const left = a.sortValue;
  const right = b.sortValue;
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing && rightMissing) return a.symbol.localeCompare(b.symbol);
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const delta = (left as number) - (right as number);
  return direction === 'asc' ? delta : -delta;
}
