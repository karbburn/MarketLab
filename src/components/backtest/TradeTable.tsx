import type { BacktestTrade } from '../../domain/types';
import { formatPrice, formatSignedPercent, formatSignedPrice } from '../../lib/format';
import { EmptyState, Tag } from '../ui';

/**
 * The per-trade log shared by a live simulation and a saved research run, so
 * the two views cannot disagree about columns or formatting.
 */
export function TradeTable({
  trades,
  emptyTitle = 'No trades',
  emptyBody = 'The rule set never produced an entry in this window. Check the rule thresholds or widen the window.',
}: {
  trades: readonly BacktestTrade[];
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (trades.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }
  return (
    <div className="stack">
      <div className="table-wrap scroll-y">
        <table className="data">
          <thead>
            <tr>
              <th>Entry</th>
              <th className="num">Entry price</th>
              <th>Exit</th>
              <th className="num">Exit price</th>
              <th className="num">Quantity</th>
              <th className="num">Gross PnL</th>
              <th className="num">Costs</th>
              <th className="num">Net PnL</th>
              <th className="num">Return</th>
              <th className="num">Bars</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={`${trade.entryDate}-${trade.exitDate}-${index}`}>
                <td className="mono">{trade.entryDate}</td>
                <td className="num">{formatPrice(trade.entryPrice)}</td>
                <td className="mono">{trade.exitDate}</td>
                <td className="num">{formatPrice(trade.exitPrice)}</td>
                <td className="num">{trade.quantity.toFixed(2)}</td>
                <td className={`num ${trade.grossPnl >= 0 ? 'up' : 'down'}`}>{formatSignedPrice(trade.grossPnl)}</td>
                <td className="num muted">{formatPrice(trade.costs)}</td>
                <td className={`num ${trade.netPnl >= 0 ? 'up' : 'down'}`}>{formatSignedPrice(trade.netPnl)}</td>
                <td className={`num ${trade.returnPct >= 0 ? 'up' : 'down'}`}>{formatSignedPercent(trade.returnPct)}</td>
                <td className="num">{trade.barsHeld}</td>
                <td>
                  <Tag tone={trade.exitReason === 'stop-loss' ? 'down' : trade.exitReason === 'take-profit' ? 'up' : undefined}>
                    {trade.exitReason}
                  </Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="field-hint">
        Entry slippage is already included in the entry price, so Gross PnL is measured from the slipped entry. Costs
        shows entry commission, exit commission and exit slippage only; it does not repeat the entry slippage embedded
        in the price. Net PnL is Gross PnL minus Costs.
      </span>
    </div>
  );
}
