import { describe, it, expect } from 'vitest';
import type { DuplicatePolicy } from '../../src/lib/validation/dataset';
import { parseNumericCell, validateCsvRows } from '../../src/lib/validation/dataset';
import type { ColumnMapping } from '../../src/lib/csv/mapping';
import { inferMapping, validateMapping } from '../../src/lib/csv/mapping';

const mapping: ColumnMapping = {
  date: 'date',
  open: 'open',
  high: 'high',
  low: 'low',
  close: 'close',
  volume: 'volume',
};

function row(
  date: string,
  open: string,
  high: string,
  low: string,
  close: string,
  volume = '100',
): Record<string, string> {
  return { date, open, high, low, close, volume };
}

describe('parseNumericCell', () => {
  it('parses plain, grouped and parenthesised numbers', () => {
    expect(parseNumericCell('1234.5')).toBe(1234.5);
    expect(parseNumericCell('1,234.5')).toBe(1234.5);
    expect(parseNumericCell('(500)')).toBe(-500);
    expect(parseNumericCell('12%')).toBe(12);
  });

  it('disambiguates decimal commas and dot thousands separators', () => {
    expect(parseNumericCell('12,5')).toBe(12.5);
    expect(parseNumericCell('1.234,56')).toBe(1234.56);
    expect(parseNumericCell('1.234')).toBe(1234);
    expect(parseNumericCell('1,234')).toBe(1234);
    expect(parseNumericCell('1,234,567')).toBe(1234567);
    expect(parseNumericCell('1.234.567,89')).toBe(1234567.89);
  });

  it('rejects ambiguous or malformed grouping', () => {
    expect(parseNumericCell('12,34,567')).toBeNull();
    expect(parseNumericCell('1.234.56')).toBeNull();
    expect(parseNumericCell('1,2,3')).toBeNull();
  });

  it('treats blanks and sentinel values as missing', () => {
    expect(parseNumericCell('')).toBeNull();
    expect(parseNumericCell('-')).toBeNull();
    expect(parseNumericCell('n/a')).toBeNull();
    expect(parseNumericCell('null')).toBeNull();
    expect(parseNumericCell(undefined)).toBeNull();
  });
});

describe('inferMapping and validateMapping', () => {
  it('infers every role from common header names', () => {
    const inferred = inferMapping(['Date', 'Open', 'High', 'Low', 'Close', 'Volume']);
    expect(inferred).toEqual({
      Date: 'date',
      Open: 'open',
      High: 'high',
      Low: 'low',
      Close: 'close',
      Volume: 'volume',
    });
  });

  it('marks unrecognised headers as ignore', () => {
    const inferred = inferMapping(['Date', 'Open', 'Notes']);
    expect(inferred.Notes).toBe('ignore');
  });

  it('warns about a missing required role', () => {
    const warnings = validateMapping({ Date: 'date', Open: 'open', High: 'high', Low: 'low' });
    expect(warnings.map((warning) => warning.code)).toContain('missing-close');
  });
});

describe('validateCsvRows row invariants', () => {
  it('accepts a well-formed row and reports a stable content hash', () => {
    const rows = [row('2024-01-01', '10', '12', '9', '11')];
    const result = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    expect(result.fatalErrors).toEqual([]);
    expect(result.bars).toHaveLength(1);
    expect(result.summary.acceptedRows).toBe(1);
    expect(result.contentHash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it('rejects a row whose high is below max(open, close)', () => {
    const result = validateCsvRows({
      rows: [row('2024-01-01', '10', '9', '8', '10')],
      mapping,
      duplicatePolicy: 'reject',
    });
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.acceptedRows).toBe(0);
    expect(result.summary.rejected[0]?.reason).toMatch(/High/);
    expect(result.fatalErrors).toContain('No valid rows were found in the file.');
  });

  it('rejects a row whose low is above min(open, close)', () => {
    const result = validateCsvRows({
      rows: [row('2024-01-01', '10', '11', '10.5', '10')],
      mapping,
      duplicatePolicy: 'reject',
    });
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.rejected[0]?.reason).toMatch(/Low/);
  });

  it('rejects a row with a zero or negative price', () => {
    const negative = validateCsvRows({
      rows: [row('2024-01-01', '-10', '-5', '-12', '-8')],
      mapping,
      duplicatePolicy: 'reject',
    });
    expect(negative.summary.rejectedRows).toBe(1);
    expect(negative.summary.acceptedRows).toBe(0);
    expect(negative.summary.rejected[0]?.reason).toMatch(/greater than zero/);

    const zero = validateCsvRows({
      rows: [row('2024-01-01', '0', '0', '0', '0')],
      mapping,
      duplicatePolicy: 'reject',
    });
    expect(zero.summary.rejectedRows).toBe(1);
    expect(zero.summary.acceptedRows).toBe(0);
  });

  it('rejects a row whose high is below its low', () => {
    // high (9) still fails the max(open, close) invariant, so the row is never accepted.
    const result = validateCsvRows({
      rows: [row('2024-01-01', '10', '9', '9.5', '10')],
      mapping,
      duplicatePolicy: 'reject',
    });
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.rejected[0]?.rowNumber).toBe(1);
  });

  it('reports unfinishable files when a required column is unmapped', () => {
    const result = validateCsvRows({
      rows: [row('2024-01-01', '10', '12', '9', '11')],
      mapping: { date: 'date', open: 'open' },
      duplicatePolicy: 'reject',
    });
    expect(result.bars).toEqual([]);
    expect(result.fatalErrors).toHaveLength(3);
  });

  it('treats duplicate role mappings as fatal', () => {
    const duplicateMapping: ColumnMapping = { ...mapping, close2: 'close' };
    const result = validateCsvRows({
      rows: [{ ...row('2024-01-01', '10', '12', '9', '11'), close2: '11' }],
      mapping: duplicateMapping,
      duplicatePolicy: 'reject',
    });
    expect(result.bars).toEqual([]);
    expect(result.fatalErrors.some((error) => /more than one column/i.test(error))).toBe(true);
  });

  it('counts rows that are missing volume instead of inventing zero', () => {
    const rows = [row('2024-01-01', '10', '12', '9', '11', ''), row('2024-01-02', '11', '13', '10', '12', '')];
    const result = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    expect(result.summary.missingVolumeRows).toBe(2);
    expect(result.bars.every((bar) => bar.volume === null)).toBe(true);
    expect(result.hasVolume).toBe(false);
    expect(result.summary.warnings.map((warning) => warning.code)).toContain('missing-volume');
  });
});

