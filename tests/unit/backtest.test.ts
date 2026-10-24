import { describe, it, expect } from 'vitest';
import type { BacktestConfig, Bar, StrategyRule } from '../../src/domain/types';
import { compare } from '../../src/lib/backtest/compare';
import { runBacktest } from '../../src/lib/backtest/engine';
import { RULE_FIELDS, describeStrategyRule, secondaryWindowValue } from '../../src/lib/backtest/rule-catalog';
import { StrategyContext, requiredWarmup } from '../../src/lib/backtest/rules';
import { addDays } from '../../src/lib/date';

function series(opens: readonly number[], closes: readonly number[]): Bar[] {
  return closes.map((close, index) => {
    const open = opens[index] as number;
    return {
      date: addDays('2024-01-01', index),
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: null,
    };
  });
}

function rule(field: StrategyRule['field'], operator: StrategyRule['operator'], value: number, window: number): StrategyRule {
  return { id: `${field}-${window}`, field, operator, value, window };
}

function config(entry: StrategyRule[], exit: StrategyRule[], overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    id: 'bt',
    name: 'test',
    datasetId: 'ds',
    startDate: null,
    endDate: null,
    initialCapital: 10_000,
    positionSizePct: 100,
    commissionBps: 10,
    slippageBps: 0,
    stopLossPct: null,
    takeProfitPct: null,
    entry,
    exit,
    entryLogic: 'AND',
    exitLogic: 'AND',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('compare cross semantics', () => {
  it('requires previous <= threshold and current > threshold to cross above', () => {
    expect(compare('crosses-above', 11, 10, 10)).toBe(true);
    expect(compare('crosses-above', 11, 11, 10)).toBe(false);
    expect(compare('crosses-above', 9, 8, 10)).toBe(false);
  });

  it('requires previous >= threshold and current < threshold to cross below', () => {
    expect(compare('crosses-below', 9, 10, 10)).toBe(true);
    expect(compare('crosses-below', 9, 9, 10)).toBe(false);
    expect(compare('crosses-below', 11, 10, 10)).toBe(false);
  });

  it('returns false when the previous value is null', () => {
    expect(compare('crosses-above', 11, null, 10)).toBe(false);
    expect(compare('crosses-below', 9, null, 10)).toBe(false);
  });

  it('returns false when the current value is null', () => {
    expect(compare('crosses-above', null, 9, 10)).toBe(false);
    expect(compare('gt', null, 9, 10)).toBe(false);
  });
});

// RSI(period 2) of this close path: [.,.,100,50,25,62.5,81.25,40.625,20.3125]
// so the entry rule (rsi > 60) first fires at index 5 and the exit rule (rsi < 60)
// fires at index 7, producing exactly one trade that fills on the next open.
const entry = rule('rsi', 'gt', 60, 2);
const exit = rule('rsi', 'lt', 60, 2);

describe('runBacktest execution', () => {
  it('fills an entry at the next bar open, charges costs, and exits on the signal', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit]));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0] as (typeof result.trades)[number];
    // Signal fired on the close of bar 5; the fill is at bar 6's open.
    expect(trade.entryDate).toBe(bars[6]?.date);
    expect(trade.entryPrice).toBe(12.5);
    // Exit signal fired on the close of bar 7; the fill is at bar 8's open.
    expect(trade.exitDate).toBe(bars[8]?.date);
    expect(trade.exitReason).toBe('signal');
    expect(trade.exitPrice).toBe(10);
  });

  it('makes net PnL smaller than gross PnL because of commissions', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 10 }));
    const trade = result.trades[0] as (typeof result.trades)[number];
    expect(trade.costs).toBeGreaterThan(0);
    expect(trade.netPnl).toBeLessThan(trade.grossPnl);
    expect(result.metrics.tradeCount).toBe(1);
  });

  it('applies slippage adversely so net PnL is below gross PnL', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 0, slippageBps: 10 }));
    const trade = result.trades[0] as (typeof result.trades)[number];
    // Buy pays more than the open, sell receives less than the open.
    expect(trade.entryPrice).toBeCloseTo(12.5 * 1.001, 10);
    expect(trade.exitPrice).toBeCloseTo(10 * 0.999, 10);
    expect(trade.netPnl).toBeLessThan(trade.grossPnl);
  });

  it('fills a stop gapped through at the session open, not the stop price', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12, 11, 9];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 9];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { stopLossPct: 5 }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0] as (typeof result.trades)[number];
    // Entered at bar 6 open 12; 5 percent stop = 11.4; bar 7 opens at 11, below
    // the stop, so a sell stop cannot fill at 11.4.
    expect(trade.entryPrice).toBe(12);
    expect(trade.exitDate).toBe(bars[7]?.date);
    expect(trade.exitReason).toBe('stop-loss');
    expect(trade.exitPrice).toBe(11);
    expect(trade.exitPrice).toBeLessThanOrEqual(opens[7] as number);
  });

  it('fills a stop touched intrabar at the stop when the session opens above it', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12, 11.5, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11.5, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { stopLossPct: 5 }));

    const trade = result.trades[0] as (typeof result.trades)[number];
    // Bar 7 opens at 11.5 (above the 11.4 stop) and trades down to 11.0.
    expect(trade.exitDate).toBe(bars[7]?.date);
    expect(trade.exitReason).toBe('stop-loss');
    expect(trade.exitPrice).toBeCloseTo(11.4, 10);
  });

  it('treats an open exactly at the stop as a fill at the stop', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12, 11.4, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11.4, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { stopLossPct: 5 }));

    const trade = result.trades[0] as (typeof result.trades)[number];
    expect(trade.exitReason).toBe('stop-loss');
    expect(trade.exitPrice).toBeCloseTo(11.4, 10);
  });

  it('does not stop out when the session low stays above the stop', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12, 12];
    const closes = [10, 11, 12, 11, 10, 11, 12, 12];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { stopLossPct: 5 }));

    const trade = result.trades[0] as (typeof result.trades)[number];
    // Bar 7 low is 11.5, above the 11.4 stop; data ends on that bar.
    expect(trade.exitReason).toBe('end-of-data');
    expect(trade.exitPrice).toBe(12);
  });

  it('labels a position still open at the final bar as end-of-data', () => {
    const opens = [10, 11, 12, 13, 14, 15, 16];
    const closes = [10, 11, 12, 13, 14, 15, 16];
    const bars = series(opens, closes);
    const never = rule('rsi', 'gt', 1000, 2);
    const result = runBacktest(bars, config([entry], [never]));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0] as (typeof result.trades)[number];
    expect(trade.entryDate).toBe(bars[4]?.date);
    expect(trade.entryPrice).toBe(14);
    expect(trade.exitDate).toBe(bars[6]?.date);
    expect(trade.exitReason).toBe('end-of-data');
    expect(trade.exitPrice).toBe(16);
    expect(trade.barsHeld).toBe(2);
  });

  it('returns an empty result for a window shorter than three bars', () => {
    const bars = series([10, 11], [10, 11]);
    const result = runBacktest(bars, config([entry], [exit]));
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
    expect(result.metrics.tradeCount).toBe(0);
  });

  it('fails closed when the warm-up is not shorter than the window', () => {
    // RSI(2) requires three warm-up bars, so a three-bar window has no bar left
    // on which a rule can evaluate. The engine must not dereference past the end.
    const bars = series([10, 11, 12], [10, 11, 12]);
    const result = runBacktest(bars, config([entry], [exit]));
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
    expect(result.metrics.tradeCount).toBe(0);
    // A curve-dependent metric has no value here; 0 would claim a flat, measured
    // result the engine never produced.
    expect(result.metrics.totalReturnPct).toBeNull();
    expect(result.metrics.annualisedVolatilityPct).toBeNull();
    expect(result.metrics.maxDrawdownPct).toBeNull();
    expect(result.metrics.exposurePct).toBeNull();
    expect(result.metrics.benchmarkTotalReturnPct).toBeNull();
  });

  it('withholds volatility when a two-point curve yields only one return', () => {
    // A one-session SMA needs one warm-up bar, so a three-bar window leaves two
    // equity points and a single return. Total return is measurable; a sample
    // deviation is not.
    const bars = series([10, 11, 12], [10, 11, 12]);
    const flat = rule('price-vs-sma', 'gt', -100, 1);
    const result = runBacktest(bars, config([flat], [flat]));
    expect(result.equityCurve).toHaveLength(2);
    expect(result.metrics.totalReturnPct).not.toBeNull();
    expect(result.metrics.annualisedVolatilityPct).toBeNull();
    expect(result.metrics.sharpe).toBeNull();
    expect(result.metrics.benchmarkTotalReturnPct).not.toBeNull();
  });

  it('includes exit slippage in costs so net PnL reconciles with gross PnL', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 10, slippageBps: 10 }));
    const trade = result.trades[0] as (typeof result.trades)[number];
    expect(trade.costs).toBeGreaterThan(0);
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.costs, 10);
  });

  it('sizes a full allocation so notional plus entry commission equals the cash committed', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 10 }));
    const trade = result.trades[0] as (typeof result.trades)[number];

    // 10 000 at 12.5 with a 10 bp entry commission: 10 000 / (12.5 * 1.001).
    const quantity = 10_000 / (12.5 * 1.001);
    expect(trade.quantity).toBeCloseTo(quantity, 10);
    expect(trade.quantity * trade.entryPrice * (1 + 0.001)).toBeCloseTo(10_000, 8);
    // No borrowing: after the fill cash is zero, so the entry-bar mark equals shares * close.
    const entryPoint = result.equityCurve.find((point) => point.date === trade.entryDate);
    expect(entryPoint?.equity).toBeCloseTo(quantity * 12, 8);
    expect(result.equityCurve.every((point) => point.equity >= 0)).toBe(true);
  });

  it('commits only the configured fraction of cash including the entry commission', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 10, positionSizePct: 50 }));
    const trade = result.trades[0] as (typeof result.trades)[number];

    const quantity = 5_000 / (12.5 * 1.001);
    expect(trade.quantity).toBeCloseTo(quantity, 10);
    const entryPoint = result.equityCurve.find((point) => point.date === trade.entryDate);
    // 5 000 of cash remains plus the marked value of the shares.
    expect(entryPoint?.equity).toBeCloseTo(5_000 + quantity * 12, 8);
  });

  it('reconciles the final equity with initial capital plus closed-trade net PnL', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12.5, 11, 10];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 10];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { commissionBps: 10, slippageBps: 10 }));
    const netPnl = result.trades.reduce((total, trade) => total + trade.netPnl, 0);
    const finalEquity = result.equityCurve[result.equityCurve.length - 1]?.equity;
    expect(finalEquity).toBeCloseTo(10_000 + netPnl, 8);
  });
});

