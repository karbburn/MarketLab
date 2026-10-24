import { describe, expect, it } from 'vitest';
import type { Dataset, DatasetValidationSummary } from '../../src/domain/types';
import { buildProvenanceSummary } from '../../src/lib/provenance/summary';

const CLEAN_VALIDATION: DatasetValidationSummary = {
  acceptedRows: 10,
  rejectedRows: 0,
  duplicateRows: 0,
  missingVolumeRows: 0,
  gapCount: 0,
  sortCorrections: 0,
  rejected: [],
  warnings: [],
};

function makeDataset(
  overrides: Partial<Omit<Dataset, 'validation'>> & { validation?: Partial<DatasetValidationSummary> } = {},
): Dataset {
  const { validation: validationOverride, ...rest } = overrides;
  return {
    id: 'ds_test',
    instrumentId: 'inst_test',
    name: 'TEST - daily (imported)',
    sourceKind: 'user-csv',
    sourceDescription: 'Imported from a CSV file.',
    frequency: 'daily',
    timezone: 'UTC',
    firstDate: '2026-01-02',
    lastDate: '2026-01-16',
    rowCount: 10,
    importedAt: '2026-01-17T09:30:00.000Z',
    contentHash: 'fnv1a-test',
    hasVolume: true,
    ...rest,
    validation: { ...CLEAN_VALIDATION, ...validationOverride },
  };
}

