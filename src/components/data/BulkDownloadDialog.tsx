import { useCallback, useMemo, useRef, useState } from 'react';
import { CloudArrowDown, GlobeSimple, Warning } from '@phosphor-icons/react';
import { useStore } from '../../state/store';
import { PROVIDER_LABEL } from '../../lib/marketdata/normalize';
import { DEFAULT_SERVICE_URL, fetchProviderHistory } from '../../lib/marketdata/client';
import { MAX_QUEUE_SYMBOLS, parseSymbolList, runDownloadQueue, type QueueItem } from '../../lib/marketdata/queue';
import { replaceTokenWithSymbol, searchQueryForToken, tokenAtCaret } from '../../lib/marketdata/symbol-suggest';
import { useProviderSymbolSearch } from '../../lib/marketdata/use-provider-search';
import type { DuplicatePolicy } from '../../lib/validation/dataset';
import { Field, Modal, Segmented, Tag, TextInput } from '../ui';

/**
 * Pause kept between requests so a batch does not hammer an unofficial provider.
 * A throttling failure earns a longer pause because the provider is explicitly
 * asking the caller to slow down.
 */
const REQUEST_PAUSE_MS = 500;
const THROTTLE_PAUSE_MS = 5_000;

type Notice = { kind: 'error' | 'info'; text: string } | null;

function defaultStart(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.toISOString().slice(0, 10);
}

function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankItem(symbol: string): QueueItem {
  return { symbol, status: 'pending', message: null, rowCount: null, firstDate: null, lastDate: null };
}

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  pending: 'Waiting',
  downloading: 'Downloading',
  saved: 'Saved',
  failed: 'Failed',
  skipped: 'Skipped',
};

/**
 * Downloads many symbols one at a time through the optional local market-data
 * service and stores each as its own dataset, which makes the whole batch
 * available to the screener and every other research view.
 *
 * Every symbol is reported individually: a failure never aborts the batch and
 * never produces an empty dataset. The run is cancellable between requests.
 */