describe('rule catalogue secondary labels and defaults', () => {
  it('labels the SMA cross second period as a slow window', () => {
    const field = RULE_FIELDS.find((entry) => entry.value === 'sma-cross');
    expect(field?.secondaryLabel).toBe('Slow SMA window');
  });

  it('labels the MACD second period as a signal window, not a slow window', () => {
    const field = RULE_FIELDS.find((entry) => entry.value === 'macd-cross');
    expect(field?.secondaryLabel).toBe('Signal window');
    const rule: StrategyRule = { id: 'macd', field: 'macd-cross', operator: 'crosses-above', value: 0, window: 12 };
    expect(secondaryWindowValue(rule)).toBe(9);
    expect(describeStrategyRule(rule)).toContain('(12, 26, 9)');
  });

  it('uses twice the window as the default slow SMA period', () => {
    const rule: StrategyRule = { id: 'sma', field: 'sma-cross', operator: 'crosses-above', value: 0, window: 20 };
    expect(secondaryWindowValue(rule)).toBe(40);
    expect(describeStrategyRule(rule)).toContain('40-session SMA');
  });

  it('returns no secondary period for a single-window rule', () => {
    const rule: StrategyRule = { id: 'rsi', field: 'rsi', operator: 'gt', value: 60, window: 14 };
    expect(secondaryWindowValue(rule)).toBeNull();
  });
});

