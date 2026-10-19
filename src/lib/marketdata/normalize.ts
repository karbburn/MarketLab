/**
 * Normalises provider (market-data service) payloads into the canonical
 * MarketLab dataset model.
 *
 * The series-level invariants (OHLC ordering, positive prices, duplicate
 * sessions, gap reporting, sorting, content hashing) are the same code path the
 * CSV import uses — see `validateBarEntries` in `lib/validation/dataset.ts`.
 * This module only maps provider rows into that pipeline and assembles the
 * `Instrument` / `Dataset` with provenance metadata.
 *
 * Honesty rules:
 * - Values that could not be parsed stay rejected; nothing is invented.
 * - Missing volume stays `null` per bar.
 * - The adjustment policy arrives from the provider payload and is stored
 *   verbatim on the dataset; it is never silently normalised away.
 */

import type {
  AssetType,
  Bar,
  CorporateAction,
  Dataset,
  DatasetProvider,
  Instrument,
} from '../../domain/types';
import { createId } from '../id';
import { validateBarEntries, type DuplicatePolicy } from '../validation/dataset';

export const PROVIDER_ID = 'yahoo-finance';
export const PROVIDER_LABEL = 'Yahoo Finance';

export interface ProviderSearchResult {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeName: string | null;
  type: string | null;
  sector: string | null;
  industry: string | null;
}

export interface ProviderBarRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Dividend + split adjusted close (captured for future use, not analysed yet). */
  adjClose: number | null;
  volume: number | null;
}

export interface ProviderHistory {
  providerMetadata: {
    provider: string;
    providerSymbol: string;
    displaySymbol: string;
    displayName: string | null;
    exchange: string | null;
    exchangeName: string | null;
    instrumentType: string | null;
    currency: string | null;
    timezone: string | null;
    interval: string;
    adjustment: string;
    rangeRequested: { start: string; end: string };
    rangeActual: { start: string; end: string };
    retrievedAt: string;
    sourceNotes: readonly string[];
    corporateActions: readonly CorporateAction[];
  };
  bars: ProviderBarRow[];
}

export interface DatasetBundle {
  instrument: Instrument;
  dataset: Dataset;
  bars: Bar[];
}



/** Maps the provider's instrument type vocabulary onto the canonical asset types. */
export function assetTypeFromProvider(type: string | null): AssetType {
  const value = (type ?? '').toLowerCase();
  if (value.includes('index') || value.includes('irindex')) return 'index';
  if (value.includes('crypto')) return 'crypto';
  if (value.includes('currency') || value === 'forex') return 'fx';
  if (value.includes('commodity')) return 'commodity';
  if (value.includes('etf') || value.includes('mutual') || value.includes('fund')) return 'fund';
  if (value.includes('equity') || value.includes('stock')) return 'equity';
  return 'other';
}

export interface ProviderValidationResult {
  bars: Bar[];
  hasVolume: boolean;
  contentHash: string;
  summary: import('../../domain/types').DatasetValidationSummary;
  fatalErrors: string[];
}

/**
 * Re-uses the shared bar validation core on provider rows. Rows whose numeric
 * fields are unusable become rejections, exactly like CSV cells that fail to
 * parse; nothing is coerced into a plausible bar.
 */
export function validateProviderBars(
  bars: readonly ProviderBarRow[],
  duplicatePolicy: DuplicatePolicy,
): ProviderValidationResult {
  const entries = bars.map((row, index) => ({
    date: typeof row.date === 'string' ? row.date : '',
    open: typeof row.open === 'number' && Number.isFinite(row.open) ? row.open : Number.NaN,
    high: typeof row.high === 'number' && Number.isFinite(row.high) ? row.high : Number.NaN,
    low: typeof row.low === 'number' && Number.isFinite(row.low) ? row.low : Number.NaN,
    close: typeof row.close === 'number' && Number.isFinite(row.close) ? row.close : Number.NaN,
    volume: typeof row.volume === 'number' && Number.isFinite(row.volume) ? row.volume : null,
    rowNumber: index + 1,
  }));

  const result = validateBarEntries({
    rows: entries,
    duplicatePolicy,
    emptyMessage: 'No valid daily sessions were returned for this symbol and range.',
  });
  return {
    bars: result.bars,
    hasVolume: result.hasVolume,
    contentHash: result.contentHash,
    summary: result.summary,
    fatalErrors: result.fatalErrors,
  };
}

