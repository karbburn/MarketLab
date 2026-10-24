/**
 * Plain-language readings for the metrics a backtest actually produced.
 *
 * The engine remains the only source of numbers. This module describes those
 * numbers, states why a value is withheld, and adds sample-size and
 * future-uncertainty caveats. It deliberately avoids ranking language: a larger
 * return is not described as better, and no result is called significant.
 */

import type { BacktestResult, Frequency } from '../../domain/types';
import { formatPercent, formatSignedPercent } from '../format';
import { periodsPerYear } from '../quant/metrics';

export interface MetricReading {
  id: string;
  label: string;
  value: string;
  reading: string;
  caveat?: string;
}

export interface Interpretation {
  headline: string;
  sampleNote: string;
  readings: MetricReading[];
  caveats: string[];
}

export interface InterpretationInput {
  metrics: BacktestResult['metrics'];
  /**
   * Sessions the equity curve and trade metrics cover, i.e. after indicator
   * warm-up, not the number of sessions stored in the window.
   */
  sessionCount: number;
  frequency: Frequency;
}

function signedPoints(value: number): string {
  if (value === 0) return '0.00 percentage points';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} percentage points`;
}

function withheldValue(): string {
  return 'Withheld';
}

export function interpretBacktest(input: InterpretationInput): Interpretation {
  const { metrics, sessionCount, frequency } = input;
  const periods = periodsPerYear(frequency);
  const hasCurve = metrics.totalReturnPct !== null && metrics.benchmarkTotalReturnPct !== null;
  const difference = hasCurve
    ? (metrics.totalReturnPct as number) - (metrics.benchmarkTotalReturnPct as number)
    : null;
  const strategyDirection = (metrics.totalReturnPct ?? 0) >= 0 ? 'returned' : 'lost';
  const benchmarkDirection = (metrics.benchmarkTotalReturnPct ?? 0) >= 0 ? 'returned' : 'lost';

  const headline = hasCurve
    ? `The strategy ${strategyDirection} ${formatPercent(Math.abs(metrics.totalReturnPct as number))} over the window; ` +
      `buy-and-hold ${benchmarkDirection} ${formatPercent(Math.abs(metrics.benchmarkTotalReturnPct as number))}.`
    : 'No equity curve was produced, so return, drawdown, volatility and exposure are withheld.';

  const readings: MetricReading[] = [
    {
      id: 'total-return',
      label: 'Total return',
      value: metrics.totalReturnPct === null ? withheldValue() : formatPercent(metrics.totalReturnPct),
      reading:
        metrics.totalReturnPct === null || metrics.benchmarkTotalReturnPct === null
          ? 'Total return is withheld because the engine could not simulate an equity curve over this window. ' +
            'No zero is reported in its place.'
          : `The simulated equity changed by ${formatSignedPercent(metrics.totalReturnPct)} from the initial capital. ` +
            `Buy-and-hold of the same series changed by ${formatSignedPercent(metrics.benchmarkTotalReturnPct)} over the same window. ` +
            `The difference is ${signedPoints(difference as number)}.`,
      caveat: hasCurve
        ? 'The difference describes this window only. It is not evidence of skill, persistence or a repeatable edge.'
        : undefined,
    },
    {
      id: 'cagr',
      label: 'CAGR',
      value: metrics.cagrPct === null ? withheldValue() : formatPercent(metrics.cagrPct),
      reading:
        metrics.cagrPct === null
          ? 'CAGR is withheld because the window spans 30 days or less, where annualising would exaggerate the result.'
          : `The compound annual growth rate is ${formatPercent(metrics.cagrPct)}, the constant yearly rate that would turn the initial capital into the final equity over this window.`,
      caveat:
        metrics.cagrPct === null
          ? undefined
          : 'It is a summary of this window, not a forecast of the next year.',
    },
    {
      id: 'max-drawdown',
      label: 'Max drawdown',
      value: metrics.maxDrawdownPct === null ? withheldValue() : formatPercent(metrics.maxDrawdownPct),
      reading:
        metrics.maxDrawdownPct === null
          ? 'Max drawdown is withheld because the engine could not simulate an equity curve over this window.'
          : `The deepest close-to-close decline from a running equity peak was ${formatPercent(
              Math.abs(metrics.maxDrawdownPct),
            )}.`,
      caveat: metrics.maxDrawdownPct === null ? undefined : 'A positive total return can still include this loss along the way.',
    },
    {
      id: 'volatility',
      label: 'Volatility',
      value:
        metrics.annualisedVolatilityPct === null ? withheldValue() : formatPercent(metrics.annualisedVolatilityPct),
      reading:
        metrics.annualisedVolatilityPct === null
          ? `Annualised volatility is withheld because ${sessionCount} evaluated session${
              sessionCount === 1 ? '' : 's'
            } produced fewer than two equity returns to measure a sample deviation from.`
          : `Annualised volatility is ${formatPercent(
              metrics.annualisedVolatilityPct,
            )}, calculated from ${sessionCount} session marks at the dataset frequency. It measures the size of the swings, not their direction.`,
      caveat: `Annualisation assumes ${periods} periods per year for a ${frequency} dataset.`,
    },
    {
      id: 'sharpe',
      label: 'Sharpe',
      value: metrics.sharpe === null ? withheldValue() : metrics.sharpe.toFixed(2),
      reading:
        metrics.sharpe === null
          ? 'Sharpe is withheld because there are fewer than two returns, or because annualised volatility is zero.'
          : `Sharpe is ${metrics.sharpe.toFixed(
              2,
            )}: arithmetic annualised return per unit of annualised volatility, with the risk-free rate fixed at zero. It is descriptive for this window and is sensitive to the sample period and return frequency.`,
      caveat:
        metrics.sharpe === null
          ? undefined
          : 'It is not a significance test, and a larger value is not by itself evidence of a better strategy.',
    },
    {
      id: 'trades',
      label: 'Trades',
      value: String(metrics.tradeCount),
      reading:
        metrics.tradeCount === 0
          ? 'No trades were closed, so there are no trade-level outcomes to describe.'
          : `${metrics.tradeCount} closed trade${metrics.tradeCount === 1 ? '' : 's'} form the sample behind the trade-level readings below.`,
    },
    {
      id: 'win-rate',
      label: 'Win rate',
      value: metrics.winRatePct === null ? withheldValue() : formatPercent(metrics.winRatePct),
      reading:
        metrics.winRatePct === null
          ? 'There is no win rate because no trades were closed.'
          : `${formatPercent(metrics.winRatePct)} of the ${metrics.tradeCount} closed trade${
              metrics.tradeCount === 1 ? '' : 's'
            } had positive net profit and loss.`,
      caveat:
        metrics.winRatePct !== null && metrics.tradeCount < 30
          ? 'With fewer than 30 trades, one or two outcomes can move this percentage substantially.'
          : undefined,
    },
    {
      id: 'profit-factor',
      label: 'Profit factor',
      value:
        metrics.profitFactor === null
          ? metrics.tradeCount > 0
            ? 'no losing trades'
            : withheldValue()
          : metrics.profitFactor.toFixed(2),
      reading:
        metrics.profitFactor === null
          ? metrics.tradeCount > 0
            ? 'Profit factor is undefined because there were no losing trades. It is shown as "no losing trades", not as infinity.'
            : 'Profit factor is undefined because no trades were closed.'
          : `Gross profits were ${metrics.profitFactor.toFixed(2)} times gross losses across the closed trades.`,
    },
    {
      id: 'average-trade',
      label: 'Average trade',
      value: metrics.averageTradePct === null ? withheldValue() : formatPercent(metrics.averageTradePct),
      reading:
        metrics.averageTradePct === null
          ? 'There is no average trade because no trades were closed.'
          : `The mean net return per closed trade was ${formatPercent(metrics.averageTradePct)}.`,
      caveat:
        metrics.averageTradePct === null
          ? undefined
          : 'It is an average, so a few large trades can dominate the figure.',
    },
    {
      id: 'exposure',
      label: 'Exposure',
      value: metrics.exposurePct === null ? withheldValue() : formatPercent(metrics.exposurePct),
      reading:
        metrics.exposurePct === null
          ? 'Exposure is withheld because the engine could not simulate any evaluated session over this window.'
          : `The strategy held a position on ${formatPercent(
              metrics.exposurePct,
            )} of the sessions. The remaining sessions are flat apart from any costs already paid.`,
    },
  ];

  const sampleParts: string[] = [
    `This run covers ${sessionCount} evaluated session${sessionCount === 1 ? '' : 's'} and ${metrics.tradeCount} closed trade${
      metrics.tradeCount === 1 ? '' : 's'
    }.`,
  ];
  if (metrics.tradeCount === 0) {
    sampleParts.push('No trades were closed, so every trade-level reading is withheld.');
  } else if (metrics.tradeCount < 30) {
    sampleParts.push(
      'Fewer than 30 trades is a small sample; win rate, profit factor and average trade can change substantially with one or two outcomes.',
    );
  }
  if (sessionCount > 0 && sessionCount < 60) {
    sampleParts.push(
      'Fewer than 60 sessions is a short window; annualised figures are especially sensitive to a few large moves.',
    );
  }

  const caveats = [
    'Past behaviour on one instrument over one window is not a forecast. These results do not establish statistical significance.',
    'The numbers assume the fills, costs, sizing and long-only rules described in the execution model. Different assumptions would change them.',
    'Only long positions are simulated. Short selling is not modelled.',
    'Metrics are recomputed from the current stored dataset. A saved research run keeps the values recorded when it was saved.',
    `Volatility and Sharpe are annualised with ${periods} periods per year for a ${frequency} dataset; exposure is the share of evaluated sessions holding a position, not an annualised figure.`,
  ];

  return {
    headline,
    sampleNote: sampleParts.join(' '),
    readings,
    caveats,
  };
}