describe('buildProvenanceSummary', () => {
  it('reports a clean provider download with only recorded provenance', () => {
    const dataset = makeDataset({
      sourceKind: 'provider-download',
      sourceDescription: 'Downloaded from Yahoo Finance via the local market-data service.',
      timezone: 'America/New_York',
      provider: {
        provider: 'yahoo-finance',
        providerSymbol: 'AAPL',
        exchange: 'NMS',
        exchangeName: 'NasdaqGS',
        instrumentType: 'EQUITY',
        interval: '1d',
        adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
        retrievedAt: '2026-01-17T09:30:00.000Z',
        timezone: 'America/New_York',
        sourceNotes: ['Unofficial, undocumented Yahoo Finance data.'],
      },
    });

    const summary = buildProvenanceSummary(dataset);

    expect(summary.status).toBe('clean');
    expect(summary.statusLabel).toBe('Data: clean');
    expect(summary.headline).toBe('Clean');
    expect(summary.statusNote).toBe(
      'No issues were recorded by import-time validation when this series was stored. ' +
        'It does not certify the data; the limits below state what MarketLab cannot know.',
    );
    expect(summary.issues).toEqual([]);
    expect(summary.inspectDatasetId).toBe('ds_test');
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Source', value: 'Yahoo Finance download' }),
        expect.objectContaining({ label: 'Exchange', value: 'NasdaqGS' }),
        expect.objectContaining({ label: 'Timezone', value: 'America/New_York' }),
        expect.objectContaining({
          label: 'Adjustment',
          value: 'splits-applied, dividends not reinvested (as-traded OHLC)',
        }),
        expect.objectContaining({ label: 'Retrieved', value: '2026-01-17 09:30' }),
      ]),
    );
    expect(summary.counts.every((count) => count.value === '0' || count.label === 'Accepted rows')).toBe(true);
    expect(summary.limitations.join(' ')).toContain('unofficial');
    expect(summary.limitations.join(' ')).toContain('Unofficial, undocumented Yahoo Finance data.');
  });

  it('names the fallback provider without calling it unofficial', () => {
    const dataset = makeDataset({
      sourceKind: 'provider-download',
      sourceDescription: 'Downloaded from Twelve Data via MarketLab’s market-data service.',
      timezone: 'America/New_York',
      provider: {
        provider: 'twelve-data',
        providerSymbol: 'AAPL',
        exchange: 'XNAS',
        exchangeName: 'NASDAQ',
        instrumentType: 'Common Stock',
        interval: '1d',
        adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported',
        retrievedAt: '2026-01-17T09:30:00.000Z',
        timezone: 'America/New_York',
        sourceNotes: ['The time-series response does not include corporate-action events.'],
      },
    });

    const summary = buildProvenanceSummary(dataset);
    expect(summary.sourceLabel).toBe('Twelve Data');
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Source', value: 'Twelve Data download' }),
      ]),
    );
    expect(summary.limitations.join(' ')).toContain('Twelve Data data may be delayed');
    expect(summary.limitations.join(' ')).not.toContain('Twelve Data data is unofficial');
  });

  it('does not invent an adjustment or retrieval date for a CSV import', () => {
    const summary = buildProvenanceSummary(makeDataset(), { exchange: 'NMS' });

    expect(summary.status).toBe('clean');
    expect(summary.sourceLabel).toBe('Imported CSV');
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Source', value: 'Imported CSV' }),
        expect.objectContaining({ label: 'Exchange', value: 'NMS' }),
        expect.objectContaining({ label: 'Adjustment', value: 'Not recorded for this import' }),
        expect.objectContaining({ label: 'Imported', value: '2026-01-17' }),
      ]),
    );
    expect(summary.fields.some((field) => field.label === 'Retrieved')).toBe(false);
    expect(summary.limitations.join(' ')).toContain('does not verify those prices');
  });

  it('lists every validation counter once and explains the weekday-gap limit', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        validation: {
          acceptedRows: 10,
          rejectedRows: 2,
          duplicateRows: 1,
          missingVolumeRows: 3,
          gapCount: 5,
          sortCorrections: 2,
          warnings: [
            { code: 'weekend-rows', message: '1 row(s) fall on a weekend.', count: 1 },
            { code: 'session-gaps', message: '5 expected weekday sessions are missing.', count: 5 },
            { code: 'missing-volume', message: '3 rows have no volume.', count: 3 },
          ],
        },
      }),
    );

    expect(summary.status).toBe('attention');
    expect(summary.statusLabel).toBe('Data: 6 issues');
    expect(summary.statusNote).toBe(
      'Import-time validation recorded the issues listed below when this series was stored.',
    );
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      'rejected-rows',
      'duplicate-sessions',
      'missing-volume',
      'weekday-gaps',
      'order-corrections',
      'weekend-rows',
    ]);
    // The warning copies of session-gaps and missing-volume are not counted twice.
    expect(summary.issues.filter((issue) => issue.code === 'weekday-gaps')).toHaveLength(1);
    expect(summary.limitations.join(' ')).toContain('public holidays and genuinely missing sessions look identical');
  });

  it('treats an absent volume column as a source limit, not a per-row defect', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        hasVolume: false,
        validation: { missingVolumeRows: 10 },
      }),
    );

    expect(summary.status).toBe('clean');
    expect(summary.issues.some((issue) => issue.code === 'missing-volume')).toBe(false);
    expect(summary.counts.find((count) => count.label === 'Rows without volume')?.note).toBe(
      'No volume in this source',
    );
    expect(summary.limitations.join(' ')).toContain('carries no volume');
  });

  it('labels legacy demo data without presenting it as real market data', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        sourceKind: 'bundled-sample',
        sourceDescription: 'Bundled synthetic sample data (deterministic, not real market data)',
        validation: {
          warnings: [{ code: 'synthetic-data', message: 'Synthetic demo series generated locally.' }],
        },
      }),
    );

    expect(summary.status).toBe('legacy');
    expect(summary.statusLabel).toBe('Data: legacy demo');
    expect(summary.headline).toBe('Legacy demo data');
    expect(summary.statusNote).toBe('Synthetic demo series, not real market data.');
    expect(summary.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Adjustment', value: 'Not applicable (synthetic series)' })]),
    );
    expect(summary.limitations.join(' ')).toContain('must not be used for research conclusions');
  });

  it('reports an empty dataset as no rows rather than clean', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        rowCount: 0,
        firstDate: '',
        lastDate: '',
        validation: { acceptedRows: 0 },
      }),
    );

    expect(summary.status).toBe('empty');
    expect(summary.statusLabel).toBe('Data: no rows');
    expect(summary.statusNote).toBe('No rows are stored, so there is nothing to validate.');
    expect(summary.coverage).toBe('No stored sessions');
    expect(summary.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Coverage', value: 'No stored sessions' })]),
    );
  });

  it('flags a download that covers less than was requested', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        sourceKind: 'provider-download',
        sourceDescription: 'Downloaded from Twelve Data via MarketLab’s market-data service.',
        firstDate: '2006-12-06',
        lastDate: '2026-10-22',
        rowCount: 5000,
        provider: {
          provider: 'twelve-data',
          providerSymbol: 'BRK.B',
          exchange: 'XNYS',
          exchangeName: 'NYSE',
          instrumentType: 'Common Stock',
          interval: '1d',
          adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported',
          retrievedAt: '2026-10-24T09:30:00.000Z',
          timezone: 'America/New_York',
          requestedRange: { start: '1995-01-01', end: '2026-10-23' },
          sourceNotes: ['At most 5,000 bars are returned per request.'],
        },
        validation: { acceptedRows: 5000 },
      }),
    );

    expect(summary.status).toBe('attention');
    expect(summary.issues.map((issue) => issue.code)).toEqual(['range-shortfall']);
    const [issue] = summary.issues;
    expect(issue?.label).toBe('Requested range not covered');
    // Calendar days missing at the start plus the single missing day at the end.
    expect(issue?.count).toBeGreaterThan(4000);
    expect(issue?.detail).toContain('5,000 bars');
    expect(summary.limitations.join(' ')).toContain('2006-12-06 to 2026-10-22');
    expect(summary.limitations.join(' ')).toContain('Sessions outside the returned window are not part of this dataset.');
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Coverage',
          value: '2006-12-06 to 2026-10-22',
          note: expect.stringContaining('requested 1995-01-01 to 2026-10-23'),
        }),
      ]),
    );
  });

  it('stays clean when the requested range was fully covered', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        sourceKind: 'provider-download',
        sourceDescription: 'Downloaded from Yahoo Finance via MarketLab’s market-data service.',
        provider: {
          provider: 'yahoo-finance',
          providerSymbol: 'AAPL',
          exchange: 'NMS',
          exchangeName: 'NasdaqGS',
          instrumentType: 'EQUITY',
          interval: '1d',
          adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
          retrievedAt: '2026-01-17T09:30:00.000Z',
          timezone: 'America/New_York',
          requestedRange: { start: '2026-01-02', end: '2026-01-16' },
          sourceNotes: ['Unofficial, undocumented Yahoo Finance data.'],
        },
      }),
    );

    expect(summary.status).toBe('clean');
    expect(summary.issues).toEqual([]);
    expect(summary.limitations.join(' ')).not.toContain('Sessions outside the returned window');
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Coverage',
          note: expect.stringContaining('requested 2026-01-02 to 2026-01-16'),
        }),
      ]),
    );
  });

  it('does not claim coverage for a download stored before the request was recorded', () => {
    const summary = buildProvenanceSummary(
      makeDataset({
        sourceKind: 'provider-download',
        sourceDescription: 'Downloaded from Yahoo Finance via MarketLab’s market-data service.',
        provider: {
          provider: 'yahoo-finance',
          providerSymbol: 'AAPL',
          exchange: 'NMS',
          exchangeName: 'NasdaqGS',
          instrumentType: 'EQUITY',
          interval: '1d',
          adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
          retrievedAt: '2026-01-17T09:30:00.000Z',
          timezone: 'America/New_York',
          sourceNotes: [],
        },
      }),
    );

    expect(summary.status).toBe('clean');
    expect(summary.issues).toEqual([]);
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Coverage', note: '10 stored sessions' }),
      ]),
    );
  });
});