export interface BuildBundleInput {
  history: ProviderHistory;
  validation: ProviderValidationResult;
  importedAt: string;
  idFactory?: () => string;
}

/**
 * Assembles the canonical instrument/dataset/bars triple from a validated
 * provider download. Instrument identity is provider-defined; datasets are
 * keyed by their content hash in the caller's merge logic if desired.
 */
export function buildDatasetBundle(input: BuildBundleInput): DatasetBundle {
  const { history, validation, importedAt } = input;
  const nextId = input.idFactory ?? createId;
  const metadata = history.providerMetadata;
  const bars = validation.bars;

  if (bars.length === 0) {
    throw new Error('The download contained no valid bars.');
  }

  const provider: DatasetProvider = {
    provider: PROVIDER_ID,
    providerSymbol: metadata.providerSymbol,
    exchange: metadata.exchange,
    exchangeName: metadata.exchangeName,
    instrumentType: metadata.instrumentType,
    interval: metadata.interval,
    adjustment: metadata.adjustment,
    retrievedAt: metadata.retrievedAt,
    timezone: metadata.timezone,
    sourceNotes: metadata.sourceNotes,
    corporateActions: [...(metadata.corporateActions ?? [])],
  };

  const instrument: Instrument = {
    id: nextId('inst'),
    symbol: metadata.displaySymbol || metadata.providerSymbol,
    displayName: metadata.displayName?.trim() || metadata.displaySymbol || metadata.providerSymbol,
    assetType: assetTypeFromProvider(metadata.instrumentType),
    currency: metadata.currency?.trim().toUpperCase() || 'USD',
    exchange: metadata.exchangeName ?? metadata.exchange ?? undefined,
    metadata: {
      provider: PROVIDER_ID,
      providerSymbol: metadata.providerSymbol,
      sectorNote: metadata.instrumentType ?? '',
    },
  };

  const dataset: Dataset = {
    id: nextId('ds'),
    instrumentId: instrument.id,
    name: `${instrument.symbol} - daily (${PROVIDER_LABEL} download)`,
    sourceKind: 'provider-download',
    sourceDescription: `Downloaded from ${PROVIDER_LABEL} via the local market-data service. ${metadata.adjustment}.`,
    frequency: 'daily',
    // Daily session dates need no intraday timezone; storing the exchange
    // timezone documents where the session dates were derived from.
    timezone: metadata.timezone ?? 'UTC',
    firstDate: bars[0]!.date,
    lastDate: bars[bars.length - 1]!.date,
    rowCount: bars.length,
    importedAt,
    contentHash: validation.contentHash,
    hasVolume: validation.hasVolume,
    validation: validation.summary,
    provider,
  };

  return { instrument, dataset, bars };
}

/** Human summary of the most relevant validation findings. */
export function describeValidationIssues(summary: import('../../domain/types').DatasetValidationSummary): string[] {
  const notes: string[] = [];
  if (summary.rejectedRows > 0) notes.push(`${summary.rejectedRows} row(s) rejected during validation.`);
  if (summary.duplicateRows > 0) notes.push(`${summary.duplicateRows} duplicate session row(s) resolved by the chosen policy.`);
  if (summary.gapCount > 0) notes.push(`${summary.gapCount} weekday session(s) missing between the first and last date.`);
  if (summary.missingVolumeRows > 0) notes.push(`${summary.missingVolumeRows} row(s) have no volume value.`);
  for (const warning of summary.warnings) {
    notes.push(warning.message);
  }
  return notes;
}
