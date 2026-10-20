import type { Bar, StrategyRule } from '../../domain/types';
import { closes, ema, rollingExtreme, sma } from '../indicators/core';
import type { Series } from '../indicators/core';
import { rsi } from '../indicators/momentum';
import { compare } from './compare';

/**
 * Precomputed indicator series shared by all strategy rules in one backtest.
 * Series are cached per (field, window) pair so a rule set with repeated windows
 * computes each series once.
 */
export class StrategyContext {
  readonly closes: number[];
  private readonly smaCache = new Map<number, Series>();
  private readonly emaCache = new Map<number, Series>();
  private readonly rsiCache = new Map<number, Series>();
  private readonly highestCache = new Map<number, Array<number | null>>();
  private readonly lowestCache = new Map<number, Array<number | null>>();
  private readonly macdCache = new Map<string, { macd: Series; signal: Series; histogram: Series }>();

  constructor(private readonly bars: readonly Bar[]) {
    this.closes = closes(bars);
  }

  get length(): number {
    return this.bars.length;
  }

  sma(period: number): Series {
    let series = this.smaCache.get(period);
    if (!series) {
      series = sma(this.closes, period);
      this.smaCache.set(period, series);
    }
    return series;
  }

  ema(period: number): Series {
    let series = this.emaCache.get(period);
    if (!series) {
      series = ema(this.closes, period);
      this.emaCache.set(period, series);
    }
    return series;
  }

  rsi(period: number): Series {
    let series = this.rsiCache.get(period);
    if (!series) {
      series = rsi(this.closes, period);
      this.rsiCache.set(period, series);
    }
    return series;
  }

  highestHigh(period: number): Array<number | null> {
    let series = this.highestCache.get(period);
    if (!series) {
      series = rollingExtreme(this.bars, period, 'high');
      this.highestCache.set(period, series);
    }
    return series;
  }

  lowestLow(period: number): Array<number | null> {
    let series = this.lowestCache.get(period);
    if (!series) {
      series = rollingExtreme(this.bars, period, 'low');
      this.lowestCache.set(period, series);
    }
    return series;
  }

  macd(fast: number, slow: number, signal: number): { macd: Series; signal: Series } {
    const key = `${fast}:${slow}:${signal}`;
    let cached = this.macdCache.get(key);
    if (!cached) {
      cached = this.macdAll(fast, slow, signal);
      this.macdCache.set(key, cached);
    }
    return { macd: cached.macd, signal: cached.signal };
  }

  private macdAll(fast: number, slow: number, signal: number) {
    const fastSeries = this.ema(fast);
    const slowSeries = this.ema(slow);
    const macdSeries: Series = this.closes.map((_, index) => {
      const f = fastSeries[index];
      const s = slowSeries[index];
      return f != null && s != null ? f - s : null;
    });
    // Signal line is an EMA of the MACD line, computed with the same seeded rule.
    const signalSeries: Series = new Array(this.closes.length).fill(null);
    const firstIdx = macdSeries.findIndex((value) => value !== null);
    if (firstIdx >= 0 && firstIdx + signal - 1 < macdSeries.length) {
      const alpha = 2 / (signal + 1);
      let seed = 0;
      for (let i = firstIdx; i < firstIdx + signal; i += 1) seed += macdSeries[i] as number;
      let previous = seed / signal;
      signalSeries[firstIdx + signal - 1] = previous;
      for (let i = firstIdx + signal; i < macdSeries.length; i += 1) {
        const value = macdSeries[i];
        if (value == null) {
          signalSeries[i] = null;
          continue;
        }
        previous = value * alpha + previous * (1 - alpha);
        signalSeries[i] = previous;
      }
    }
    const histogram: Series = macdSeries.map((value, index) => {
      const s = signalSeries[index];
      return value != null && s != null ? value - s : null;
    });
    return { macd: macdSeries, signal: signalSeries, histogram };
  }
}

/**
 * The warm-up index before which no rule can evaluate: the first index at which
 * the evaluator can produce a non-null current *and* previous value, computed
 * with the same defaults the evaluator uses (notably the derived slow period of
 * `sma-cross` and the derived slow/signal periods of `macd-cross`).
 */
