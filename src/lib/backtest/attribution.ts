/**
 * Descriptive trade-level attribution derived from an existing BacktestResult.
 *
 * Pure, deterministic, no mutation, no I/O. Does not modify the engine or metrics.
 * All results are descriptive of a historical run; nothing here predicts future performance.
 */
import type { BacktestResult, BacktestTrade } from '../../domain/types';

export type Unavailable = null;

export interface HoldingBucketDef {
  label: string;
  minBars: number;
  maxBars: number | null;
}

export const HOLDING_BUCKETS: readonly HoldingBucketDef[] = [
  { label: '1 bar', minBars: 0, maxBars: 1 },
  { label: '2-5 bars', minBars: 2, maxBars: 5 },
  { label: '6-20 bars', minBars: 6, maxBars: 20 },
  { label: '21+ bars', minBars: 21, maxBars: null },
];

export function bucketForBars(bars: number): HoldingBucketDef {
  for (const b of HOLDING_BUCKETS) {
    if (bars >= b.minBars && (b.maxBars === null || bars <= b.maxBars)) return b;
  }
  return HOLDING_BUCKETS[HOLDING_BUCKETS.length - 1] as HoldingBucketDef;
}

export interface ConcentrationSummary {
  tradeCount: number;
  totalNetPnl: number;
  top1SharePct: number | null;
  top3SharePct: number | null;
  top5SharePct: number | null;
  top10SharePct: number | null;
  largestTradeSharePct: number | null;
  /** Unavailable when total net PnL <= 0 (denominator invalid). */
  unavailableReason: string | null;
}

export interface HoldingBucketSummary {
  label: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  netPnl: number;
  winRatePct: number | null;
}

export interface HoldingPeriodSummary {
  tradeCount: number;
  minBars: number | null;
  maxBars: number | null;
  meanBars: number | null;
  medianBars: number | null;
  byBucket: HoldingBucketSummary[];
}

export interface CostDragSummary {
  totalCosts: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  costsPerTrade: number | null;
  costDragPct: number | null; // costs / grossProfit * 100, null if grossProfit <= 0
}

export interface DrawdownEpisode {
  startIndex: number;
  troughIndex: number;
  recoveryIndex: number | null; // null if unrecovered
  peakEquity: number;
  troughEquity: number;
  depthPct: number; // negative
  durationBars: number; // trough - start
  recoveryBars: number | null; // recovery - trough, null if unrecovered
}

export interface DrawdownEpisodeSummary {
  episodeCount: number;
  maxDepthPct: number | null;
  longestDurationBars: number | null;
  longestRecoveryBars: number | null;
  episodes: DrawdownEpisode[];
}

export interface AttributionSummary {
  concentration: ConcentrationSummary;
  holdingPeriod: HoldingPeriodSummary;
  costDrag: CostDragSummary;
  drawdownEpisodes: DrawdownEpisodeSummary;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return null;
  return (a + b) / 2;
}

function topShare(trades: BacktestTrade[], k: number, total: number): number | null {
  if (total <= 0 || trades.length === 0) return null;
  const sorted = [...trades].sort((a, b) => b.netPnl - a.netPnl);
  const top = sorted.slice(0, k).reduce((acc, t) => acc + t.netPnl, 0);
  return (top / total) * 100;
}

export function buildConcentration(trades: BacktestTrade[]): ConcentrationSummary {
  const tradeCount = trades.length;
  const totalNetPnl = trades.reduce((acc, t) => acc + t.netPnl, 0);
  const valid = totalNetPnl > 0;
  const reason = valid ? null : 'Total net profit is zero or negative, so a share of profit is not meaningful.';
  const largest = trades.length ? Math.max(...trades.map((t) => t.netPnl)) : 0;
  return {
    tradeCount,
    totalNetPnl,
    top1SharePct: valid ? topShare(trades, 1, totalNetPnl) : null,
    top3SharePct: valid ? topShare(trades, 3, totalNetPnl) : null,
    top5SharePct: valid ? topShare(trades, 5, totalNetPnl) : null,
    top10SharePct: valid ? topShare(trades, 10, totalNetPnl) : null,
    largestTradeSharePct: valid && largest > 0 ? (largest / totalNetPnl) * 100 : null,
    unavailableReason: reason,
  };
}