describe('validateCsvRows duplicates', () => {
  const rows = [
    row('2024-01-01', '10', '12', '9', '11', '100'),
    row('2024-01-01', '20', '22', '19', '21', '200'),
    row('2024-01-02', '30', '32', '29', '31', '300'),
  ];

  function run(policy: DuplicatePolicy) {
    return validateCsvRows({ rows, mapping, duplicatePolicy: policy });
  }

  it('keeps the first occurrence and rejects the later one', () => {
    const result = run('keep-first');
    expect(result.summary.duplicateRows).toBe(2);
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.acceptedRows).toBe(2);
    expect(result.bars[0]?.close).toBe(11);
  });

  it('keeps the last occurrence and rejects the earlier one', () => {
    const result = run('keep-last');
    expect(result.summary.duplicateRows).toBe(2);
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.acceptedRows).toBe(2);
    expect(result.bars[0]?.close).toBe(21);
  });

  it('rejects every row sharing a duplicate date under the reject policy', () => {
    const result = run('reject');
    expect(result.summary.duplicateRows).toBe(2);
    expect(result.summary.rejectedRows).toBe(2);
    expect(result.summary.acceptedRows).toBe(1);
    expect(result.bars[0]?.date).toBe('2024-01-02');
  });

  it('counts every excluded row in a larger duplicate group', () => {
    const triple = [
      row('2024-01-01', '10', '12', '9', '11', '100'),
      row('2024-01-01', '20', '22', '19', '21', '200'),
      row('2024-01-01', '30', '32', '29', '31', '300'),
      row('2024-01-02', '40', '42', '39', '41', '400'),
    ];
    const keepFirst = validateCsvRows({ rows: triple, mapping, duplicatePolicy: 'keep-first' });
    expect(keepFirst.summary.rejectedRows).toBe(2);
    expect(keepFirst.summary.acceptedRows).toBe(2);

    const rejectAll = validateCsvRows({ rows: triple, mapping, duplicatePolicy: 'reject' });
    expect(rejectAll.summary.rejectedRows).toBe(3);
    expect(rejectAll.summary.acceptedRows).toBe(1);
  });
});

describe('validateCsvRows gaps and hashing', () => {
  it('counts missing weekday sessions between accepted rows', () => {
    const rows = [row('2024-01-01', '10', '12', '9', '11'), row('2024-01-04', '11', '13', '10', '12')];
    const result = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    expect(result.summary.gapCount).toBe(2);
    expect(result.summary.warnings.map((warning) => warning.code)).toContain('session-gaps');
  });

  it('is stable for identical input and changes when a value changes', () => {
    const rows = [row('2024-01-01', '10', '12', '9', '11'), row('2024-01-02', '11', '13', '10', '12')];
    const first = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    const second = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).not.toBe('');

    const changed = [row('2024-01-01', '10', '12', '9', '11'), row('2024-01-02', '11', '13', '10', '12.5')];
    const third = validateCsvRows({ rows: changed, mapping, duplicatePolicy: 'reject' });
    expect(third.contentHash).not.toBe(first.contentHash);
  });

  it('corrects out-of-order rows and records a warning', () => {
    const rows = [row('2024-01-03', '10', '12', '9', '11'), row('2024-01-01', '11', '13', '10', '12')];
    const result = validateCsvRows({ rows, mapping, duplicatePolicy: 'reject' });
    expect(result.summary.sortCorrections).toBe(1);
    expect(result.bars[0]?.date).toBe('2024-01-01');
    expect(result.summary.warnings.map((warning) => warning.code)).toContain('sort-order');
  });
});
