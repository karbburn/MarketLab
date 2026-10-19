import type { ValidationWarning } from '../../domain/types';

export type ColumnRole = 'date' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'ignore';

export type ColumnMapping = Record<string, ColumnRole>;

const HEADER_HINTS: Array<{ role: ColumnRole; patterns: RegExp[] }> = [
  { role: 'date', patterns: [/^(date|time|timestamp|datetime|day)$/i, /(date|time)/i] },
  { role: 'open', patterns: [/^open/i, /^o$/i] },
  { role: 'high', patterns: [/^high/i, /^h$/i] },
  { role: 'low', patterns: [/^low/i, /^l$/i] },
  { role: 'close', patterns: [/^(close|adj ?close|last|price)$/i, /^c$/i] },
  { role: 'volume', patterns: [/^(volume|vol|qty|quantity)$/i, /^v$/i] },
];

export function inferMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<ColumnRole>();
  for (const header of headers) {
    let match: ColumnRole = 'ignore';
    for (const hint of HEADER_HINTS) {
      if (used.has(hint.role)) continue;
      if (hint.patterns.some((pattern) => pattern.test(header.trim()))) {
        match = hint.role;
        break;
      }
    }
    if (match !== 'ignore') used.add(match);
    mapping[header] = match;
  }
  return mapping;
}

export function validateMapping(mapping: ColumnMapping): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const roles = Object.values(mapping);
  const required: ColumnRole[] = ['date', 'open', 'high', 'low', 'close'];
  for (const role of required) {
    const count = roles.filter((value) => value === role).length;
    if (count === 0) warnings.push({ code: `missing-${role}`, message: `No column is mapped to "${role}".` });
    if (count > 1) warnings.push({ code: `duplicate-${role}`, message: `More than one column is mapped to "${role}".` });
  }
  return warnings;
}

export function emptyMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const header of headers) mapping[header] = 'ignore';
  return mapping;
}
