import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Dataset } from '../../domain/types';
import { buildProvenanceSummary } from '../../lib/provenance/summary';
import { Modal } from '../ui';

/**
 * Compact integrity badge for the chart legend.
 *
 * The dialog is a sibling of the chart, not a child of the legend: the legend
 * disables pointer events on its background, and a modal inside it would inherit
 * that. `ChartPanel` owns the open state and renders both pieces.
 */
export function DataProvenanceChip({
  dataset,
  exchange,
  onOpen,
}: {
  dataset: Dataset;
  exchange?: string | null;
  onOpen: () => void;
}) {
  const summary = useMemo(() => buildProvenanceSummary(dataset, { exchange }), [dataset, exchange]);
  return (
    <button
      type="button"
      className="provenance-chip"
      data-status={summary.status}
      aria-haspopup="dialog"
      aria-label={`Data provenance: ${summary.headline}. Open details`}
      title={`${summary.statusLabel} - open provenance and quality details`}
      onClick={onOpen}
    >
      <span className="provenance-dot" aria-hidden />
      {summary.statusLabel}
    </button>
  );
}

export function DataProvenanceDialog({
  dataset,
  exchange,
  open,
  onClose,
}: {
  dataset: Dataset;
  exchange?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const summary = useMemo(() => buildProvenanceSummary(dataset, { exchange }), [dataset, exchange]);

  return (
    <Modal open={open} onClose={onClose} title="Data provenance" wide>
      <div className="stack">
        <div className="provenance-summary" data-status={summary.status}>
          <strong>{summary.headline}</strong>
          <span className="field-hint">
            {summary.sourceLabel} &middot; {summary.coverage}
          </span>
        </div>

        <div>
          <span className="field-label">Where it came from</span>
          <dl className="provenance-grid">
            {summary.fields.map((field) => (
              <div key={field.label} className="provenance-field">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
                {field.note && <dd className="field-hint">{field.note}</dd>}
              </div>
            ))}
          </dl>
        </div>

        <div>
          <span className="field-label">Validation counts</span>
          <dl className="provenance-grid">
            {summary.counts.map((count) => (
              <div key={count.label} className="provenance-field">
                <dt>{count.label}</dt>
                <dd className="mono">{count.value}</dd>
                {count.note && <dd className="field-hint">{count.note}</dd>}
              </div>
            ))}
          </dl>
        </div>

        {summary.issues.length > 0 && (
          <div>
            <span className="field-label">Issues</span>
            <ul className="list-reset stack provenance-list">
              {summary.issues.map((issue) => (
                <li key={`${issue.code}-${issue.label}`}>
                  <strong>{issue.label}</strong>{' '}
                  <span className="mono">({issue.count.toLocaleString('en-US')})</span>
                  <span className="field-hint"> {issue.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.limitations.length > 0 && (
          <div>
            <span className="field-label">Limits of this data</span>
            <ul className="list-reset stack provenance-list field-hint">
              {summary.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="row tight">
          <Link
            className="button sm"
            to={`/data?dataset=${encodeURIComponent(summary.inspectDatasetId)}`}
            onClick={onClose}
          >
            Inspect in Data
          </Link>
          <span className="field-hint">
            Opens the stored rows, rejected samples and full validation record.
          </span>
        </div>
      </div>
    </Modal>
  );
}
