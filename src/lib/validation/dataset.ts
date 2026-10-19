import type { Bar, DatasetValidationSummary, RejectedRow, ValidationWarning } from '../../domain/types';
import { compareDates, isoWeekday, normaliseDate, parseDate } from '../date';
import type { ColumnMapping } from '../csv/mapping';

export type DuplicatePolicy = 'reject' | 'keep-first' | 'keep-last';

export interface CsvValidationInput {
  rows: Array<Record<string, string>>;
  mapping: ColumnMapping;
  duplicatePolicy: DuplicatePolicy;
}

export interface CsvValidationResult {
  bars: Bar[];
  summary: DatasetValidationSummary;
  fatalErrors: string[];
  hasVolume: boolean;
  contentHash: string;
}

const MAX_REJECTED_SAMPLES = 100;
const NUMERIC_TOLERANCE = 1e-6;

function roleFor(mapping: ColumnMapping, role: string): string | null {
  for (const [header, value] of Object.entries(mapping)) {
    if (value === role) return header;
  }
  return null;
}

export function parseNumericCell(input: string | undefined): number | null {
  if (input === undefined || input === null) return null;
  let value = String(input).trim();
  if (!value || value === '-' || value.toLowerCase() === 'n/a' || value.toLowerCase() === 'null') return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[,\s$€£₹%]/g, '');
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