export function requiredWarmup(rules: readonly StrategyRule[]): number {
  let max = 1;
  for (const rule of rules) max = Math.max(max, ruleWarmup(rule));
  return max;
}

function ruleWarmup(rule: StrategyRule): number {
  const window = Math.max(1, rule.window);
  switch (rule.field) {
    case 'price-vs-sma':
    case 'price-vs-ema':
      // Series first has a value at `window - 1`; the evaluator also reads the
      // previous bar, so the first fully computable index is `window`.
      return window;
    case 'rsi':
      return window + 1;
    case 'sma-cross': {
      const slow = Math.max(window, rule.secondaryWindow ?? window * 2);
      return slow;
    }
    case 'macd-cross': {
      // slow EMA = window * 2 + 2, signal EMA seed of `secondaryWindow ?? 9`.
      const slow = window * 2 + 2;
      const signal = Math.max(1, rule.secondaryWindow ?? 9);
      return slow + signal - 1;
    }
    case 'breakout-high':
    case 'breakout-low':
      // Needs the rolling extreme at `index - 1` and at `index - 2`.
      return window + 1;
  }
}

/**
 * Evaluates one rule at bar `index` (inclusive). Signals are computed from data
 * up to and including `index`; the engine executes at the next bar's open.
 */
export function evaluateRule(rule: StrategyRule, context: StrategyContext, index: number): boolean {
  if (index < 1) return false;
  const previousIndex = index - 1;
  switch (rule.field) {
    case 'price-vs-sma':
    case 'price-vs-ema': {
      const series = rule.field === 'price-vs-sma' ? context.sma(rule.window) : context.ema(rule.window);
      return compare(rule.operator, distancePct(context.closes[index], series[index]), distancePct(context.closes[previousIndex], series[previousIndex]), rule.value);
    }
    case 'sma-cross': {
      const fast = context.sma(rule.window);
      const slow = context.sma(rule.secondaryWindow ?? rule.window * 2);
      return compare(rule.operator, spread(fast[index], slow[index]), spread(fast[previousIndex], slow[previousIndex]), rule.value);
    }
    case 'rsi': {
      const series = context.rsi(rule.window);
      return compare(rule.operator, series[index] ?? null, series[previousIndex] ?? null, rule.value);
    }
    case 'macd-cross': {
      const secondary = rule.secondaryWindow ?? 9;
      const { macd, signal } = context.macd(rule.window, rule.window * 2 + 2, secondary);
      return compare(rule.operator, spread(macd[index], signal[index]), spread(macd[previousIndex], signal[previousIndex]), 0);
    }
    case 'breakout-high': {
      const highest = context.highestHigh(rule.window);
      const current = context.closes[index] != null && highest[previousIndex] != null ? context.closes[index]! - (highest[previousIndex] as number) : null;
      const previous = context.closes[previousIndex] != null && highest[previousIndex - 1] != null ? context.closes[previousIndex]! - (highest[previousIndex - 1] as number) : null;
      return compare(rule.operator, current, previous, 0);
    }
    case 'breakout-low': {
      const lowest = context.lowestLow(rule.window);
      const current = context.closes[index] != null && lowest[previousIndex] != null ? (lowest[previousIndex] as number) - context.closes[index]! : null;
      const previous = context.closes[previousIndex] != null && lowest[previousIndex - 1] != null ? (lowest[previousIndex - 1] as number) - context.closes[previousIndex]! : null;
      return compare(rule.operator, current, previous, 0);
    }
  }
}

function distancePct(close: number | undefined, level: number | null | undefined): number | null {
  if (close == null || level == null || level === 0) return null;
  return ((close - level) / level) * 100;
}

function spread(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

/** Combines several rules with AND/OR logic. */
export function evaluateRules(
  rules: readonly StrategyRule[],
  context: StrategyContext,
  index: number,
  logic: 'AND' | 'OR',
): boolean {
  if (rules.length === 0) return false;
  const results = rules.map((rule) => evaluateRule(rule, context, index));
  return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}
