import { describe, expect, it } from 'vitest';
import { calculateCagrExample, screenWindowDrill } from '../../src/lib/learn/calculations';
import {
  LEARN_CASES,
  LEARN_EXECUTION_STEPS,
  LEARN_FACTS,
  LEARN_INDICATORS,
  LEARN_METRIC_GROUPS,
  LEARN_METRICS,
  LEARN_ROUTE,
  LEARN_SECTIONS,
  LEARN_WITHHELD,
} from '../../src/lib/learn/content';
import { cagrPct } from '../../src/lib/quant/metrics';
import type { Bar } from '../../src/domain/types';

function bar(date: string, close: number): Bar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

describe('CAGR example', () => {
  it('waits for all three inputs', () => {
    expect(calculateCagrExample(null, 121, 730)).toEqual({ status: 'incomplete' });
    expect(calculateCagrExample(100, null, 730)).toEqual({ status: 'incomplete' });
    expect(calculateCagrExample(100, 121, null)).toEqual({ status: 'incomplete' });
  });

  it('rejects non-positive and non-integer values', () => {
    expect(calculateCagrExample(0, 121, 730)).toMatchObject({ status: 'invalid' });
    expect(calculateCagrExample(100, 0, 730)).toMatchObject({ status: 'invalid' });
    expect(calculateCagrExample(100, 121, 0)).toMatchObject({ status: 'invalid' });
    expect(calculateCagrExample(100, 121, 30.5)).toMatchObject({ status: 'invalid' });
    expect(calculateCagrExample(Number.NaN, 121, 730)).toMatchObject({ status: 'invalid' });
  });

  it('uses the same calendar-year convention as the production CAGR', () => {
    const example = calculateCagrExample(100, 121, 730);
    expect(example.status).toBe('ok');
    if (example.status !== 'ok') return;

    expect(example.totalReturnPct).toBeCloseTo(21, 6);
    expect(example.years).toBeCloseTo(730 / 365.25, 6);
    expect(example.cagrPct).toBeCloseTo(10.0072, 3);
    expect(example.cagrWithheld).toBe(false);

    const production = cagrPct([bar('2024-01-01', 100), bar('2025-12-31', 121)]);
    expect(production).not.toBeNull();
    expect(example.cagrPct).toBeCloseTo(production as number, 9);
  });

  it('withholds CAGR at the 30-day boundary, matching the product', () => {
    const thirty = calculateCagrExample(100, 110, 30);
    const thirtyOne = calculateCagrExample(100, 110, 31);
    expect(thirty).toMatchObject({ status: 'ok', cagrPct: null, cagrWithheld: true });
    expect(thirtyOne).toMatchObject({ status: 'ok', cagrWithheld: false });
    if (thirtyOne.status === 'ok') expect(thirtyOne.cagrPct).not.toBeNull();

    expect(cagrPct([bar('2024-01-01', 100), bar('2024-01-31', 110)])).toBeNull();
    expect(cagrPct([bar('2024-01-01', 100), bar('2024-02-01', 110)])).not.toBeNull();
  });

  it('rejects finite inputs whose growth or CAGR overflows', () => {
    const gradient = calculateCagrExample(1e-308, 1e308, 730);
    expect(gradient).toMatchObject({ status: 'invalid' });
    if (gradient.status === 'invalid') {
      expect(gradient.message).toContain('too far apart');
    }

    // A finite growth ratio can still overflow during exponentiation.
    const steep = calculateCagrExample(1, 1e300, 31);
    expect(steep).toMatchObject({ status: 'invalid' });
    if (steep.status === 'invalid') {
      expect(steep.message).toContain('finite CAGR');
    }
  });

  it('keeps a loss negative and a flat period at zero', () => {
    const loss = calculateCagrExample(100, 50, 730);
    const flat = calculateCagrExample(100, 100, 730);
    expect(loss.status).toBe('ok');
    expect(flat.status).toBe('ok');
    if (loss.status === 'ok') {
      expect(loss.totalReturnPct).toBeCloseTo(-50, 6);
      expect(loss.cagrPct).toBeLessThan(0);
    }
    if (flat.status === 'ok') {
      expect(flat.totalReturnPct).toBe(0);
      expect(flat.cagrPct).toBe(0);
    }
  });
});

