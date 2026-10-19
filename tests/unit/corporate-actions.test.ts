import { describe, expect, it } from 'vitest';
import type { Bar, CorporateAction } from '../../src/domain/types';
import {
  formatDividendAmount,
  formatSplitRatio,
  planCorporateActionMarkers,
} from '../../src/lib/corporate-actions';

function bars(...dates: string[]): Bar[] {
  return dates.map((date, index) => ({
    date,
    open: 10 + index,
    high: 11 + index,
    low: 9 + index,
    close: 10.5 + index,
    volume: 100,
  }));
}

describe('corporate-action labels', () => {
  it('formats forward and reverse split ratios', () => {
    expect(formatSplitRatio(4)).toBe('4:1 split');
    expect(formatSplitRatio(1.5)).toBe('1.5:1 split');
    expect(formatSplitRatio(0.1)).toBe('1:10 reverse split');
    expect(formatSplitRatio(0.5)).toBe('1:2 reverse split');
  });

  it('formats cash dividends with the instrument currency, never assuming one', () => {
    expect(formatDividendAmount(0.24, 'USD')).toBe('Div $0.24');
    expect(formatDividendAmount(0.24, 'EUR')).toBe('Div \u20ac0.24');
    expect(formatDividendAmount(0.24, 'CHF')).toBe('Div CHF 0.24');
    expect(formatDividendAmount(0.24, null)).toBe('Div 0.24');
  });
});

describe('planCorporateActionMarkers', () => {
  const actions: CorporateAction[] = [
    { date: '2024-01-03', type: 'split', value: 4 },
    { date: '2024-01-04', type: 'dividend', value: 0.24 },
    { date: '2024-01-05', type: 'dividend', value: 0.25 },
  ];

  it('marks only actions that fall on a displayed session and counts the rest', () => {
    const plan = planCorporateActionMarkers({
      actions,
      bars: bars('2024-01-02', '2024-01-03', '2024-01-04'),
      currency: 'USD',
    });

    expect(plan.markers).toEqual([
      { date: '2024-01-03', type: 'split', label: '4:1 split' },
      { date: '2024-01-04', type: 'dividend', label: 'Div $0.24' },
    ]);
    expect(plan.splits).toBe(1);
    expect(plan.dividends).toBe(1);
    expect(plan.unmatched).toBe(1);
    expect(plan.hasActions).toBe(true);
    expect(plan.note).toContain('Provider-reported corporate actions: 1 split, 1 cash dividend.');
    expect(plan.note).toContain('prices are split-adjusted');
    expect(plan.note).toContain('not reinvested');
    expect(plan.note).toContain('1 action date does not coincide with a displayed session');
  });

  it('states that no action was stored instead of implying one', () => {
    const plan = planCorporateActionMarkers({ actions: [], bars: bars('2024-01-02'), currency: 'USD' });
    expect(plan).toMatchObject({ markers: [], splits: 0, dividends: 0, unmatched: 0, hasActions: false, note: null });
  });

  it('does not snap an action to a neighbouring session', () => {
    const plan = planCorporateActionMarkers({
      actions: [{ date: '2024-01-06', type: 'split', value: 2 }],
      bars: bars('2024-01-05', '2024-01-08'),
    });
    expect(plan.markers).toEqual([]);
    expect(plan.unmatched).toBe(1);
    expect(plan.note).toContain('1 action date does not coincide');
  });

  it('orders markers by date and ignores invalid stored values defensively', () => {
    const plan = planCorporateActionMarkers({
      actions: [
        { date: '2024-01-05', type: 'dividend', value: 0.25 },
        { date: '2024-01-03', type: 'split', value: 2 },
        { date: '2024-01-04', type: 'dividend', value: 0 },
      ],
      bars: bars('2024-01-03', '2024-01-04', '2024-01-05'),
      currency: 'USD',
    });
    expect(plan.markers.map((marker) => marker.date)).toEqual(['2024-01-03', '2024-01-05']);
    expect(plan.splits + plan.dividends).toBe(2);
    expect(plan.unmatched).toBe(0);
  });
});