describe('StrategyContext indicator caches', () => {
  it('keys the MACD cache by (fast, slow, signal)', () => {
    const closes = Array.from({ length: 40 }, (_, index) => 10 + index);
    const bars: Bar[] = closes.map((close, index) => ({
      date: addDays('2024-01-01', index),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: null,
    }));
    const context = new StrategyContext(bars);
    const first = context.macd(12, 26, 9);
    const second = context.macd(5, 10, 3);
    expect(second.macd).not.toBe(first.macd);
    expect(second.macd.some((value, index) => value !== first.macd[index])).toBe(true);
  });
});

describe('requiredWarmup', () => {
  it('matches the first index the evaluator can actually compute for each field', () => {
    expect(requiredWarmup([])).toBe(1);
    expect(requiredWarmup([rule('price-vs-sma', 'gt', 0, 50)])).toBe(50);
    expect(requiredWarmup([rule('rsi', 'lt', 30, 14)])).toBe(15);
    expect(requiredWarmup([rule('breakout-high', 'gt', 0, 20)])).toBe(21);
    expect(requiredWarmup([{ ...rule('sma-cross', 'gt', 0, 10), secondaryWindow: 30 }])).toBe(30);
    expect(requiredWarmup([rule('sma-cross', 'gt', 0, 10)])).toBe(20);
    expect(requiredWarmup([rule('macd-cross', 'gt', 0, 12)])).toBe(34);
    expect(requiredWarmup([{ ...rule('macd-cross', 'gt', 0, 12), secondaryWindow: 5 }])).toBe(30);
    expect(requiredWarmup([rule('rsi', 'lt', 30, 14), rule('breakout-low', 'lt', 0, 30)])).toBe(31);
  });

  it('agrees with the indicator series the evaluator reads', () => {
    const bars = series(
      Array.from({ length: 120 }, () => 10),
      Array.from({ length: 120 }, (_, index) => 10 + index * 0.5),
    );
    const context = new StrategyContext(bars);

    const fast = context.sma(10);
    const slow = context.sma(30);
    expect(slow[29]).not.toBeNull();
    expect(slow[28]).toBeNull();
    expect(fast[29]).not.toBeNull();

    const rsiSeries = context.rsi(14);
    expect(rsiSeries[14]).not.toBeNull();
    expect(rsiSeries[13]).toBeNull();

    const highest = context.highestHigh(20);
    expect(highest[19]).not.toBeNull();
    expect(highest[18]).toBeNull();

    const { signal } = context.macd(12, 26, 9);
    expect(signal[33]).not.toBeNull();
    expect(signal[32]).toBeNull();
  });
});

