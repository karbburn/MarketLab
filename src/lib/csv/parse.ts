import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  /** Raw string rows keyed by header, in file order. */
  rows: Array<Record<string, string>>;
  delimiter: string;
  truncated: boolean;
  errors: Array<{ row: number; message: string }>;
  totalRows: number;
}

const MAX_ROWS = 200_000;
const MAX_PREVIEW_ROWS = 200_000;

/**
 * Parses CSV text as inert data. File contents are never executed and are
 * never injected as HTML.
 */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (header) => header.trim(),
  });

  const rows = (result.data ?? []).filter((row) => Object.values(row).some((value) => String(value ?? '').trim() !== ''));
  const truncated = rows.length > MAX_ROWS;
  const limited = rows.slice(0, MAX_ROWS);

  const errors = (result.errors ?? []).slice(0, 50).map((error) => ({
    row: typeof error.row === 'number' ? error.row + 1 : 0,
    message: error.message,
  }));

  return {
    headers: (result.meta?.fields ?? []).filter((field) => field && field.length > 0),
    rows: limited,
    delimiter: result.meta?.delimiter ?? ',',
    truncated,
    errors,
    totalRows: rows.length,
  };
}

export function toPreview(parsed: ParsedCsv, limit = 8): Array<Record<string, string>> {
  return parsed.rows.slice(0, Math.min(limit, MAX_PREVIEW_ROWS));
}
