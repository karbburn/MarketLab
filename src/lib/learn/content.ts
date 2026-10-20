/**
 * Text and lookup data for the learning page.
 *
 * Kept free of React so the content can be checked in unit tests (unique ids,
 * valid routes, no em or en dashes) without rendering the page.
 */

export type LearnMetricGroup = 'return' | 'risk' | 'comparison';

export const LEARN_METRIC_GROUPS: ReadonlyArray<{ id: LearnMetricGroup; label: string }> = [
  { id: 'return', label: 'Return' },
  { id: 'risk', label: 'Risk' },
  { id: 'comparison', label: 'Comparison' },
];

export interface LearnMetricLink {
  label: string;
  to: string;
}

export interface LearnMetric {
  id: string;
  group: LearnMetricGroup;
  name: string;
  question: string;
  formula: string;
  inputs: string;
  conventions: readonly string[];
  withheld: string;
  appearsIn: readonly LearnMetricLink[];
}

export interface LearnFact {
  value: string;
  label: string;
  section: string;
}

export interface LearnCaseOption {
  id: string;
  label: string;
}

export interface LearnCase {
  id: string;
  prompt: string;
  options: readonly LearnCaseOption[];
  answerId: string;
  explanation: string;
}

export const LEARN_METRICS: readonly LearnMetric[] = [
  {
    id: 'total-return',
    group: 'return',
    name: 'Total return',
    question: 'How much did the stored period change?',
    formula: 'totalReturnPct = (lastClose / firstClose - 1) * 100',
    inputs: 'The first and last close in the selected series.',
    conventions: [
      'A simple percentage change, not a log return.',
      'MarketLab adds no dividends, fees or taxes.',
      'Price adjustment already present in the stored bars is kept as-is.',
    ],
    withheld: 'A zero first close, or an empty series.',
    appearsIn: [
      { label: 'Overview', to: '/' },
      { label: 'Quant lab', to: '/quant' },
    ],
  },
  {
    id: 'cagr',
    group: 'return',
    name: 'CAGR',
    question: 'What constant yearly rate connects the first and last close?',
    formula: 'CAGR = ((lastClose / firstClose) ^ (1 / years) - 1) * 100\nyears = calendarDays / 365.25',
    inputs: 'The first and last close, plus the calendar dates between them.',
    conventions: [
      'Uses calendar years, not 252-session years.',
      'A 20% gain in six months is not a 20% annual return.',
      'Withheld when the span is 30 calendar days or less.',
    ],
    withheld: 'A span of 30 days or less, a zero first close, or a non-positive growth ratio.',
    appearsIn: [
      { label: 'Overview', to: '/' },
      { label: 'Quant lab', to: '/quant' },
    ],
  },
  {
    id: 'volatility',
    group: 'risk',
    name: 'Annualised volatility',
    question: 'How wide are the daily moves, scaled to a year?',
    formula: 'annualisedVolatilityPct = sampleStdDev(dailyReturns) * sqrt(252) * 100',
    inputs: 'Simple close-to-close daily returns.',
    conventions: [
      'Sample standard deviation, with n - 1 in the denominator.',
      '252 sessions per year, regardless of the calendar span.',
      'Up and down moves count as risk in the same way.',
    ],
    withheld: 'Fewer than two returns.',
    appearsIn: [
      { label: 'Overview', to: '/' },
      { label: 'Quant lab', to: '/quant' },
      { label: 'Screener', to: '/screener' },
      { label: 'Backtest', to: '/backtest' },
    ],
  },
  {
    id: 'sharpe',
    group: 'risk',
    name: 'Sharpe ratio',
    question: 'How much return is there per unit of volatility?',
    formula: 'Sharpe = (mean(dailyReturns) * 252) / (sampleStdDev(dailyReturns) * sqrt(252))',
    inputs: 'Daily simple returns.',
    conventions: [
      'The risk-free rate is fixed at zero.',
      'Uses arithmetic annualised return, not CAGR.',
      'A zero annualised volatility produces no value.',
    ],
    withheld: 'Fewer than two returns, or zero volatility.',
    appearsIn: [
      { label: 'Quant lab', to: '/quant' },
      { label: 'Backtest', to: '/backtest' },
    ],
  },
  {
    id: 'sortino',
    group: 'risk',
    name: 'Sortino ratio',
    question: 'How much return is there per unit of downside?',
    formula:
      'Sortino = (mean(dailyReturns) * 252) / downsideDeviation\ndownsideDeviation = sqrt(sum(min(r, 0)^2) / n) * sqrt(252)',
    inputs: 'Daily simple returns.',
    conventions: [
      'The target return is fixed at zero.',
      'Shortfalls are squared over all observations, not only losing days.',
      'A flat or rising series can still have zero downside deviation.',
    ],
    withheld: 'No returns, or zero downside deviation.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'max-drawdown',
    group: 'risk',
    name: 'Maximum drawdown',
    question: 'What was the worst close-to-close decline from a peak?',
    formula: 'drawdown_t = (close_t / runningPeak_t - 1) * 100\nmaxDrawdownPct = min(drawdown_t)',
    inputs: 'The close series, or the equity curve in a backtest.',
    conventions: [
      'Close-to-close only. An intraday low is not used.',
      'The running peak starts at the first close.',
      'The result is negative or zero.',
    ],
    withheld: 'An empty series.',
    appearsIn: [
      { label: 'Overview', to: '/' },
      { label: 'Quant lab', to: '/quant' },
      { label: 'Screener', to: '/screener' },
      { label: 'Backtest', to: '/backtest' },
    ],
  },
  {
    id: 'ulcer',
    group: 'risk',
    name: 'Ulcer index',
    question: 'How much time was spent below the peak, and how deep was it?',
    formula: 'Ulcer = sqrt(mean(drawdown_t^2))',
    inputs: 'Percentage close-to-close drawdowns.',
    conventions: [
      'Uses the same close-only drawdown series as maximum drawdown.',
      'Deeper and longer drawdowns both raise the value.',
      'Reported in percentage points.',
    ],
    withheld: 'An empty series.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'calmar',
    group: 'risk',
    name: 'Calmar ratio',
    question: 'How much annual return came with each point of drawdown?',
    formula: 'Calmar = CAGR / abs(maxDrawdownPct)',
    inputs: 'CAGR, which uses calendar years, and close-to-close max drawdown.',
    conventions: [
      'CAGR is annualised over the calendar span.',
      'The drawdown denominator is the absolute value of a negative number.',
      'A zero drawdown gives no value rather than infinity.',
    ],
    withheld: 'A span of 30 days or less, or a zero drawdown.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'var95',
    group: 'risk',
    name: 'VaR 95',
    question: 'What one-session loss was exceeded in only 5% of observed sessions?',
    formula: 'VaR95 = max(0, -quantile(dailyReturns, 0.05)) * 100',
    inputs: 'Daily simple returns.',
    conventions: [
      'Historical, not normal-distribution VaR.',
      'A one-session horizon.',
      'Reported as a non-negative loss percentage, floored at zero.',
      'At least 20 returns are required.',
    ],
    withheld: 'Fewer than 20 returns.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'cvar95',
    group: 'risk',
    name: 'CVaR 95',
    question: 'When the 5% tail happened, how bad was it on average?',
    formula: 'CVaR95 = max(0, -mean(returns <= VaR threshold)) * 100',
    inputs: 'Daily simple returns and the historical VaR threshold.',
    conventions: [
      'Historical expected shortfall, not a fitted model.',
      'The mean of observed tail returns, not an extrapolation.',
      'At least 20 returns are required.',
    ],
    withheld: 'Fewer than 20 returns.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'rebased-100',
    group: 'comparison',
    name: 'Rebased index of 100',
    question: 'How did two series move relative to the same starting point?',
    formula: 'index_t = (close_t / firstSharedClose) * 100',
    inputs: 'Closes on the dates every selected series shares.',
    conventions: [
      'The first session shared by every compared series is 100.',
      'No forward fill and no interpolation.',
      'The chart needs at least two shared sessions before it draws an overlay.',
      'Panning the view does not move the baseline. Changing the timeframe can.',
    ],
    withheld: 'No shared sessions, fewer than two shared sessions, or a non-positive baseline.',
    appearsIn: [{ label: 'Chart workspace', to: '/chart' }],
  },
  {
    id: 'normalised-performance',
    group: 'comparison',
    name: 'Normalised performance',
    question: 'How far has each series moved from the first shared close?',
    formula: 'normalised_t = (close_t / firstSharedClose - 1) * 100',
    inputs: 'Closes on the dates every selected series shares.',
    conventions: [
      'The first shared close is 0%. A move to +10% is 10% above it.',
      'No forward fill and no interpolation.',
      'The Quant lab plots percentage change; the chart overlay instead rebases to 100.',
    ],
    withheld: 'No shared sessions, or a non-positive first shared close.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'beta',
    group: 'comparison',
    name: 'Beta',
    question: 'How much did the series move when the benchmark moved?',
    formula: 'beta = covariance(assetReturns, benchmarkReturns) / variance(benchmarkReturns)',
    inputs: 'Daily simple returns on shared sessions.',
    conventions: [
      'Pearson covariance, not a regression with an intercept.',
      'Only dates present in both series are used.',
      'Zero benchmark variance produces no value.',
    ],
    withheld: 'No benchmark, fewer than two shared returns, or zero benchmark variance.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
  {
    id: 'alpha',
    group: 'comparison',
    name: 'Alpha',
    question: 'What return is left after accounting for benchmark exposure?',
    formula: 'alphaPct = (mean(assetReturns) - beta * mean(benchmarkReturns)) * 252 * 100',
    inputs: 'Aligned daily returns and the computed beta.',
    conventions: [
      'Annualised arithmetic alpha.',
      'The risk-free rate is fixed at zero.',
      'A beta from a short overlap is still just a beta from that overlap.',
      'The metric grid shows beta; R squared appears in its note.',
    ],
    withheld: 'No benchmark, fewer than two shared returns, or a missing beta.',
    appearsIn: [{ label: 'Quant lab method notes', to: '/quant' }],
  },
  {
    id: 'correlation',
    group: 'comparison',
    name: 'Correlation',
    question: 'Did the two series move together on the sessions they share?',
    formula: 'rho = pearsonCorrelation(assetReturns, benchmarkReturns)',
    inputs: 'Daily simple returns on shared sessions.',
    conventions: [
      'Pearson correlation, from -1 to 1.',
      'Needs three shared returns, which means four shared sessions.',
      'Only shared dates. Nothing is filled.',
      'Correlation does not imply causation.',
    ],
    withheld: 'Fewer than three shared returns, or a constant return series.',
    appearsIn: [{ label: 'Quant lab', to: '/quant' }],
  },
];

export const LEARN_SECTIONS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'stored', title: 'What is stored' },
  { id: 'returns', title: 'Returns' },
  { id: 'risk', title: 'Risk' },
  { id: 'comparison', title: 'Comparison' },
  { id: 'screening', title: 'Screens' },
  { id: 'execution', title: 'Backtests' },
  { id: 'indicators', title: 'Indicators' },
  { id: 'reference', title: 'Metric reference' },
  { id: 'blanks', title: 'Blank results' },
  { id: 'rule-check', title: 'Check the rule' },
  { id: 'route', title: 'A route through the app' },
];

