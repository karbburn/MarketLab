import { describe, expect, it } from 'vitest';
import { toCsv, validationToCsv } from '../../src/lib/export/csv';

describe('CSV formula injection neutralisation', () => {
  it('prefixes string cells that a spreadsheet would evaluate as formulas', () => {
    expect(toCsv(['value'], [['=1+1']])).toBe("value\r\n'=1+1\r\n");
    expect(toCsv(['value'], [['+SUM(A1)']])).toBe("value\r\n'+SUM(A1)\r\n");
    expect(toCsv(['value'], [['-1+1']])).toBe("value\r\n'-1+1\r\n");
    expect(toCsv(['value'], [['@cmd']])).toBe("value\r\n'@cmd\r\n");
    expect(toCsv(['value'], [['\tx']])).toBe("value\r\n'\tx\r\n");
  });

  it('still quotes neutralised cells that contain a comma or quote', () => {
    expect(toCsv(['value'], [["=cmd|' /C calc'!A0,1"]])).toBe(`value\r\n"'=cmd|' /C calc'!A0,1"\r\n`);
  });

  it('leaves numeric cells untouched, including negative numbers', () => {
    expect(toCsv(['value'], [[-5]])).toBe('value\r\n-5\r\n');
    expect(toCsv(['value', 'other'], [[-1.5, 2]])).toBe('value,other\r\n-1.5,2\r\n');
  });

  it('neutralises formula-like rejected-row text in the validation export', () => {
    const csv = validationToCsv({
      acceptedRows: 0,
      rejectedRows: 1,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [{ rowNumber: 1, reason: 'bad row', raw: '=HYPERLINK("http://evil")' }],
      warnings: [],
    });
    expect(csv).toContain(`'=HYPERLINK(""http://evil"")`);
  });
});
