import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Bar,
  DateString,
} from '../../domain/types';
import { maxDrawdownPct, TRADING_DAYS_PER_YEAR } from '../quant/metrics';
import { sampleStdDev, mean } from '../stats';
import { compareDates, yearsBetween } from '../date';
import { evaluateRules, requiredWarmup, StrategyContext } from './rules';

/**
 * Explicit execution assumptions.
 *
 * 1. Signals are evaluated on a bar's *close*; orders fill at the *next* bar's
 *    open. There is no same-bar fill and no look-ahead.
 * 2. Slippage is applied adversely to every fill: buys pay more, sells receive
 *    less. `slippageBps` is charged on entry and again on exit.
 * 3. Commission is charged on the traded notional at entry and at exit.
 * 4. Size is a fixed percentage of *current* equity, re-evaluated at entry, and
 *    the resulting share count is fractional (no lot-size rounding).
 * 5. If a bar's range touches both the stop and the target, the stop is assumed
 *    to fill first. This is the conservative assumption and is documented
 *    wherever the result is shown.
 * 6. Stop/target fills are approximated at the stop/target price (plus adverse
 *    slippage), not at the bar's open.
 * 7. A position still open at the final bar is closed at the last close and
 *    labelled `end-of-data`. No forward return is invented.
 * 8. The benchmark is a buy-and-hold of the same instrument over the same
 *    window, starting from the same initial capital, with no costs.
 */
export interface EngineOptions {
  bars: readonly Bar[];
  config: BacktestConfig;
}

interface OpenPosition {
  entryIndex: number;
  entryDate: DateString;
  entryPrice: number;
  quantity: number;
  stopPrice: number | null;
  targetPrice: number | null;
  entryCosts: number;
}

export function runBacktest(bars: readonly Bar[], config: BacktestConfig): BacktestResult {
  const windowBars = sliceWindow(bars, config.startDate, config.endDate);
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestResult['equityCurve'] = [];
  const initialCapital = config.initialCapital > 0 ? config.initialCapital : 10_000;

  if (windowBars.length < 3) {
    return {
      trades,
      equityCurve: [],
      metrics: emptyMetrics(),
    };
  }

  const context = new StrategyContext(windowBars);
  const warmup = Math.max(requiredWarmup([...config.entry, ...config.exit]), 1);
  const commissionRate = config.commissionBps / 10_000;
  const slippageRate = config.slippageBps / 10_000;
  const positionFraction = Math.max(0.01, Math.min(1, config.positionSizePct / 100));

  let cash = initialCapital;
  let position: OpenPosition | null = null;
  let pendingEntryIndex = -1;
  let pendingExitIndex = -1;
  let exposedBars = 0;
  const firstEquityDate = (windowBars[warmup] as Bar).date;
  const benchmarkBase = (windowBars[warmup] as Bar).close;

  for (let i = warmup; i < windowBars.length; i += 1) {
    const bar = windowBars[i] as Bar;

    // 1. Fill any order scheduled on this bar's open.
    if (position === null && pendingEntryIndex === i) {
      const entryPrice = bar.open * (1 + slippageRate);
      const equity = cash;
      const quantity = (equity * positionFraction) / entryPrice;
      if (quantity > 0) {
        const notional = quantity * entryPrice;
        const entryCommission = notional * commissionRate;
        cash -= notional + entryCommission;
        position = {
          entryIndex: i,
          entryDate: bar.date,
          entryPrice,
          quantity,
          stopPrice: config.stopLossPct != null ? entryPrice * (1 - config.stopLossPct / 100) : null,
          targetPrice: config.takeProfitPct != null ? entryPrice * (1 + config.takeProfitPct / 100) : null,
          entryCosts: entryCommission,
        };
      }
      pendingEntryIndex = -1;
    } else if (position !== null && pendingExitIndex === i) {
      cash = closePosition(position, bar.open, 'signal', commissionRate, slippageRate, trades, cash, i, bar.date);
      position = null;
      pendingExitIndex = -1;
    }

    // 2. Intrabar stop / take-profit (conservative: stop wins ties).
    if (position !== null) {
      const stop = position.stopPrice;
      const target = position.targetPrice;
      if (stop !== null && bar.low <= stop) {
        cash = closePosition(position, stop, 'stop-loss', commissionRate, slippageRate, trades, cash, i, bar.date);
        position = null;
        pendingExitIndex = -1;
      } else if (target !== null && bar.high >= target) {
        cash = closePosition(position, target, 'take-profit', commissionRate, slippageRate, trades, cash, i, bar.date);
        position = null;
        pendingExitIndex = -1;
      }
    }

    // 3. Evaluate signals at this bar's close and schedule the next open.
    if (position === null) {
      if (pendingEntryIndex < 0 && i + 1 < windowBars.length && evaluateRules(config.entry, context, i, config.entryLogic)) {
        pendingEntryIndex = i + 1;
      }
    } else if (pendingExitIndex < 0 && i + 1 < windowBars.length && evaluateRules(config.exit, context, i, config.exitLogic)) {
      pendingExitIndex = i + 1;
    }

    if (position !== null) exposedBars += 1;

    // 4. Mark-to-market equity for this bar's close.
    const markedEquity = position !== null ? cash + position.quantity * bar.close : cash;
    equityCurve.push({
      date: bar.date,
      equity: markedEquity,
      benchmark: initialCapital * (bar.close / benchmarkBase),
      drawdown: 0,
    });
  }

  // Close anything still open at the final close (no invented forward return).
  const lastBar = windowBars[windowBars.length - 1] as Bar;
  if (position !== null) {
    cash = closePosition(position, lastBar.close, 'end-of-data', commissionRate, slippageRate, trades, cash, windowBars.length - 1, lastBar.date);
    position = null;
    const point = equityCurve[equityCurve.length - 1];
    if (point) point.equity = cash;
  }

  applyDrawdown(equityCurve);

  return {
    trades,
    equityCurve,
    metrics: computeMetrics({
      trades,
      equityCurve,
      initialCapital,
      exposedBars,
      totalBars: equityCurve.length,
      firstDate: firstEquityDate,
      lastDate: lastBar.date,
    }),
  };
}

