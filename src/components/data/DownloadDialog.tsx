import { useCallback, useMemo, useRef, useState } from 'react';
import { CloudArrowDown, GlobeSimple, Warning } from '@phosphor-icons/react';
import type { DatasetBundle } from '../../state/store';
import { useStore } from '../../state/store';
import {
  assetTypeFromProvider,
  buildDatasetBundle,
  describeValidationIssues,
  providerLabel,
  validateProviderBars,
} from '../../lib/marketdata/normalize';
import {
  DEFAULT_SERVICE_URL,
  describeMarketDataFailure,
  fetchProviderHistory,
  marketDataServiceDescription,
} from '../../lib/marketdata/client';
import { useProviderSymbolSearch } from '../../lib/marketdata/use-provider-search';
import type { DuplicatePolicy } from '../../lib/validation/dataset';
import { Field, Modal, Segmented, Tag, TextInput } from '../ui';

const SYMBOL_RE = /^[A-Za-z0-9._^=:-]{1,16}$/;

/**
 * Sensible starting points for a first download. They are suggestions, not a
 * guarantee: the provider decides what exists, and a symbol that cannot be
 * downloaded is reported as a failure rather than replaced by other data.
 */
const SUGGESTED_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'];

type Phase = 'idle' | 'downloading' | 'review';
type Notice = { kind: 'error' | 'info'; text: string } | null;

function defaultStart(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.toISOString().slice(0, 10);
}

function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Dialog for downloading real daily history through the market-data service.
 * Localhost uses the optional local service; deployed hosts use the same-origin
 * proxy, so no local setup is needed. Loading, empty, throttled, timeout, unavailable and
 * malformed-response states are all explicit; a download can never silently
 * produce an empty dataset. The result is first reviewed (provider, adjustment
 * policy, retrieval time, validation summary) before it is saved.
 */
