import type { CoverageReport } from '../../lib/marketdata/coverage';
import type { RunWindowReport } from '../../lib/backtest/run-window';
import type { ProvenanceSummary } from '../../lib/provenance/summary';

/**
 * What the current result covers, shown beside the metrics that quote "the
 * window". Numbers come from `describeRunWindow` (the engine's own window and
 * warm-up helpers) and the provenance from `buildProvenanceSummary`, so this
 * block introduces no second source of truth and no new calculation.
 *
 * Two different shortfalls are kept apart on purpose:
 *
 * - the run's requested dates fall outside the stored series (the config);
 * - the stored series itself is shorter than the download it came from.
 *
 * The second one is invisible in the date inputs: a dataset downloaded with no
 * explicit range still records the provider's requested window, and a provider
 * that returns fewer sessions must not let a run look like it covered them.
 */
export function RunWindowDisclosure({
  report,
  provenance,
  coverage,
}: {
  report: RunWindowReport;
  provenance: ProvenanceSummary | null;
  coverage: CoverageReport | null;
}) {
  const warnings = report.notes.filter((note) => note.tone === 'warn');
  const infos = report.notes.filter((note) => note.tone === 'info');
  const adjustment = provenance?.fields.find((field) => field.label === 'Adjustment')?.value ?? null;
  // The heading names the actual reason. A warm-up that consumes the whole
  // window is not a missing-data problem, so it must not be described as one.
  const hasStoredRangeShortfall = warnings.some(
    (note) => note.code === 'requested-start-shortfall' || note.code === 'requested-end-shortfall',
  );
  const heading = hasStoredRangeShortfall
    ? 'Not all of the requested window is stored.'
    : report.storedSessions === 0
      ? 'No stored session falls inside the requested window.'
      : 'The requested window cannot be evaluated.';

  return (
    <div aria-label="What this run simulated">
      <p>
        <span className="field-label">Simulated sessions</span>{' '}
        {report.effectiveStart === null || report.effectiveEnd === null ? (
          <span className="mono">none</span>
        ) : (
          <span className="mono">
            {report.effectiveStart} to {report.effectiveEnd}
          </span>
        )}
        {report.storedSessions > 0 && (
          <span className="field-hint">
            {' '}
            · {report.storedSessions.toLocaleString('en-US')} stored sessions,{' '}
            {report.evaluatedSessions.toLocaleString('en-US')} evaluated
          </span>
        )}
      </p>
      {infos.map((note) => (
        <p key={note.text} className="field-hint">
          {note.text}
        </p>
      ))}
      {warnings.length > 0 && (
        <div className="coverage-warning" role="status">
          <strong>{heading}</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning.text}>{warning.text}</li>
            ))}
          </ul>
        </div>
      )}
      {coverage?.status === 'partial' && (
        <div className="coverage-warning" role="status">
          <strong>The stored dataset does not cover its whole download request.</strong>
          <ul>
            {coverage.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {provenance && (
        <div>
          <p className="field-hint">
            <span className="field-label">Data source</span> {provenance.sourceLabel}
          </p>
          <p className="field-hint">
            <span className="field-label">Stored coverage</span> {provenance.coverage}
          </p>
          {adjustment && (
            <p className="field-hint">
              <span className="field-label">Adjustment</span> {adjustment}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