function sliceWindow(bars: readonly Bar[], startDate: DateString | null, endDate: DateString | null): Bar[] {
  return bars.filter((bar) => {
    if (startDate && compareDates(bar.date, startDate) < 0) return false;
    if (endDate && compareDates(bar.date, endDate) > 0) return false;
    return true;
  });
}

function closePosition(
  position: OpenPosition,
  rawPrice: number,
  reason: BacktestTrade['exitReason'],
  commissionRate: number,
  slippageRate: number,
  trades: BacktestTrade[],
  cash: number,
  exitIndex: number,
  exitDate: DateString,
): number {
  const exitPrice = rawPrice * (1 - slippageRate);
  const entryNotional = position.quantity * position.entryPrice;
  const exitNotional = position.quantity * exitPrice;
  const exitCommission = exitNotional * commissionRate;
  const proceeds = exitNotional - exitCommission;
  // Gross PnL ignores all costs; net PnL is proceeds minus the entry notional and
  // the entry commission that was already deducted from cash.
  const grossPnl = position.quantity * (rawPrice - position.entryPrice);
  const costs = position.entryCosts + exitCommission;
  const netPnl = proceeds - entryNotional - position.entryCosts;
  trades.push({
    entryDate: position.entryDate,
    entryPrice: position.entryPrice,
    exitDate,
    exitPrice,
    quantity: position.quantity,
    grossPnl,
    costs,
    netPnl,
    returnPct: entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0,
    barsHeld: exitIndex - position.entryIndex,
    exitReason: reason,
  });
  return cash + proceeds;
}

function applyDrawdown(curve: BacktestResult['equityCurve']): void {
  let peak = curve[0]?.equity ?? 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    point.drawdown = peak > 0 ? (point.equity / peak - 1) * 100 : 0;
  }
}

interface MetricInput {
  trades: BacktestTrade[];
  equityCurve: BacktestResult['equityCurve'];
  initialCapital: number;
  exposedBars: number;
  totalBars: number;
  firstDate: DateString;
  lastDate: DateString;
}

function computeMetrics(input: MetricInput): BacktestResult['metrics'] {
  const { trades, equityCurve, initialCapital } = input;
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const previous = equityCurve[i - 1] as { equity: number };
    const current = equityCurve[i] as { equity: number };
    if (previous.equity !== 0) dailyReturns.push(current.equity / previous.equity - 1);
  }

  const sd = sampleStdDev(dailyReturns);
  const annualisedVolatilityPct = sd === null ? 0 : sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  const meanReturn = mean(dailyReturns);
  const annualisedReturnPct = meanReturn === null ? null : meanReturn * TRADING_DAYS_PER_YEAR * 100;
  const sharpe =
    annualisedReturnPct === null || annualisedVolatilityPct === 0
      ? null
      : annualisedReturnPct / annualisedVolatilityPct;

  const years = yearsBetween(input.firstDate, input.lastDate);
  const cagrPct =
    years > 30 / 365.25 && finalEquity > 0
      ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100
      : null;

  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((acc, trade) => acc + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, trade) => acc + trade.netPnl, 0));

  const benchmarkStart = equityCurve[0];
  const benchmarkEnd = equityCurve[equityCurve.length - 1];
  const benchmarkTotalReturnPct =
    benchmarkStart && benchmarkEnd && benchmarkStart.benchmark !== 0
      ? (benchmarkEnd.benchmark / benchmarkStart.benchmark - 1) * 100
      : 0;

  return {
    totalReturnPct,
    cagrPct,
    annualisedVolatilityPct,
    maxDrawdownPct: maxDrawdownPct(equityCurve.map((point) => point.equity)) ?? 0,
    sharpe,
    tradeCount: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    averageTradePct: trades.length ? trades.reduce((acc, trade) => acc + trade.returnPct, 0) / trades.length : null,
    exposurePct: input.totalBars ? (input.exposedBars / input.totalBars) * 100 : 0,
    benchmarkTotalReturnPct,
  };
}

function emptyMetrics(): BacktestResult['metrics'] {
  return {
    totalReturnPct: 0,
    cagrPct: null,
    annualisedVolatilityPct: 0,
    maxDrawdownPct: 0,
    sharpe: null,
    tradeCount: 0,
    winRatePct: null,
    profitFactor: null,
    averageTradePct: null,
    exposurePct: 0,
    benchmarkTotalReturnPct: 0,
  };
}