export function DownloadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actions } = useStore();
  const [symbol, setSymbol] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>('keep-first');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [review, setReview] = useState<DatasetBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const { suggestions, searching, dismiss } = useProviderSymbolSearch(symbol, open);
  // Both the run id and the controller are bumped on close and on a new
  // download, so a late response for an abandoned request can never replace a
  // newer review (or write state into a dialog the user has closed).
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancelInFlight = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancelInFlight();
    setPhase('idle');
    setNotice(null);
    setReview(null);
    setBusy(false);
  }, [cancelInFlight]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const rangeError = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 'Enter dates as YYYY-MM-DD.';
    if (start > end) return 'The start date must be on or before the end date.';
    return null;
  }, [start, end]);

  const symbolError = symbol.trim().length > 0 && !SYMBOL_RE.test(symbol.trim())
    ? 'Use a provider symbol such as AAPL, ^GSPC or BP.L.'
    : null;

  const download = async () => {
    const clean = symbol.trim();
    if (!SYMBOL_RE.test(clean) || rangeError) {
      setNotice({ kind: 'error', text: rangeError ?? 'Enter a valid symbol first.' });
      return;
    }
    // A second download supersedes the first: the abandoned request is aborted
    // and its run id is stale, so only this one may write the review state.
    cancelInFlight();
    const runId = runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('downloading');
    setNotice({ kind: 'info', text: `Requesting daily history for ${clean}…` });
    try {
      const history = await fetchProviderHistory({ symbol: clean, start, end }, DEFAULT_SERVICE_URL, controller.signal);
      if (runIdRef.current !== runId) return;
      const validation = validateProviderBars(history.bars, duplicatePolicy);
      if (validation.fatalErrors.length > 0) {
        setPhase('idle');
        setNotice({ kind: 'error', text: 'No valid daily sessions were returned for this symbol and range.' });
        return;
      }
      const bundle = buildDatasetBundle({
        history,
        validation,
        importedAt: new Date().toISOString(),
      });
      setReview(bundle);
      setPhase('review');
      setNotice(null);
    } catch (error) {
      // An aborted request is the expected result of closing the dialog or
      // starting a newer download, not a failure to report.
      if (runIdRef.current !== runId) return;
      setPhase('idle');
      setNotice({ kind: 'error', text: describeMarketDataFailure(error) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const save = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await actions.importDataset(review);
      // Reset before closing so reopening shows the download form rather than
      // the review of the dataset that was just saved.
      handleClose();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'The dataset could not be saved.' });
      setPhase('idle');
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  const metadata = review?.dataset.provider ?? null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Download market data"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={handleClose}>
            Cancel
          </button>
          {phase === 'review' ? (
            <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save dataset'}
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={phase === 'downloading' || Boolean(symbolError) || Boolean(rangeError) || symbol.trim().length === 0}
              onClick={() => void download()}
            >
              <CloudArrowDown size={14} aria-hidden />
              {phase === 'downloading' ? 'Downloading…' : 'Download'}
            </button>
          )}
        </>
      }
    >
      <div className="dialog-body">
        <div className="panel-sub" style={{ marginBottom: 8 }}>
          <GlobeSimple size={13} aria-hidden />{' '}
          Real historical data via {marketDataServiceDescription()}. The provider is named in the review before saving;
          it may be delayed for some venues and can fail without notice. Daily sessions only — the app aggregates weekly
          and monthly views itself.
        </div>

        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Symbol" error={symbolError ?? undefined} hint="Symbols follow provider conventions (e.g. AAPL, MSFT, ^GSPC).">
            <TextInput id="download-symbol" value={symbol} onChange={setSymbol} placeholder="AAPL" />
          </Field>
          <Field label="Duplicate sessions" hint="Applies if the source ever repeats a session date.">
            <Segmented
              label="Duplicate sessions"
              value={duplicatePolicy}
              onChange={setDuplicatePolicy}
              options={[
                { value: 'reject', label: 'Reject' },
                { value: 'keep-first', label: 'Keep first' },
                { value: 'keep-last', label: 'Keep last' },
              ]}
            />
          </Field>
          <Field label="Start (optional)" hint="Defaults to five years ago.">
            <TextInput id="download-start" value={start} onChange={setStart} placeholder="YYYY-MM-DD" />
          </Field>
          <Field label="End (optional)" hint="Defaults to today.">
            <TextInput id="download-end" value={end} onChange={setEnd} placeholder="YYYY-MM-DD" />
          </Field>
        </div>

        <div className="row tight" style={{ marginTop: 10, alignItems: 'center' }}>
          <span className="field-label">Suggested symbols</span>
          {SUGGESTED_SYMBOLS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="button ghost sm mono"
              onClick={() => {
                setSymbol(suggestion);
                dismiss(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
          <span className="field-hint">
            Availability depends on the provider. A symbol that cannot be downloaded fails with an explicit message; no
            other series is substituted for it.
          </span>
        </div>

        {suggestions !== null && (
          <ul className="suggestion-list" aria-label="Symbol suggestions">
            {suggestions.length === 0 && !searching && (
              <li className="field-hint">No suggestions. Type a symbol and press Download to try it directly.</li>
            )}
            {suggestions.map((suggestion) => (
              <li key={`${suggestion.exchangeName ?? ''}-${suggestion.symbol}`}>
                <button
                  type="button"
                  className="button ghost sm suggestion"
                  onClick={() => {
                    setSymbol(suggestion.symbol);
                    dismiss(suggestion.symbol);
                  }}
                >
                  <span className="mono">{suggestion.symbol}</span>
                  <span className="suggestion-name">{suggestion.name}</span>
                  <span className="muted">{suggestion.type ?? ''} {suggestion.exchangeName ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {searching && <div className="field-hint">Searching symbols…</div>}

        {notice && (
          <div className={notice.kind === 'error' ? 'field-error' : 'field-hint'} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'error' ? <Warning size={13} aria-hidden /> : null} {notice.text}
          </div>
        )}

        {phase === 'review' && review && metadata && (
          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-body">
              <div className="row tight" style={{ flexWrap: 'wrap' }}>
                <Tag tone="accent">{providerLabel(metadata.provider)} download</Tag>
                <Tag>{metadata.exchangeName ?? metadata.exchange ?? 'Exchange not reported'}</Tag>
                <Tag>{review.instrument.currency}</Tag>
                <Tag>{assetTypeFromProvider(metadata.instrumentType)}</Tag>
              </div>
              <div className="metric" style={{ marginTop: 8 }}>
                <span className="metric-label">Series</span>
                <span className="metric-value">{review.dataset.name}</span>
              </div>
              <div className="metric">
                <span className="metric-label">Sessions</span>
                <span className="metric-value">{review.dataset.rowCount.toLocaleString('en-US')}</span>
              </div>
              <div className="metric">
                <span className="metric-label">Range</span>
                <span className="metric-note mono">
                  {review.dataset.firstDate} through {review.dataset.lastDate}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">Adjustment</span>
                <span className="metric-note">{metadata.adjustment}</span>
              </div>
              <div className="metric">
                <span className="metric-label">Retrieved</span>
                <span className="metric-note mono">{metadata.retrievedAt}</span>
              </div>
              <div className="field-hint" style={{ marginTop: 6 }}>
                Limitations: daily bars only; frequencies above daily are aggregated locally; volume may be absent for
                some instruments; this is not real-time data and is not licensed for redistribution.
              </div>
              {review.dataset.validation.rejectedRows > 0 || review.dataset.validation.warnings.length > 0 ? (
                <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                  {describeValidationIssues(review.dataset.validation).map((issue) => (
                    <li key={issue} className="field-hint">
                      {issue}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

