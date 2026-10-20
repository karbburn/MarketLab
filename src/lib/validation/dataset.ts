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

function groupedInteger(value: string, separator: string): string | null {
  const parts = value.split(separator);
  if (parts.length < 2) return null;
  const first = parts[0];
  if (!first || first.length > 3 || !/^\d+$/.test(first)) return null;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || part.length !== 3 || !/^\d+$/.test(part)) return null;
  }
  return parts.join('');
}

/**
 * Normalises the decimal/thousands separators in a numeric cell and returns a
 * plain `Number`-compatible string, or `null` when the format is ambiguous.
 *
 * With both separators the last one is the decimal separator. With one
 * separator it is a thousands separator only when the groups after the first
 * are exactly three digits (and the first is one to three digits); otherwise it
 * is treated as the decimal separator.
 */
function interpretNumericSeparators(value: string): string | null {
  if (!/\d/.test(value)) return null;
  const dots = (value.match(/\./g) ?? []).length;
  const commas = (value.match(/,/g) ?? []).length;

  if (dots > 0 && commas > 0) {
    const decimal = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    const parts = value.split(decimal);
    if (parts.length !== 2) return null;
    const integerPart = parts[0] as string;
    const fractionPart = parts[1] as string;
    if (!/^\d+$/.test(fractionPart)) return null;
    const integerDigits = integerPart.includes(grouping)
      ? groupedInteger(integerPart, grouping)
      : /^\d+$/.test(integerPart)
        ? integerPart
        : null;
    if (integerDigits === null) return null;
    return `${integerDigits}.${fractionPart}`;
  }

  const separator = dots > 0 ? '.' : commas > 0 ? ',' : null;
  if (separator === null) return /^\d+$/.test(value) ? value : null;

  const parts = value.split(separator);
  if (parts.length === 2) {
    const left = parts[0] as string;
    const right = parts[1] as string;
    // Thousands grouping: first group 1-3 digits, every following group 3.
    if (/^\d{1,3}$/.test(left) && /^\d{3}$/.test(right)) return `${left}${right}`;
    // Otherwise the single separator is a decimal point; allow `.5` and `5.`.
    const integer = left === '' ? '0' : left;
    const fraction = right === '' ? '0' : right;
    if (!/^\d+$/.test(integer) || !/^\d+$/.test(fraction)) return null;
    return `${integer}.${fraction}`;
  }

  // Multiple separators of one kind are only accepted as a valid thousands grouping.
  return groupedInteger(value, separator);
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
  value = value.replace(/[\s$€£₹%]/g, '');
  if (value === '') return null;
  if (value.startsWith('-')) {
    // "(-5)" and "(- 5)" apply the sign twice: the parentheses already mean
    // "negative", and toggling would silently turn the cell positive. Reject
    // the ambiguity instead of guessing which sign the file meant.
    if (negative) return null;
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith('+')) {
    // "(+5)" contradicts the accounting-parens convention for the same reason.
    if (negative) return null;
    value = value.slice(1);
  }
  if (!value) return null;
  const normalised = interpretNumericSeparators(value);
  if (normalised === null) return null;
  const parsed = Number(normalised);
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
  // Duplicate role mappings are fatal: which column wins would otherwise depend
  // on header order rather than on the user's intent.
  const roleCounts = new Map<string, number>();
  for (const role of Object.values(mapping)) {
    if (role === 'ignore') continue;
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  for (const [role, count] of roleCounts) {
    if (count > 1) {
      fatalErrors.push(`More than one column is mapped to "${role}". Map each role to exactly one column.`);
    }
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

  const entries: BarEntry[] = [];
  const rowRejections: RejectedRow[] = [];
  let rejectedRowCount = 0;

  rows.forEach((row, index) => {
    const rawDate = dateColumn ? row[dateColumn] : '';
    const date = normaliseDate(String(rawDate ?? ''));
    if (!date) {
      rejectedRowCount += 1;
      rowRejections.push({ rowNumber: index + 1, reason: `Unrecognised date value "${rawDate ?? ''}".`, raw: rawDate });
      return;
    }

    const open = parseNumericCell(openColumn ? row[openColumn] : undefined);
    const high = parseNumericCell(highColumn ? row[highColumn] : undefined);
    const low = parseNumericCell(lowColumn ? row[lowColumn] : undefined);
    const close = parseNumericCell(closeColumn ? row[closeColumn] : undefined);
    if (open === null || high === null || low === null || close === null) {
      rejectedRowCount += 1;
      rowRejections.push({
        rowNumber: index + 1,
        reason: 'Open, high, low and close must all be finite numbers.',
        raw: [
          row[openColumn ?? ''] ?? '',
          row[highColumn ?? ''] ?? '',
          row[lowColumn ?? ''] ?? '',
          row[closeColumn ?? ''] ?? '',
        ].join(','),
      });
      return;
    }

    let volume: number | null = null;
    let volumeMissing = false;
    if (volumeColumn) {
      const rawVolume = row[volumeColumn];
      if (rawVolume === undefined || String(rawVolume).trim() === '') {
        volumeMissing = true;
      } else {
        volume = parseNumericCell(rawVolume);
        if (volume === null) {
          rejectedRowCount += 1;
          rowRejections.push({ rowNumber: index + 1, reason: `Volume "${rawVolume}" is not a finite number.`, raw: rawVolume });
          return;
        }
      }
    }

    entries.push({ date, open, high, low, close, volume, rowNumber: index + 1, volumeMissing });
  });

  const series = validateBarEntries({ rows: entries, duplicatePolicy });

  // Row-level CSV rejections (bad dates/numbers) never reached the shared
  // series core, so their counts and samples are merged back into its summary.
  const summary: DatasetValidationSummary = rowRejections.length === 0
    ? series.summary
    : {
        ...series.summary,
        rejectedRows: series.summary.rejectedRows + rejectedRowCount,
        rejected: [
          ...series.summary.rejected,
          ...rowRejections.slice(0, Math.max(0, MAX_REJECTED_SAMPLES - series.summary.rejected.length)),
        ]
          .sort((a, b) => a.rowNumber - b.rowNumber)
          .slice(0, MAX_REJECTED_SAMPLES),
      };

  return {
    bars: series.bars,
    fatalErrors: series.fatalErrors,
    hasVolume: series.hasVolume,
    contentHash: series.contentHash,
    summary,
  };
}

export interface BarEntry {
  /** Normalised `YYYY-MM-DD` exchange session date. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** `null` when the source provided no value for this row. */
  volume: number | null;
  /** 1-based index of the row within its source, for rejection reports. */
  rowNumber: number;
  /** Set when the row is accepted but carries no volume value at all. */
  volumeMissing?: boolean;
}

export interface BarSeriesValidationInput {
  rows: readonly BarEntry[];
  duplicatePolicy: DuplicatePolicy;
  /** Message used when zero rows survive validation. */
  emptyMessage?: string;
}

export interface BarSeriesValidationResult {
  bars: Bar[];
  summary: DatasetValidationSummary;
  fatalErrors: string[];
  hasVolume: boolean;
  contentHash: string;
}

/**
 * Applies the shared series-level rules (OHLC invariants, positive prices,
 * duplicate policy, ordering, gap reporting) to already-parsed rows. The CSV
 * import and the market-data download pipeline both funnel through this, so
 * downstream consumers never see different rule behaviour per source.
 */
export function validateBarEntries(input: BarSeriesValidationInput): BarSeriesValidationResult {
  const { rows, duplicatePolicy } = input;

  const rejected: RejectedRow[] = [];
  const warnings: ValidationWarning[] = [];
  let rejectedRows = 0;
  let duplicateRows = 0;
  let missingVolumeRows = 0;
  const recordRejection = (rowNumber: number, reason: string, raw?: string, count = 1) => {
    rejectedRows += count;
    if (rejected.length < MAX_REJECTED_SAMPLES) rejected.push({ rowNumber, reason, raw });
  };

  interface ParsedRow extends BarEntry {
    bar: Bar;
  }

  const parsedRows: ParsedRow[] = [];
  const seen = new Map<string, number[]>();

  for (const row of rows) {
    const { date, open, high, low, close, volume } = row;
    if (open === null || high === null || low === null || close === null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      recordRejection(row.rowNumber, `Open, high, low and close must all be finite numbers for ${date}.`);
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      recordRejection(
        row.rowNumber,
        `Prices must be greater than zero for ${date}. Series with zero or negative prices (such as spread quotes) are not supported.`,
      );
      continue;
    }
    if (high < Math.max(open, close) - NUMERIC_TOLERANCE * Math.max(1, high)) {
      recordRejection(row.rowNumber, `High (${high}) is below max(open, close) for ${date}.`);
      continue;
    }
    if (low > Math.min(open, close) + NUMERIC_TOLERANCE * Math.max(1, low)) {
      recordRejection(row.rowNumber, `Low (${low}) is above min(open, close) for ${date}.`);
      continue;
    }
    if (high < low && !nearlyEqual(high, low)) {
      recordRejection(row.rowNumber, `High (${high}) is below low (${low}) for ${date}.`);
      continue;
    }
    if (volume !== null && (volume < 0 || !Number.isFinite(volume))) {
      recordRejection(row.rowNumber, `Volume (${volume}) must not be negative for ${date}.`);
      continue;
    }
    if (volume === null) missingVolumeRows += 1;

    const bar: Bar = { date, open, high, low, close, volume };
    parsedRows.push({ ...row, bar });
    const bucket = seen.get(date);
    if (bucket) bucket.push(parsedRows.length - 1);
    else seen.set(date, [parsedRows.length - 1]);
  }

  const excluded = new Set<number>();
  for (const [date, indices] of seen) {
    if (indices.length < 2) continue;
    duplicateRows += indices.length;
    if (duplicatePolicy === 'keep-first') {
      for (const index of indices.slice(1)) excluded.add(index);
      recordRejection(
        (parsedRows[indices[1] as number]?.rowNumber ?? 0),
        `Duplicate session ${date}; kept the first occurrence.`,
        undefined,
        indices.length - 1,
      );
    } else if (duplicatePolicy === 'keep-last') {
      for (const index of indices.slice(0, -1)) excluded.add(index);
      recordRejection(
        (parsedRows[indices[0] as number]?.rowNumber ?? 0),
        `Duplicate session ${date}; kept the last occurrence.`,
        undefined,
        indices.length - 1,
      );
    } else {
      for (const index of indices) excluded.add(index);
      recordRejection(
        (parsedRows[indices[0] as number]?.rowNumber ?? 0),
        `Duplicate session ${date}; all ${indices.length} rows rejected.`,
        undefined,
        indices.length,
      );
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
  const fatalErrors: string[] = [];
  if (bars.length === 0) fatalErrors.push(input.emptyMessage ?? 'No valid rows were found in the file.');
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
    hasVolume: bars.some((bar) => bar.volume !== null),
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
