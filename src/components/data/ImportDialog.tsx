import { useMemo, useState } from 'react';
import { UploadSimple } from '@phosphor-icons/react';
import type { AssetType, Bar, Dataset, Instrument } from '../../domain/types';
import { parseCsv, toPreview, type ParsedCsv } from '../../lib/csv/parse';
import { emptyMapping, inferMapping, validateMapping, type ColumnMapping, type ColumnRole } from '../../lib/csv/mapping';
import { validateCsvRows, type DuplicatePolicy } from '../../lib/validation/dataset';
import { readFileAsText } from '../../lib/export/download';
import { createId } from '../../lib/id';
import { toCsv } from '../../lib/export/csv';
import { useStore } from '../../state/store';
import { Field, Modal, Select, Tag, TextInput } from '../ui';

const ROLE_OPTIONS: Array<{ value: ColumnRole; label: string }> = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'date', label: 'Date' },
  { value: 'open', label: 'Open' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'close', label: 'Close' },
  { value: 'volume', label: 'Volume' },
];

const ASSET_OPTIONS: Array<{ value: AssetType; label: string }> = [
  { value: 'equity', label: 'Equity' },
  { value: 'index', label: 'Index' },
  { value: 'fx', label: 'FX' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'commodity', label: 'Commodity' },
  { value: 'fund', label: 'Fund' },
  { value: 'other', label: 'Other' },
];

