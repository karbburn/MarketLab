import { useMemo, useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { ChartConfig } from '../../domain/types';
import type { DatasetView } from '../../state/selectors';
import { comparisonEligibility, type ComparisonPreparation } from '../../lib/chart/compare-overlays';
import { resolveTimeframe } from '../../lib/timeframe';
import { requestDownloadDialog, requestImportDialog } from '../../lib/ui-events';
import { useStore } from '../../state/store';
import { Field, Modal, Select, Tag } from '../ui';

/**
 * Compare-symbol selector for one chart panel.
 *
 * It only offers datasets that are already stored locally and that can be
 * rendered on this panel's timeframe. Selecting one never changes the panel's
 * primary instrument or dataset: it only appends an overlay reference, which
 * the panel rebases to 100 on the first shared session.
 */
export function CompareDialog({
  open,
  onClose,
  chart,
  workspaceId,
  primaryDatasetId,
  views,
  preparation,
}: {
  open: boolean;
  onClose: () => void;
  chart: ChartConfig;
  workspaceId: string;
  primaryDatasetId: string;
  views: readonly DatasetView[];
  preparation: ComparisonPreparation | null;
}) {
  const { actions } = useStore();
  const [draftId, setDraftId] = useState('');

  const selected = useMemo(() => chart.compareDatasetIds ?? [], [chart.compareDatasetIds]);
  const primary = views.find((view) => view.dataset.id === primaryDatasetId) ?? null;
  const panelTimeframe = primary ? resolveTimeframe(primary.dataset, chart.timeframe) : chart.timeframe;

  const selectedViews = useMemo(
    () =>
      selected
        .map((id) => views.find((view) => view.dataset.id === id))
        .filter((view): view is DatasetView => view !== undefined),
    [selected, views],
  );

  const available = useMemo(
    () =>
      views
        .filter((view) => view.dataset.id !== primaryDatasetId && !selected.includes(view.dataset.id))
        .map((view) => ({
          view,
          eligibility: comparisonEligibility(view.dataset.frequency, panelTimeframe),
        })),
    [panelTimeframe, primaryDatasetId, selected, views],
  );

  const options = available.map((entry) => ({
    value: entry.view.dataset.id,
    label: `${entry.view.instrument?.symbol ?? entry.view.dataset.name} - ${entry.view.dataset.frequency}${
      entry.eligibility.eligible ? '' : ' (not on this timeframe)'
    }`,
  }));
  const effectiveDraft = options.some((option) => option.value === draftId) ? draftId : options[0]?.value ?? '';
  const draft = available.find((entry) => entry.view.dataset.id === effectiveDraft) ?? null;

  const writeSelection = (next: string[]) => {
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, compareDatasetIds: next }));
  };

  const addComparison = () => {
    if (!draft || !draft.eligibility.eligible) return;
    writeSelection([...selected, draft.view.dataset.id]);
    setDraftId('');
  };

  const removeComparison = (datasetId: string) => {
    writeSelection(selected.filter((id) => id !== datasetId));
  };

  const noOtherSeries = views.filter((view) => view.dataset.id !== primaryDatasetId).length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compare symbols"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button danger" disabled={selected.length === 0} onClick={() => writeSelection([])}>
            Clear all overlays
          </button>
        </>
      }
    >
      <p className="panel-sub">
        Comparison lines are rebased to an index of 100 at the first session shared by every selected series. They are
        drawn on a separate Compare index axis; the primary price axis, candles and volume pane are unchanged.
      </p>

      {noOtherSeries ? (
        <div className="stack">
          <span className="field-hint">
            Only one series is stored, so there is nothing to compare it with yet. Download or import a second series,
            then reopen this dialog.
          </span>
          <div className="row tight">
            <button type="button" className="button primary" onClick={requestDownloadDialog}>
              Download real market data
            </button>
            <button type="button" className="button" onClick={requestImportDialog}>
              Import a CSV file
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="stack">
            <span className="panel-title">Add a comparison</span>
            {available.length === 0 ? (
              <span className="field-hint">Every eligible stored series is already on this chart.</span>
            ) : (
              <div className="row">
                <Field label="Stored series" hint={`Panel timeframe: ${panelTimeframe}`}>
                  <Select value={effectiveDraft} onChange={setDraftId} options={options} ariaLabel="Stored series to compare" />
                </Field>
                <button
                  type="button"
                  className="button primary"
                  disabled={!draft || !draft.eligibility.eligible}
                  onClick={addComparison}
                >
                  <Plus size={13} aria-hidden />
                  Add overlay
                </button>
              </div>
            )}
            {draft && !draft.eligibility.eligible && <span className="field-hint">{draft.eligibility.reason}</span>}
            <span className="field-hint">
              Weekly and monthly bars are only compared on identical session dates. A series stored at a lower frequency
              than the panel is not stretched to fill missing sessions.
            </span>
          </div>

          <div className="stack">
            <span className="panel-title">On this chart</span>
            {selectedViews.length === 0 ? (
              <span className="field-hint">No comparison overlays yet.</span>
            ) : (
              selectedViews.map((view) => {
                const preparationLine = preparation?.lines.find((line) => line.datasetId === view.dataset.id);
                const excluded = preparation?.excluded.find((entry) => entry.datasetId === view.dataset.id);
                return (
                  <div key={view.dataset.id} className="spread">
                    <div style={{ display: 'grid', gap: 1 }}>
                      <span className="row tight">
                        <span className="mono">{view.instrument?.symbol ?? view.dataset.name}</span>
                        <SourceTag sourceKind={view.dataset.sourceKind} />
                      </span>
                      <span className="panel-sub">
                        {excluded
                          ? excluded.reason
                          : preparationLine
                            ? `${preparationLine.points.length} shared session(s)`
                            : 'Waiting for enough shared history.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button ghost sm"
                      aria-label={`Remove ${view.instrument?.symbol ?? view.dataset.name} from comparison`}
                      onClick={() => removeComparison(view.dataset.id)}
                    >
                      <Trash size={12} aria-hidden />
                      Remove
                    </button>
                  </div>
                );
              })
            )}
            {preparation && <span className="field-hint">{preparation.message}</span>}
          </div>
        </>
      )}

      <div className="panel" style={{ background: 'var(--surface-inset)' }}>
        <div className="panel-body stack">
          <span className="panel-title">Method</span>
          <span className="field-hint">{preparation?.methodNote ?? METHOD_NOTE}</span>
        </div>
      </div>
    </Modal>
  );
}

const METHOD_NOTE =
  'Comparison series are rebased to 100 at the first session shared by every selected series, aligned on exchange ' +
  'session dates and never forward-filled. The primary price axis stays in price units; the comparison index has its own axis.';

function SourceTag({ sourceKind }: { sourceKind: 'bundled-sample' | 'user-csv' | 'provider-download' }) {
  if (sourceKind === 'provider-download') return <Tag tone="accent">Yahoo download</Tag>;
  if (sourceKind === 'user-csv') return <Tag>CSV import</Tag>;
  return <Tag tone="warn">Legacy sample</Tag>;
}
