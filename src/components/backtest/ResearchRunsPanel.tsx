import { useMemo, useRef, useState } from 'react';
import { DownloadSimple, FloppyDisk, PencilSimple, Play, Trash, UploadSimple } from '@phosphor-icons/react';
import type { BacktestConfig, BacktestResult, BacktestRun, Dataset, Instrument } from '../../domain/types';
import {
  createBacktestRun,
  parseResearchRunManifest,
  serialiseResearchRunManifest,
  sortResearchRuns,
  verifyBacktestRun,
  type ResearchRunVerification,
} from '../../lib/backtest/research-runs';
import { indexInstrumentsById, resolveRunDataset } from '../../lib/backtest/run-datasets';
import { downloadTextFile, readFileAsText } from '../../lib/export/download';
import { formatPercent, formatPrice } from '../../lib/format';
import { describeStrategyRules } from '../../lib/backtest/rule-catalog';
import { useStore } from '../../state/store';
import { EmptyState, Metric, Panel, Tag, TextInput, type TagTone } from '../ui';
import { TradeTable } from './TradeTable';

export interface ResearchRunSource {
  config: BacktestConfig;
  result: BacktestResult;
  dataset: Dataset;
  instrument: Instrument | undefined;
}

function fileSlug(run: BacktestRun): string {
  const slug = run.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'research-run';
}

function savedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : `${parsed.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function runMatchesFilter(run: BacktestRun, query: string): boolean {
  return [
    run.name,
    run.dataset.instrumentSymbol,
    run.dataset.instrumentId,
    run.dataset.datasetName,
    run.dataset.frequency,
    run.dataset.windowStart,
    run.dataset.windowEnd,
    savedAt(run.createdAt),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function statusCopy(verification: ResearchRunVerification): { tone: TagTone; label: string; body: string } {
  switch (verification.status) {
    case 'match':
      return {
        tone: 'up',
        label: 'Verified',
        body: 'The rerun reproduced every metric and trade within a 1e-9 absolute or relative tolerance.',
      };
    case 'mismatch':
      return {
        tone: 'down',
        label: 'Outputs differ',
        body: 'The inputs and engine version still match, but the rerun produced different outputs. Investigate before trusting either result.',
      };
    case 'inputs-changed':
      return {
        tone: 'warn',
        label: 'Inputs changed',
        body: 'The stored dataset no longer matches the inputs this run consumed. The saved result was not overwritten.',
      };
    case 'engine-changed':
      return {
        tone: 'warn',
        label: 'Engine changed',
        body: 'This run was produced by a different engine version. Outputs may legitimately differ.',
      };
    case 'dataset-missing':
      return {
        tone: 'warn',
        label: 'Dataset unavailable',
        body: 'The dataset this run used is no longer in the library, so the run cannot be reproduced. Import the same series to verify it.',
      };
  }
}

/**
 * Saved research runs for the strategy page.
 *
 * A run is an immutable snapshot of its configuration, dataset identity,
 * outputs and assumptions. Saving never touches the strategy draft; deleting a
 * run never touches the strategy or the dataset.
 */
export function ResearchRunsPanel({
  current,
  onLoadConfig,
}: {
  current: ResearchRunSource | null;
  onLoadConfig?: (run: BacktestRun) => void;
}) {
  const { state, actions } = useStore();
  const [selectedId, setSelectedId] = useState('');
  const [verification, setVerification] = useState<{ runId: string; value: ResearchRunVerification } | null>(null);
  const [busy, setBusy] = useState<'save' | 'verify' | 'import' | 'rename' | null>(null);
  const [filter, setFilter] = useState('');
  const [renameDraft, setRenameDraft] = useState<{ runId: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runs = useMemo(() => sortResearchRuns(state.backtestRuns), [state.backtestRuns]);
  const instrumentsById = useMemo(() => indexInstrumentsById(state.instruments), [state.instruments]);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  // The selected run's dataset resolves through its stored id first; when the
  // record is gone, a unique content-identical sibling still supports
  // verification and loading. Same rule as comparison and load planning.
  const selectedDatasetIdBasis = useMemo(
    () => (selected ? resolveRunDataset(selected, state.datasets, instrumentsById) : null),
    [selected, state.datasets, instrumentsById],
  );
  const activeVerification = selected && verification?.runId === selected.id ? verification.value : null;
  const filteredRuns = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? runs.filter((run) => runMatchesFilter(run, query)) : runs;
  }, [filter, runs]);
  const selectedVisible = selected !== null && filteredRuns.some((run) => run.id === selected.id);
  const isRenaming = selected !== null && renameDraft?.runId === selected.id;

  const selectRun = (runId: string) => {
    setSelectedId(runId);
    setVerification(null);
    setRenameDraft(null);
    setRenameError(null);
  };

  const changeFilter = (value: string) => {
    setFilter(value);
    const query = value.trim().toLowerCase();
    const nextRuns = query ? runs.filter((run) => runMatchesFilter(run, query)) : runs;
    if (!selected || !nextRuns.some((run) => run.id === selected.id)) {
      setRenameDraft(null);
      setRenameError(null);
      if (nextRuns.length > 0) selectRun(nextRuns[0]!.id);
    }
  };

  const startRename = () => {
    if (!selected) return;
    setRenameDraft({ runId: selected.id, name: selected.name });
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenameDraft(null);
    setRenameError(null);
  };

  const saveRename = async () => {
    if (!selected || !renameDraft || renameDraft.runId !== selected.id || busy) return;
    const name = renameDraft.name.trim();
    if (!name) {
      setRenameError('Enter a name before saving. The recorded run has not been changed.');
      return;
    }
    if (name === selected.name) {
      cancelRename();
      return;
    }
    setBusy('rename');
    try {
      const renamed = await actions.renameBacktestRun(selected.id, name);
      if (renamed) cancelRename();
    } finally {
      setBusy(null);
    }
  };

  const saveCurrent = async () => {
    if (!current || busy) return;
    setBusy('save');
    try {
      const run = await createBacktestRun({
        config: current.config,
        dataset: current.dataset,
        instrument: current.instrument,
        bars: state.barsByDataset[current.dataset.id] ?? [],
        result: current.result,
      });
      const saved = await actions.saveBacktestRun(run);
      if (saved) {
        setSelectedId(run.id);
        setVerification(null);
        setFilter('');
        setRenameDraft(null);
        setRenameError(null);
      }
    } catch (error) {
      actions.notify('error', error instanceof Error ? error.message : 'The research run could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const rerun = async (run: BacktestRun, allowChangedInputs: boolean) => {
    if (busy) return;
    setBusy('verify');
    try {
      const resolution = resolveRunDataset(run, state.datasets, instrumentsById);
      const dataset = resolution.dataset ?? undefined;
      const value = await verifyBacktestRun({
        run,
        dataset,
        bars: dataset ? state.barsByDataset[dataset.id] : undefined,
        allowChangedInputs,
      });
      setSelectedId(run.id);
      setVerification({ runId: run.id, value });
    } catch (error) {
      actions.notify('error', error instanceof Error ? error.message : 'The run could not be verified.');
    } finally {
      setBusy(null);
    }
  };

  const exportRun = (run: BacktestRun) => {
    downloadTextFile(`${fileSlug(run)}.research-run.json`, serialiseResearchRunManifest(run), 'application/json');
    actions.notify('success', `Exported research run "${run.name}".`);
  };

  const importRun = async (file: File) => {
    setBusy('import');
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFileAsText(file));
      } catch {
        actions.notify('error', 'That research run file is not valid JSON.');
        return;
      }
      const manifest = parseResearchRunManifest(parsed);
      if (!manifest.ok) {
        actions.notify('error', manifest.error);
        return;
      }
      if (state.backtestRuns.some((entry) => entry.id === manifest.value.run.id)) {
        actions.notify('info', `Research run "${manifest.value.run.name}" is already saved. Imported runs are never overwritten.`);
        return;
      }
      const saved = await actions.saveBacktestRun(manifest.value.run);
      if (saved) {
        setSelectedId(manifest.value.run.id);
        setFilter('');
        setRenameDraft(null);
        setRenameError(null);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Research runs"
      subtitle="Saved runs keep their inputs and outputs together so a result can be audited later"
      actions={
        <div className="row tight">
          <button
            type="button"
            className="button sm primary"
            disabled={!current || busy !== null}
            title={current ? 'Save the current run' : 'Run the strategy before saving it'}
            onClick={() => void saveCurrent()}
          >
            <FloppyDisk size={13} aria-hidden />
            {busy === 'save' ? 'Saving…' : 'Save run'}
          </button>
          <button type="button" className="button sm" disabled={busy !== null} onClick={() => fileInputRef.current?.click()}>
            <UploadSimple size={13} aria-hidden />
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="Import research run manifest"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importRun(file);
              event.target.value = '';
            }}
          />
        </div>
      }
    >
      {runs.length === 0 ? (
        <EmptyState
          title="No saved research runs"
          body="Run a strategy, then save the result to keep its configuration, dataset fingerprint, metrics and trades together."
        />
      ) : (
        <div className="stack">
          <span className="field-hint">
            Saving stores the configuration, the dataset identity and fingerprint, metrics and trades. It never stores
            bars or the equity curve. A rerun never modifies a saved run; renaming changes only its label.
          </span>

          <div className={`research-runs-layout${selectedVisible ? '' : ' is-library-only'}`}>
            <div className="stack research-runs-browser">
              <div className="stack research-run-filter">
                <TextInput
                  ariaLabel="Filter saved runs"
                  value={filter}
                  onChange={changeFilter}
                  placeholder="Name, symbol, dataset or date"
                />
                <span className="field-hint">
                  {filter.trim() ? `${filteredRuns.length} of ${runs.length} runs` : `${runs.length} saved runs · newest first`}
                </span>
              </div>

              {filteredRuns.length === 0 ? (
                <EmptyState
                  title="No runs match this filter"
                  body={`No saved run matches "${filter.trim()}". The filter searches names, symbols, datasets, windows and saved times.`}
                  action={
                    <button type="button" className="button sm" onClick={() => changeFilter('')}>
                      Clear filter
                    </button>
                  }
                />
              ) : (
                <ul className="list-reset research-run-list" aria-label="Saved research runs">
                  {filteredRuns.map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        className="research-run-item"
                        aria-current={run.id === selected?.id ? 'true' : undefined}
                        onClick={() => selectRun(run.id)}
                      >
                        <span className="research-run-item-head">
                          <span className="research-run-item-name">{run.name}</span>
                          {run.id === selected?.id && <Tag>Selected</Tag>}
                        </span>
                        <span className="research-run-item-meta">
                          {run.dataset.instrumentSymbol || run.dataset.instrumentId} · {run.dataset.datasetName} ·{' '}
                          {run.dataset.frequency}
                        </span>
                        <span className="research-run-item-meta">
                          {run.dataset.windowStart} to {run.dataset.windowEnd} · {run.dataset.barCount} sessions · saved{' '}
                          {savedAt(run.createdAt)}
                        </span>
                        <span className="research-run-item-metrics">
                          <span className="research-run-item-metric">
                            <strong className={run.metrics.totalReturnPct >= 0 ? 'num up' : 'num down'}>
                              {formatPercent(run.metrics.totalReturnPct)}
                            </strong>
                            <span>Return</span>
                          </span>
                          <span className="research-run-item-metric">
                            <strong className="num">{run.metrics.tradeCount}</strong>
                            <span>Trades</span>
                          </span>
                          <span className="research-run-item-metric">
                            <strong className="num">
                              {run.metrics.sharpe === null ? '--' : run.metrics.sharpe.toFixed(2)}
                            </strong>
                            <span>Sharpe</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selected && selectedVisible && (
              <div className="stack research-runs-inspector">
                {isRenaming ? (
                  <div className="stack research-run-rename">
                    <div className="row tight">
                      <div className="research-run-rename-input">
                        <TextInput
                          ariaLabel="Research run name"
                          value={renameDraft.name}
                          onChange={(value) => {
                            setRenameDraft({ runId: selected.id, name: value });
                            setRenameError(null);
                          }}
                          autoFocus
                          onKeyDown={(event) => {
                            if (busy) return;
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void saveRename();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="button sm primary"
                        disabled={busy !== null}
                        onClick={() => void saveRename()}
                      >
                        {busy === 'rename' ? 'Saving…' : 'Save name'}
                      </button>
                      <button type="button" className="button sm" disabled={busy !== null} onClick={cancelRename}>
                        Cancel
                      </button>
                    </div>
                    {renameError && (
                      <span className="field-error" role="alert">
                        {renameError}
                      </span>
                    )}
                    <span className="field-hint">
                      Only the display name changes. The recorded configuration, dataset fingerprint, metrics and trades
                      stay exactly as saved.
                    </span>
                  </div>
                ) : (
                  <div className="spread research-run-inspector-head">
                    <div className="stack research-run-inspector-title">
                      <span className="panel-title">{selected.name}</span>
                      <span className="field-hint">
                        Saved {savedAt(selected.createdAt)} · {selected.dataset.instrumentSymbol || selected.dataset.instrumentId} ·{' '}
                        {selected.dataset.datasetName}
                      </span>
                    </div>
                    <button type="button" className="button sm" disabled={busy !== null} onClick={startRename}>
                      <PencilSimple size={13} aria-hidden />
                      Rename
                    </button>
                  </div>
                )}

                <div className="grid-4">
                  <Metric
                    label="Total return"
                    value={formatPercent(selected.metrics.totalReturnPct)}
                    tone={selected.metrics.totalReturnPct >= 0 ? 'up' : 'down'}
                    note={`Buy and hold ${formatPercent(selected.metrics.benchmarkTotalReturnPct)}`}
                  />
                  <Metric
                    label="Max drawdown"
                    value={formatPercent(selected.metrics.maxDrawdownPct)}
                    tone="down"
                  />
                  <Metric label="Trades" value={String(selected.metrics.tradeCount)} />
                  <Metric
                    label="Sharpe"
                    value={selected.metrics.sharpe === null ? '--' : selected.metrics.sharpe.toFixed(2)}
                  />
                </div>

                <div className="stack field-hint">
                  <span>
                    {selected.dataset.instrumentSymbol || selected.dataset.instrumentId} · {selected.dataset.datasetName} ·{' '}
                    {selected.dataset.frequency}
                  </span>
                  <span>
                    Window {selected.dataset.windowStart} to {selected.dataset.windowEnd} · {selected.dataset.barCount}{' '}
                    sessions · saved {savedAt(selected.createdAt)}
                  </span>
                  <span>
                    Engine {selected.engineVersion} · dataset hash {selected.dataset.contentHash}
                  </span>
                  <span className="fingerprint" title={selected.dataset.windowFingerprint}>
                    Window fingerprint {selected.dataset.windowFingerprint}
                  </span>
                </div>

                <div className="row tight">
                  <button
                    type="button"
                    className="button sm"
                    disabled={busy !== null || !onLoadConfig || selectedDatasetIdBasis?.dataset === null}
                    title={
                      !selectedDatasetIdBasis || selectedDatasetIdBasis.dataset === null
                        ? 'The dataset this run used is not in the library and no identical-content series is stored'
                        : selectedDatasetIdBasis.basis === 'matching-content'
                          ? 'Load this run\u2019s configuration into the strategy editor. The stored dataset was re-imported under a new library id; the editor targets the identical stored series'
                          : 'Load this run\u2019s configuration into the strategy editor'
                    }
                    onClick={() => onLoadConfig?.(selected)}
                  >
                    <PencilSimple size={13} aria-hidden />
                    Load into editor
                  </button>
                  <button type="button" className="button sm" disabled={busy !== null} onClick={() => void rerun(selected, false)}>
                    <Play size={13} aria-hidden />
                    {busy === 'verify' ? 'Verifying…' : 'Rerun and verify'}
                  </button>
                  <button type="button" className="button sm" onClick={() => exportRun(selected)}>
                    <DownloadSimple size={13} aria-hidden />
                    Export manifest
                  </button>
                  <button
                    type="button"
                    className="button sm danger"
                    disabled={busy !== null}
                    onClick={() => {
                      void actions.deleteBacktestRun(selected.id);
                      setVerification(null);
                      setRenameDraft(null);
                      setRenameError(null);
                    }}
                  >
                    <Trash size={13} aria-hidden />
                    Delete
                  </button>
                </div>

                {activeVerification && (
                  <div className="panel research-verification">
                    <div className="panel-body stack">
                      <div className="row tight">
                        <Tag tone={statusCopy(activeVerification).tone}>{statusCopy(activeVerification).label}</Tag>
                        <span className="panel-sub">{statusCopy(activeVerification).body}</span>
                      </div>
                      {activeVerification.notes.length > 0 && (
                        <ul className="list-reset stack field-hint">
                          {activeVerification.notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      )}
                      {activeVerification.differences.length > 0 && (
                        <ul className="list-reset stack field-hint">
                          {activeVerification.differences.map((difference) => (
                            <li key={difference}>{difference}</li>
                          ))}
                        </ul>
                      )}
                      {activeVerification.status === 'inputs-changed' && activeVerification.result === null && (
                        <div className="row tight">
                          <button type="button" className="button sm" disabled={busy !== null} onClick={() => void rerun(selected, true)}>
                            Run anyway on current data
                          </button>
                          <span className="field-hint">
                            This simulates with today&apos;s bars. It does not replace the saved run or its fingerprint.
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <details className="research-assumptions">
                  <summary>Strategy configuration recorded with this run</summary>
                  <div className="stack field-hint">
                    <span>
                      <strong>Entry:</strong> {describeStrategyRules(selected.config.entry, selected.config.entryLogic)}
                    </span>
                    <span>
                      <strong>Exit:</strong> {describeStrategyRules(selected.config.exit, selected.config.exitLogic)}
                    </span>
                    <span>
                      Initial capital {formatPrice(selected.config.initialCapital)} · position size{' '}
                      {formatPercent(selected.config.positionSizePct)} · commission {selected.config.commissionBps} bps ·
                      slippage {selected.config.slippageBps} bps
                    </span>
                    <span>
                      Stop loss{' '}
                      {selected.config.stopLossPct === null ? 'none' : formatPercent(selected.config.stopLossPct)} · take
                      profit{' '}
                      {selected.config.takeProfitPct === null ? 'none' : formatPercent(selected.config.takeProfitPct)} ·
                      fills at the next session&apos;s open
                    </span>
                    <span>
                      Window {selected.config.startDate ?? 'first session'} to{' '}
                      {selected.config.endDate ?? 'last session'}
                    </span>
                  </div>
                </details>

                <span className="panel-title">
                  Trades saved with this run ({selected.trades.length})
                </span>
                <TradeTable
                  trades={selected.trades}
                  emptyTitle="No trades in this run"
                  emptyBody="The saved result contains no entries in this window."
                />

                <details className="research-assumptions">
                  <summary>Execution assumptions recorded with this run</summary>
                  <ul className="list-reset stack field-hint">
                    {selected.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
