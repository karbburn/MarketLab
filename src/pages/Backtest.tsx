import { useCallback, useMemo, useRef, useState } from 'react';
import { DownloadSimple, FloppyDisk, Play, Plus, Trash } from '@phosphor-icons/react';
import type { BacktestConfig, BacktestResult, RuleField, ScreenerOperator, StrategyRule } from '../domain/types';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { runBacktest } from '../lib/backtest/engine';
import { createBacktestConfig } from '../state/defaults';
import { createId } from '../lib/id';
import { downloadTextFile } from '../lib/export/download';
import { equityToCsv, tradesToCsv } from '../lib/export/csv';
import { formatPercent, formatPrice, formatSignedPercent, formatSignedPrice } from '../lib/format';
import { EmptyState, Field, Metric, NumberInput, Panel, Select, Tag, TextInput } from '../components/ui';
import { GetStartedPanel } from '../components/data/GetStartedPanel';
import { LineChart, type ChartSeries } from '../components/charts/LineChart';

const RULE_FIELDS: Array<{ value: RuleField; label: string; needsSecondary: boolean; implicitThreshold: boolean }> = [
  { value: 'price-vs-sma', label: 'Price vs SMA (%)', needsSecondary: false, implicitThreshold: false },
  { value: 'price-vs-ema', label: 'Price vs EMA (%)', needsSecondary: false, implicitThreshold: false },
  { value: 'sma-cross', label: 'SMA cross', needsSecondary: true, implicitThreshold: true },
  { value: 'macd-cross', label: 'MACD cross', needsSecondary: true, implicitThreshold: true },
  { value: 'rsi', label: 'RSI level', needsSecondary: false, implicitThreshold: false },
  { value: 'breakout-high', label: 'Breakout above high', needsSecondary: false, implicitThreshold: true },
  { value: 'breakout-low', label: 'Breakdown below low', needsSecondary: false, implicitThreshold: true },
];