const SAMPLE_CSV = toCsv(
  ['date', 'open', 'high', 'low', 'close', 'volume'],
  [
    ['2026-01-02', 100, 102.5, 99.5, 101.8, 1200000],
    ['2026-01-05', 101.8, 103.4, 100.9, 102.7, 980000],
  ],
);

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useStore();
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>('reject');
  const [symbol, setSymbol] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [assetType, setAssetType] = useState<AssetType>('equity');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setParsed(null);
    setMapping({});
    setError(null);
    setSymbol('');
    setDisplayName('');
  };

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const text = await readFileAsText(file);
      const result = parseCsv(text);
      if (result.headers.length === 0) {
        setError('No columns were found in that file.');
        return;
      }
      setParsed(result);
      setMapping(inferMapping(result.headers));
      const base = file.name.replace(/\.[^.]+$/, '').slice(0, 24);
      setSymbol(base.toUpperCase().replace(/[^A-Z0-9._-]/g, '') || 'IMPORT');
      setDisplayName(base || 'Imported series');
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'The file could not be read.');
    }
  };

  const mappingWarnings = useMemo(() => (parsed ? validateMapping(mapping) : []), [parsed, mapping]);

  const validation = useMemo(() => {
    if (!parsed) return null;
    if (validateMapping(mapping).some((warning) => warning.code.startsWith('missing-'))) return null;
    return validateCsvRows({ rows: parsed.rows, mapping, duplicatePolicy });
  }, [parsed, mapping, duplicatePolicy]);

  const commit = async () => {
    if (!parsed || !validation || validation.fatalErrors.length > 0) return;
    setBusy(true);
    try {
      const bars: Bar[] = validation.bars;
      const first = bars[0] as Bar;
      const last = bars[bars.length - 1] as Bar;
      const instrument: Instrument = {
        id: createId('inst'),
        symbol: symbol.trim().toUpperCase() || 'IMPORT',
        displayName: displayName.trim() || symbol.trim() || 'Imported series',
        assetType,
        currency: currency.trim().toUpperCase() || 'USD',
        metadata: { importedFrom: parsed.headers.join(',') },
      };
      const dataset: Dataset = {
        id: createId('ds'),
        instrumentId: instrument.id,
        name: `${instrument.symbol} - daily (imported)`,
        sourceKind: 'user-csv',
        sourceDescription: 'Imported from a CSV file on this device',
        frequency: 'daily',
        timezone: 'UTC',
        firstDate: first.date,
        lastDate: last.date,
        rowCount: bars.length,
        importedAt: new Date().toISOString(),
        contentHash: validation.contentHash,
        hasVolume: validation.hasVolume,
        validation: validation.summary,
      };
      await actions.importDataset({ instrument, dataset, bars });
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const preview = parsed ? toPreview(parsed, 6) : [];

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import OHLCV from CSV"
      wide
      footer={
        <>
          <button type="button" className="button ghost" onClick={() => { reset(); onClose(); }}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!validation || validation.fatalErrors.length > 0 || busy}
            onClick={() => void commit()}
          >
            {busy ? 'Importing...' : 'Import dataset'}
          </button>
        </>
      }
    >
      <p className="panel-sub">
        Files are parsed as inert data on this device. Nothing is uploaded. Only daily sessions are accepted; higher
        timeframes are aggregated from daily here, never the other way round.
      </p>

      {error && <span className="field-error">{error}</span>}

      {!parsed && (
        <Field label="CSV file" hint="A header row is required. Expected columns include date, open, high, low, close and optionally volume.">
          <input
            className="input"
            type="file"
            accept=".csv,text/csv,.txt"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </Field>
      )}

      {parsed && (
        <>
          <div className="panel" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="panel-head">
              <span className="panel-title">Map columns</span>
              <div style={{ flex: 1 }} />
              {mappingWarnings.length === 0 ? <Tag tone="up">Ready</Tag> : <Tag tone="warn">{mappingWarnings.length} issue(s)</Tag>}
            </div>
            <div className="panel-body">
              <div className="grid-3">
                {parsed.headers.map((header) => (
                  <Field key={header} label={header || '(empty header)'}>
                    <Select
                      value={mapping[header] ?? 'ignore'}
                      options={ROLE_OPTIONS}
                      onChange={(value) => setMapping((previous) => ({ ...previous, [header]: value }))}
                    />
                  </Field>
                ))}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="button sm ghost" onClick={() => setMapping(emptyMapping(parsed.headers))}>
                  Clear all
                </button>
                <button type="button" className="button sm ghost" onClick={() => setMapping(inferMapping(parsed.headers))}>
                  Re-detect
                </button>
              </div>
              {mappingWarnings.length > 0 && (
                <ul className="list-reset stack" style={{ marginTop: 8 }}>
                  {mappingWarnings.map((warning) => (
                    <li key={warning.code} className="field-error">
                      {warning.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="panel" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="panel-head">
              <span className="panel-title">Preview</span>
              <span className="panel-sub">First {preview.length} rows of {parsed.totalRows}</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {parsed.headers.map((header) => (
                      <th key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, index) => (
                    <tr key={index}>
                      {parsed.headers.map((header) => (
                        <td key={header} className="num">
                          {row[header] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid-3">
            <Field label="Symbol">
              <TextInput value={symbol} onChange={setSymbol} placeholder="ATX" />
            </Field>
            <Field label="Display name">
              <TextInput value={displayName} onChange={setDisplayName} placeholder="Aurora Tech" />
            </Field>
            <Field label="Asset type">
              <Select value={assetType} options={ASSET_OPTIONS} onChange={setAssetType} />
            </Field>
            <Field label="Currency">
              <TextInput value={currency} onChange={setCurrency} placeholder="USD" />
            </Field>
            <Field label="Duplicate sessions" hint="Applied when the same session date appears more than once.">
              <Select
                value={duplicatePolicy}
                onChange={setDuplicatePolicy}
                options={[
                  { value: 'reject', label: 'Reject all duplicates' },
                  { value: 'keep-first', label: 'Keep first occurrence' },
                  { value: 'keep-last', label: 'Keep last occurrence' },
                ]}
              />
            </Field>
          </div>

          {validation && (
            <div className="panel" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="panel-head">
                <span className="panel-title">Validation</span>
                <div style={{ flex: 1 }} />
                {validation.fatalErrors.length > 0 ? (
                  <Tag tone="down">Cannot import</Tag>
                ) : (
                  <Tag tone="up">
                    {validation.summary.acceptedRows} row{validation.summary.acceptedRows === 1 ? '' : 's'} accepted
                  </Tag>
                )}
              </div>
              <div className="panel-body stack">
                {validation.fatalErrors.map((fatal) => (
                  <span key={fatal} className="field-error">
                    {fatal}
                  </span>
                ))}
                <div className="grid-4">
                  <div className="metric">
                    <span className="metric-label">Accepted</span>
                    <span className="metric-value">{validation.summary.acceptedRows}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Rejected</span>
                    <span className="metric-value">{validation.summary.rejectedRows}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Duplicates</span>
                    <span className="metric-value">{validation.summary.duplicateRows}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Missing sessions</span>
                    <span className="metric-value">{validation.summary.gapCount}</span>
                  </div>
                </div>
                {validation.summary.warnings.map((warning) => (
                  <span key={warning.code} className="field-hint">
                    {warning.message}
                  </span>
                ))}
                {validation.summary.rejected.length > 0 && (
                  <details>
                    <summary className="field-label">Rejected rows ({validation.summary.rejected.length} shown)</summary>
                    <div className="table-wrap scroll-y" style={{ marginTop: 6 }}>
                      <table className="data">
                        <thead>
                          <tr>
                            <th className="num">Row</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {validation.summary.rejected.slice(0, 30).map((row) => (
                            <tr key={`${row.rowNumber}-${row.reason}`}>
                              <td className="num">{row.rowNumber}</td>
                              <td style={{ whiteSpace: 'normal' }}>{row.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                <details>
                  <summary className="field-label">Sample CSV format</summary>
                  <pre className="mono" style={{ fontSize: 11, overflowX: 'auto', margin: '6px 0 0' }}>
                    {SAMPLE_CSV}
                  </pre>
                </details>
              </div>
            </div>
          )}
        </>
      )}

      {!parsed && (
        <div className="empty">
          <UploadSimple size={22} aria-hidden />
          <span className="empty-title">No file selected</span>
          <span className="empty-body">
            Currently {state.datasets.length} dataset{state.datasets.length === 1 ? '' : 's'} are stored locally. Choose a
            CSV to validate and add another.
          </span>
        </div>
      )}
    </Modal>
  );
}
