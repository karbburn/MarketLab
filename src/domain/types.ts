/**
 * Canonical domain types for MarketLab.
 *
 * Time policy: every bar is identified by an exchange session date in ISO
 * `YYYY-MM-DD` form. Bars are date-only; no timezone conversion is applied and
 * no intraday timestamps are produced or inferred. Aggregation buckets are
 * derived from the session date itself, so weekly/monthly bars remain stable
 * regardless of the viewer's local timezone.
 */

export type DateString = string;

export type Frequency = 'daily' | 'weekly' | 'monthly';

export type Timeframe = '1D' | '1W' | '1M';

export const CHART_TYPES = ['candlestick', 'bar', 'line', 'area', 'baseline'] as const;

/** Order and labels for chart-type selectors; one source so they cannot drift. */
export type ChartType = (typeof CHART_TYPES)[number];

export type PriceScaleMode = 'normal' | 'logarithmic' | 'percentage';

export type AssetType = 'equity' | 'index' | 'fx' | 'crypto' | 'commodity' | 'fund' | 'other';

export interface Instrument {
  id: string;
  symbol: string;
  displayName: string;
  assetType: AssetType;
  currency: string;
  exchange?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface Bar {
  date: DateString;
  open: number;
  high: number;
  low: number;
  close: number;
  /** `null` means the source did not provide volume; it is never invented. */
  volume: number | null;
  /**
   * Aggregation bucket identity (`2024-W01`, `2024-08`) for bars produced by
   * `aggregateBars`. Never stored; it lets weekly/monthly comparisons align on
   * the period even when two markets closed the period on different sessions.
   */
  bucket?: string;
}

/**
 * Distinguishes where a dataset came from; drives every provenance label.
 *
 * `bundled-sample` is a legacy value: the synthetic demo series it described
 * are no longer created. It stays in the union so older stored data and older
 * backups still validate, and the migration in `lib/migration` removes those
 * records on load.
 */
export type SourceKind = 'bundled-sample' | 'user-csv' | 'provider-download';

/** Open set of downloadable sources; the first is Yahoo Finance via yfinance. */
export type ProviderId = 'yahoo-finance';

export type CorporateActionType = 'split' | 'dividend';

/**
 * A provider-reported corporate action on an exchange session.
 *
 * `value` is the split ratio (new shares per old share) for a split, or the
 * cash amount per share for a dividend in the instrument's currency. These
 * events are stored exactly as the provider reported them; MarketLab never
 * derives or imputes one.
 */
export interface CorporateAction {
  date: DateString;
  type: CorporateActionType;
  value: number;
}

/**
 * Provenance for a downloaded dataset. Optional so older locally stored data
 * and existing backups stay valid without a migration.
 */
export interface DatasetProvider {
  provider: ProviderId;
  /** Symbol as the provider keys it (e.g. `AAPL`, `^GSPC`, `BP.L`). */
  providerSymbol: string;
  /** Provider-local exchange code (e.g. `NMS`) when reported, otherwise null. */
  exchange: string | null;
  /** Human exchange name (e.g. `NasdaqGS`) when reported, otherwise null. */
  exchangeName: string | null;
  instrumentType: string | null;
  interval: string;
  /** Declared price-adjustment convention, e.g. splits applied, dividends not reinvested. */
  adjustment: string;
  /** ISO instant of the retrieval, from the provider metadata, not the client. */
  retrievedAt: string;
  /** Exchange timezone name (e.g. `America/New_York`) when reported. */
  timezone: string | null;
  /** Provider-stated limitations of this download, verbatim. */
  sourceNotes: readonly string[];
  /**
   * Provider-reported split/dividend events in the requested range. Absent on
   * datasets downloaded before corporate actions were captured; treat it as an
   * empty list rather than inferring events from price moves.
   */
  corporateActions?: readonly CorporateAction[];
}

export interface RejectedRow {
  rowNumber: number;
  reason: string;
  raw?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  count?: number;
}

export interface DatasetValidationSummary {
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  missingVolumeRows: number;
  gapCount: number;
  sortCorrections: number;
  rejected: RejectedRow[];
  warnings: ValidationWarning[];
}

export interface Dataset {
  id: string;
  instrumentId: string;
  name: string;
  sourceKind: SourceKind;
  sourceDescription: string;
  frequency: Frequency;
  timezone: string;
  firstDate: DateString;
  lastDate: DateString;
  rowCount: number;
  importedAt: string;
  contentHash: string;
  hasVolume: boolean;
  validation: DatasetValidationSummary;
  /** Present exactly when `sourceKind === 'provider-download'`. */
  provider?: DatasetProvider;
}

export interface ChartConfig {
  id: string;
  instrumentId: string;
  datasetId: string;
  timeframe: Timeframe;
  chartType: ChartType;
  showVolume: boolean;
  priceScaleMode: PriceScaleMode;
  visibleRange: { from: DateString; to: DateString } | null;
  indicators: IndicatorInstance[];
  drawings: Drawing[];
  /**
   * Datasets overlaid for relative comparison, in draw order. Rebased to 100 at
   * the first shared session; empty unless the user adds a comparison. Stored
   * dataset ids are validated on load and pruned when their dataset is deleted.
   */
  compareDatasetIds: string[];
}

export type IndicatorPlacement = 'overlay' | 'pane';

export interface IndicatorInstance {
  id: string;
  type: string;
  version: number;
  parameters: Record<string, number>;
  visible: boolean;
  placement: IndicatorPlacement;
  style: IndicatorStyle;
}

export interface IndicatorStyle {
  color?: string;
  secondaryColor?: string;
  lineWidth?: number;
}

/**
 * A reusable chart presentation: the five view settings and the ordered
 * indicator set. It deliberately carries no dataset, instrument, visible range,
 * comparison or drawing data, so applying it never moves a panel to another
 * series or discards annotations.
 */
export interface ChartTemplate {
  id: string;
  name: string;
  schemaVersion: number;
  chartType: ChartType;
  priceScaleMode: PriceScaleMode;
  showVolume: boolean;
  timeframe: Timeframe;
  indicators: IndicatorInstance[];
  createdAt: string;
  updatedAt: string;
}

export type DrawingType =
  | 'trendline'
  | 'ray'
  | 'horizontal-line'
  | 'vertical-line'
  | 'rectangle'
  | 'text'
  | 'price-range'
  | 'fibonacci';

export interface DrawingAnchor {
  date: DateString;
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  anchors: DrawingAnchor[];
  text?: string;
  visible: boolean;
  locked: boolean;
  style: DrawingStyle;
  /** Fibonacci level ratios, 0..1, ascending. */
  levels?: number[];
}

export interface DrawingStyle {
  color: string;
  lineWidth: number;
  fillOpacity?: number;
  fontSize?: number;
  lineStyle?: 'solid' | 'dashed';
}

export type LinkProperty = 'symbol' | 'timeframe' | 'visible-range' | 'crosshair';

export interface LinkGroup {
  id: string;
  name: string;
  chartIds: string[];
  properties: LinkProperty[];
}

export type WorkspaceLayout = 'single' | 'two-horizontal' | 'two-vertical' | 'four';

export interface Workspace {
  id: string;
  name: string;
  schemaVersion: number;
  layout: WorkspaceLayout;
  charts: ChartConfig[];
  linkGroups: LinkGroup[];
  activeWatchlistId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Watchlist {
  id: string;
  name: string;
  instrumentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserPreferences {
  theme: 'dark' | 'light';
  defaultWorkspaceId: string | null;
  showVolumeByDefault: boolean;
  defaultChartType: ChartType;
  defaultTimeframe: Timeframe;
}

export type ScreenerOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'crosses-above' | 'crosses-below';

export type ScreenerField =
  | 'return'
  | 'price-vs-sma'
  | 'price-vs-ema'
  | 'rsi'
  | 'volatility'
  | 'max-drawdown'
  | 'relative-volume'
  | 'close';

export interface ScreenerFilter {
  id: string;
  field: ScreenerField;
  operator: ScreenerOperator;
  value: number;
  window: number;
}

export interface ScreenerDefinition {
  id: string;
  name: string;
  schemaVersion: number;
  universeDatasetIds: string[];
  combinators: Array<'AND' | 'OR'>;
  filters: ScreenerFilter[];
  cutoff: DateString | null;
  sortBy: string;
  /** Sessions used to compute the sort field; independent of any filter window. */
  sortWindow: number;
  sortDirection: 'asc' | 'desc';
  createdAt: string;
  updatedAt: string;
}

export type RuleField =
  | 'price-vs-sma'
  | 'sma-cross'
  | 'rsi'
  | 'price-vs-ema'
  | 'macd-cross'
  | 'breakout-high'
  | 'breakout-low';

export interface StrategyRule {
  id: string;
  field: RuleField;
  operator: ScreenerOperator;
  value: number;
  secondaryValue?: number;
  window: number;
  secondaryWindow?: number;
}

export interface BacktestConfig {
  id: string;
  name: string;
  datasetId: string;
  startDate: DateString | null;
  endDate: DateString | null;
  initialCapital: number;
  positionSizePct: number;
  commissionBps: number;
  slippageBps: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  entry: StrategyRule[];
  exit: StrategyRule[];
  entryLogic: 'AND' | 'OR';
  exitLogic: 'AND' | 'OR';
  execution: 'next-open';
  createdAt: string;
  updatedAt: string;
}

export interface BacktestTrade {
  entryDate: DateString;
  entryPrice: number;
  exitDate: DateString;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  barsHeld: number;
  exitReason: 'signal' | 'stop-loss' | 'take-profit' | 'end-of-data';
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: Array<{ date: DateString; equity: number; benchmark: number; drawdown: number }>;
  metrics: {
    totalReturnPct: number;
    cagrPct: number | null;
    annualisedVolatilityPct: number;
    maxDrawdownPct: number;
    sharpe: number | null;
    tradeCount: number;
    winRatePct: number | null;
    profitFactor: number | null;
    averageTradePct: number | null;
    exposurePct: number;
    benchmarkTotalReturnPct: number;
  };
}