export const LEARN_FACTS: readonly LearnFact[] = [
  {
    value: '252',
    label: 'sessions used to annualise volatility',
    section: 'returns',
  },
  {
    value: '0%',
    label: 'risk-free rate in Sharpe and alpha',
    section: 'risk',
  },
  {
    value: 'Close',
    label: 'price basis for returns and drawdown',
    section: 'risk',
  },
  {
    value: 'Shared',
    label: 'dates required for a comparison',
    section: 'comparison',
  },
];

export interface LearnExecutionStep {
  id: string;
  label: string;
  title: string;
  body: string;
  rule: string;
}

export const LEARN_EXECUTION_STEPS: readonly LearnExecutionStep[] = [
  {
    id: 'signal',
    label: 'Signal',
    title: 'The rule reads the close',
    body: 'Entry and exit rules are evaluated with the closing bar. Indicators use bars up to and including that close.',
    rule: 'No future bar is used.',
  },
  {
    id: 'order',
    label: 'Order',
    title: 'The order waits for the next open',
    body: 'If a rule is true, MarketLab schedules the order for the next session. It does not fill at the close that produced the signal.',
    rule: 'No same-bar fill.',
  },
  {
    id: 'fill',
    label: 'Fill',
    title: 'Slippage moves the fill against you',
    body: 'A buy pays the next open plus slippage. A sell receives the next open minus slippage. Commission is charged on the traded notional.',
    rule: 'Costs apply on entry and exit.',
  },
  {
    id: 'protect',
    label: 'Stop and target',
    title: 'The stop wins a tie',
    body: 'If a session range touches both the stop and the target, the stop is assumed to fill first. A stop fills at the stop price unless the session opens through it, in which case it fills at the open. The target fills at the target price.',
    rule: 'The conservative choice is the stated one.',
  },
  {
    id: 'mark',
    label: 'Mark',
    title: 'Equity is marked at each close',
    body: 'Equity is cash plus shares multiplied by the close. Commission and slippage already paid are reflected in that number.',
    rule: 'The curve is net of the costs configured for the run.',
  },
  {
    id: 'end',
    label: 'End of data',
    title: 'An open position is closed at the last close',
    body: 'A position still open on the final bar is closed at that close and labelled end-of-data. No forward return is invented.',
    rule: 'The buy-and-hold benchmark uses the same window with no costs.',
  },
];

