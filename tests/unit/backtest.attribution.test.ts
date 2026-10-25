import { describe, expect, it } from 'vitest';
import { buildAttribution } from '../../src/lib/backtest/attribution';
import type { BacktestResult, BacktestTrade } from '../../src/domain/types';

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    entryDate: '2024-01-01',
    entryPrice: 100,
    exitDate: '2024-01-05',
    exitPrice: 110,
    quantity: 1,
    grossPnl: 10,
    costs: 1,
    netPnl: 9,
    returnPct: 9,
    barsHeld: 4,
    exitReason: 'signal',
    ...overrides,
  };
}

function makeResult(trades: BacktestTrade[], equity: Array<{ date: string; equity: number; benchmark: number; drawdown: number }> = []): BacktestResult {
  return { trades, equityCurve: equity as BacktestResult['equityCurve'], metrics: {} as BacktestResult['metrics'] };
}

describe('attribution', () => {
  it('empty result yields null-safe empty states', () => {
    const a = buildAttribution(makeResult([]));
    expect(a.concentration.tradeCount).toBe(0);
    expect(a.concentration.totalNetPnl).toBe(0);
    expect(a.concentration.top1SharePct).toBeNull();
    expect(a.concentration.unavailableReason).not.toBeNull();
    expect(a.holdingPeriod.tradeCount).toBe(0);
    expect(a.costDrag.totalCosts).toBe(0);
    expect(a.drawdownEpisodes.episodeCount).toBe(0);
  });

  it('single winning trade concentration is 100%', () => {
    const a = buildAttribution(makeResult([makeTrade()]));
    expect(a.concentration.top1SharePct).toBe(100);
    expect(a.concentration.totalNetPnl).toBe(9);
  });

  it('zero total net profit makes concentration unavailable', () => {
    const t = makeTrade({ netPnl: 5, grossPnl: 6, costs: 1 });
    const t2 = makeTrade({ netPnl: -5, grossPnl: -4, costs: 1 });
    const a = buildAttribution(makeResult([t, t2]));
    expect(a.concentration.totalNetPnl).toBe(0);
    expect(a.concentration.top1SharePct).toBeNull();
  });

  it('negative aggregate keeps concentration unavailable', () => {
    const t = makeTrade({ netPnl: -5 });
    const a = buildAttribution(makeResult([t]));
    expect(a.concentration.unavailableReason).not.toBeNull();
  });

  it('cost drag computes costs per trade and drag pct', () => {
    const a = buildAttribution(makeResult([makeTrade({ costs: 2 }), makeTrade({ costs: 4 })]));
    expect(a.costDrag.totalCosts).toBe(6);
    expect(a.costDrag.costsPerTrade).toBe(3);
  });

  it('drawdown episodes detects one recovered episode', () => {
    const eq = [
      { date: '2024-01-01', equity: 100, benchmark: 100, drawdown: 0 },
      { date: '2024-01-02', equity: 90, benchmark: 100, drawdown: -0.1 },
      { date: '2024-01-03', equity: 80, benchmark: 100, drawdown: -0.2 },
      { date: '2024-01-04', equity: 100, benchmark: 100, drawdown: 0 },
    ];
    const a = buildAttribution(makeResult([], eq as BacktestResult['equityCurve']));
    expect(a.drawdownEpisodes.episodeCount).toBe(1);
    expect(a.drawdownEpisodes.episodes[0]?.recoveryBars).not.toBeNull();
  });

  it('unrecovered final drawdown has null recovery', () => {
    const eq = [
      { date: '2024-01-01', equity: 100, benchmark: 100, drawdown: 0 },
      { date: '2024-01-02', equity: 90, benchmark: 100, drawdown: -0.1 },
    ];
    const a = buildAttribution(makeResult([], eq as BacktestResult['equityCurve']));
    expect(a.drawdownEpisodes.episodeCount).toBe(1);
    expect(a.drawdownEpisodes.episodes[0]?.recoveryBars).toBeNull();
  });

  it('holding buckets assign boundary correctly', () => {
    const t1 = makeTrade({ barsHeld: 1 });
    const t2 = makeTrade({ barsHeld: 5 });
    const t3 = makeTrade({ barsHeld: 21 });
    const a = buildAttribution(makeResult([t1, t2, t3]));
    const b1 = a.holdingPeriod.byBucket.find((b) => b.label === '1 bar');
    const b2 = a.holdingPeriod.byBucket.find((b) => b.label === '2-5 bars');
    const b4 = a.holdingPeriod.byBucket.find((b) => b.label === '21+ bars');
    expect(b1?.tradeCount).toBe(1);
    expect(b2?.tradeCount).toBe(1);
    expect(b4?.tradeCount).toBe(1);
  });

  it('does not mutate input', () => {
    const trades = [makeTrade()];
    const before = JSON.stringify(trades);
    buildAttribution(makeResult(trades));
    expect(JSON.stringify(trades)).toBe(before);
  });
});