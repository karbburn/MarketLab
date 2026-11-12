import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Dataset } from '../../domain/types';
import { buildProvenanceSummary, type ProvenanceSummary } from '../../lib/provenance/summary';
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
  // Freshness is descriptive context, not part of the verdict: it sits in the
  // hover title so the compact chip keeps its stable footprint.
  const title = summary.freshness
    ? `${summary.statusLabel} - ${summary.freshness.label} - open provenance and quality details`
    : `${summary.statusLabel} - open provenance and quality details`;
  return (
    <button
      type="button"
      className="provenance-chip"
      data-status={summary.status}
      data-severity={summary.severity ?? undefined}
      aria-haspopup="dialog"
      aria-label={`Data provenance: ${summary.headline}. Open details`}
      title={title}
      onClick={onOpen}
    >
      <span className="provenance-dot" aria-hidden />
      {summary.statusLabel}
    </button>
  );
}

export interface ProvenanceComparison {
  dataset: Dataset;
  symbol: string;
  exchange?: string | null;
}

function IssueGroup({
  heading,
  issues,
}: {
  heading: string;
  issues: ProvenanceSummary['issues'];
}) {
  return (
    <div>
      <span className="field-label">{heading}</span>
      <ul className="list-reset stack provenance-list">
        {issues.map((issue) => (
          <li key={`${issue.code}-${issue.label}`}>
            <strong>{issue.label}</strong>{' '}
            <span className="mono">({issue.count.toLocaleString('en-US')})</span>
            <span className="field-hint"> {issue.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InspectionLink({ datasetId, label }: { datasetId: string; label: string }) {
  return (
    <Link
      className="button sm"
      to={`/data?dataset=${encodeURIComponent(datasetId)}#inspection`}
      aria-label={label}
    >
      Inspect
    </Link>
  );
}

export function DataProvenanceDialog({
  dataset,
  exchange,
  comparisons = [],
  open,
  onClose,
}: {
  dataset: Dataset;
  exchange?: string | null;
  comparisons?: readonly ProvenanceComparison[];
  open: boolean;
  onClose: () => void;
}) {
  const summary = useMemo(() => buildProvenanceSummary(dataset, { exchange }), [dataset, exchange]);
  const comparisonSummaries = useMemo(
    () =>
      comparisons.map((comparison) => ({
        comparison,
        summary: buildProvenanceSummary(comparison.dataset, { exchange: comparison.exchange }),
      })),
    [comparisons],
  );
  const materialIssues = summary.issues.filter((issue) => issue.severity === 'material');
  const advisoryIssues = summary.issues.filter((issue) => issue.severity === 'advisory');

  return (
    <Modal open={open} onClose={onClose} title="Data provenance" wide>
      <div className="stack">
        <div className="provenance-summary" data-status={summary.status} data-severity={summary.severity ?? undefined}>
          <strong>{summary.headline}</strong>
          <p className="provenance-status-note field-hint">{summary.statusNote}</p>
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

        {materialIssues.length > 0 && <IssueGroup heading="Issues" issues={materialIssues} />}
        {advisoryIssues.length > 0 && <IssueGroup heading="Notes" issues={advisoryIssues} />}

        {comparisonSummaries.length > 0 && (
          <div>
            <span className="field-label">Also on this chart</span>
            <ul className="list-reset stack provenance-compare-list">
              {comparisonSummaries.map(({ comparison, summary: comparisonSummary }) => (
                <li key={comparison.dataset.id} className="provenance-compare-row">
                  <span className="mono provenance-compare-symbol">{comparison.symbol}</span>
                  <span className="field-hint">{comparisonSummary.sourceLabel}</span>
                  <span className="provenance-compare-status" data-status={comparisonSummary.status}>
                    {comparisonSummary.statusLabel}
                  </span>
                  <InspectionLink
                    datasetId={comparisonSummary.inspectDatasetId}
                    label={`Inspect ${comparison.symbol} in Data`}
                  />
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
            to={`/data?dataset=${encodeURIComponent(summary.inspectDatasetId)}#inspection`}
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