export const LEARN_INDICATORS: ReadonlyArray<{ name: string; note: string }> = [
  {
    name: 'Simple moving average',
    note: 'No value until N closes exist. A partial window is never averaged.',
  },
  {
    name: 'Exponential moving average',
    note: 'Seeded with the simple average of the first N closes, then smoothed with alpha = 2 / (N + 1).',
  },
  {
    name: 'Bollinger Bands',
    note: 'An SMA centre with bands at k population standard deviations. The defaults are 20 and 2.',
  },
  {
    name: 'RSI',
    note: "Wilder smoothing with a simple-mean seed. A flat series is 50, not undefined.",
  },
  {
    name: 'ATR',
    note: 'Wilder smoothing. The first true range is high - low; later values use the previous close. Default 14.',
  },
  {
    name: 'ADX',
    note: 'Wilder directional movement and smoothing. The warm-up is roughly two periods.',
  },
  {
    name: 'Anchored VWAP',
    note: 'Cumulative from the first loaded bar, using (high + low + close) / 3. Not a session VWAP.',
  },
  {
    name: 'Ichimoku Cloud',
    note: 'Leading spans are displaced forward and the lagging span trails. Defaults are 9, 26, 52 and 26.',
  },
  {
    name: 'Volume SMA',
    note: 'A missing volume clears the rolling window instead of counting as zero.',
  },
];

