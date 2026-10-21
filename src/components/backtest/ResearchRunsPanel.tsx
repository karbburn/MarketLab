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
import { downloadTextFile, readFileAsText } from '../../lib/export/download';
import { formatPercent, formatPrice } from '../../lib/format';
import { describeStrategyRules } from '../../lib/backtest/rule-catalog';
import { useStore } from '../../state/store';
import { EmptyState, Metric, Panel, Select, Tag, type TagTone } from '../ui';
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
  const [busy, setBusy] = useState<'save' | 'verify' | 'import' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runs = useMemo(() => sortResearchRuns(state.backtestRuns), [state.backtestRuns]);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const activeVerification = selected && verification?.runId === selected.id ? verification.value : null;

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
      const dataset = state.datasets.find((entry) => entry.id === run.dataset.datasetId);
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
      if (saved) setSelectedId(manifest.value.run.id);
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
            bars or the equity curve, and a saved run is never modified by a rerun.
          </span>

          <Select
            ariaLabel="Saved research runs"
            value={selected?.id ?? ''}
            onChange={(value) => {
              setSelectedId(value);
              setVerification(null);
            }}
            options={runs.map((run) => ({ value: run.id, label: `${run.name} · ${savedAt(run.createdAt)}` }))}
          />

          {selected && (
            <div className="stack">
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
                  disabled={busy !== null || !onLoadConfig || !state.datasets.some((entry) => entry.id === selected.dataset.datasetId)}
                  title={
                    state.datasets.some((entry) => entry.id === selected.dataset.datasetId)
                      ? 'Load this run\u2019s configuration into the strategy editor'
                      : 'The dataset this run used is not in the library'
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
      )}
    </Panel>
  );
}