export function buildHoldingPeriod(trades: BacktestTrade[]): HoldingPeriodSummary {
  const bars = trades.map((t) => (Number.isFinite(t.barsHeld) ? t.barsHeld : 0));
  const tradeCount = trades.length;
  const minBars = tradeCount ? Math.min(...bars) : null;
  const maxBars = tradeCount ? Math.max(...bars) : null;
  const meanBars = tradeCount ? bars.reduce((a, b) => a + b, 0) / tradeCount : null;
  const medianBars = median(bars);

  const byBucket: HoldingBucketSummary[] = HOLDING_BUCKETS.map((def) => {
    const members = trades.filter((t) => {
      const b = Number.isFinite(t.barsHeld) ? t.barsHeld : 0;
      return b >= def.minBars && (def.maxBars === null || b <= def.maxBars);
    });
    const wins = members.filter((t) => t.netPnl > 0);
    const losses = members.filter((t) => t.netPnl < 0);
    const breakeven = members.filter((t) => t.netPnl === 0);
    const net = members.reduce((a, t) => a + t.netPnl, 0);
    return {
      label: def.label,
      tradeCount: members.length,
      winCount: wins.length,
      lossCount: losses.length,
      breakevenCount: breakeven.length,
      netPnl: net,
      winRatePct: members.length ? (wins.length / members.length) * 100 : null,
    };
  });

  return { tradeCount, minBars, maxBars, meanBars, medianBars, byBucket };
}

export function buildCostDrag(trades: BacktestTrade[]): CostDragSummary {
  const totalCosts = trades.reduce((a, t) => a + (Number.isFinite(t.costs) ? t.costs : 0), 0);
  const grossProfit = trades.filter((t) => t.netPnl > 0).reduce((a, t) => a + t.grossPnl, 0);
  // gross loss as positive
  const grossLoss = Math.abs(trades.filter((t) => t.netPnl < 0).reduce((a, t) => a + t.grossPnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const costsPerTrade = trades.length ? totalCosts / trades.length : null;
  const costDragPct = grossProfit > 0 ? (totalCosts / grossProfit) * 100 : null;
  return { totalCosts, grossProfit, grossLoss, netPnl, costsPerTrade, costDragPct };
}

export function buildDrawdownEpisodes(equityCurve: BacktestResult['equityCurve']): DrawdownEpisodeSummary {
  const episodes: DrawdownEpisode[] = [];
  if (!equityCurve || equityCurve.length === 0) {
    return { episodeCount: 0, maxDepthPct: null, longestDurationBars: null, longestRecoveryBars: null, episodes };
  }
  let i = 0;
  const n = equityCurve.length;
  while (i < n) {
    // find a peak followed by decline
    // find next index where drawdown < 0
    if (!(equityCurve[i]?.drawdown !== undefined && equityCurve[i]!.drawdown < 0)) {
      i += 1;
      continue;
    }
    // start = last index before decline where drawdown was 0 (or 0)
    let start = i;
    while (start > 0 && equityCurve[start - 1]!.drawdown < 0) start -= 1;
    // Actually start should be peak: walk back while drawdown<0? peak is where drawdown==0 before
    // Recompute start as first index of this contiguous negative run's preceding zero
    let s = i;
    while (s > 0 && equityCurve[s - 1]!.drawdown < 0) s -= 1;
    // peak index is s-1 if s>0 and drawdown 0 there; else s
    const peakIdx = s > 0 ? s - 1 : 0;
    // trough: min equity in run until recovery (drawdown back to 0) or end
    let troughIdx = s;
    let j = s;
    while (j < n && equityCurve[j]!.drawdown < 0) {
      if (equityCurve[j]!.equity < equityCurve[troughIdx]!.equity) troughIdx = j;
      j += 1;
    }
    const recoveryIdx = j < n ? j : null;
    const peakEquity = equityCurve[peakIdx]!.equity;
    const troughEquity = equityCurve[troughIdx]!.equity;
    const depthPct = peakEquity > 0 ? (troughEquity / peakEquity - 1) * 100 : 0;
    episodes.push({
      startIndex: peakIdx,
      troughIndex: troughIdx,
      recoveryIndex: recoveryIdx,
      peakEquity,
      troughEquity,
      depthPct,
      durationBars: troughIdx - peakIdx,
      recoveryBars: recoveryIdx !== null ? recoveryIdx - troughIdx : null,
    });
    i = recoveryIdx !== null ? recoveryIdx + 1 : n;
  }
  const maxDepthPct = episodes.length ? Math.min(...episodes.map((e) => e.depthPct)) : null;
  const longestDurationBars = episodes.length ? Math.max(...episodes.map((e) => e.durationBars)) : null;
  const longestRecoveryBars = episodes.length
    ? Math.max(...episodes.map((e) => (e.recoveryBars === null ? 0 : e.recoveryBars)))
    : null;
  // if no recovered episodes, longestRecovery null
  const hasRecovery = episodes.some((e) => e.recoveryBars !== null);
  return {
    episodeCount: episodes.length,
    maxDepthPct,
    longestDurationBars,
    longestRecoveryBars: hasRecovery ? longestRecoveryBars : null,
    episodes,
  };
}

export function buildAttribution(result: BacktestResult): AttributionSummary {
  return {
    concentration: buildConcentration(result.trades),
    holdingPeriod: buildHoldingPeriod(result.trades),
    costDrag: buildCostDrag(result.trades),
    drawdownEpisodes: buildDrawdownEpisodes(result.equityCurve),
  };
}