describe('screener cutoff drill', () => {
  it('needs one more session than the window', () => {
    expect(screenWindowDrill(6)).toMatchObject({
      sessions: 6,
      required: 7,
      available: false,
      after: 6,
    });
    expect(screenWindowDrill(7)).toMatchObject({
      sessions: 7,
      required: 7,
      available: true,
      after: 5,
    });
    expect(screenWindowDrill(12)).toMatchObject({
      sessions: 12,
      required: 7,
      available: true,
      after: 0,
    });
  });

  it('keeps the cutoff inside the illustrated session range', () => {
    expect(screenWindowDrill(-3).sessions).toBe(0);
    expect(screenWindowDrill(99).sessions).toBe(12);
    expect(screenWindowDrill(8.4).sessions).toBe(8);
  });
});

describe('learning content', () => {
  it('has unique metric ids and a metric in every group', () => {
    const ids = LEARN_METRICS.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of LEARN_METRIC_GROUPS) {
      expect(LEARN_METRICS.some((metric) => metric.group === group.id)).toBe(true);
    }
    for (const metric of LEARN_METRICS) {
      expect(LEARN_METRIC_GROUPS.some((group) => group.id === metric.group)).toBe(true);
    }
  });

  it('has complete metric records', () => {
    for (const metric of LEARN_METRICS) {
      expect(metric.name.length).toBeGreaterThan(0);
      expect(metric.question.length).toBeGreaterThan(0);
      expect(metric.formula.length).toBeGreaterThan(0);
      expect(metric.inputs.length).toBeGreaterThan(0);
      expect(metric.conventions.length).toBeGreaterThan(0);
      expect(metric.withheld.length).toBeGreaterThan(0);
      expect(metric.appearsIn.length).toBeGreaterThan(0);
      for (const link of metric.appearsIn) {
        expect(link.to.startsWith('/')).toBe(true);
      }
    }
  });

  it('keeps section, step, case and route ids unique', () => {
    const sections = LEARN_SECTIONS.map((section) => section.id);
    const steps = LEARN_EXECUTION_STEPS.map((step) => step.id);
    const cases = LEARN_CASES.map((item) => item.id);
    const routes = LEARN_ROUTE.map((item) => item.to);
    expect(new Set(sections).size).toBe(sections.length);
    expect(new Set(steps).size).toBe(steps.length);
    expect(new Set(cases).size).toBe(cases.length);
    expect(new Set(routes).size).toBe(routes.length);
    for (const item of LEARN_ROUTE) expect(item.to.startsWith('/')).toBe(true);
  });

  it('points every fact at a real section', () => {
    const sections = new Set(LEARN_SECTIONS.map((section) => section.id));
    for (const fact of LEARN_FACTS) {
      expect(sections.has(fact.section)).toBe(true);
    }
  });

  it('has complete rule-check cases with one valid answer', () => {
    for (const item of LEARN_CASES) {
      expect(item.prompt.length).toBeGreaterThan(0);
      expect(item.options.length).toBeGreaterThanOrEqual(2);
      expect(item.options.some((option) => option.id === item.answerId)).toBe(true);
      expect(item.explanation.length).toBeGreaterThan(0);
      expect(new Set(item.options.map((option) => option.id)).size).toBe(item.options.length);
    }
  });

  it('lists Overview for annualised volatility before the Quant lab', () => {
    const volatility = LEARN_METRICS.find((metric) => metric.id === 'volatility');
    expect(volatility?.appearsIn[0]).toEqual({ label: 'Overview', to: '/' });
    expect(volatility?.appearsIn[1]).toEqual({ label: 'Quant lab', to: '/quant' });
  });

  it('states the four-session boundary for correlation and the floored loss wording', () => {
    const correlation = LEARN_METRICS.find((metric) => metric.id === 'correlation');
    const conventions = correlation?.conventions.join(' ') ?? '';
    expect(conventions).toContain('three shared returns');
    expect(conventions).toContain('four shared sessions');

    expect(
      LEARN_WITHHELD.some((entry) => entry.condition.includes('four shared sessions')),
    ).toBe(true);

    const var95 = LEARN_METRICS.find((metric) => metric.id === 'var95');
    const varConventions = var95?.conventions.join(' ') ?? '';
    expect(varConventions).toContain('floored at zero');
    expect(varConventions).not.toContain('positive loss');
  });

  it('does not use em or en dashes in user-facing content', () => {
    const all = stringsIn({
      LEARN_METRICS,
      LEARN_SECTIONS,
      LEARN_FACTS,
      LEARN_CASES,
      LEARN_EXECUTION_STEPS,
      LEARN_INDICATORS,
      LEARN_WITHHELD,
      LEARN_ROUTE,
    });
    const offenders = all.filter((value) => /[\u2013\u2014]/.test(value));
    expect(offenders).toEqual([]);
  });
});
