import type {
  BacktestTrade,
  Bar,
  DatasetValidationSummary,
} from '../../domain/types';
import type { ScreenerRow } from '../screener/evaluate';
import type { QuantSummary } from '../quant/metrics';
import { formatPrice } from '../format';

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  // Numeric cells are written verbatim (including negative numbers) and are
  // never treated as formulas. String cells that could be interpreted as a
  // spreadsheet formula are prefixed with an apostrophe before quoting.
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsv).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function barsToCsv(bars: readonly Bar[]): string {
  return toCsv(
    ['date', 'open', 'high', 'low', 'close', 'volume'],
    bars.map((bar) => [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume]),
  );
}

export function tradesToCsv(trades: readonly BacktestTrade[]): string {
  return toCsv(
    ['entry_date', 'entry_price', 'exit_date', 'exit_price', 'quantity', 'gross_pnl', 'costs', 'net_pnl', 'return_pct', 'bars_held', 'exit_reason'],
    trades.map((trade) => [
      trade.entryDate,
      round(trade.entryPrice, 6),
      trade.exitDate,
      round(trade.exitPrice, 6),
      round(trade.quantity, 6),
      round(trade.grossPnl, 4),
      round(trade.costs, 4),
      round(trade.netPnl, 4),
      round(trade.returnPct, 4),
      trade.barsHeld,
      trade.exitReason,
    ]),
  );
}

export function equityToCsv(curve: ReadonlyArray<{ date: string; equity: number; benchmark: number; drawdown: number }>): string {
  return toCsv(
    ['date', 'equity', 'benchmark', 'drawdown_pct'],
    curve.map((point) => [point.date, round(point.equity, 4), round(point.benchmark, 4), round(point.drawdown, 4)]),
  );
}

export function screenerToCsv(rows: readonly ScreenerRow[], fields: readonly string[]): string {
  const headers = ['symbol', 'name', 'as_of', ...fields, 'matched'];
  return toCsv(
    headers,
    rows.map((row) => [
      row.symbol,
      row.displayName,
      row.asOf ?? '',
      ...fields.map((field) => {
        const value = row.values[field as keyof typeof row.values];
        return value === null || value === undefined ? '' : round(value, 4);
      }),
      row.passed ? 'yes' : 'no',
    ]),
  );
}

export function validationToCsv(summary: DatasetValidationSummary): string {
  return toCsv(
    ['row_number', 'reason', 'raw'],
    summary.rejected.map((row) => [row.rowNumber, row.reason, row.raw ?? '']),
  );
}

export function quantSummaryToCsv(symbol: string, summary: QuantSummary): string {
  const entries: Array<[string, number | null]> = [
    ['total_return_pct', summary.totalReturnPct],
    ['cagr_pct', summary.cagrPct],
    ['annualised_volatility_pct', summary.annualisedVolatilityPct],
    ['sharpe', summary.sharpe],
    ['sortino', summary.sortino],
    ['max_drawdown_pct', summary.maxDrawdownPct],
    ['ulcer_index_pct', summary.ulcerIndexPct],
    ['calmar', summary.calmar],
    ['var_95_pct', summary.var95Pct],
    ['cvar_95_pct', summary.cvar95Pct],
    ['best_day_pct', summary.bestDayPct],
    ['worst_day_pct', summary.worstDayPct],
    ['positive_day_rate_pct', summary.positiveDayRatePct],
    ['skewness', summary.skewness],
    ['excess_kurtosis', summary.excessKurtosis],
  ];
  return toCsv(['symbol', 'metric', 'value'], entries.map(([metric, value]) => [symbol, metric, value === null ? '' : round(value, 6)]));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { formatPrice };
