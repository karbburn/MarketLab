import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/domain/types';
import {
  INDICATOR_DEFINITIONS,
  calculateIndicator,
  defaultParameters,
  getIndicatorDefinition,
  normaliseParameters,
} from '../../src/lib/indicators';

function makeBar(index: number): Bar {
  const close = 100 + Math.sin(index / 3) * 10 + index * 0.1;
  return {
    date: `2024-01-${String((index % 28) + 1).padStart(2, '0')}`,
    open: close - 0.5,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000 + index * 10,
  };
}

const bars: Bar[] = Array.from({ length: 40 }, (_, i) => makeBar(i));

describe('indicator registry', () => {
  it('registers at least one definition with unique type identifiers', () => {
    const types = INDICATOR_DEFINITIONS.map((definition) => definition.type);
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types).size).toBe(types.length);
  });

  it('uses only overlay or pane placement', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      expect(['overlay', 'pane']).toContain(definition.placement);
    }
  });

  it('exposes definitions by type and returns undefined for unknown types', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      expect(getIndicatorDefinition(definition.type)).toBe(definition);
    }
    expect(getIndicatorDefinition('does-not-exist')).toBeUndefined();
    expect(calculateIndicator('does-not-exist', bars, {})).toBeNull();
  });

  it('produces every declared output key with one value per bar', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      const outputs = definition.calculate(bars, defaultParameters(definition));
      for (const output of definition.outputs) {
        expect(outputs).toHaveProperty(output.key);
        expect(outputs[output.key]).toHaveLength(bars.length);
      }
    }
  });

  it('declares a distinct key for each declared output', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      const keys = definition.outputs.map((output) => output.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('defaultParameters', () => {
  it('returns the declared default for every parameter', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      const defaults = defaultParameters(definition);
      for (const spec of definition.parameters) {
        expect(defaults[spec.key]).toBe(spec.defaultValue);
      }
    }
  });
});

describe('normaliseParameters', () => {
  it('clamps below-min and above-max values to the declared bounds', () => {
    for (const definition of INDICATOR_DEFINITIONS) {
      for (const spec of definition.parameters) {
        const below = normaliseParameters(definition, { [spec.key]: spec.min - 1000 });
        expect(below[spec.key]).toBe(spec.min);
        const above = normaliseParameters(definition, { [spec.key]: spec.max + 1000 });
        expect(above[spec.key]).toBe(spec.max);
      }
    }
  });

  it('rounds integer parameters and preserves fractional ones', () => {
    const bollinger = getIndicatorDefinition('bollinger');
    expect(bollinger).toBeDefined();
    if (!bollinger) return;
    const rounded = normaliseParameters(bollinger, { period: 20.7, multiplier: 2.35 });
    expect(rounded.period).toBe(21);
    expect(rounded.multiplier).toBe(2.35);
  });

  it('drops unknown keys and falls back to defaults for missing values', () => {
    const sma = getIndicatorDefinition('sma');
    expect(sma).toBeDefined();
    if (!sma) return;
    const result = normaliseParameters(sma, { unknownKey: 5 });
    expect(result).not.toHaveProperty('unknownKey');
    expect(result.period).toBe(20);
  });
});
