import { describe, expect, it } from 'vitest';
import { formatCompact } from '../../src/lib/format';

describe('formatCompact', () => {
  it('uses the expected unit for ordinary magnitudes', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(1234)).toBe('1.23K');
    expect(formatCompact(1_500_000)).toBe('1.50M');
  });

  it('promotes a value that would round to 1000.00 in the smaller unit', () => {
    expect(formatCompact(999_999.9)).toBe('1.00M');
    expect(formatCompact(999_999_999.9)).toBe('1.00B');
  });

  it('keeps the sign of negative values', () => {
    expect(formatCompact(-1234)).toBe('-1.23K');
  });
});