export function BulkDownloadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actions } = useStore();
  const [raw, setRaw] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>('keep-first');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [summary, setSummary] = useState<string | null>(null);
  /**
   * Caret position of the symbol field, so a suggestion can be applied to the
   * token under the cursor and never to the other symbols in the list.
   */
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState<{ query: string; index: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Both refs are also bumped on close so a still-running batch cannot write
  // state into an unmounted dialog.
  const runIdRef = useRef(0);
  const cancelRef = useRef(false);

  const parsed = useMemo(() => parseSymbolList(raw), [raw]);
  const token = useMemo(() => tokenAtCaret(raw, caret), [raw, caret]);
  const query = searchQueryForToken(token);
  const { suggestions, searching, unavailable, dismiss } = useProviderSymbolSearch(query ?? '', open && !running);

  const options = suggestions ?? [];
  const highlighted =
    highlight !== null && query !== null && highlight.query === query && highlight.index < options.length
      ? highlight.index
      : -1;

  const rangeError = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 'Enter dates as YYYY-MM-DD.';
    if (start > end) return 'The start date must be on or before the end date.';
    return null;
  }, [start, end]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    cancelRef.current = true;
    setItems([]);
    setRunning(false);
    setCancelling(false);
    setNotice(null);
    setSummary(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  /** Applies a provider symbol to the token the caret is in. */
  const accept = (symbol: string) => {
    if (!token) return;
    const next = replaceTokenWithSymbol(raw, token, symbol);
    setRaw(next.value);
    setCaret(next.caret);
    setHighlight(null);
    dismiss(symbol);
    // The textarea renders the new value on the next frame, so the caret is
    // placed after it there rather than on the text it replaced.
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  const syncCaret = () => {
    const element = textareaRef.current;
    if (element) setCaret(element.selectionStart);
  };

  const moveHighlight = (delta: number) => {
    if (options.length === 0) return;
    const next =
      highlighted < 0 ? (delta > 0 ? 0 : options.length - 1) : (highlighted + delta + options.length) % options.length;
    setHighlight({ query: query ?? '', index: next });
  };

  const onSymbolKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Escape dismisses the list first; with nothing open it closes the dialog.
      if (options.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(query ?? '');
      setHighlight(null);
      return;
    }
    if (options.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // These keys move the caret in a textarea; while suggestions are open
      // they select a suggestion instead, so Enter stays the way to accept one.
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' && highlighted >= 0) {
      const choice = options[highlighted];
      if (!choice) return;
      event.preventDefault();
      accept(choice.symbol);
    }
  };

  const run = async (symbols: string[]) => {
    if (symbols.length === 0 || rangeError) {
      setNotice({ kind: 'error', text: rangeError ?? 'Add at least one symbol first.' });
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    cancelRef.current = false;
    setItems(symbols.map(blankItem));
    setRunning(true);
    setCancelling(false);
    setSummary(null);
    setNotice({ kind: 'info', text: `Requesting ${symbols.length} series from ${PROVIDER_LABEL}…` });

    const result = await runDownloadQueue(
      { symbols, range: { start, end }, duplicatePolicy },
      {
        fetchHistory: (symbol, range) => fetchProviderHistory({ symbol, start: range.start, end: range.end }),
        // One toast per symbol would bury the UI; the dialog owns the summary.
        save: (bundle) => actions.importDataset(bundle, { silent: true }),
        onUpdate: (next) => {
          if (runIdRef.current === runId) setItems([...next]);
        },
        isCancelled: () => cancelRef.current,
        delayMs: REQUEST_PAUSE_MS,
        throttleDelayMs: THROTTLE_PAUSE_MS,
      },
    );

    if (runIdRef.current !== runId) return; // Dialog closed while the batch ran.

    setRunning(false);
    setCancelling(false);
    setSummary(
      `${result.savedCount} saved, ${result.failedCount} failed${result.skippedCount ? `, ${result.skippedCount} skipped` : ''}.`,
    );
    if (result.cancelled) {
      setNotice({ kind: 'info', text: 'The batch was cancelled. Series already saved are unaffected.' });
    } else if (result.failedCount > 0) {
      setNotice({ kind: 'error', text: 'Some symbols failed. Review the reasons below and retry the failed ones.' });
    } else {
      setNotice({ kind: 'info', text: 'Every requested series was saved.' });
    }
    if (result.savedCount > 0) {
      actions.notify('success', `Downloaded ${result.savedCount} series (${symbols.length} requested).`);
    }
  };

  const failedSymbols = items.filter((item) => item.status === 'failed').map((item) => item.symbol);
  const canRun = !running && parsed.symbols.length > 0 && !rangeError;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Download many symbols"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={handleClose}>
            {running ? 'Cancel batch' : 'Close'}
          </button>
          {!running && failedSymbols.length > 0 && (
            <button type="button" className="button" onClick={() => void run(failedSymbols)}>
              Retry failed ({failedSymbols.length})
            </button>
          )}
          {running ? (
            <button
              type="button"
              className="button"
              disabled={cancelling}
              onClick={() => {
                cancelRef.current = true;
                setCancelling(true);
              }}
            >
              {cancelling ? 'Stopping…' : 'Cancel after this request'}
            </button>
          ) : (
            <button type="button" className="button primary" disabled={!canRun} onClick={() => void run(parsed.symbols)}>
              <CloudArrowDown size={14} aria-hidden />
              Download {parsed.symbols.length > 0 ? `${parsed.symbols.length} ` : ''}symbol{parsed.symbols.length === 1 ? '' : 's'}
            </button>
          )}
        </>
      }
    >
      <div className="dialog-body">
        <div className="panel-sub" style={{ marginBottom: 8 }}>
          <GlobeSimple size={13} aria-hidden /> {PROVIDER_LABEL} via the optional local market-data service (
          {DEFAULT_SERVICE_URL}). Series are fetched one at a time with a {REQUEST_PAUSE_MS / 1000}s pause between
          requests, up to {MAX_QUEUE_SYMBOLS} symbols per batch. Daily sessions only. This is real but unofficial data
          that can be delayed or throttled, and it is not licensed for redistribution.
        </div>

        <Field
          label="Symbols"
          hint="One per line, or separated by commas. Type a name such as google and pick its ticker from the suggestions. Duplicates are removed automatically."
        >
          <textarea
            id="bulk-symbols"
            ref={textareaRef}
            className="input"
            rows={6}
            value={raw}
            disabled={running}
            placeholder={'AAPL\nMSFT\nNVDA, AMZN, GOOGL'}
            aria-label="Symbols"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
            aria-controls={options.length > 0 ? 'bulk-symbol-suggestions' : undefined}
            aria-activedescendant={highlighted >= 0 ? `bulk-symbol-option-${highlighted}` : undefined}
            onChange={(event) => {
              setRaw(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onKeyDown={onSymbolKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
            onFocus={syncCaret}
          />
          {options.length > 0 && (
            <ul className="suggestion-list" id="bulk-symbol-suggestions" role="listbox" aria-label="Symbol suggestions">
              {options.map((option, index) => (
                <li
                  key={`${option.exchangeName ?? ''}-${option.symbol}`}
                  id={`bulk-symbol-option-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  className="suggestion"
                  // The tracked caret is state, so losing focus to this click does
                  // not move the pick onto another line of the list.
                  onClick={() => accept(option.symbol)}
                >
                  <span className="mono">{option.symbol}</span>
                  <span className="suggestion-name">{option.name}</span>
                  <span className="muted">
                    {option.type ?? ''} {option.exchangeName ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {searching && <div className="field-hint">Searching symbols…</div>}
          {suggestions !== null && options.length === 0 && !searching && (
            <div className="field-hint">No symbol matched. A ticker typed here is still requested as-is.</div>
          )}
          {unavailable && (
            <div className="field-hint">
              Symbol suggestions could not reach the local market-data service. Tickers typed here are still requested
              as-is.
            </div>
          )}
        </Field>

        <div className="panel-sub" style={{ marginTop: 6 }}>
          {parsed.symbols.length} symbol{parsed.symbols.length === 1 ? '' : 's'} ready
          {parsed.duplicates.length > 0 ? ` · ${parsed.duplicates.length} duplicate(s) removed` : ''}
          {parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} invalid token(s) ignored` : ''}
          {parsed.droppedForLimit > 0 ? ` · ${parsed.droppedForLimit} over the ${MAX_QUEUE_SYMBOLS}-symbol limit` : ''}
        </div>
        {parsed.invalid.length > 0 && (
          <div className="field-error" role="alert">
            <Warning size={13} aria-hidden /> Ignored: {parsed.invalid.map((problem) => problem.token).join(', ')}
          </div>
        )}

        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
          <Field label="Start (optional)" hint="Defaults to five years ago." error={rangeError ?? undefined}>
            <TextInput id="bulk-start" value={start} onChange={setStart} placeholder="YYYY-MM-DD" disabled={running} />
          </Field>
          <Field label="End (optional)" hint="Defaults to today.">
            <TextInput id="bulk-end" value={end} onChange={setEnd} placeholder="YYYY-MM-DD" disabled={running} />
          </Field>
          <Field label="Duplicate sessions" hint="Applies per symbol if the source repeats a session date.">
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
        </div>

        {notice && (
          <div className={notice.kind === 'error' ? 'field-error' : 'field-hint'} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'error' ? <Warning size={13} aria-hidden /> : null} {notice.text}
          </div>
        )}
        {summary && <div className="panel-sub">{summary}</div>}

        {items.length > 0 && (
          <div className="table-wrap scroll-y" style={{ marginTop: 10, maxHeight: 260 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.symbol}>
                    <td className="mono">{item.symbol}</td>
                    <td>
                      <Tag
                        tone={
                          item.status === 'saved'
                            ? 'up'
                            : item.status === 'failed'
                              ? 'down'
                              : item.status === 'skipped'
                                ? 'warn'
                                : item.status === 'downloading'
                                  ? 'accent'
                                  : undefined
                        }
                      >
                        {STATUS_LABEL[item.status]}
                      </Tag>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>
                      {item.status === 'saved' && item.rowCount !== null ? (
                        <span className="mono">
                          {item.rowCount.toLocaleString('en-US')} sessions · {item.firstDate} to {item.lastDate}
                        </span>
                      ) : (
                        <span className={item.status === 'failed' ? 'field-error' : 'muted'}>{item.message ?? '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!running && items.some((item) => item.status === 'saved') && (
          <div className="field-hint" style={{ marginTop: 8 }}>
            Saved series are now available to the chart workspace, Quant lab, backtest and the screener.
          </div>
        )}
      </div>
    </Modal>
  );
}