export const LEARN_WITHHELD: ReadonlyArray<{ condition: string; result: string }> = [
  {
    condition: 'Fewer than 20 daily returns',
    result: 'VaR 95 and CVaR 95 show --.',
  },
  {
    condition: 'A CAGR span of 30 days or less',
    result: 'CAGR and Calmar show --.',
  },
  {
    condition: 'No shared sessions',
    result: 'The comparison draws nothing and says why.',
  },
  {
    condition: 'No benchmark selected',
    result: 'Beta shows --; alpha is not computed.',
  },
  {
    condition: 'A maximum drawdown of zero',
    result: 'Calmar shows -- instead of dividing by zero.',
  },
  {
    condition: 'No losing trades',
    result: 'Profit factor says "no losing trades", not infinity.',
  },
  {
    condition: 'No volume on a bar',
    result: 'Volume SMA and relative volume restart their window.',
  },
  {
    condition: 'Fewer than two series, or fewer than four shared sessions',
    result: 'The correlation matrix is not shown, because Pearson needs three shared returns.',
  },
  {
    condition: 'A screen field cannot be computed',
    result: 'That series does not match. Missing is never treated as true.',
  },
  {
    condition: 'Fewer than two returns',
    result: 'Volatility and Sharpe show --. Sortino can still be computed if downside deviation is non-zero.',
  },
];

