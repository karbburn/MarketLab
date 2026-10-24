import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChartLineUp, Flask, FunnelSimple, PlayCircle } from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { datasetViews, sessionCount } from '../state/selectors';
import { summarise } from '../lib/quant/metrics';
import { formatPercent, formatPrice, formatSignedPercent } from '../lib/format';
import { Metric, Panel, Tag } from '../components/ui';
import { GetStartedPanel } from '../components/data/GetStartedPanel';

export function OverviewPage() {
  const { state } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const sessions = sessionCount(state);

  const rows = useMemo(
    () =>
      views.map((view) => {
        const bars = view.bars;
        const last = bars[bars.length - 1];
        const previous = bars[bars.length - 2];
        const summary = summarise(bars, view.dataset.frequency);
        const dayChange = last && previous && previous.close !== 0 ? ((last.close - previous.close) / previous.close) * 100 : null;
        return { view, summary, last, dayChange };
      }),
    [views],
  );

  const totalSessions = rows.reduce((total, row) => total + row.summary.sessions, 0);
  const firstDate = rows.reduce<string | null>((earliest, row) => {
    if (!row.summary.firstDate) return earliest;
    if (!earliest) return row.summary.firstDate;
    return row.summary.firstDate < earliest ? row.summary.firstDate : earliest;
  }, null);
  const lastDate = rows.reduce<string | null>((latest, row) => {
    if (!row.summary.lastDate) return latest;
    if (!latest) return row.summary.lastDate;
    return row.summary.lastDate > latest ? row.summary.lastDate : latest;
  }, null);
  const synthetic = rows.some((row) => row.view.dataset.sourceKind === 'bundled-sample');
  const isEmpty = rows.length === 0;

  return (
    <div className="page">
      {isEmpty ? (
        <GetStartedPanel title="Welcome to MarketLab" />
      ) : (
        <>
          <div className="grid-4">
            <Panel title="Datasets">
              <Metric label="Stored locally" value={String(state.datasets.length)} note={`${state.instruments.length} instruments`} />
            </Panel>
            <Panel title="Sessions">
              <Metric label="Total rows" value={totalSessions.toLocaleString('en-US')} note={`${sessions.toLocaleString('en-US')} in memory`} />
            </Panel>
            <Panel title="History span">
              <Metric
                label="Coverage (union)"
                value={firstDate && lastDate ? `${firstDate.slice(0, 7)} to ${lastDate.slice(0, 7)}` : '--'}
                note={firstDate && lastDate ? `Earliest and latest session across the stored series: ${firstDate} through ${lastDate}` : 'No data loaded'}
              />
            </Panel>
            <Panel title="Workspaces">
              <Metric label="Saved" value={String(state.workspaces.length)} note={`${state.watchlists.length} watchlist(s)`} />
            </Panel>
          </div>

          {synthetic && (
            <div className="panel">
              <div className="panel-body row">
                <Tag tone="warn">Legacy demo data</Tag>
                <span className="panel-sub">
                  These series came from an earlier build of the application. They are generated locally from a fixed seed,
                  are not real market data and are not connected to any live feed.
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {!isEmpty && (
        <Panel
          title="Instruments in view"
          subtitle="Metrics are computed from the stored daily bars, not from a live feed"
          flush
          actions={
            <Link className="button sm" to="/chart">
              Open chart workspace
              <ArrowRight size={13} aria-hidden />
            </Link>
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="num">Last close</th>
                  <th className="num">Day</th>
                  <th className="num">Total return</th>
                  <th className="num">CAGR</th>
                  <th className="num">Volatility</th>
                  <th className="num">Max drawdown</th>
                  <th className="num">Sessions</th>
                  <th>Last date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.view.dataset.id}>
                    <td className="mono">{row.view.instrument?.symbol ?? '--'}</td>
                    <td>{row.view.instrument?.displayName ?? row.view.dataset.name}</td>
                    <td className="muted">{row.view.instrument?.assetType ?? '--'}</td>
                    <td className="num">{row.last ? formatPrice(row.last.close) : '--'}</td>
                    <td className={`num ${row.dayChange === null ? '' : row.dayChange >= 0 ? 'up' : 'down'}`}>
                      {row.dayChange === null ? '--' : formatSignedPercent(row.dayChange)}
                    </td>
                    <td className={`num ${row.summary.totalReturnPct === null ? '' : row.summary.totalReturnPct >= 0 ? 'up' : 'down'}`}>
                      {row.summary.totalReturnPct === null ? '--' : formatPercent(row.summary.totalReturnPct)}
                    </td>
                    <td className="num">{row.summary.cagrPct === null ? '--' : formatPercent(row.summary.cagrPct)}</td>
                    <td className="num">{row.summary.annualisedVolatilityPct === null ? '--' : formatPercent(row.summary.annualisedVolatilityPct)}</td>
                    <td className="num down">{row.summary.maxDrawdownPct === null ? '--' : formatPercent(row.summary.maxDrawdownPct)}</td>
                    <td className="num">{row.summary.sessions.toLocaleString('en-US')}</td>
                    <td className="mono">{row.summary.lastDate ?? '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <div className="grid-3">
        <Panel title="Chart workspace" subtitle="Multi-panel charts with linked symbol, timeframe and range">
          <Link className="button primary" to="/chart">
            <ChartLineUp size={14} aria-hidden />
            Open charts
          </Link>
        </Panel>
        <Panel title="Quant lab" subtitle="Risk, drawdown and cross-asset comparison">
          <Link className="button" to="/quant">
            <Flask size={14} aria-hidden />
            Open quant lab
          </Link>
        </Panel>
        <Panel title="Screener and backtest" subtitle="Historical filters and rule-based simulation">
          <div className="row tight">
            <Link className="button" to="/screener">
              <FunnelSimple size={14} aria-hidden />
              Screener
            </Link>
            <Link className="button" to="/backtest">
              <PlayCircle size={14} aria-hidden />
              Backtest
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