describe('backtest metric frequency', () => {
  const bars = series(
    [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
    [100, 102, 101, 104, 103, 106, 105, 108, 107, 110],
  );
  const base = config(
    [rule('price-vs-sma', 'gt', 0, 2)],
    [rule('price-vs-sma', 'lt', 0, 2)],
    { commissionBps: 0 },
  );

  it('annualises reported risk metrics with the requested frequency', () => {
    const daily = runBacktest(bars, base, 'daily');
    const weekly = runBacktest(bars, base, 'weekly');
    const monthly = runBacktest(bars, base, 'monthly');
    expect(daily.metrics.annualisedVolatilityPct).not.toBeNull();
    expect(weekly.metrics.annualisedVolatilityPct as number).toBeCloseTo(
      (daily.metrics.annualisedVolatilityPct as number) * Math.sqrt(52 / 252),
      8,
    );
    expect(monthly.metrics.annualisedVolatilityPct as number).toBeCloseTo(
      (daily.metrics.annualisedVolatilityPct as number) * Math.sqrt(12 / 252),
      8,
    );
  });

  it('keeps the default daily behaviour when no frequency is supplied', () => {
    expect(runBacktest(bars, base).metrics.annualisedVolatilityPct).toBeCloseTo(
      runBacktest(bars, base, 'daily').metrics.annualisedVolatilityPct as number,
      12,
    );
  });
});
