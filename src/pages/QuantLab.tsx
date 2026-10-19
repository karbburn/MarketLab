import { useMemo, useState } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { betaAlpha, historicalVarPct, simpleReturns, summarise } from '../lib/quant/metrics';
import {
  alignOnCommonDates,
  correlationMatrix,
  normalisedPerformance,
  rollingDrawdownPct,
  rollingVolatilityPct,
} from '../lib/quant/comparison';
import { formatPercent, formatPrice } from '../lib/format';
import { downloadTextFile } from '../lib/export/download';
import { quantSummaryToCsv } from '../lib/export/csv';
import { EmptyState, Field, Metric, NumberInput, Panel, Select, Tag } from '../components/ui';
import { LineChart, type ChartSeries } from '../components/charts/LineChart';

const PALETTE = ['#3fb8a3', '#d8a13f', '#5b9bd5', '#e2586a', '#35c48d', '#8aa0b8'];

export function QuantLabPage() {
  const { state } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [benchmarkId, setBenchmarkId] = useState<string | null>(null);
  const [window, setWindow] = useState(60);
  const [matrixIds, setMatrixIds] = useState<string[]>([]);

  const primary = views.find((view) => view.dataset.id === primaryId) ?? views[0] ?? null;
  const benchmark = views.find((view) => view.dataset.id === benchmarkId) ?? null;

  const metrics = useMemo(() => {
    if (!primary) return null;
    const summary = summarise(primary.bars);
    const returns = simpleReturns(primary.bars.map((bar) => bar.close));
    let beta: ReturnType<typeof betaAlpha> | null = null;
    if (benchmark) {
      const aligned = alignOnCommonDates([primary.bars, benchmark.bars]);
      if (aligned.closes.length === 2) {
        const assetReturns = simpleReturns(aligned.closes[0] as number[]);
        const benchmarkReturns = simpleReturns(aligned.closes[1] as number[]);
        beta = betaAlpha(assetReturns, benchmarkReturns);
      }
    }
    return { summary, returns, beta };
  }, [primary, benchmark]);

  const performance = useMemo(() => {
    if (!primary) return [] as ChartSeries[];
    const sources = benchmark ? [primary.bars, benchmark.bars] : [primary.bars];
    const aligned = alignOnCommonDates(sources);
    if (aligned.dates.length === 0) {
      const normalised = normalisedPerformance(
        primary.bars.map((bar) => bar.date),
        primary.bars.map((bar) => bar.close),
      );
      return [
        {
          id: primary.dataset.id,
          label: primary.instrument?.symbol ?? primary.dataset.name,
          color: PALETTE[0] as string,
          points: normalised.values.map((value, index) => ({ x: index, y: value })),
        },
      ];
    }
    return aligned.closes.map((closes, index) => {
      const normalised = normalisedPerformance(aligned.dates, closes);
      const source = index === 0 ? primary : benchmark;
      return {
        id: source?.dataset.id ?? `series-${index}`,
        label: source?.instrument?.symbol ?? source?.dataset.name ?? `series ${index + 1}`,
        color: PALETTE[index % PALETTE.length] as string,
        points: normalised.values.map((value, pointIndex) => ({ x: pointIndex, y: value })),
      };
    });
  }, [primary, benchmark]);

  const rollingVol = useMemo(() => {
    if (!primary || primary.bars.length < window + 2) return [] as ChartSeries[];
    const dates = primary.bars.map((bar) => bar.date);
    const closes = primary.bars.map((bar) => bar.close);
    const points = rollingVolatilityPct(dates, closes, window)
      .map((point, index) => ({ x: index, y: point.value }))
      .filter((point): point is { x: number; y: number } => point.y !== null);
    return [
      {
        id: 'vol',
        label: `Annualised volatility, ${window}-session window`,
        color: PALETTE[1] as string,
        points,
      },
    ];
  }, [primary, window]);

  const drawdown = useMemo(() => {
    if (!primary) return [] as ChartSeries[];
    const dates = primary.bars.map((bar) => bar.date);
    const closes = primary.bars.map((bar) => bar.close);
    const points = rollingDrawdownPct(dates, closes)
      .map((point, index) => ({ x: index, y: point.value }))
      .filter((point): point is { x: number; y: number } => point.y !== null);
    return [{ id: 'dd', label: 'Drawdown from running peak', color: PALETTE[3] as string, points }];
  }, [primary]);

  const matrix = useMemo(() => {
    const selected = views.filter((view) => matrixIds.includes(view.dataset.id));
    if (selected.length < 2) return null;
    const aligned = alignOnCommonDates(selected.map((view) => view.bars));
    if (aligned.dates.length < 3) return null;
    const labels = selected.map((view) => view.instrument?.symbol ?? view.dataset.name);
    return { labels, values: correlationMatrix(labels, aligned.closes).values, sessions: aligned.dates.length };
  }, [views, matrixIds]);

  if (views.length === 0) {
    return (
      <div className="page">
        <Panel title="Quant lab">
          <EmptyState title="No data" body="Import a CSV or reset local data to run risk and comparison analytics." />
        </Panel>
      </div>
    );
  }

  const symbols = primary ? primary.instrument?.symbol ?? primary.dataset.name : '--';

  return (
    <div className="page">
      <Panel
        title="Selection"
        subtitle="Analytics are computed only from the sessions you have stored"
        actions={
          metrics &&
          primary && (
            <button
              type="button"
              className="button sm"
              onClick={() =>
                downloadTextFile(`marketlab-quant-${symbols}.csv`, quantSummaryToCsv(symbols, metrics.summary), 'text/csv')
              }
            >
              <DownloadSimple size={13} aria-hidden />
              Export summary
            </button>
          )
        }
      >
        <div className="grid-4">
          <Field label="Instrument">
            <Select
              value={primary?.dataset.id ?? ''}
              onChange={(value) => setPrimaryId(value)}
              options={views.map((view) => ({ value: view.dataset.id, label: `${view.instrument?.symbol ?? view.dataset.name} - ${view.dataset.frequency}` }))}
            />
          </Field>
          <Field label="Benchmark" hint="Optional. Beta, alpha and correlation need a second series.">
            <Select
              value={benchmark?.dataset.id ?? ''}
              onChange={(value) => setBenchmarkId(value === '' ? null : value)}
              options={[{ value: '', label: 'None' }, ...views.map((view) => ({ value: view.dataset.id, label: view.instrument?.symbol ?? view.dataset.name }))]}
            />
          </Field>
          <Field label="Rolling window" hint="Sessions used for rolling volatility.">
            <NumberInput value={window} min={5} max={500} step={5} onChange={(value) => setWindow(Number.isFinite(value) ? Math.max(5, Math.round(value)) : 60)} />
          </Field>
          <Field label="Coverage">
            <div className="row tight">
              <Tag>{primary ? `${primary.bars.length} sessions` : '--'}</Tag>
              {primary && <Tag>{primary.dataset.contentHash.slice(0, 12)}</Tag>}
            </div>
          </Field>
        </div>
      </Panel>

      {primary && metrics && (
        <>
          <Panel title={`Risk and return - ${symbols}`} subtitle={primary.dataset.sourceDescription}>
            <div className="grid-4">
              <Metric label="Total return" value={metrics.summary.totalReturnPct === null ? '--' : formatPercent(metrics.summary.totalReturnPct)} tone={metrics.summary.totalReturnPct !== null && metrics.summary.totalReturnPct >= 0 ? 'up' : 'down'} />
              <Metric label="CAGR" value={metrics.summary.cagrPct === null ? '--' : formatPercent(metrics.summary.cagrPct)} />
              <Metric label="Volatility" value={metrics.summary.annualisedVolatilityPct === null ? '--' : formatPercent(metrics.summary.annualisedVolatilityPct)} note="Annualised, sample standard deviation" />
              <Metric label="Sharpe" value={metrics.summary.sharpe === null ? '--' : metrics.summary.sharpe.toFixed(2)} note="Risk-free rate assumed at zero" />
              <Metric label="Sortino" value={metrics.summary.sortino === null ? '--' : metrics.summary.sortino.toFixed(2)} note="Downside deviation only" />
              <Metric label="Max drawdown" value={metrics.summary.maxDrawdownPct === null ? '--' : formatPercent(metrics.summary.maxDrawdownPct)} tone="down" />
              <Metric label="Ulcer index" value={metrics.summary.ulcerIndexPct === null ? '--' : metrics.summary.ulcerIndexPct.toFixed(2)} note="Root mean square drawdown" />
              <Metric label="Calmar" value={metrics.summary.calmar === null ? '--' : metrics.summary.calmar.toFixed(2)} />
              <Metric label="VaR 95" value={metrics.summary.var95Pct === null ? '--' : formatPercent(metrics.summary.var95Pct)} note="Historical, one session" />
              <Metric label="CVaR 95" value={metrics.summary.cvar95Pct === null ? '--' : formatPercent(metrics.summary.cvar95Pct)} note="Expected shortfall beyond VaR" />
              <Metric label="Best session" value={metrics.summary.bestDayPct === null ? '--' : formatPercent(metrics.summary.bestDayPct)} tone="up" />
              <Metric label="Worst session" value={metrics.summary.worstDayPct === null ? '--' : formatPercent(metrics.summary.worstDayPct)} tone="down" />
              <Metric label="Up-day rate" value={metrics.summary.positiveDayRatePct === null ? '--' : formatPercent(metrics.summary.positiveDayRatePct)} />
              <Metric label="Skewness" value={metrics.summary.skewness === null ? '--' : metrics.summary.skewness.toFixed(2)} note="Sample skew of daily returns" />
              <Metric label="Excess kurtosis" value={metrics.summary.excessKurtosis === null ? '--' : metrics.summary.excessKurtosis.toFixed(2)} note="Tail thickness versus normal" />
              <Metric
                label={benchmark ? `Beta vs ${benchmark.instrument?.symbol ?? ''}` : 'Beta'}
                value={metrics.beta?.beta == null ? '--' : metrics.beta.beta.toFixed(2)}
                note={metrics.beta?.rSquared == null ? 'Select a benchmark to compute' : `R squared ${metrics.beta.rSquared.toFixed(2)}`}
              />
            </div>
          </Panel>

          <div className="grid-2">
            <Panel title="Normalised performance" subtitle="Percent change from the first common session">
              <LineChart
                series={performance}
                height={220}
                baseline={0}
                yFormat={(value) => `${value.toFixed(0)}%`}
                ariaLabel={`Normalised performance of ${symbols}`}
                xLabels={
                  primary.bars.length > 1
                    ? [
                        { x: 0, label: (primary.bars[0] as { date: string }).date },
                        { x: 1, label: (primary.bars[primary.bars.length - 1] as { date: string }).date },
                      ]
                    : []
                }
              />
            </Panel>
            <Panel title="Rolling volatility" subtitle={`Annualised, ${window}-session window`}>
              {rollingVol[0]?.points.length ? (
                <LineChart series={rollingVol} height={220} yFormat={(value) => `${value.toFixed(0)}%`} ariaLabel="Rolling annualised volatility" />
              ) : (
                <EmptyState title="Not enough sessions" body={`At least ${window + 2} sessions are required for this window.`} />
              )}
            </Panel>
          </div>

          <Panel title="Drawdown profile" subtitle="Percentage below the running peak">
            <LineChart series={drawdown} height={200} baseline={0} yFormat={(value) => `${value.toFixed(1)}%`} ariaLabel="Drawdown profile" />
          </Panel>
        </>
      )}

      <Panel
        title="Correlation matrix"
        subtitle={matrix ? `${matrix.sessions} shared sessions across ${matrix.labels.length} series` : 'Select two or more series'}
      >
        <div className="stack">
          <div className="row">
            {views.map((view) => (
              <label key={view.dataset.id} className="row tight">
                <input
                  type="checkbox"
                  checked={matrixIds.includes(view.dataset.id)}
                  onChange={() =>
                    setMatrixIds((previous) =>
                      previous.includes(view.dataset.id)
                        ? previous.filter((id) => id !== view.dataset.id)
                        : [...previous, view.dataset.id],
                    )
                  }
                />
                <span className="field-label">{view.instrument?.symbol ?? view.dataset.name}</span>
              </label>
            ))}
            <button type="button" className="button ghost sm" onClick={() => setMatrixIds(views.map((view) => view.dataset.id))}>
              Select all
            </button>
            <button type="button" className="button ghost sm" onClick={() => setMatrixIds([])}>
              Clear
            </button>
          </div>
          {matrix ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    {matrix.labels.map((label) => (
                      <th key={label} className="num">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.labels.map((rowLabel, rowIndex) => (
                    <tr key={rowLabel}>
                      <th>{rowLabel}</th>
                      {matrix.values[rowIndex]?.map((value, columnIndex) => (
                        <td key={`${rowLabel}-${matrix.labels[columnIndex] ?? columnIndex}`} className="num">
                          {value === null ? '--' : renderCorrelation(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <span className="field-hint">Select at least two series with overlapping sessions to build the matrix.</span>
          )}
        </div>
      </Panel>

      <Panel title="Cross-asset comparison" subtitle="Independent series, each measured over its own available sessions" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Sessions</th>
                <th className="num">Total return</th>
                <th className="num">Volatility</th>
                <th className="num">Max drawdown</th>
                <th className="num">Sharpe</th>
                <th className="num">VaR 95</th>
                <th className="num">Last close</th>
              </tr>
            </thead>
            <tbody>
              {views.map((view) => {
                const summary = summarise(view.bars);
                const returns = simpleReturns(view.bars.map((bar) => bar.close));
                const last = view.bars[view.bars.length - 1];
                return (
                  <tr key={view.dataset.id}>
                    <td className="mono">{view.instrument?.symbol ?? '--'}</td>
                    <td className="num">{summary.sessions}</td>
                    <td className={`num ${summary.totalReturnPct === null ? '' : summary.totalReturnPct >= 0 ? 'up' : 'down'}`}>
                      {summary.totalReturnPct === null ? '--' : formatPercent(summary.totalReturnPct)}
                    </td>
                    <td className="num">{summary.annualisedVolatilityPct === null ? '--' : formatPercent(summary.annualisedVolatilityPct)}</td>
                    <td className="num down">{summary.maxDrawdownPct === null ? '--' : formatPercent(summary.maxDrawdownPct)}</td>
                    <td className="num">{summary.sharpe === null ? '--' : summary.sharpe.toFixed(2)}</td>
                    <td className="num">{historicalVarPct(returns, 0.95) === null ? '--' : formatPercent(historicalVarPct(returns, 0.95) as number)}</td>
                    <td className="num">{last ? formatPrice(last.close) : '--'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {metrics && primary && (
        <Panel title="Method notes">
          <ul className="list-reset stack field-hint">
            <li>Returns are simple session-over-session changes in close. No dividends, splits or fees are implied.</li>
            <li>Annualisation uses 252 sessions. CAGR uses calendar years between the first and last session, and is withheld for spans under 30 days.</li>
            <li>
              VaR and CVaR are historical (non-parametric) and need at least 20 returns.
              {historicalVarPct(metrics.returns, 0.95) === null ? ' This series is below that threshold, so both are withheld.' : ''}
            </li>
            <li>Maximum drawdown is close-to-close, not an intraday peak-to-trough measure.</li>
            <li>Multi-series comparison uses only dates present in every selected series. Nothing is forward-filled or interpolated.</li>
            <li>Correlation is Pearson on daily simple returns, computed on the shared sessions only.</li>
            <li>Beta and alpha are regressed on aligned daily returns with a zero risk-free rate; alpha is annualised.</li>
          </ul>
        </Panel>
      )}
    </div>
  );
}

function renderCorrelation(value: number): string {
  if (Number.isNaN(value)) return '--';
  return value.toFixed(2);
}