export const LEARN_CASES: readonly LearnCase[] = [
  {
    id: 'cagr-six-months',
    prompt: 'A series gains 20% over six months. What does MarketLab show for CAGR?',
    options: [
      { id: 'twenty', label: '20.00%' },
      { id: 'forty-four', label: 'About 44%' },
      { id: 'withheld', label: 'CAGR is withheld' },
    ],
    answerId: 'forty-four',
    explanation:
      'Six months is more than 30 days, so CAGR is annualised with 365.25 days per year. 1.20 squared is 1.44, or about 44% per year.',
  },
  {
    id: 'one-shared-session',
    prompt: 'Two series share only one session. What does the chart comparison overlay do?',
    options: [
      { id: 'one-point', label: 'Draws a single index point at 100' },
      { id: 'insufficient', label: 'Draws nothing and reports the shared count' },
      { id: 'fill', label: 'Forward-fills the missing dates' },
    ],
    answerId: 'insufficient',
    explanation:
      'The overlay needs at least two shared sessions. It does not fill the gap, so it reports the shared count and draws no line.',
  },
  {
    id: 'stop-and-target',
    prompt: 'A daily bar reaches both the stop and the target. Which fill is assumed?',
    options: [
      { id: 'stop', label: 'The stop' },
      { id: 'target', label: 'The target' },
      { id: 'open', label: 'The session open' },
    ],
    answerId: 'stop',
    explanation:
      'MarketLab resolves the ambiguity against the strategy: the stop fills first. It fills at the stop price, or at the open when the session gaps through the stop, then adverse slippage is applied to the sale.',
  },
  {
    id: 'twelve-returns',
    prompt: 'A series has 12 daily returns. Which metric is withheld?',
    options: [
      { id: 'volatility', label: 'Annualised volatility' },
      { id: 'var', label: 'VaR 95' },
      { id: 'drawdown', label: 'Maximum drawdown' },
    ],
    answerId: 'var',
    explanation:
      'VaR and CVaR need at least 20 returns. Volatility and maximum drawdown can still be computed from the 12 returns.',
  },
];

export const LEARN_ROUTE: ReadonlyArray<{ label: string; to: string; body: string }> = [
  {
    label: 'Data library',
    to: '/data',
    body: 'Load a series, then read the validation summary before the chart. Rejected rows and gaps are part of the story.',
  },
  {
    label: 'Chart workspace',
    to: '/chart',
    body: 'Put two series on one panel and read the 100 baseline. The compare axis is separate from the price axis.',
  },
  {
    label: 'Quant lab',
    to: '/quant',
    body: 'Start with drawdown and VaR, then add a benchmark and watch beta and correlation use only shared sessions.',
  },
  {
    label: 'Screener',
    to: '/screener',
    body: 'Set a cutoff before a known event and compare the matched set with the full history.',
  },
  {
    label: 'Backtest',
    to: '/backtest',
    body: 'Run once with 0 bps costs and once with 20 bps. The difference is cost drag, not a better signal.',
  },
];
