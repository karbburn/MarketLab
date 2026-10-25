import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DownloadSimple, FloppyDisk, Play, Plus, Trash } from '@phosphor-icons/react';
import type { BacktestConfig, BacktestResult, BacktestRun, StrategyRule } from '../domain/types';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { BACKTEST_ASSUMPTIONS, runBacktest } from '../lib/backtest/engine';
import { buildAttribution } from '../lib/backtest/attribution';
import { planResearchRunLoad } from '../lib/backtest/research-runs';
import { indexInstrumentsById } from '../lib/backtest/run-datasets';
import { describeRunWindow } from '../lib/backtest/run-window';
import { buildProvenanceSummary } from '../lib/provenance/summary';
import { coverageFromDataset } from '../lib/marketdata/coverage';
import { RULE_FIELDS, RULE_OPERATORS as OPERATORS, secondaryWindowValue } from '../lib/backtest/rule-catalog';
import { createBacktestConfig } from '../state/defaults';
import { createId } from '../lib/id';
import { downloadTextFile } from '../lib/export/download';
import { equityToCsv, tradesToCsv } from '../lib/export/csv';
import { formatPercent } from '../lib/format';
import { EmptyState, Field, Metric, NumberInput, Panel, Select, Tag, TextInput } from '../components/ui';
import { GetStartedPanel } from '../components/data/GetStartedPanel';
import { LineChart, type ChartSeries } from '../components/charts/LineChart';
import { ResearchRunsPanel, type ResearchRunSource } from '../components/backtest/ResearchRunsPanel';
import { ResearchRunComparison } from '../components/backtest/ResearchRunComparison';
import { RunWindowDisclosure } from '../components/backtest/RunWindowDisclosure';
import { ResultsReading } from '../components/backtest/ResultsReading';
import { TradeTable } from '../components/backtest/TradeTable';

