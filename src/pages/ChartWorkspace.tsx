import { useEffect, useMemo, useState } from 'react';
import { Copy, LinkSimple, Plus, Trash } from '@phosphor-icons/react';
import type { LinkProperty, WorkspaceLayout } from '../domain/types';
import { useStore } from '../state/store';
import { activeWorkspace, datasetViews } from '../state/selectors';
import { WORKSPACE_LAYOUTS, chartCountForLayout, duplicateChartConfig, withLayout } from '../state/defaults';
import { formatCompact, formatCount, formatPercent, formatPrice, formatSignedPercent } from '../lib/format';
import { WATCHLIST_CONTEXT_SESSIONS, watchlistContext } from '../lib/watchlist-context';
import { EmptyState, Panel, Segmented, Select, Tag, TextInput, Switch } from '../components/ui';
import { GetStartedPanel } from '../components/data/GetStartedPanel';
import { ChartPanel } from '../components/chart/ChartPanel';

const LINK_PROPERTIES: Array<{ id: LinkProperty; label: string; note: string }> = [
  { id: 'symbol', label: 'Symbol', note: 'Panel symbol and dataset follow the focused panel' },
  { id: 'timeframe', label: 'Timeframe', note: 'Timeframe follows the focused panel' },
  { id: 'visible-range', label: 'Visible range', note: 'Mirror the focused panel zoom across panels' },
];

/** Smallest layout that can render every stored panel. */
function layoutForPanelCount(count: number): WorkspaceLayout {
  if (count <= 1) return 'single';
  if (count === 2) return 'two-vertical';
  return 'four';
}

