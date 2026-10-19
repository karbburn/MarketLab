import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv/parse';

describe('parseCsv row cap', () => {
  it('surfaces truncation in errors instead of dropping rows silently', () => {
    const header = 'date,open,high,low,close\n';
    const row = '2024-01-01,1,1,1,1\n';
    const parsed = parseCsv(header + row.repeat(200_001));

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(200_000);
    expect(parsed.totalRows).toBe(200_001);
    expect(parsed.errors.some((error) => /only the first 200000 were read/i.test(error.message))).toBe(true);
  }, 30_000);
});
