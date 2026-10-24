import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowsLeftRight, Warning } from '@phosphor-icons/react';
import type { BacktestRun } from '../../domain/types';
import { BACKTEST_ENGINE_VERSION } from '../../lib/backtest/engine';
import {
  compareResearchRuns,
  formatComparisonDelta,
  formatComparisonValue,
  formatRunTimestamp,
  inspectResearchRunInputs,
  type ResearchRunComparison,
  type ResearchRunInputInspection,
} from '../../lib/backtest/run-comparison';
import { useStore } from '../../state/store';
import { indexInstrumentsById, resolveRunDataset } from '../../lib/backtest/run-datasets';
import { EmptyState, Field, Panel, Select, Tag, type TagTone } from '../ui';

const SUMMARY_TONE: Record<ResearchRunComparison['summary']['severity'], TagTone | undefined> = {
  warning: 'warn',
  note: 'accent',
  match: 'up',
};

function inputCheckCopy(
  run: BacktestRun,
  check: ResearchRunInputInspection | undefined,
): { tone: TagTone | undefined; label: string; note: string } {
  if (!check) {
    return {
      tone: undefined,
      label: 'Checking inputs',
      note: 'Hashing the saved window against the current dataset. No strategy is rerun.',
    };
  }
  const engineNote = check.engineChanged
    ? ` Saved on engine ${run.engineVersion}; current build ${check.currentEngineVersion}.`
    : '';
  switch (check.status) {
    case 'match':
      return {
        tone: 'up',
        label: 'Inputs match',
        note: 'Current window and dataset identity match the saved fingerprint.',
      };
    case 'missing-dataset':
      return {
        tone: 'warn',
        label: 'Dataset missing',
        note: 'The saved snapshot is readable, but the dataset is not in the library. Current inputs cannot be checked.',
      };
    case 'inputs-changed':
      return {
        tone: 'warn',
        label: 'Inputs differ',
        note: `The current library no longer matches the saved window. Recorded outputs are unchanged.${engineNote}`,
      };
    case 'engine-changed':
      return {
        tone: 'warn',
        label: 'Engine differs',
        note: `Inputs match, but the recorded engine is not the current build.${engineNote} No rerun was performed.`,
      };
    case 'unavailable':
      return {
        tone: 'warn',
        label: 'Check unavailable',
        note: check.notes[0] ?? 'The current window could not be checked.',
      };
  }
}

