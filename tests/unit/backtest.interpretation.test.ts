import { describe, expect, it } from 'vitest';
import type { BacktestResult } from '../../src/domain/types';
import { interpretBacktest } from '../../src/lib/backtest/interpretation';

function makeMetrics(overrides: Partial<BacktestResult['metrics']> = {}): BacktestResult['metrics'] {
  return {
    totalReturnPct: 12.5,
    cagrPct: 9.2,
    annualisedVolatilityPct: 18.4,
    maxDrawdownPct: -8.3,
    sharpe: 0.67,
    tradeCount: 12,
    winRatePct: 58.33,
    profitFactor: 1.8,
    averageTradePct: 1.2,
    exposurePct: 42.5,
    benchmarkTotalReturnPct: 7.1,
    ...overrides,
  };
}

function interpret(overrides: Partial<BacktestResult['metrics']> = {}, sessionCount = 252) {
  return interpretBacktest({ metrics: makeMetrics(overrides), sessionCount, frequency: 'daily' });
}

function reading(result: ReturnType<typeof interpret>, id: string) {
  return result.readings.find((entry) => entry.id === id);
}

describe('interpretBacktest', () => {
  it('describes a positive window against buy-and-hold without claiming skill', () => {
    const result = interpret();

    expect(result.headline).toBe(
      'The strategy returned 12.50% over the window; buy-and-hold returned 7.10%.',
    );
    expect(reading(result, 'total-return')?.value).toBe('12.50%');
    expect(reading(result, 'total-return')?.reading).toContain('+5.40 percentage points');
    expect(reading(result, 'total-return')?.caveat).toContain('not evidence of skill');
    expect(result.caveats.join(' ')).toContain('do not establish statistical significance');
  });

  it('describes a losing window without treating it as proof either way', () => {
    const result = interpret({ totalReturnPct: -6.2, benchmarkTotalReturnPct: -2.1 });

    expect(result.headline).toBe(
      'The strategy lost 6.20% over the window; buy-and-hold lost 2.10%.',
    );
    expect(reading(result, 'total-return')?.reading).toContain('changed by -6.20%');
    expect(reading(result, 'total-return')?.reading).toContain('-4.10 percentage points');
    expect(reading(result, 'total-return')?.caveat).toContain('this window only');
  });

  it('explains every withheld value and the sample it rests on', () => {
    const result = interpret(
      {
        cagrPct: null,
        sharpe: null,
        tradeCount: 0,
        winRatePct: null,
        profitFactor: null,
        averageTradePct: null,
      },
      20,
    );

    expect(reading(result, 'cagr')?.value).toBe('Withheld');
    expect(reading(result, 'cagr')?.reading).toContain('30 days or less');
    expect(reading(result, 'sharpe')?.value).toBe('Withheld');
    expect(reading(result, 'sharpe')?.reading).toContain('fewer than two returns');
    expect(reading(result, 'win-rate')?.value).toBe('Withheld');
    expect(reading(result, 'profit-factor')?.value).toBe('Withheld');
    expect(reading(result, 'average-trade')?.value).toBe('Withheld');
    expect(result.sampleNote).toContain('No trades were closed');
    expect(result.sampleNote).toContain('Fewer than 60 sessions is a short window');
  });

  it('distinguishes an undefined profit factor from infinity', () => {
    const result = interpret({ tradeCount: 5, profitFactor: null });

    expect(reading(result, 'profit-factor')?.value).toBe('no losing trades');
    expect(reading(result, 'profit-factor')?.reading).toContain('not as infinity');
    expect(reading(result, 'profit-factor')?.reading).toContain('no losing trades');
  });

  it('states the trade sample and warns only when it is small', () => {
    const small = interpret({ tradeCount: 4, winRatePct: 50, profitFactor: 2 });
    expect(small.sampleNote).toContain('Fewer than 30 trades is a small sample');
    expect(reading(small, 'win-rate')?.caveat).toContain('fewer than 30 trades');

    const larger = interpret({ tradeCount: 40 });
    expect(larger.sampleNote).not.toContain('Fewer than 30 trades');
    expect(reading(larger, 'win-rate')?.caveat).toBeUndefined();
  });

  it('uses the dataset frequency for annualisation', () => {
    const daily = interpret();
    expect(daily.caveats.join(' ')).toContain('252 periods per year');
    expect(daily.caveats.join(' ')).toContain('daily dataset');

    const weekly = interpretBacktest({ metrics: makeMetrics(), sessionCount: 120, frequency: 'weekly' });
    expect(weekly.caveats.join(' ')).toContain('52 periods per year');
    expect(weekly.caveats.join(' ')).toContain('weekly dataset');

    const monthly = interpretBacktest({ metrics: makeMetrics(), sessionCount: 60, frequency: 'monthly' });
    expect(monthly.caveats.join(' ')).toContain('12 periods per year');
  });

  it('keeps Sharpe descriptive and never ranks returns', () => {
    const result = interpret();
    const sharpe = reading(result, 'sharpe');

    expect(sharpe?.value).toBe('0.67');
    expect(sharpe?.reading).toContain('risk-free rate fixed at zero');
    expect(sharpe?.reading).toContain('descriptive for this window');
    expect(sharpe?.caveat).toContain('not a significance test');

    const text = [result.headline, result.sampleNote, ...result.caveats, ...result.readings.flatMap((entry) => [entry.reading, entry.caveat ?? ''])]
      .join(' ')
      .toLowerCase();
    expect(text).not.toContain('outperform');
    expect(text).not.toContain('higher return is better');
    expect(text).not.toContain('statistically significant result');
  });
});