export function validateCsvRows(input: CsvValidationInput): CsvValidationResult {
  const { rows, mapping, duplicatePolicy } = input;
  const fatalErrors: string[] = [];

  const dateColumn = roleFor(mapping, 'date');
  const openColumn = roleFor(mapping, 'open');
  const highColumn = roleFor(mapping, 'high');
  const lowColumn = roleFor(mapping, 'low');
  const closeColumn = roleFor(mapping, 'close');
  const volumeColumn = roleFor(mapping, 'volume');

  for (const [role, column] of [
    ['date', dateColumn],
    ['open', openColumn],
    ['high', highColumn],
    ['low', lowColumn],
    ['close', closeColumn],
  ] as const) {
    if (!column) fatalErrors.push(`A column must be mapped to ${role}.`);
  }
  if (fatalErrors.length > 0) {
    return {
      bars: [],
      fatalErrors,
      hasVolume: Boolean(volumeColumn),
      contentHash: '',
      summary: emptySummary(),
    };
  }

  const rejected: RejectedRow[] = [];
  const warnings: ValidationWarning[] = [];
  let rejectedRows = 0;
  let duplicateRows = 0;
  let missingVolumeRows = 0;

  const recordRejection = (rowNumber: number, reason: string, raw?: string) => {
    rejectedRows += 1;
    if (rejected.length < MAX_REJECTED_SAMPLES) rejected.push({ rowNumber, reason, raw });
  };

  interface ParsedRow {
    date: string;
    bar: Bar;
    rowNumber: number;
  }

  const parsedRows: ParsedRow[] = [];
  const seen = new Map<string, number[]>();

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const rawDate = dateColumn ? row[dateColumn] : '';
    const date = normaliseDate(String(rawDate ?? ''));
    if (!date) {
      recordRejection(rowNumber, `Unrecognised date value "${rawDate ?? ''}".`, rawDate);
      return;
    }

    const open = parseNumericCell(openColumn ? row[openColumn] : undefined);
    const high = parseNumericCell(highColumn ? row[highColumn] : undefined);
    const low = parseNumericCell(lowColumn ? row[lowColumn] : undefined);
    const close = parseNumericCell(closeColumn ? row[closeColumn] : undefined);
    if (open === null || high === null || low === null || close === null) {
      recordRejection(rowNumber, 'Open, high, low and close must all be finite numbers.', [
        row[openColumn ?? ''] ?? '',
        row[highColumn ?? ''] ?? '',
        row[lowColumn ?? ''] ?? '',
        row[closeColumn ?? ''] ?? '',
      ].join(','));
      return;
    }

    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      recordRejection(
        rowNumber,
        `Prices must be greater than zero for ${date}. Series with zero or negative prices (such as spread quotes) are not supported.`,
        [open, high, low, close].join(','),
      );
      return;
    }

    if (high < Math.max(open, close) - NUMERIC_TOLERANCE * Math.max(1, high)) {
      recordRejection(rowNumber, `High (${high}) is below max(open, close) for ${date}.`);
      return;
    }
    if (low > Math.min(open, close) + NUMERIC_TOLERANCE * Math.max(1, low)) {
      recordRejection(rowNumber, `Low (${low}) is above min(open, close) for ${date}.`);
      return;
    }
    if (high < low && !nearlyEqual(high, low)) {
      recordRejection(rowNumber, `High (${high}) is below low (${low}) for ${date}.`);
      return;
    }

    let volume: number | null = null;
    if (volumeColumn) {
      const rawVolume = row[volumeColumn];
      const emptyVolume = rawVolume === undefined || String(rawVolume).trim() === '';
      if (emptyVolume) {
        missingVolumeRows += 1;
      } else {
        volume = parseNumericCell(rawVolume);
        if (volume === null) {
          recordRejection(rowNumber, `Volume "${rawVolume}" is not a finite number.`, rawVolume);
          return;
        }
        if (volume < 0) {
          recordRejection(rowNumber, `Volume (${volume}) must not be negative.`);
          return;
        }
      }
    }

    const bar: Bar = { date, open, high, low, close, volume };
    parsedRows.push({ date, bar, rowNumber });
    const bucket = seen.get(date);
    if (bucket) bucket.push(parsedRows.length - 1);
    else seen.set(date, [parsedRows.length - 1]);
  });

  const excluded = new Set<number>();
  for (const [date, indices] of seen) {
    if (indices.length < 2) continue;
    duplicateRows += indices.length;
    if (duplicatePolicy === 'keep-first') {
      for (const index of indices.slice(1)) excluded.add(index);
      recordRejection(parsedRows[indices[1] as number]?.rowNumber ?? 0, `Duplicate session ${date}; kept the first occurrence.`);
    } else if (duplicatePolicy === 'keep-last') {
      for (const index of indices.slice(0, -1)) excluded.add(index);
      recordRejection(parsedRows[indices[0] as number]?.rowNumber ?? 0, `Duplicate session ${date}; kept the last occurrence.`);
    } else {
      for (const index of indices) excluded.add(index);
      recordRejection(parsedRows[indices[0] as number]?.rowNumber ?? 0, `Duplicate session ${date}; all ${indices.length} rows rejected.`);
    }
  }

  let accepted = parsedRows.filter((_, index) => !excluded.has(index));
  const sorted = [...accepted].sort((a, b) => compareDates(a.date, b.date));
  let sortCorrections = 0;
  for (let i = 1; i < accepted.length; i += 1) {
    if (compareDates((accepted[i - 1] as ParsedRow).date, (accepted[i] as ParsedRow).date) > 0) sortCorrections += 1;
  }
  accepted = sorted;

  let gapCount = 0;
  for (let i = 1; i < accepted.length; i += 1) {
    const previous = accepted[i - 1] as ParsedRow;
    const current = accepted[i] as ParsedRow;
    const between = businessDaysBetween(previous.date, current.date);
    if (between > 0) gapCount += between;
  }

  const bars = accepted.map((row) => row.bar);
  if (bars.length === 0) fatalErrors.push('No valid rows were found in the file.');
  if (accepted.length > 0) {
    const weekendRows = bars.filter((bar) => isoWeekday(bar.date) > 5).length;
    if (weekendRows > 0) {
      warnings.push({
        code: 'weekend-rows',
        message: `${weekendRows} row(s) fall on a weekend. They are retained as-is; the app never fabricates trading sessions.`,
        count: weekendRows,
      });
    }
    if (gapCount > 0) {
      warnings.push({
        code: 'session-gaps',
        message: `${gapCount} expected weekday session(s) are missing between the first and last date. Gaps are shown as gaps and never filled.`,
        count: gapCount,
      });
    }
    if (missingVolumeRows > 0) {
      warnings.push({
        code: 'missing-volume',
        message: `${missingVolumeRows} row(s) have no volume value. Volume stays unavailable for those bars.`,
        count: missingVolumeRows,
      });
    }
    if (sortCorrections > 0) {
      warnings.push({
        code: 'sort-order',
        message: `${sortCorrections} row(s) were out of chronological order and were sorted before saving.`,
        count: sortCorrections,
      });
    }
  }

  const hashSource = bars.map((bar) => `${bar.date}:${bar.open}:${bar.high}:${bar.low}:${bar.close}:${bar.volume ?? ''}`).join('|');

  return {
    bars,
    fatalErrors,
    hasVolume: Boolean(volumeColumn) && bars.some((bar) => bar.volume !== null),
    contentHash: hashSource ? `fnv1a-${hashString(hashSource)}` : '',
    summary: {
      acceptedRows: bars.length,
      rejectedRows,
      duplicateRows,
      missingVolumeRows,
      gapCount,
      sortCorrections,
      rejected,
      warnings,
    },
  };
}

function emptySummary(): DatasetValidationSummary {
  return {
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    missingVolumeRows: 0,
    gapCount: 0,
    sortCorrections: 0,
    rejected: [],
    warnings: [],
  };
}

export function businessDaysBetween(from: string, to: string): number {
  let cursor = from;
  let count = -1;
  let guard = 0;
  while (compareDates(cursor, to) < 0 && guard < 10_000) {
    cursor = addBusinessDay(cursor);
    count += 1;
    guard += 1;
  }
  return count;
}

function addBusinessDay(date: string): string {
  const next = parseDate(date);
  next.setUTCDate(next.getUTCDate() + 1);
  let value = next.toISOString().slice(0, 10);
  while (isoWeekday(value) > 5) {
    next.setUTCDate(next.getUTCDate() + 1);
    value = next.toISOString().slice(0, 10);
  }
  return value;
}