const OPERATORS: Array<{ value: ScreenerOperator; label: string }> = [
  { value: 'crosses-above', label: 'crosses above' },
  { value: 'crosses-below', label: 'crosses below' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
];

export function BacktestPage() {
  const { state, actions } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const [draft, setDraft] = useState<BacktestConfig | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [runRequest, setRunRequest] = useState<{ config: BacktestConfig; token: number } | null>(null);
  const tokenRef = useRef(0);

  const datasetId = draft?.datasetId ?? null;
  const bars = useMemo(() => views.find((view) => view.dataset.id === datasetId)?.bars ?? [], [views, datasetId]);
  const signature = draft ? JSON.stringify(draft) : '';
  const runSignature = runRequest ? JSON.stringify(runRequest.config) : null;

  // The simulation only recomputes when a run is requested or the data changes,
  // never on every keystroke in the rule editor.
  const result = useMemo<BacktestResult | null>(() => {
    if (!runRequest || bars.length < 3) return null;
    return runBacktest(bars, runRequest.config);
  }, [runRequest, bars]);

  const requestRun = useCallback((config: BacktestConfig | null) => {
    if (!config) return;
    tokenRef.current += 1;
    setRunRequest({ config, token: tokenRef.current });
  }, []);

  const updateDraft = (updater: (current: BacktestConfig) => BacktestConfig) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const updateRule = (side: 'entry' | 'exit', ruleId: string, updater: (rule: StrategyRule) => StrategyRule) => {
    updateDraft((current) => ({
      ...current,
      [side]: current[side].map((rule) => (rule.id === ruleId ? updater(rule) : rule)),
    }));
  };

  const stale = draft !== null && runSignature !== null && runSignature !== signature;

  const equitySeries = useMemo<ChartSeries[]>(() => {
    if (!result || result.equityCurve.length === 0) return [];
    // Rebase against the capital the run actually used, not the live draft.
    const base = runRequest?.config.initialCapital ?? 1;
    return [
      {
        id: 'equity',
        label: 'Strategy equity',
        color: '#3fb8a3',
        points: result.equityCurve.map((point, index) => ({ x: index, y: (point.equity / base - 1) * 100 })),
      },
      {
        id: 'benchmark',
        label: 'Buy and hold',
        color: '#8aa0b8',
        points: result.equityCurve.map((point, index) => ({ x: index, y: (point.benchmark / base - 1) * 100 })),
      },
    ];
  }, [result, runRequest]);

  const drawdownSeries = useMemo<ChartSeries[]>(() => {
    if (!result) return [];
    return [
      {
        id: 'drawdown',
        label: 'Strategy drawdown',
        color: '#e2586a',
        points: result.equityCurve.map((point, index) => ({ x: index, y: point.drawdown })),
      },
    ];
  }, [result]);

  if (views.length === 0) {
    return (
      <div className="page">
        <GetStartedPanel title="No market data to simulate" />
      </div>
    );
  }

  return (
    <div className="page">
      <Panel
        title="Strategy"
        subtitle="Signals are evaluated on the close and filled at the next open"
        actions={
          <div className="row tight">
            <Select
              value={selectedSavedId}
              onChange={(value) => {
                setSelectedSavedId(value);
                const saved = state.backtests.find((entry) => entry.id === value) ?? null;
                const next = saved ? { ...saved } : null;
                setDraft(next);
                requestRun(next);
              }}
              options={[{ value: '', label: 'Saved strategies' }, ...state.backtests.map((entry) => ({ value: entry.id, label: entry.name }))]}
            />
            <button
              type="button"
              className="button sm"
              onClick={() => {
                const first = views[0];
                if (!first) return;
                const created = createBacktestConfig({ datasetId: first.dataset.id });
                setDraft(created);
                setSelectedSavedId('');
                requestRun(created);
              }}
            >
              <Plus size={13} aria-hidden />
              New strategy
            </button>
            {draft && (
              <>
                <button
                  type="button"
                  className="button sm"
                  onClick={() => requestRun(draft)}
                  disabled={bars.length < 3}
                >
                  <Play size={13} aria-hidden />
                  Run
                </button>
                <button type="button" className="button sm primary" onClick={() => void actions.saveBacktest(draft)}>
                  <FloppyDisk size={13} aria-hidden />
                  Save
                </button>
                <button
                  type="button"
                  className="button sm danger"
                  onClick={() => {
                    void actions.deleteBacktest(draft.id);
                    setDraft(null);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        }
      >
        {!draft ? (
          <EmptyState
            title="No strategy selected"
            body="Start a new strategy to describe entry and exit rules, costs and risk limits."
            action={
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  const first = views[0];
                  if (!first) return;
                  const created = createBacktestConfig({ datasetId: first.dataset.id });
                  setDraft(created);
                  requestRun(created);
                }}
              >
                Start a new strategy
              </button>
            }
          />
        ) : (
          <div className="stack">
            <div className="grid-4">
              <Field label="Strategy name">
                <TextInput value={draft.name} onChange={(value) => updateDraft((current) => ({ ...current, name: value }))} />
              </Field>
              <Field label="Dataset">
                <Select
                  value={draft.datasetId}
                  onChange={(value) => {
                    const next = { ...draft, datasetId: value };
                    setDraft(next);
                    requestRun(next);
                  }}
                  options={views.map((view) => ({ value: view.dataset.id, label: `${view.instrument?.symbol ?? view.dataset.name} - ${view.dataset.frequency}` }))}
                />
              </Field>
              <Field label="Start date" hint="Leave empty to use the full history.">
                <TextInput type="date" value={draft.startDate ?? ''} onChange={(value) => updateDraft((current) => ({ ...current, startDate: value === '' ? null : value }))} />
              </Field>
              <Field label="End date">
                <TextInput type="date" value={draft.endDate ?? ''} onChange={(value) => updateDraft((current) => ({ ...current, endDate: value === '' ? null : value }))} />
              </Field>
              <Field label="Initial capital">
                <NumberInput value={draft.initialCapital} min={1} step={1000} onChange={(value) => updateDraft((current) => ({ ...current, initialCapital: Number.isFinite(value) ? Math.max(1, value) : 10000 }))} />
              </Field>
              <Field label="Position size (%)" hint="Share of current equity deployed at entry.">
                <NumberInput value={draft.positionSizePct} min={1} max={100} step={1} onChange={(value) => updateDraft((current) => ({ ...current, positionSizePct: Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : 95 }))} />
              </Field>
              <Field label="Commission (bps)" hint="Charged on notional at entry and at exit.">
                <NumberInput value={draft.commissionBps} min={0} max={1000} step={1} onChange={(value) => updateDraft((current) => ({ ...current, commissionBps: Number.isFinite(value) ? Math.max(0, value) : 0 }))} />
              </Field>
              <Field label="Slippage (bps)" hint="Applied adversely to every fill.">
                <NumberInput value={draft.slippageBps} min={0} max={1000} step={1} onChange={(value) => updateDraft((current) => ({ ...current, slippageBps: Number.isFinite(value) ? Math.max(0, value) : 0 }))} />
              </Field>
              <Field label="Stop loss (%)" hint="Empty disables the stop.">
                <TextInput
                  type="number"
                  value={draft.stopLossPct === null ? '' : String(draft.stopLossPct)}
                  onChange={(value) =>
                    updateDraft((current) => ({ ...current, stopLossPct: value.trim() === '' ? null : Math.min(99, Math.max(0, Number(value))) }))
                  }
                />
              </Field>
              <Field label="Take profit (%)" hint="Empty disables the target.">
                <TextInput
                  type="number"
                  value={draft.takeProfitPct === null ? '' : String(draft.takeProfitPct)}
                  onChange={(value) =>
                    updateDraft((current) => ({ ...current, takeProfitPct: value.trim() === '' ? null : Math.max(0, Number(value)) }))
                  }
                />
              </Field>
              <Field label="Entry logic">
                <Select
                  value={draft.entryLogic}
                  onChange={(value) => updateDraft((current) => ({ ...current, entryLogic: value as 'AND' | 'OR' }))}
                  options={[
                    { value: 'AND', label: 'All entry rules (AND)' },
                    { value: 'OR', label: 'Any entry rule (OR)' },
                  ]}
                />
              </Field>
              <Field label="Exit logic">
                <Select
                  value={draft.exitLogic}
                  onChange={(value) => updateDraft((current) => ({ ...current, exitLogic: value as 'AND' | 'OR' }))}
                  options={[
                    { value: 'AND', label: 'All exit rules (AND)' },
                    { value: 'OR', label: 'Any exit rule (OR)' },
                  ]}
                />
              </Field>
            </div>

            <div className="divider" />

            <div className="grid-2">
              <div className="stack">
                <span className="field-label">Entry rules</span>
                {draft.entry.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onChange={(updater) => updateRule('entry', rule.id, updater)}
                    onRemove={draft.entry.length > 1 ? () => updateDraft((current) => ({ ...current, entry: current.entry.filter((entry) => entry.id !== rule.id) })) : undefined}
                  />
                ))}
                <button
                  type="button"
                  className="button sm"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      entry: [...current.entry, { id: createId('rule'), field: 'rsi', operator: 'lt', value: 35, window: 14 }],
                    }))
                  }
                >
                  <Plus size={13} aria-hidden />
                  Add entry rule
                </button>
              </div>
              <div className="stack">
                <span className="field-label">Exit rules</span>
                {draft.exit.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onChange={(updater) => updateRule('exit', rule.id, updater)}
                    onRemove={draft.exit.length > 1 ? () => updateDraft((current) => ({ ...current, exit: current.exit.filter((entry) => entry.id !== rule.id) })) : undefined}
                  />
                ))}
                <button
                  type="button"
                  className="button sm"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      exit: [...current.exit, { id: createId('rule'), field: 'rsi', operator: 'gt', value: 65, window: 14 }],
                    }))
                  }
                >
                  <Plus size={13} aria-hidden />
                  Add exit rule
                </button>
              </div>
            </div>
          </div>
        )}
      </Panel>

      {draft && result && (
        <>
          <Panel
            title="Results"
            subtitle={stale ? 'Parameters changed since the last run. Press Run to refresh.' : `${result.trades.length} trade(s) simulated`}
            actions={
              <div className="row tight">
                {stale && <Tag tone="warn">Stale</Tag>}
                <button
                  type="button"
                  className="button sm"
                  disabled={result.trades.length === 0}
                  onClick={() => downloadTextFile(`marketlab-trades-${draft.name.replace(/\s+/g, '-').toLowerCase()}.csv`, tradesToCsv(result.trades), 'text/csv')}
                >
                  <DownloadSimple size={13} aria-hidden />
                  Trades
                </button>
                <button
                  type="button"
                  className="button sm"
                  disabled={result.equityCurve.length === 0}
                  onClick={() => downloadTextFile(`marketlab-equity-${draft.name.replace(/\s+/g, '-').toLowerCase()}.csv`, equityToCsv(result.equityCurve), 'text/csv')}
                >
                  <DownloadSimple size={13} aria-hidden />
                  Equity curve
                </button>
              </div>
            }
          >
            <div className="grid-4">
              <Metric label="Total return" value={formatPercent(result.metrics.totalReturnPct)} tone={result.metrics.totalReturnPct >= 0 ? 'up' : 'down'} note={`Buy and hold ${formatPercent(result.metrics.benchmarkTotalReturnPct)}`} />
              <Metric label="CAGR" value={result.metrics.cagrPct === null ? '--' : formatPercent(result.metrics.cagrPct)} />
              <Metric label="Max drawdown" value={formatPercent(result.metrics.maxDrawdownPct)} tone="down" />
              <Metric label="Volatility" value={formatPercent(result.metrics.annualisedVolatilityPct)} note="Annualised from the equity curve" />
              <Metric label="Sharpe" value={result.metrics.sharpe === null ? '--' : result.metrics.sharpe.toFixed(2)} />
              <Metric label="Trades" value={String(result.metrics.tradeCount)} />
              <Metric label="Win rate" value={result.metrics.winRatePct === null ? '--' : formatPercent(result.metrics.winRatePct)} />
              <Metric label="Profit factor" value={result.metrics.profitFactor === null ? (result.metrics.tradeCount > 0 ? 'no losing trades' : '--') : result.metrics.profitFactor.toFixed(2)} />
              <Metric label="Average trade" value={result.metrics.averageTradePct === null ? '--' : formatPercent(result.metrics.averageTradePct)} />
              <Metric label="Exposure" value={formatPercent(result.metrics.exposurePct)} note="Share of sessions holding a position" />
            </div>
          </Panel>

          <div className="grid-2">
            <Panel title="Equity versus buy and hold" subtitle="Percent change from the initial capital">
              {equitySeries.length > 0 ? (
                <LineChart series={equitySeries} height={220} baseline={0} yFormat={(value) => `${value.toFixed(0)}%`} ariaLabel="Equity curve versus buy and hold" />
              ) : (
                <EmptyState title="No equity curve" body="The window is too short to simulate." />
              )}
            </Panel>
            <Panel title="Drawdown" subtitle="Percent below the running equity peak">
              {drawdownSeries.length > 0 ? (
                <LineChart series={drawdownSeries} height={220} baseline={0} yFormat={(value) => `${value.toFixed(1)}%`} ariaLabel="Strategy drawdown" />
              ) : (
                <EmptyState title="No drawdown series" body="Run the strategy to see the drawdown profile." />
              )}
            </Panel>
          </div>

          <Panel title="Trades" subtitle="Fills are at the next session's open, then adjusted for slippage and commission" flush>
            {result.trades.length === 0 ? (
              <EmptyState title="No trades" body="The rule set never produced an entry in this window. Check the rule thresholds or widen the window." />
            ) : (
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
                    {result.trades.map((trade, index) => (
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
                          <Tag tone={trade.exitReason === 'stop-loss' ? 'down' : trade.exitReason === 'take-profit' ? 'up' : undefined}>{trade.exitReason}</Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel title="Execution assumptions" subtitle="Stated plainly so the numbers cannot be mistaken for more than they are">
        <ul className="list-reset stack field-hint">
          <li>Signals are evaluated on a session's close. Orders fill at the next session's open. There is no same-bar fill and no look-ahead.</li>
          <li>Slippage is applied adversely on entry and again on exit. Commission is charged on the traded notional at entry and at exit.</li>
          <li>Position size is a fixed percentage of the equity at entry, and the resulting share count is fractional. No lot rounding, no margin, no leverage beyond that percentage.</li>
          <li>If a session's range touches both the stop and the target, the stop is assumed to fill first. That is the conservative choice.</li>
          <li>Stop and target fills are approximated at the stop or target price plus adverse slippage, not at the session open.</li>
          <li>A position still open at the final session is closed at the last close and labelled end-of-data. No forward return is invented.</li>
          <li>The buy-and-hold benchmark uses the same initial capital over the same window with no costs.</li>
          <li>Only long positions are simulated. Short selling is not modelled.</li>
        </ul>
      </Panel>
    </div>
  );
}

function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: StrategyRule;
  onChange: (updater: (rule: StrategyRule) => StrategyRule) => void;
  onRemove?: () => void;
}) {
  const meta = RULE_FIELDS.find((field) => field.value === rule.field);
  return (
    <div className="rule-row">
      <Field label="Rule">
        <Select value={rule.field} onChange={(value) => onChange((current) => ({ ...current, field: value }))} options={RULE_FIELDS.map((field) => ({ value: field.value, label: field.label }))} />
      </Field>
      <Field label="Operator">
        <Select value={rule.operator} onChange={(value) => onChange((current) => ({ ...current, operator: value }))} options={OPERATORS} />
      </Field>
      <Field label="Threshold" hint={meta?.implicitThreshold ? 'Unused for this rule' : undefined}>
        <NumberInput
          value={rule.value}
          step={0.5}
          disabled={meta?.implicitThreshold}
          onChange={(value) => onChange((current) => ({ ...current, value: Number.isFinite(value) ? value : 0 }))}
        />
      </Field>
      <Field label="Window">
        <NumberInput value={rule.window} min={1} max={500} step={1} onChange={(value) => onChange((current) => ({ ...current, window: Number.isFinite(value) ? Math.max(1, Math.round(value)) : 14 }))} />
      </Field>
      {meta?.needsSecondary ? (
        <Field label="Slow window">
          <NumberInput
            value={rule.secondaryWindow ?? rule.window * 2}
            min={1}
            max={500}
            step={1}
            onChange={(value) => onChange((current) => ({ ...current, secondaryWindow: Number.isFinite(value) ? Math.max(1, Math.round(value)) : 50 }))}
          />
        </Field>
      ) : (
        <span />
      )}
      <div className="row tight">
        {onRemove && (
          <button type="button" className="button ghost sm" aria-label="Remove rule" onClick={onRemove}>
            <Trash size={13} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
