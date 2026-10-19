import { describe, it, expect } from 'vitest';
import type { BacktestConfig, Bar, StrategyRule } from '../../src/domain/types';
import { compare } from '../../src/lib/backtest/compare';
import { runBacktest } from '../../src/lib/backtest/engine';
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

  it('labels a stop-loss exit and fills it at the stop price', () => {
    const opens = [10, 11, 12, 11, 10, 11, 12, 11, 9];
    const closes = [10, 11, 12, 11, 10, 11, 12, 11, 9];
    const bars = series(opens, closes);
    const result = runBacktest(bars, config([entry], [exit], { stopLossPct: 5 }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0] as (typeof result.trades)[number];
    // Entered at bar 6 open 12; 5 percent stop = 11.4; bar 7 low is 10.5.
    expect(trade.entryPrice).toBe(12);
    expect(trade.exitDate).toBe(bars[7]?.date);
    expect(trade.exitReason).toBe('stop-loss');
    expect(trade.exitPrice).toBeCloseTo(11.4, 10);
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
});