function RunSnapshotCard({
  side,
  run,
  check,
}: {
  side: 'A' | 'B';
  run: BacktestRun;
  check: ResearchRunInputInspection | undefined;
}) {
  const copy = inputCheckCopy(run, check);
  return (
    <div className="compare-run" role="group" aria-label={`Run ${side}: ${run.name}`}>
      <div className="compare-run-head">
        <Tag tone="accent">Run {side}</Tag>
        <span className="compare-run-name">{run.name}</span>
      </div>
      <div className="compare-run-meta">
        <span>Saved {formatRunTimestamp(run.createdAt)}</span>
        <span>
          {run.dataset.instrumentSymbol || run.dataset.instrumentId} · {run.dataset.frequency}
        </span>
        <span>
          {run.dataset.windowStart} to {run.dataset.windowEnd}, {run.dataset.barCount} sessions
        </span>
      </div>
      <div className="compare-run-state">
        <Tag tone={copy.tone}>{copy.label}</Tag>
        <span className="field-hint">{copy.note}</span>
      </div>
      {check && check.notes.length > 0 && (
        <details className="research-assumptions compare-check-details">
          <summary>Input check details</summary>
          <ul className="list-reset stack field-hint">
            {check.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ComparisonTable({
  label,
  columns,
  children,
  className,
}: {
  label: string;
  columns: readonly string[];
  children: ReactNode;
  className: string;
}) {
  return (
    <div className="compare-table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className={`data compare-table ${className}`} role="table">
        <caption className="visually-hidden">{label}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                role="columnheader"
                className={
                  column === 'Run A' || column === 'Run B' || column === 'Delta (B - A)' ? 'num' : undefined
                }
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Compares two immutable research-run snapshots.
 *
 * The saved records are read into local state by the store and never mutated.
 * The current-input check only hashes the stored window; it does not call the
 * backtest engine. Output verification remains the explicit `Rerun and verify`
 * action in the Research runs panel.
 */
export function ResearchRunComparison() {
  const { state } = useStore();
  const runs = useMemo(
    () => [...state.backtestRuns].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)),
    [state.backtestRuns],
  );
  const [selectedAId, setSelectedAId] = useState('');
  const [selectedBId, setSelectedBId] = useState('');
  const [inputCheckState, setInputCheckState] = useState<{
    signature: string;
    checks: Record<string, ResearchRunInputInspection>;
  }>({ signature: '', checks: {} });

  // Newest is first. When no explicit choice exists, put the older run on the
  // left and the newest on the right so time reads left to right.
  const fallbackA = runs.length > 1 ? runs[1] : runs[0] ?? null;
  const runA = runs.find((run) => run.id === selectedAId) ?? fallbackA;
  const runB =
    runs.find((run) => run.id === selectedBId) ??
    runs.find((run) => run.id !== runA?.id) ??
    runs[0] ??
    null;
  const selectionLost =
    (selectedAId !== '' && !runs.some((run) => run.id === selectedAId)) ||
    (selectedBId !== '' && !runs.some((run) => run.id === selectedBId));

  // A run's dataset resolves through its stored id first; when that id is gone,
  // a unique content-identical sibling still supports checking the inputs. This
  // uses the same identity rule as verification, so the comparison screen never
  // calls a verifiable run uncheckable, and never calls a changed series
  // checked.
  const instrumentsById = useMemo(() => indexInstrumentsById(state.instruments), [state.instruments]);
  const resolvableRunIds = useMemo(
    () =>
      runs
        .filter((run) => resolveRunDataset(run, state.datasets, instrumentsById).dataset !== null)
        .map((run) => run.id),
    [runs, state.datasets, instrumentsById],
  );
  const comparison = useMemo(
    () => (runA && runB ? compareResearchRuns(runA, runB, { resolvableRunIds }) : null),
    [runA, runB, resolvableRunIds],
  );

  // A check is only shown when it was produced for this exact selection and
  // library identity. This avoids flashing an old "inputs match" result while
  // a new window is being hashed.
  const inputCheckSignature = useMemo(() => {
    if (!runA || !runB) return '';
    const selected = runA.id === runB.id ? [runA] : [runA, runB];
    return selected
      .map((run) => {
        const dataset = resolveRunDataset(run, state.datasets, instrumentsById).dataset;
        const bars = dataset ? state.barsByDataset[dataset.id] : undefined;
        return [
          run.id,
          run.dataset.datasetId,
          run.dataset.windowFingerprint,
          dataset?.contentHash ?? 'missing',
          bars?.length ?? -1,
        ].join(':');
      })
      .join('|');
  }, [runA, runB, state.datasets, state.barsByDataset, instrumentsById]);
  const inputChecks =
    inputCheckState.signature === inputCheckSignature ? inputCheckState.checks : {};

  useEffect(() => {
    if (!runA || !runB) return;
    let cancelled = false;
    const selected = runA.id === runB.id ? [runA] : [runA, runB];
    void Promise.all(
      selected.map(async (run) => {
        const dataset = resolveRunDataset(run, state.datasets, instrumentsById).dataset ?? undefined;
        return [
          run.id,
          await inspectResearchRunInputs({
            run,
            dataset,
            bars: dataset ? state.barsByDataset[dataset.id] : undefined,
          }),
        ] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          setInputCheckState({ signature: inputCheckSignature, checks: Object.fromEntries(entries) });
        }
      })
      .catch(() => {
        if (!cancelled) {
          const checks = Object.fromEntries(
            selected.map((run) => [
              run.id,
              {
                status: 'unavailable',
                datasetAvailable: resolveRunDataset(run, state.datasets, instrumentsById).dataset !== null,
                inputsChanged: false,
                engineChanged: run.engineVersion !== BACKTEST_ENGINE_VERSION,
                windowFingerprint: null,
                currentEngineVersion: BACKTEST_ENGINE_VERSION,
                notes: ['The current input check could not be completed. The saved snapshot is unchanged.'],
              } satisfies ResearchRunInputInspection,
            ]),
          );
          setInputCheckState({ signature: inputCheckSignature, checks });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runA, runB, state.datasets, state.barsByDataset, instrumentsById, inputCheckSignature]);

  const swap = () => {
    if (!runA || !runB) return;
    setSelectedAId(runB.id);
    setSelectedBId(runA.id);
  };

  const runOptions = runs.map((run) => ({
    value: run.id,
    label: `${run.name} · ${formatRunTimestamp(run.createdAt)}`,
  }));

  return (
    <Panel
      title="Compare saved runs"
      subtitle="Two recorded snapshots side by side. Comparing never reruns or changes either run"
    >
      {runs.length === 0 ? (
        <EmptyState
          title="No saved runs to compare"
          body="Save a strategy run in Research runs, then save a second to compare its inputs, settings and recorded results."
        />
      ) : runs.length === 1 ? (
        <EmptyState
          title="One saved run"
          body="Save a second research run to compare different windows, inputs or strategy settings. A single snapshot has nothing to compare against."
        />
      ) : !comparison || !runA || !runB ? (
        <EmptyState
          title="No comparison available"
          body="Two saved research runs are required. Save another run and try again."
        />
      ) : (
        <div className="stack compare">
          <div className="compare-picker">
            <Field label="Run A">
              <Select
                ariaLabel="Run A"
                value={runA.id}
                onChange={setSelectedAId}
                options={runOptions}
              />
            </Field>
            <button
              type="button"
              className="button sm compare-swap-button"
              onClick={swap}
              aria-label="Swap run A and run B"
            >
              <ArrowsLeftRight size={14} aria-hidden />
              Swap
            </button>
            <Field label="Run B">
              <Select
                ariaLabel="Run B"
                value={runB.id}
                onChange={setSelectedBId}
                options={runOptions}
              />
            </Field>
          </div>

          {selectionLost && (
            <div className="compare-findings is-note" role="status">
              <div className="compare-findings-head">
                <Tag tone="warn">Selection changed</Tag>
                <span className="panel-sub">
                  One or both selected runs are no longer saved. The nearest available runs are shown instead; no
                  saved record was restored or changed.
                </span>
              </div>
            </div>
          )}

          <div className="compare-runs">
            <RunSnapshotCard side="A" run={runA} check={inputChecks[runA.id]} />
            <RunSnapshotCard side="B" run={runB} check={inputChecks[runB.id]} />
          </div>

          <div className={`compare-findings is-${comparison.summary.severity}`}>
            <div className="compare-findings-head" aria-live="polite">
              <Tag tone={SUMMARY_TONE[comparison.summary.severity]}>{comparison.summary.label}</Tag>
              <span className="panel-sub">{comparison.summary.detail}</span>
            </div>
            {comparison.findings.length > 0 && (
              <ul className="list-reset compare-finding-list">
                {comparison.findings.map((finding) => (
                  <li key={finding.id} className={finding.severity === 'warning' ? 'compare-finding warning' : 'compare-finding'}>
                    {finding.severity === 'warning' && <Warning size={14} aria-hidden />}
                    <span>
                      <strong>{finding.title}.</strong> {finding.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <section className="compare-section" aria-labelledby="compare-metrics-title">
            <div className="compare-section-head">
              <span className="panel-title" id="compare-metrics-title">
                Recorded metrics
              </span>
              <span className="field-hint">Delta is B minus A. Percent deltas are percentage points.</span>
            </div>
            <ComparisonTable
              label={`Recorded metrics for ${runA.name} and ${runB.name}, with B minus A deltas`}
              columns={['Metric', 'Run A', 'Run B', 'Delta (B - A)']}
              className="compare-metrics-table"
            >
              {comparison.metrics.map((row) => (
                <tr key={row.key} role="row">
                  <th scope="row" role="rowheader">{row.label}</th>
                  <td className="num" role="cell" data-label="Run A">
                    <span className={row.leftValue === null ? 'muted' : undefined}>
                      {formatComparisonValue(row.valueKind, row.leftValue)}
                    </span>
                  </td>
                  <td className="num" role="cell" data-label="Run B">
                    <span className={row.rightValue === null ? 'muted' : undefined}>
                      {formatComparisonValue(row.valueKind, row.rightValue)}
                    </span>
                  </td>
                  <td className="num" role="cell" data-label="Delta (B - A)">
                    <span
                      className={row.delta === null ? 'muted' : undefined}
                      title={
                        row.deltaKind === 'none'
                          ? 'Profit factor is undefined without losing trades; an absolute delta is not shown.'
                          : row.delta === null
                            ? 'Needs a recorded value on both sides.'
                            : 'Run B minus Run A.'
                      }
                    >
                      {formatComparisonDelta(row)}
                    </span>
                  </td>
                </tr>
              ))}
            </ComparisonTable>
            <p className="field-hint compare-footnote">
              These are the values saved with each run. No strategy was rerun to build this comparison. Profit
              factor has no delta because it is undefined without losing trades and is not additive. To test whether
              an output still reproduces, use Rerun and verify in Research runs.
            </p>
          </section>

          <section className="compare-section" aria-labelledby="compare-config-title">
            <div className="compare-section-head">
              <span className="panel-title" id="compare-config-title">
                Strategy configuration
              </span>
              <span className="field-hint">Every field is shown so matching settings are as visible as changes.</span>
            </div>
            <ComparisonTable
              label={`Strategy configuration for ${runA.name} and ${runB.name}`}
              columns={['Setting', 'Run A', 'Run B', 'Status']}
              className="compare-config-table"
            >
              {comparison.config.map((row) => (
                <tr key={row.key} role="row">
                  <th scope="row" role="rowheader">{row.label}</th>
                  <td className="compare-value" role="cell" data-label="Run A">{row.left}</td>
                  <td className="compare-value" role="cell" data-label="Run B">{row.right}</td>
                  <td role="cell" data-label="Status">
                    <span className={row.changed ? 'compare-diff' : 'compare-same'}>
                      {row.changed ? 'Differs' : 'Same'}
                    </span>
                  </td>
                </tr>
              ))}
            </ComparisonTable>
          </section>

          <section className="compare-section" aria-labelledby="compare-provenance-title">
            <div className="compare-section-head">
              <span className="panel-title" id="compare-provenance-title">
                Inputs and provenance
              </span>
              <span className="field-hint">Recorded identity is compared exactly. Hashes are shown in full.</span>
            </div>
            <ComparisonTable
              label={`Inputs and provenance for ${runA.name} and ${runB.name}`}
              columns={['Field', 'Run A', 'Run B', 'Status']}
              className="compare-provenance-table"
            >
              {comparison.provenance.map((row) => (
                <tr key={row.key} role="row">
                  <th scope="row" role="rowheader">{row.label}</th>
                  <td className="compare-value" role="cell" data-label="Run A">
                    {row.mono ? <span className="fingerprint">{row.left}</span> : row.left}
                  </td>
                  <td className="compare-value" role="cell" data-label="Run B">
                    {row.mono ? <span className="fingerprint">{row.right}</span> : row.right}
                  </td>
                  <td role="cell" data-label="Status">
                    <span className={row.changed ? 'compare-diff' : 'compare-same'}>
                      {row.changed ? 'Differs' : 'Same'}
                    </span>
                  </td>
                </tr>
              ))}
            </ComparisonTable>
          </section>

          <details className="research-assumptions compare-assumptions">
            <summary>
              Recorded execution assumptions ({comparison.assumptions.same ? 'same on both sides' : 'different'})
            </summary>
            {comparison.assumptions.same ? (
              <div className="stack field-hint">
                <span>
                  Both runs recorded the same {runA.assumptions.length} assumption
                  {runA.assumptions.length === 1 ? '' : 's'}.
                </span>
                <ul className="list-reset stack">
                  {runA.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="compare-assumption-columns">
                <div className="stack field-hint">
                  <span className="field-label">Run A assumptions</span>
                  <ul className="list-reset stack">
                    {runA.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </div>
                <div className="stack field-hint">
                  <span className="field-label">Run B assumptions</span>
                  <ul className="list-reset stack">
                    {runB.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </details>
        </div>
      )}
    </Panel>
  );
}
