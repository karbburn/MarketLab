import { describe, expect, it } from 'vitest';
import {
  COMPARISON_DRILL_OPTIONS,
  comparisonDrill,
  EMPTY_COMPARISON_DRILL,
  type ComparisonDrillInput,
} from '../../src/lib/learn/comparison';

function drill(overrides: Partial<ComparisonDrillInput> = {}): ComparisonDrillInput {
  return { ...EMPTY_COMPARISON_DRILL, ...overrides };
}

describe('saved-run comparison drill', () => {
  it('starts with no differences and comparable inputs', () => {
    const verdict = comparisonDrill(drill());

    expect(verdict.state).toBe('same');
    expect(verdict.label).toBe('No differences selected');
    expect(verdict.inputsComparable).toBe(true);
    expect(verdict.notes).toEqual([]);
  });

  it('treats different strategy settings as a valid comparison', () => {
    const verdict = comparisonDrill(drill({ settingsChanged: true }));

    expect(verdict.state).toBe('different-strategy');
    expect(verdict.inputsComparable).toBe(true);
    expect(verdict.notes).toEqual([
      'The strategies use different rules, position size, costs, stops or targets.',
    ]);
    expect(verdict.detail).toContain('rather than one isolated change');
  });

  it.each([
    'datasetChanged',
    'windowChanged',
    'engineChanged',
    'assumptionsChanged',
  ] as const)('marks a recorded input difference as not directly comparable: %s', (key) => {
    const verdict = comparisonDrill(drill({ [key]: true }));

    expect(verdict.state).toBe('not-comparable');
    expect(verdict.inputsComparable).toBe(false);
    expect(verdict.notes).toHaveLength(1);
    expect(verdict.detail).toContain('descriptive');
  });

  it('keeps a missing dataset readable but calls the current check unavailable', () => {
    const verdict = comparisonDrill(drill({ datasetMissing: true }));

    expect(verdict.state).toBe('snapshot-only');
    expect(verdict.inputsComparable).toBe(true);
    expect(verdict.notes).toEqual([
      'The snapshot remains readable, but the dataset is no longer in the library.',
    ]);
    expect(verdict.detail).toContain('current input check is unavailable');
  });

  it('keeps settings differences visible when the dataset is missing', () => {
    const verdict = comparisonDrill(drill({ datasetMissing: true, settingsChanged: true }));

    expect(verdict.state).toBe('snapshot-only');
    expect(verdict.notes).toHaveLength(2);
    expect(verdict.notes).toContain(
      'The snapshot remains readable, but the dataset is no longer in the library.',
    );
    expect(verdict.notes).toContain(
      'The strategies use different rules, position size, costs, stops or targets.',
    );
  });

  it('lets a recorded input difference override settings and a missing dataset', () => {
    const verdict = comparisonDrill(
      drill({ datasetChanged: true, settingsChanged: true, datasetMissing: true }),
    );

    expect(verdict.state).toBe('not-comparable');
    expect(verdict.inputsComparable).toBe(false);
    expect(verdict.notes).toHaveLength(3);
  });

  it('lists every selected difference once', () => {
    const all = Object.fromEntries(
      COMPARISON_DRILL_OPTIONS.map((option) => [option.key, true]),
    ) as unknown as ComparisonDrillInput;
    const verdict = comparisonDrill(all);

    expect(verdict.state).toBe('not-comparable');
    expect(verdict.notes).toHaveLength(COMPARISON_DRILL_OPTIONS.length);
    expect(new Set(verdict.notes).size).toBe(COMPARISON_DRILL_OPTIONS.length);
    expect(verdict.notes).toContain('The stored dataset identity or content hash differs.');
    expect(verdict.notes).toContain(
      'The snapshot remains readable, but the dataset is no longer in the library.',
    );
  });

  it('has one option for each drill input', () => {
    const keys = COMPARISON_DRILL_OPTIONS.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(EMPTY_COMPARISON_DRILL).sort());
  });

  it('does not change the input', () => {
    const input = drill({ windowChanged: true, settingsChanged: true });
    const before = { ...input };

    comparisonDrill(input);

    expect(input).toEqual(before);
  });
});