export function ChartWorkspacePage() {
  const { state, actions } = useStore();
  const workspace = activeWorkspace(state);
  const views = useMemo(() => datasetViews(state), [state]);
  const [focusedChartId, setFocusedChartId] = useState<string | null>(null);
  const [sharedRange, setSharedRange] = useState<{ from: number; to: number } | null>(null);
  const [watchlistByWorkspace, setWatchlistByWorkspace] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const visibleCharts = useMemo(
    () => (workspace ? workspace.charts.slice(0, chartCountForLayout(workspace.layout)) : []),
    [workspace],
  );
  const focusedChart = visibleCharts.find((chart) => chart.id === focusedChartId) ?? visibleCharts[0] ?? null;
  // The focused panel is derived: a stale id simply falls back to the first panel.
  // The workspace remembers the watchlist chosen with "Use on charts"; the local
  // state only wins while it still points at an existing watchlist.
  const workspaceWatchlistId = workspace ? watchlistByWorkspace[workspace.id] : undefined;
  const persistedWatchlistId = workspace?.activeWatchlistId;
  const effectiveWatchlistId =
    (workspaceWatchlistId && state.watchlists.some((entry) => entry.id === workspaceWatchlistId) ? workspaceWatchlistId : null) ??
    (persistedWatchlistId && state.watchlists.some((entry) => entry.id === persistedWatchlistId) ? persistedWatchlistId : null) ??
    state.watchlists[0]?.id ??
    null;

  const chooseWatchlist = (value: string) => {
    if (!workspace) return;
    setWatchlistByWorkspace((previous) => ({ ...previous, [workspace.id]: value }));
    void actions.updateWorkspace(workspace.id, (current) => ({ ...current, activeWatchlistId: value }));
  };

  const linkGroup = workspace?.linkGroups[0] ?? null;
  const linkProperties = linkGroup?.properties ?? [];
  const linksEnabled = (property: LinkProperty) => linkProperties.includes(property);

  const writeLinkProperties = (properties: LinkProperty[]) => {
    if (!workspace) return;
    void actions.updateWorkspace(workspace.id, (current) => ({
      ...current,
      linkGroups: [
        {
          id: current.linkGroups[0]?.id ?? `link_${current.id}`,
          name: current.linkGroups[0]?.name ?? 'Linked panels',
          chartIds: current.charts.map((chart) => chart.id),
          // `crosshair` is not implemented; drop any stored value rather than
          // persisting a property that nothing reads.
          properties: properties.filter((property) => property !== 'crosshair'),
        },
      ],
    }));
  };

  // Propagate symbol, dataset and timeframe from the focused panel to its links.
  useEffect(() => {
    if (!workspace || !focusedChart) return;
    const properties = workspace.linkGroups[0]?.properties ?? [];
    const symbolLinked = properties.includes('symbol');
    const timeframeLinked = properties.includes('timeframe');
    if (!symbolLinked && !timeframeLinked) return;
    const needsSync = workspace.charts.some((chart) => {
      if (chart.id === focusedChart.id) return false;
      if (symbolLinked && (chart.instrumentId !== focusedChart.instrumentId || chart.datasetId !== focusedChart.datasetId)) return true;
      if (timeframeLinked && chart.timeframe !== focusedChart.timeframe) return true;
      return false;
    });
    if (!needsSync) return;
    void actions.updateWorkspace(workspace.id, (current) => ({
      ...current,
      charts: current.charts.map((chart) =>
        chart.id === focusedChart.id
          ? chart
          : {
              ...chart,
              ...(symbolLinked ? { instrumentId: focusedChart.instrumentId, datasetId: focusedChart.datasetId } : {}),
              ...(timeframeLinked ? { timeframe: focusedChart.timeframe } : {}),
            },
      ),
    }));
  }, [workspace, focusedChart, actions]);

  if (!workspace) {
    return (
      <div className="page">
        {views.length === 0 ? (
          <GetStartedPanel title="Nothing to chart yet" />
        ) : (
          <Panel
            title="No workspace"
            subtitle="A workspace holds the panels, indicators and drawings for the series you chart."
          >
            <div className="stack">
              <p className="panel-sub">
                There is no workspace stored in this browser. Create one from the series you already have.
              </p>
              <div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    const first = views[0];
                    if (!first?.instrument) return;
                    void actions.createWorkspaceFromBase({
                      name: 'Primary',
                      datasetId: first.dataset.id,
                      instrumentId: first.instrument.id,
                    });
                  }}
                >
                  Create a workspace
                </button>
              </div>
            </div>
          </Panel>
        )}
      </div>
    );
  }

  const activeWatchlist = state.watchlists.find((entry) => entry.id === effectiveWatchlistId) ?? null;
  const watchlistViews = activeWatchlist
    ? activeWatchlist.instrumentIds
        .map((instrumentId) => views.find((view) => view.instrument?.id === instrumentId))
        .filter((view): view is (typeof views)[number] => Boolean(view))
    : [];

  const assignToFocused = (datasetId: string, instrumentId: string) => {
    if (!focusedChart) return;
    void actions.updateChart(workspace.id, focusedChart.id, (config) => ({ ...config, datasetId, instrumentId }));
  };

  return (
    <div className="page">
      <Panel
        title="Workspace"
        subtitle={`${workspace.charts.length} panel(s) stored, ${visibleCharts.length} rendered in this layout`}
        actions={
          <div className="row tight">
            {renaming ? (
              <>
                <TextInput ariaLabel="Workspace name" value={nameDraft} onChange={setNameDraft} />
                <button
                  type="button"
                  className="button sm primary"
                  onClick={() => {
                    void actions.updateWorkspace(workspace.id, (current) => ({ ...current, name: nameDraft.trim() || current.name }));
                    setRenaming(false);
                  }}
                >
                  Save
                </button>
                <button type="button" className="button sm ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <Select
                  ariaLabel="Active workspace"
                  value={workspace.id}
                  onChange={(value) => void actions.setActiveWorkspace(value)}
                  options={state.workspaces.map((entry) => ({ value: entry.id, label: entry.name }))}
                />
                <button
                  type="button"
                  className="button sm"
                  onClick={() => {
                    setNameDraft(workspace.name);
                    setRenaming(true);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="button sm danger"
                  onClick={() => void actions.deleteWorkspace(workspace.id)}
                  disabled={state.workspaces.length <= 1}
                >
                  <Trash size={13} aria-hidden />
                  Delete
                </button>
              </>
            )}
          </div>
        }
      >
        <div className="stack">
          <div className="row">
            <span className="field-label">Layout</span>
            <Segmented
              label="Panel layout"
              value={workspace.layout}
              onChange={(value: WorkspaceLayout) => void actions.updateWorkspace(workspace.id, (current) => withLayout(current, value))}
              options={WORKSPACE_LAYOUTS.map((layout) => ({ value: layout.id, label: layout.label, title: `${layout.chartCount} panel(s)` }))}
            />
            <span className="field-hint">Reducing the layout hides panels without deleting them or their drawings.</span>
          </div>

          <div className="row">
            <span className="field-label">Link groups</span>
            {LINK_PROPERTIES.map((property) => (
              <label key={property.id} className="row tight" title={property.note}>
                <input
                  type="checkbox"
                  checked={linksEnabled(property.id)}
                  onChange={() =>
                    writeLinkProperties(
                      linkProperties.includes(property.id)
                        ? linkProperties.filter((entry) => entry !== property.id)
                        : [...linkProperties, property.id],
                    )
                  }
                />
                <span className="field-label">
                  <LinkSimple size={12} aria-hidden /> {property.label}
                </span>
              </label>
            ))}
            <span className="field-hint">Range mirroring only applies to panels showing the same dataset and timeframe.</span>
          </div>

          <div className="row">
            <span className="field-label">Focused panel</span>
            {focusedChart ? (
              <>
                <Select
                  ariaLabel="Focused panel dataset"
                  value={focusedChart.datasetId}
                  onChange={(value) => {
                    const view = views.find((entry) => entry.dataset.id === value);
                    if (view?.instrument) assignToFocused(view.dataset.id, view.instrument.id);
                  }}
                  options={views.map((view) => ({
                    value: view.dataset.id,
                    label: `${view.instrument?.symbol ?? view.dataset.name} - ${view.dataset.frequency}`,
                  }))}
                />
                <Switch
                  checked={focusedChart.showVolume}
                  label="Volume pane"
                  onChange={(checked) => void actions.updateChart(workspace.id, focusedChart.id, (config) => ({ ...config, showVolume: checked }))}
                />
                <button
                  type="button"
                  className="button sm"
                  disabled={workspace.charts.length >= 4}
                  title={workspace.charts.length >= 4 ? 'Four panels is the maximum layout' : undefined}
                  onClick={() =>
                    void actions.updateWorkspace(workspace.id, (current) => {
                      const source = current.charts.find((chart) => chart.id === focusedChart.id);
                      if (!source) return current;
                      const charts = [...current.charts, duplicateChartConfig(source)];
                      // Grow the layout so the new panel is visible immediately.
                      const layout = charts.length > chartCountForLayout(current.layout) ? layoutForPanelCount(charts.length) : current.layout;
                      return { ...current, charts, layout };
                    })
                  }
                >
                  <Copy size={13} aria-hidden />
                  Duplicate panel
                </button>
                {workspace.charts.length >= 4 && <span className="field-hint">Four panels is the maximum layout.</span>}
                <button
                  type="button"
                  className="button sm danger"
                  disabled={workspace.charts.length <= 1}
                  onClick={() => void actions.updateWorkspace(workspace.id, (current) => ({ ...current, charts: current.charts.filter((chart) => chart.id !== focusedChart.id) }))}
                >
                  Remove panel
                </button>
              </>
            ) : (
              <span className="field-hint">No panel in this layout.</span>
            )}
          </div>
        </div>
      </Panel>

      <div className="page-split">
        <div className={`workspace-grid ${workspace.layout}`}>
          {visibleCharts.map((chart) => (
            <ChartPanel
              key={chart.id}
              chart={chart}
              workspaceId={workspace.id}
              view={views.find((entry) => entry.dataset.id === chart.datasetId) ?? null}
              focused={chart.id === focusedChart?.id}
              onFocus={() => setFocusedChartId(chart.id)}
              onRangeChange={chart.id === focusedChart?.id && linksEnabled('visible-range') ? setSharedRange : undefined}
              appliedRange={
                chart.id !== focusedChart?.id &&
                linksEnabled('visible-range') &&
                sharedRange &&
                chart.datasetId === focusedChart?.datasetId &&
                chart.timeframe === focusedChart?.timeframe
                  ? sharedRange
                  : null
              }
            />
          ))}
        </div>

        <div className="stack">
          <Panel
            title="Watchlist"
            subtitle={activeWatchlist ? `${watchlistViews.length} instrument(s)` : 'None selected'}
            actions={
              <div className="row tight">
                <Select
                  ariaLabel="Chart watchlist"
                  value={activeWatchlist?.id ?? ''}
                  onChange={chooseWatchlist}
                  options={state.watchlists.map((entry) => ({ value: entry.id, label: entry.name }))}
                />
                <button
                  type="button"
                  className="button sm ghost"
                  onClick={async () => {
                    const id = await actions.createWatchlistNamed(`Watchlist ${state.watchlists.length + 1}`, []);
                    chooseWatchlist(id);
                  }}
                >
                  <Plus size={13} aria-hidden />
                  New
                </button>
              </div>
            }
          >
            {!activeWatchlist ? (
              <EmptyState title="No watchlist" body="Create a watchlist to keep a short instrument list next to the charts." />
            ) : watchlistViews.length === 0 ? (
              <EmptyState title="Empty watchlist" body="Add instruments from the list below." />
            ) : (
              <div className="table-wrap">
                <table className="data watchlist-table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th className="num">Last</th>
                      <th className="num">Day</th>
                      <th className="num" title="Average reported volume over the last 30 sessions">
                        Avg vol 30
                      </th>
                      <th className="num" title="High-low spread as a percentage of the low over the last 30 sessions">
                        Range 30
                      </th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {watchlistViews.map((view) => {
                      const context = watchlistContext(view.bars);
                      const windowLabel =
                        context.sessions === WATCHLIST_CONTEXT_SESSIONS
                          ? `${context.sessions} sessions`
                          : `${context.sessions} available session${context.sessions === 1 ? '' : 's'}`;
                      const volumeTitle =
                        context.averageVolume === null
                          ? 'No volume was reported for the context window.'
                          : `Average volume of ${formatCount(Math.round(context.averageVolume))} from ${context.volumeSessions} reporting session${
                              context.volumeSessions === 1 ? '' : 's'
                            } over the last ${windowLabel}${
                              context.volumeSessions < context.sessions ? '; missing volume excluded' : ''
                            }.`;
                      const rangeTitle =
                        context.low === null || context.high === null
                          ? 'High and low prices are unavailable for the context window.'
                          : `High-low range over the last ${windowLabel}: ${formatPrice(context.low)} to ${formatPrice(
                              context.high,
                            )}${context.rangePct === null ? '' : ` (${formatPercent(context.rangePct, 1)} of the low)`}.`;
                      const isFocused = focusedChart?.datasetId === view.dataset.id;
                      return (
                        <tr key={view.dataset.id} className={isFocused ? '' : undefined}>
                          <td>
                            <button
                              type="button"
                              className="button ghost sm"
                              onClick={() => view.instrument && assignToFocused(view.dataset.id, view.instrument.id)}
                              title="Show in the focused panel"
                            >
                              {view.instrument?.symbol ?? '--'}
                            </button>
                          </td>
                          <td className="num">{context.lastClose === null ? '--' : formatPrice(context.lastClose)}</td>
                          <td className={`num ${context.changePct === null ? '' : context.changePct >= 0 ? 'up' : 'down'}`}>
                            {context.changePct === null ? '--' : formatSignedPercent(context.changePct)}
                          </td>
                          <td className="num" title={volumeTitle}>
                            {context.averageVolume === null ? '--' : formatCompact(context.averageVolume)}
                          </td>
                          <td className="num" title={rangeTitle}>
                            {context.rangePct === null ? '--' : formatPercent(context.rangePct, 1)}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="button ghost sm"
                              aria-label={`Remove ${view.instrument?.symbol ?? 'instrument'} from the watchlist`}
                              onClick={() =>
                                void actions.saveWatchlist({
                                  ...activeWatchlist,
                                  instrumentIds: activeWatchlist.instrumentIds.filter((id) => id !== view.instrument?.id),
                                })
                              }
                            >
                              <Trash size={12} aria-hidden />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {activeWatchlist && watchlistViews.length > 0 && (
              <div className="watchlist-note">
                <span className="panel-sub">
                  Avg vol and range use the last {WATCHLIST_CONTEXT_SESSIONS} sessions; shorter histories use every
                  available session. Range is the high-low spread as a percentage of the low, and missing volume is
                  excluded from the average.
                </span>
              </div>
            )}
          </Panel>

          <Panel title="All instruments" subtitle="Click to load into the focused panel">
            <div className="stack scroll-y">
              {views.map((view) => {
                const inWatchlist = activeWatchlist?.instrumentIds.includes(view.instrument?.id ?? '') ?? false;
                return (
                  <div key={view.dataset.id} className="spread">
                    <div style={{ display: 'grid', gap: 1 }}>
                      <span className="mono">{view.instrument?.symbol ?? '--'}</span>
                      <span className="panel-sub">
                        {view.instrument?.displayName ?? view.dataset.name}
                        {view.dataset.sourceKind === 'bundled-sample' && ' - legacy demo data'}
                        {view.dataset.sourceKind === 'provider-download' && ' - downloaded'}
                      </span>
                    </div>
                    <div className="row tight">
                      {view.dataset.sourceKind === 'bundled-sample' && <Tag tone="warn">Sample</Tag>}
                      {view.dataset.sourceKind === 'provider-download' && <Tag tone="accent">Download</Tag>}
                      <button
                        type="button"
                        className="button sm ghost"
                        disabled={!activeWatchlist || inWatchlist}
                        onClick={() =>
                          activeWatchlist &&
                          !inWatchlist &&
                          view.instrument &&
                          void actions.saveWatchlist({ ...activeWatchlist, instrumentIds: [...activeWatchlist.instrumentIds, view.instrument.id] })
                        }
                      >
                        <Plus size={12} aria-hidden />
                        Watch
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Shortcuts">
            <ul className="list-reset stack field-hint">
              <li>Drag on empty chart space to pan, scroll to zoom.</li>
              <li>Pick a drawing tool, then click once for a level or twice for a two-point shape.</li>
              <li>The text tool opens a field where you click; double-click a label to change it.</li>
              <li>Escape cancels a half-drawn shape and returns to the pointer tool.</li>
              <li>Delete removes the selected drawing, Ctrl+Z undoes and Ctrl+Shift+Z redoes.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
