import { useMemo, useState } from 'react';
import { Database, DownloadSimple, Eye } from '@phosphor-icons/react';
import type { Workspace } from '../domain/types';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { downloadTextFile } from '../lib/export/download';
import { barsToCsv, validationToCsv } from '../lib/export/csv';
import { formatPrice } from '../lib/format';
import { EmptyState, Metric, Panel, Tag } from '../components/ui';

function affectedPanels(datasetId: string, workspaces: readonly Workspace[]): number {
  return workspaces.reduce(
    (total, workspace) => total + workspace.charts.filter((chart) => chart.datasetId === datasetId).length,
    0,
  );
}

function affectedDrawings(datasetId: string, workspaces: readonly Workspace[]): number {
  return workspaces.reduce(
    (total, workspace) =>
      total +
      workspace.charts
        .filter((chart) => chart.datasetId === datasetId)
        .reduce((count, chart) => count + chart.drawings.length, 0),
    0,
  );
}

export function DataPage() {
  const { state, actions } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const selected = views.find((view) => view.dataset.id === selectedId) ?? null;
  const previewHead = selected ? selected.bars.slice(0, 12) : [];
  // Only add the tail when it cannot overlap the head, so no session is printed
  // twice and the omitted count can never go negative.
  const previewTail = selected && selected.bars.length > 18 ? selected.bars.slice(-6) : [];
  const omittedRows = selected ? Math.max(0, selected.bars.length - previewHead.length - previewTail.length) : 0;

  return (
    <div className="page">
      <Panel
        title="Stored datasets"
        subtitle={`${views.length} dataset(s) - ${state.adapterKind === 'indexeddb' ? 'persisted in this browser' : 'in memory only for this session'}`}
        flush
      >
        {views.length === 0 ? (
          <EmptyState
            icon={<Database size={22} aria-hidden />}
            title="No datasets"
            body="Import a CSV file from the top bar, or reset local data to restore the bundled sample set."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Frequency</th>
                  <th className="num">Sessions</th>
                  <th>First</th>
                  <th>Last</th>
                  <th>Volume</th>
                  <th>Hash</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {views.map((view) => (
                  <tr key={view.dataset.id}>
                    <td className="mono">{view.instrument?.symbol ?? '--'}</td>
                    <td>{view.instrument?.displayName ?? view.dataset.name}</td>
                    <td>
                      {view.dataset.sourceKind === 'bundled-sample' ? <Tag tone="warn">Synthetic sample</Tag> : <Tag tone="accent">Imported CSV</Tag>}
                    </td>
                    <td className="muted">{view.dataset.frequency}</td>
                    <td className="num">{view.dataset.rowCount.toLocaleString('en-US')}</td>
                    <td className="mono">{view.dataset.firstDate}</td>
                    <td className="mono">{view.dataset.lastDate}</td>
                    <td className="muted">{view.dataset.hasVolume ? 'present' : 'absent'}</td>
                    <td className="mono faint">{view.dataset.contentHash.slice(0, 10)}</td>
                    <td>
                      <div className="row tight">
                        <button type="button" className="button ghost sm" onClick={() => setSelectedId(view.dataset.id)}>
                          <Eye size={12} aria-hidden />
                          Inspect
                        </button>
                        <button
                          type="button"
                          className="button ghost sm"
                          onClick={() =>
                            downloadTextFile(
                              `marketlab-${(view.instrument?.symbol ?? view.dataset.id).toLowerCase()}-${view.dataset.frequency}.csv`,
                              barsToCsv(view.bars),
                              'text/csv',
                            )
                          }
                        >
                          <DownloadSimple size={12} aria-hidden />
                          Export
                        </button>
                        {confirmDeleteId === view.dataset.id ? (
                          <span className="row tight">
                            <span className="field-hint">
                              Removes {affectedPanels(view.dataset.id, state.workspaces)} panel(s) and{' '}
                              {affectedDrawings(view.dataset.id, state.workspaces)} drawing(s)
                            </span>
                            <button
                              type="button"
                              className="button ghost sm danger"
                              onClick={() => {
                                setConfirmDeleteId(null);
                                void actions.deleteDataset(view.dataset.id);
                              }}
                            >
                              Delete dataset
                            </button>
                            <button type="button" className="button ghost sm" onClick={() => setConfirmDeleteId(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="button ghost sm danger" onClick={() => setConfirmDeleteId(view.dataset.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && (
        <>
          <Panel
            title={`Inspection - ${selected.instrument?.symbol ?? selected.dataset.name}`}
            subtitle={selected.dataset.sourceDescription}
            actions={
              <button type="button" className="button sm" onClick={() => setSelectedId(null)}>
                Close
              </button>
            }
          >
            <div className="grid-4">
              <Metric label="Accepted rows" value={selected.dataset.validation.acceptedRows.toLocaleString('en-US')} />
              <Metric label="Rejected rows" value={selected.dataset.validation.rejectedRows.toLocaleString('en-US')} />
              <Metric label="Duplicate sessions" value={selected.dataset.validation.duplicateRows.toLocaleString('en-US')} />
              <Metric label="Missing sessions" value={selected.dataset.validation.gapCount.toLocaleString('en-US')} note="Weekday gaps inside the stored range" />
              <Metric label="Rows without volume" value={selected.dataset.validation.missingVolumeRows.toLocaleString('en-US')} />
              <Metric label="Order corrections" value={selected.dataset.validation.sortCorrections.toLocaleString('en-US')} note="Rows re-sorted by date" />
              <Metric label="Imported" value={selected.dataset.importedAt.slice(0, 10)} note={selected.dataset.timezone} />
              <Metric label="Content hash" value={selected.dataset.contentHash.slice(0, 14)} note="Stable across identical imports" />
            </div>
            {selected.dataset.validation.warnings.length > 0 && (
              <ul className="list-reset stack field-hint" style={{ marginTop: 10 }}>
                {selected.dataset.validation.warnings.map((warning) => (
                  <li key={warning.code}>
                    {warning.message}
                    {warning.count !== undefined ? ` (${warning.count})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Bars"
            subtitle={
              previewTail.length > 0
                ? `First ${previewHead.length} and last ${previewTail.length} rows of ${selected.bars.length}`
                : `${previewHead.length} of ${selected.bars.length} rows`
            }
            flush
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Open</th>
                    <th className="num">High</th>
                    <th className="num">Low</th>
                    <th className="num">Close</th>
                    <th className="num">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {previewHead.map((bar) => (
                    <tr key={bar.date}>
                      <td className="mono">{bar.date}</td>
                      <td className="num">{formatPrice(bar.open)}</td>
                      <td className="num">{formatPrice(bar.high)}</td>
                      <td className="num">{formatPrice(bar.low)}</td>
                      <td className="num">{formatPrice(bar.close)}</td>
                      <td className="num">{bar.volume === null ? '--' : bar.volume.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                  {previewTail.length > 0 && omittedRows > 0 && (
                    <tr>
                      <td colSpan={6} className="faint" style={{ textAlign: 'center' }}>
                        {omittedRows} rows omitted
                      </td>
                    </tr>
                  )}
                  {previewTail.map((bar) => (
                    <tr key={bar.date}>
                      <td className="mono">{bar.date}</td>
                      <td className="num">{formatPrice(bar.open)}</td>
                      <td className="num">{formatPrice(bar.high)}</td>
                      <td className="num">{formatPrice(bar.low)}</td>
                      <td className="num">{formatPrice(bar.close)}</td>
                      <td className="num">{bar.volume === null ? '--' : bar.volume.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {selected.dataset.validation.rejected.length > 0 && (
            <Panel
              title="Rejected rows"
              subtitle={`${selected.dataset.validation.rejected.length} of ${selected.dataset.validation.rejectedRows} recorded`}
              actions={
                <button
                  type="button"
                  className="button sm"
                  onClick={() => downloadTextFile(`marketlab-rejected-${selected.dataset.id}.csv`, validationToCsv(selected.dataset.validation), 'text/csv')}
                >
                  <DownloadSimple size={13} aria-hidden />
                  Export
                </button>
              }
              flush
            >
              <div className="table-wrap scroll-y">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">Row</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.dataset.validation.rejected.map((row) => (
                      <tr key={`${row.rowNumber}-${row.reason}`}>
                        <td className="num">{row.rowNumber}</td>
                        <td style={{ whiteSpace: 'normal' }}>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}

      <Panel title="Import rules">
        <ul className="list-reset stack field-hint">
          <li>Every session is identified by its date. Intraday timestamps are not supported and are never inferred from daily data.</li>
          <li>Weekly and monthly views are aggregated from daily bars. A series stored as weekly is never broken down into daily bars.</li>
          <li>Prices must be greater than zero and must satisfy high &gt;= max(open, close) and low &lt;= min(open, close).</li>
          <li>Volume may be empty; it is stored as missing rather than as zero, and volume-based indicators withhold output where it is missing.</li>
          <li>Duplicate sessions are handled by the policy chosen during import: reject, keep first, or keep last.</li>
          <li>Weekend rows are flagged as a warning because most exchanges do not trade then.</li>
        </ul>
      </Panel>
    </div>
  );
}