export function BacktestPage() {
  const { state, actions } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const [draft, setDraft] = useState<BacktestConfig | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [loadedFrom, setLoadedFrom] = useState<{ id: string; name: string } | null>(null);
  const [runRequest, setRunRequest] = useState<{ config: BacktestConfig; token: number } | null>(null);
  const tokenRef = useRef(0);

  const datasetId = draft?.datasetId ?? null;
  const bars = useMemo(() => views.find((view) => view.dataset.id === datasetId)?.bars ?? [], [views, datasetId]);
  const frequency = useMemo(
    () => views.find((view) => view.dataset.id === datasetId)?.dataset.frequency ?? 'daily',
    [views, datasetId],
  );
  const activeView = useMemo(() => views.find((view) => view.dataset.id === datasetId) ?? null, [views, datasetId]);
  const loadedRun = loadedFrom ? state.backtestRuns.find((run) => run.id === loadedFrom.id) ?? null : null;
  const loadedInputsDiffer =
    loadedRun !== null &&
    activeView !== null &&
    (activeView.dataset.contentHash !== loadedRun.dataset.contentHash ||
      activeView.dataset.frequency !== loadedRun.dataset.frequency);
  // The window disclosure must describe exactly the configuration whose result
  // is on screen, so it uses the same source as the `result` memo below.
  const runWindow = useMemo(
    () => (draft && bars.length > 0 ? describeRunWindow(runRequest?.config ?? draft, bars) : null),
    [draft, runRequest, bars],
  );
  // Reuses the chart provenance summary so source and adjustment wording cannot
  // drift between screens.
  const provenance = useMemo(
    () => (activeView ? buildProvenanceSummary(activeView.dataset, { exchange: activeView.instrument?.exchange }) : null),
    [activeView],
  );
  // A download can return less than it was asked for even when the strategy has
  // no explicit dates. The Results panel discloses that separately from the
  // run's own window, so a shorter series is never implied to be complete.
  const datasetCoverage = useMemo(
    () => (activeView ? coverageFromDataset(activeView.dataset) : null),
    [activeView],
  );
  const signature = draft ? JSON.stringify(draft) : '';
  const runSignature = runRequest ? JSON.stringify(runRequest.config) : null;

  // The simulation only recomputes when a run is requested or the data changes,
  // never on every keystroke in the rule editor.
  const result = useMemo<BacktestResult | null>(() => {
    if (!runRequest || bars.length < 3) return null;
    return runBacktest(bars, runRequest.config, frequency);
  }, [runRequest, bars, frequency]);

  const attribution = useMemo(() => (result ? buildAttribution(result) : null), [result]);

  const requestRun = useCallback((config: BacktestConfig | null) => {
    if (!config) return;
    tokenRef.current += 1;
    setRunRequest({ config, token: tokenRef.current });
  }, []);

  const updateDraft = (updater: (current: BacktestConfig) => BacktestConfig) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const loadRunConfig = useCallback((run: BacktestRun) => {
    const plan = planResearchRunLoad(
      run,
      state.datasets,
      indexInstrumentsById(state.instruments),
      createId('backtest'),
    );
    if (!plan.ok) {
      actions.notify('error', plan.message);
      return;
    }
    // A loaded run becomes an editable working copy: it never aliases the saved
    // run, and saving it creates a new strategy rather than overwriting one.
    setDraft(plan.config);
    setSelectedSavedId('');
    setLoadedFrom({ id: run.id, name: run.name });
    requestRun(plan.config);
    if (plan.repointed) {
      actions.notify(
        'info',
        `The dataset of this run was re-imported under a new library id; the editor targets the identical stored series.`,
      );
    }
    actions.notify('info', `Loaded the configuration from research run "${run.name}".`);
  }, [state.datasets, state.instruments, actions, requestRun]);

  const updateRule = (side: 'entry' | 'exit', ruleId: string, updater: (rule: StrategyRule) => StrategyRule) => {
    updateDraft((current) => ({
      ...current,
      [side]: current[side].map((rule) => (rule.id === ruleId ? updater(rule) : rule)),
    }));
  };

  const stale = draft !== null && runSignature !== null && runSignature !== signature;
  const researchSource: ResearchRunSource | null =
    draft && result && activeView && !stale
      ? { config: runRequest?.config ?? draft, result, dataset: activeView.dataset, instrument: activeView.instrument }
      : null;

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
              ariaLabel="Saved strategies"
              value={selectedSavedId}
              onChange={(value) => {
                setSelectedSavedId(value);
                setLoadedFrom(null);
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
                setLoadedFrom(null);
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
                  setSelectedSavedId('');
                  setLoadedFrom(null);
                  requestRun(created);
                }}
              >
                Start a new strategy
              </button>
            }
          />
        ) : (
          <div className="stack">
            {loadedFrom && (
              <div className="row tight research-working-copy" role="status">
                <Tag tone="accent">Working copy</Tag>
                <span className="field-hint">
                  Editing the configuration recorded by research run “{loadedFrom.name}”. The saved run and its
                  results are unchanged; a research run saved from here is a separate record.
                  {loadedInputsDiffer
                    ? ' The stored dataset has changed since this run was saved, so a fresh run can legitimately produce different numbers.'
                    : ''}
                </span>
              </div>
            )}
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
            {runWindow && (
              <div style={{ marginBottom: 12 }}>
                <RunWindowDisclosure report={runWindow} provenance={provenance} coverage={datasetCoverage} />
              </div>
            )}
            <div className="grid-4">
              <Metric
                label="Total return"
                value={result.metrics.totalReturnPct === null ? '--' : formatPercent(result.metrics.totalReturnPct)}
                tone={result.metrics.totalReturnPct === null ? undefined : result.metrics.totalReturnPct >= 0 ? 'up' : 'down'}
                note={
                  result.metrics.benchmarkTotalReturnPct === null
                    ? 'Buy and hold unavailable'
                    : `Buy and hold ${formatPercent(result.metrics.benchmarkTotalReturnPct)}`
                }
              />
              <Metric label="CAGR" value={result.metrics.cagrPct === null ? '--' : formatPercent(result.metrics.cagrPct)} />
              <Metric
                label="Max drawdown"
                value={result.metrics.maxDrawdownPct === null ? '--' : formatPercent(result.metrics.maxDrawdownPct)}
                tone={result.metrics.maxDrawdownPct === null ? undefined : 'down'}
              />
              <Metric
                label="Volatility"
                value={
                  result.metrics.annualisedVolatilityPct === null
                    ? '--'
                    : formatPercent(result.metrics.annualisedVolatilityPct)
                }
                note="Annualised from the equity curve at the dataset frequency"
              />
              <Metric label="Sharpe" value={result.metrics.sharpe === null ? '--' : result.metrics.sharpe.toFixed(2)} />
              <Metric label="Trades" value={String(result.metrics.tradeCount)} />
              <Metric label="Win rate" value={result.metrics.winRatePct === null ? '--' : formatPercent(result.metrics.winRatePct)} />
              <Metric label="Profit factor" value={result.metrics.profitFactor === null ? (result.metrics.tradeCount > 0 ? 'no losing trades' : '--') : result.metrics.profitFactor.toFixed(2)} />
              <Metric label="Average trade" value={result.metrics.averageTradePct === null ? '--' : formatPercent(result.metrics.averageTradePct)} />
              <Metric
                label="Exposure"
                value={result.metrics.exposurePct === null ? '--' : formatPercent(result.metrics.exposurePct)}
                note="Share of sessions holding a position"
              />
            </div>
          </Panel>

          <ResultsReading
            metrics={result.metrics}
            sessionCount={result.equityCurve.length}
            frequency={frequency}
            savedRunName={loadedRun?.name ?? null}
            savedRunCreatedAt={loadedRun?.createdAt ?? null}
            inputsChanged={loadedInputsDiffer}
          />

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
            <TradeTable trades={result.trades} />
          </Panel>

          {attribution && (
            <Panel title="Performance attribution" subtitle="Descriptive analysis of historical backtest results. These statistics do not predict future performance or establish causation.">
              <div className="stack">
                <div>
                  <span className="field-label">Return concentration</span>
                  {attribution.concentration.unavailableReason ? (
                    <p className="field-hint">{attribution.concentration.unavailableReason}</p>
                  ) : (
                    <ul className="list-reset stack field-hint">
                      <li>Top 1 trade: {attribution.concentration.top1SharePct?.toFixed(1) ?? '--'}% of net profit</li>
                      <li>Top 3 trades: {attribution.concentration.top3SharePct?.toFixed(1) ?? '--'}%</li>
                      <li>Top 5 trades: {attribution.concentration.top5SharePct?.toFixed(1) ?? '--'}%</li>
                      <li>Top 10 trades: {attribution.concentration.top10SharePct?.toFixed(1) ?? '--'}%</li>
                      <li>Total net profit: {attribution.concentration.totalNetPnl.toFixed(2)}</li>
                    </ul>
                  )}
                </div>
                <div>
                  <span className="field-label">Holding periods (bars)</span>
                  <p className="field-hint">
                    Min {attribution.holdingPeriod.minBars ?? '--'} / Max {attribution.holdingPeriod.maxBars ?? '--'} / Mean{' '}
                    {attribution.holdingPeriod.meanBars?.toFixed(1) ?? '--'} / Median{' '}
                    {attribution.holdingPeriod.medianBars?.toFixed(1) ?? '--'}
                  </p>
                  <table className="data">
                    <thead><tr><th>Bucket</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Net PnL</th><th>Win rate</th></tr></thead>
                    <tbody>
                      {attribution.holdingPeriod.byBucket.map((b) => (
                        <tr key={b.label}>
                          <td>{b.label}</td>
                          <td>{b.tradeCount}</td>
                          <td>{b.winCount}</td>
                          <td>{b.lossCount}</td>
                          <td>{b.netPnl.toFixed(2)}</td>
                          <td>{b.winRatePct === null ? '--' : `${b.winRatePct.toFixed(1)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <span className="field-label">Cost drag</span>
                  <ul className="list-reset stack field-hint">
                    <li>Total costs: {attribution.costDrag.totalCosts.toFixed(2)}</li>
                    <li>Gross profit: {attribution.costDrag.grossProfit.toFixed(2)}</li>
                    <li>Gross loss: {attribution.costDrag.grossLoss.toFixed(2)}</li>
                    <li>Net profit: {attribution.costDrag.netPnl.toFixed(2)}</li>
                    <li>Costs per trade: {attribution.costDrag.costsPerTrade?.toFixed(2) ?? '--'}</li>
                    <li>Cost drag: {attribution.costDrag.costDragPct === null ? '--' : `${attribution.costDrag.costDragPct.toFixed(1)}% of gross profit`}</li>
                  </ul>
                </div>
                <div>
                  <span className="field-label">Drawdown episodes</span>
                  {attribution.drawdownEpisodes.episodeCount === 0 ? (
                    <p className="field-hint">No drawdown episodes recorded.</p>
                  ) : (
                    <>
                      <p className="field-hint">
                        Episodes: {attribution.drawdownEpisodes.episodeCount} / Max depth:{' '}
                        {attribution.drawdownEpisodes.maxDepthPct?.toFixed(1) ?? '--'}% / Longest
                        duration: {attribution.drawdownEpisodes.longestDurationBars ?? '--'} bars / Longest recovery:{' '}
                        {attribution.drawdownEpisodes.longestRecoveryBars ?? '--'} bars
                      </p>
                      <table className="data">
                        <thead><tr><th>#</th><th>Peak idx</th><th>Trough idx</th><th>Depth %</th><th>Duration (bars)</th><th>Recovery (bars)</th></tr></thead>
                        <tbody>
                          {attribution.drawdownEpisodes.episodes.map((e, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td>{e.startIndex}</td>
                              <td>{e.troughIndex}</td>
                              <td>{e.depthPct.toFixed(1)}</td>
                              <td>{e.durationBars}</td>
                              <td>{e.recoveryBars === null ? 'unrecovered' : e.recoveryBars}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>
            </Panel>
          )}
        </>
      )}

      <ResearchRunsPanel current={researchSource} onLoadConfig={loadRunConfig} />

      <ResearchRunComparison />

      <Panel title="Execution assumptions" subtitle="Stated plainly so the numbers cannot be mistaken for more than they are">
        <ul className="list-reset stack field-hint">
          {BACKTEST_ASSUMPTIONS.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
          <li>
            <Link to="/learn?section=execution">Walk through the execution model stage by stage</Link>
          </li>
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
      {meta?.needsSecondary && secondaryWindowValue(rule) !== null ? (
        <Field label={meta.secondaryLabel ?? 'Second window'}>
          <NumberInput
            value={secondaryWindowValue(rule) as number}
            min={1}
            max={500}
            step={1}
            onChange={(value) =>
              onChange((current) => ({
                ...current,
                secondaryWindow: Number.isFinite(value)
                  ? Math.max(1, Math.round(value))
                  : secondaryWindowValue(current) ?? 9,
              }))
            }
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
