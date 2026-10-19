import type { Bar, Dataset, Instrument, ScreenerDefinition, ScreenerField } from '../../domain/types';
import { compare } from '../backtest/compare';
import { compareDates } from '../date';
import { computeField } from './fields';

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
  passed: boolean;
}

export interface ScreenerRunResult {
  rows: ScreenerRow[];
  matchedCount: number;
  evaluatedCount: number;
}

function truncate(bars: readonly Bar[], cutoff: string | null): Bar[] {
  if (!cutoff) return [...bars];
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

    for (const filter of definition.filters) {
      const reading = computeField(filter.field, filter.window, bars);
      values[filter.field] = reading.current;
      filterResults.push(compare(filter.operator, reading.current, reading.previous, filter.value));
    }

    rows.push({
      datasetId: input.dataset.id,
      instrumentId: input.instrument.id,
      symbol: input.instrument.symbol,
      displayName: input.instrument.displayName,
      currency: input.instrument.currency,
      assetType: input.instrument.assetType,
      asOf,
      values,
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
  const left = a.values[sortBy as ScreenerField];
  const right = b.values[sortBy as ScreenerField];
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing && rightMissing) return a.symbol.localeCompare(b.symbol);
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  const delta = (left as number) - (right as number);
  return direction === 'asc' ? delta : -delta;
}
