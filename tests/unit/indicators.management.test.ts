import { describe, expect, it } from 'vitest';
import type { IndicatorInstance } from '../../src/domain/types';
import {
  describeIndicatorInstance,
  parametersDifferFromStore,
  reorderIndicators,
  updateIndicatorParameters,
} from '../../src/lib/indicators/management';
import { getIndicatorDefinition } from '../../src/lib/indicators';
import { indicatorSma } from '../../src/lib/indicators/moving-averages';

// Real definitions come from the registry so the label contract cannot drift
// from the declared parameter specs.
const sma = indicatorSma;
const bollinger = getIndicatorDefinition('bollinger');
if (!bollinger || bollinger.parameters.length < 2) throw new Error('bollinger definition drifted');

function instance(overrides: Partial<IndicatorInstance> = {}): IndicatorInstance {
  return {
    id: 'ind-1',
    type: 'sma',
    version: 1,
    parameters: { period: 20 },
    visible: true,
    placement: 'overlay',
    style: {},
    ...overrides,
  };
}

describe('describeIndicatorInstance', () => {
  it('disambiguates two instances of the same indicator by their parameters', () => {
    const first = describeIndicatorInstance(sma, instance());
    const second = describeIndicatorInstance(sma, instance({ id: 'ind-2', parameters: { period: 50 } }));
    expect(first).toBe('Simple Moving Average 20');
    expect(second).toBe('Simple Moving Average 50');
  });

  it('joins multi-parameter values in declaration order', () => {
    expect(describeIndicatorInstance(bollinger, instance({ type: 'bollinger', parameters: { period: 20, multiplier: 2.5 } }))).toBe(
      'Bollinger Bands 20/2.5',
    );
  });

  it('falls back to declared defaults for parameters the record is missing', () => {
    expect(describeIndicatorInstance(sma, instance({ parameters: {} }))).toBe('Simple Moving Average 20');
  });

  it('labels an instance whose type is unknown in this build with the raw type', () => {
    // Nothing may crash or be hidden: the row stays removable through the UI.
    expect(describeIndicatorInstance(undefined, instance({ type: 'mystery-v1' }))).toBe('mystery-v1');
  });
});

describe('reorderIndicators', () => {
  const list = [instance({ id: 'a' }), instance({ id: 'b' }), instance({ id: 'c' })];

  it('swaps one step in the requested direction', () => {
    const moved = reorderIndicators(list, 'b', 'up');
    expect(moved.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(reorderIndicators(list, 'b', 'down').map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('does nothing when the instance is already at the requested edge', () => {
    expect(reorderIndicators(list, 'a', 'up')).toEqual(list);
    expect(reorderIndicators(list, 'c', 'down')).toEqual(list);
  });

  it('does nothing for an unknown id and never mutates the input', () => {
    expect(reorderIndicators(list, 'nope', 'up')).toEqual(list);
    const moved = reorderIndicators(list, 'b', 'down');
    expect(list.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moved).not.toBe(list);
  });
});

describe('updateIndicatorParameters', () => {
  const list = [instance({ id: 'a', parameters: { period: 20 } }), instance({ id: 'b', type: 'bollinger', parameters: { period: 50, multiplier: 2 } })];
  const bollingerDefinition = bollinger;
  it('applies a valid edit to only that instance', () => {
    const next = updateIndicatorParameters(list, 'a', sma, { period: 30 });
    expect(next[0]?.parameters).toEqual({ period: 30 });
    expect(next[1]?.parameters).toEqual({ period: 50, multiplier: 2 });
  });

  it('clamps out-of-range values to the definition bounds instead of storing them', () => {
    const next = updateIndicatorParameters(list, 'a', sma, { period: 999 });
    expect(next[0]?.parameters).toEqual({ period: 500 });
    const clampedLow = updateIndicatorParameters(list, 'b', bollingerDefinition, { period: 0, multiplier: 42 });
    expect(clampedLow[1]?.parameters).toEqual({ period: 2, multiplier: 10 });
  });

  it('drops unknown keys and replaces a non-finite draft with declared defaults', () => {
    const next = updateIndicatorParameters(list, 'a', sma, { period: 40, mystery: 3, extraKey: 1 } as Record<string, number>);
    expect(next[0]?.parameters).toEqual({ period: 40 });
    const nonFinite = updateIndicatorParameters(list, 'a', sma, { period: Number.NaN });
    expect(nonFinite[0]?.parameters).toEqual({ period: 20 });
  });

  it('returns an unchanged copy when the draft matches the stored values', () => {
    const next = updateIndicatorParameters(list, 'a', sma, { period: 20 });
    expect(next[0]?.parameters).toEqual({ period: 20 });
    expect(next).not.toBe(list);
  });
});

describe('parametersDifferFromStore', () => {
  it('reports a difference only when the clamped draft changes a stored value', () => {
    expect(parametersDifferFromStore(sma, { period: 20 }, { period: 30 })).toBe(true);
    expect(parametersDifferFromStore(sma, { period: 20 }, { period: 20 })).toBe(false);
    // A draft that clamps to the stored value is not an edit.
    expect(parametersDifferFromStore(sma, { period: 500 }, { period: 999 })).toBe(false);
    // A missing stored key is compared against the declared default.
    expect(parametersDifferFromStore(sma, {}, { period: 20 })).toBe(false);
    expect(parametersDifferFromStore(sma, {}, { period: 21 })).toBe(true);
  });
});
