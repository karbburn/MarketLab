import { describe, expect, it } from 'vitest';
import type { Dataset, DatasetProvider, DatasetValidationSummary } from '../../src/domain/types';
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

const PROVIDER: DatasetProvider = {
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

function providerDataset(overrides: Partial<Omit<Dataset, 'validation'>> = {}): Dataset {
  return makeDataset({
    sourceKind: 'provider-download',
    sourceDescription: 'Downloaded from Yahoo Finance via the local market-data service.',
    timezone: 'America/New_York',
    provider: PROVIDER,
    ...overrides,
  });
}

const AT_RETRIEVAL_TIME = { now: new Date('2026-01-17T12:00:00.000Z') };

describe('buildProvenanceSummary', () => {
  describe('status vocabulary and clean honesty', () => {
    it('reports a clean provider download with only recorded provenance', () => {
      const summary = buildProvenanceSummary(providerDataset(), AT_RETRIEVAL_TIME);

      expect(summary.status).toBe('clean');
      expect(summary.statusLabel).toBe('Data: no issues');
      expect(summary.headline).toBe('No recorded issues');
      expect(summary.severity).toBeNull();
      expect(summary.materialCount).toBe(0);
      expect(summary.advisoryCount).toBe(0);
      expect(summary.statusNote).toBe(
        'Import-time validation recorded no issues. This is not a certification: provider data can be delayed ' +
          'or revised, and MarketLab does not re-check the prices.',
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
          expect.objectContaining({
            label: 'Retrieved',
            value: '2026-01-17 09:30',
            note: 'retrieved today · provider timestamp, UTC',
          }),
        ]),
      );
      expect(summary.freshness).toEqual({ ageDays: 0, label: 'retrieved today', source: 'provider' });
      expect(summary.counts.every((count) => count.value === '0' || count.label === 'Accepted rows')).toBe(true);
      expect(summary.limitations.join(' ')).toContain('unofficial');
      expect(summary.limitations.join(' ')).toContain('Unofficial, undocumented Yahoo Finance data.');
    });

    it('names the fallback provider without calling it unofficial', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          sourceKind: 'provider-download',
          sourceDescription: 'Downloaded from Twelve Data via MarketLab’s market-data service.',
          timezone: 'America/New_York',
          provider: {
            ...PROVIDER,
            provider: 'twelve-data',
            exchange: 'XNAS',
            exchangeName: 'NASDAQ',
            instrumentType: 'Common Stock',
            adjustment:
              'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported',
            sourceNotes: ['The time-series response does not include corporate-action events.'],
          },
        }),
      );

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
      const summary = buildProvenanceSummary(makeDataset(), {
        exchange: 'NMS',
        now: new Date('2026-01-17T12:00:00.000Z'),
      });

      expect(summary.status).toBe('clean');
      expect(summary.statusLabel).toBe('Data: no issues');
      expect(summary.statusNote).toBe(
        'Import-time validation recorded no issues. MarketLab does not verify imported prices against an ' +
          'exchange or a second source.',
      );
      expect(summary.sourceLabel).toBe('Imported CSV');
      expect(summary.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Source', value: 'Imported CSV' }),
          expect.objectContaining({ label: 'Exchange', value: 'NMS' }),
          expect.objectContaining({ label: 'Adjustment', value: 'Not recorded for this import' }),
          expect.objectContaining({
            label: 'Imported',
            value: '2026-01-17',
            note: 'imported today · when this browser stored the series',
          }),
        ]),
      );
      expect(summary.fields.some((field) => field.label === 'Retrieved')).toBe(false);
      expect(summary.freshness).toEqual({ ageDays: 0, label: 'imported today', source: 'import' });
      expect(summary.limitations.join(' ')).toContain('does not verify those prices');
    });
  });

  describe('issue severity and priority', () => {
    it('classifies and ranks all eight issue codes', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          sourceKind: 'provider-download',
          firstDate: '2006-12-06',
          lastDate: '2026-10-22',
          rowCount: 5000,
          provider: {
            ...PROVIDER,
            provider: 'twelve-data',
            requestedRange: { start: '1995-01-01', end: '2026-10-23' },
          },
          validation: {
            acceptedRows: 5000,
            rejectedRows: 2,
            duplicateRows: 1,
            missingVolumeRows: 3,
            gapCount: 5,
            sortCorrections: 2,
            warnings: [
              { code: 'some-new-warning', message: 'A warning this build does not know.', count: 4 },
              { code: 'weekend-rows', message: '1 row(s) fall on a weekend.', count: 1 },
            ],
          },
        }),
      );

      expect(summary.issues.map((issue) => issue.code)).toEqual([
        'range-shortfall',
        'rejected-rows',
        'duplicate-sessions',
        'weekend-rows',
        'missing-volume',
        'weekday-gaps',
        'order-corrections',
        'other-warning',
      ]);
      expect(summary.issues.map((issue) => issue.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(summary.issues.map((issue) => issue.severity)).toEqual([
        'material',
        'material',
        'material',
        'material',
        'advisory',
        'advisory',
        'advisory',
        'advisory',
      ]);
      // Unknown codes cannot establish materiality, so they stay advisory.
      expect(summary.issues[7]?.label).toBe('Some New Warning');
      expect(summary.issues[7]?.count).toBe(4);
    });

    it('keeps weekend rows material, not a routine timezone artefact', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          validation: {
            warnings: [{ code: 'weekend-rows', message: '2 row(s) fall on a weekend.', count: 2 }],
          },
        }),
      );

      const weekend = summary.issues.find((issue) => issue.code === 'weekend-rows');
      expect(weekend).toMatchObject({ severity: 'material', rank: 4, count: 2 });
      expect(summary.severity).toBe('material');
      expect(summary.materialCount).toBe(1);
      expect(summary.advisoryCount).toBe(0);
    });

    it('counts material issues on the chip and reads them first', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          validation: {
            rejectedRows: 1,
            warnings: [{ code: 'weekend-rows', message: '1 row(s) fall on a weekend.', count: 1 }],
          },
        }),
      );

      expect(summary.status).toBe('attention');
      expect(summary.severity).toBe('material');
      expect(summary.materialCount).toBe(2);
      expect(summary.advisoryCount).toBe(0);
      expect(summary.statusLabel).toBe('Data: 2 issues');
      expect(summary.headline).toBe('2 issues');
      expect(summary.issues.map((issue) => issue.code)).toEqual(['rejected-rows', 'weekend-rows']);
    });

    it('reports advisory-only defects as notes without a warning headline', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          validation: { missingVolumeRows: 3, gapCount: 5 },
        }),
      );

      expect(summary.status).toBe('attention');
      expect(summary.severity).toBe('advisory');
      expect(summary.materialCount).toBe(0);
      expect(summary.advisoryCount).toBe(2);
      expect(summary.statusLabel).toBe('Data: 2 notes');
      expect(summary.headline).toBe('2 notes');
      expect(summary.statusNote).toContain('no material issues');
      expect(summary.issues.map((issue) => issue.code)).toEqual(['missing-volume', 'weekday-gaps']);
    });

    it('names both tiers when material and advisory issues coexist', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          validation: { rejectedRows: 1, gapCount: 2 },
        }),
      );

      expect(summary.severity).toBe('material');
      expect(summary.materialCount).toBe(1);
      expect(summary.advisoryCount).toBe(1);
      expect(summary.statusLabel).toBe('Data: 1 issue');
      expect(summary.headline).toBe('1 issue, 1 note');
      expect(summary.issues.map((issue) => issue.code)).toEqual(['rejected-rows', 'weekday-gaps']);
    });

    it('lists every validation counter once and sorts independently of insertion order', () => {
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
      expect(summary.statusLabel).toBe('Data: 3 issues');
      expect(summary.headline).toBe('3 issues, 3 notes');
      expect(summary.issues.map((issue) => issue.code)).toEqual([
        'rejected-rows',
        'duplicate-sessions',
        'weekend-rows',
        'missing-volume',
        'weekday-gaps',
        'order-corrections',
      ]);
      // The warning copies of session-gaps and missing-volume are not counted twice.
      expect(summary.issues.filter((issue) => issue.code === 'weekday-gaps')).toHaveLength(1);
      expect(
        summary.issues.filter((issue) => issue.code === 'missing-volume'),
      ).toHaveLength(1);
      expect(summary.limitations.join(' ')).toContain(
        'public holidays and genuinely missing sessions look identical',
      );
    });

    it('treats an absent volume column as a source limit, not a per-row defect', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          hasVolume: false,
          validation: { missingVolumeRows: 10 },
        }),
      );

      expect(summary.status).toBe('clean');
      expect(summary.statusLabel).toBe('Data: no issues');
      expect(summary.issues.some((issue) => issue.code === 'missing-volume')).toBe(false);
      expect(summary.counts.find((count) => count.label === 'Rows without volume')?.note).toBe(
        'No volume in this source',
      );
      expect(summary.limitations.join(' ')).toContain('carries no volume');
    });
  });

  describe('freshness', () => {
    const freshnessFor = (importedAt: string, now: string) =>
      buildProvenanceSummary(makeDataset({ importedAt }), { now: new Date(now) }).freshness;

    it('counts whole UTC calendar days and labels the common cases', () => {
      expect(freshnessFor('2026-01-17T23:59:00.000Z', '2026-01-17T00:01:00.000Z')).toEqual({
        ageDays: 0,
        label: 'imported today',
        source: 'import',
      });
      expect(freshnessFor('2026-01-17T23:59:00.000Z', '2026-01-18T00:01:00.000Z')).toEqual({
        ageDays: 1,
        label: 'imported yesterday',
        source: 'import',
      });
      expect(freshnessFor('2026-01-15T09:30:00.000Z', '2026-01-18T09:30:00.000Z')).toEqual({
        ageDays: 3,
        label: 'imported 3 days ago',
        source: 'import',
      });
      expect(freshnessFor('2024-12-31T09:30:00.000Z', '2026-01-02T09:30:00.000Z')).toEqual({
        ageDays: 367,
        label: 'imported over a year ago',
        source: 'import',
      });
    });

    it('uses the provider retrieval timestamp for downloads', () => {
      const summary = buildProvenanceSummary(
        providerDataset({ importedAt: '2026-02-01T00:00:00.000Z' }),
        { now: new Date('2026-01-18T12:00:00.000Z') },
      );

      expect(summary.freshness).toEqual({
        ageDays: 1,
        label: 'retrieved yesterday',
        source: 'provider',
      });
      expect(summary.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'Retrieved',
            note: 'retrieved yesterday · provider timestamp, UTC',
          }),
        ]),
      );
    });

    it('returns null for invalid and future timestamps instead of inventing an age', () => {
      expect(freshnessFor('not-a-date', '2026-01-17T12:00:00.000Z')).toBeNull();
      expect(freshnessFor('', '2026-01-17T12:00:00.000Z')).toBeNull();
      expect(freshnessFor('2026-01-18T09:30:00.000Z', '2026-01-17T12:00:00.000Z')).toBeNull();
    });

    it('never changes the status or severity', () => {
      const old = buildProvenanceSummary(providerDataset(), {
        now: new Date('2027-06-01T12:00:00.000Z'),
      });
      expect(old.freshness?.label).toBe('retrieved over a year ago');
      expect(old.status).toBe('clean');
      expect(old.severity).toBeNull();
    });
  });

  describe('status priority and coverage honesty', () => {
    it('labels legacy demo data without presenting it as real market data', () => {
      const summary = buildProvenanceSummary(
        makeDataset({
          sourceKind: 'bundled-sample',
          sourceDescription: 'Bundled synthetic sample data (deterministic, not real market data)',
          validation: {
            rejectedRows: 5,
            warnings: [{ code: 'synthetic-data', message: 'Synthetic demo series generated locally.' }],
          },
        }),
      );

      expect(summary.status).toBe('legacy');
      expect(summary.statusLabel).toBe('Data: legacy demo');
      expect(summary.headline).toBe('Legacy demo data');
      expect(summary.severity).toBeNull();
      expect(summary.statusNote).toBe('Synthetic demo series, not real market data.');
      expect(summary.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Adjustment', value: 'Not applicable (synthetic series)' }),
        ]),
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
      expect(summary.severity).toBeNull();
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
            ...PROVIDER,
            provider: 'twelve-data',
            providerSymbol: 'BRK.B',
            exchange: 'XNYS',
            exchangeName: 'NYSE',
            interval: '1d',
            adjustment:
              'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported',
            retrievedAt: '2026-10-24T09:30:00.000Z',
            requestedRange: { start: '1995-01-01', end: '2026-10-23' },
            sourceNotes: ['At most 5,000 bars are returned per request.'],
          },
          validation: { acceptedRows: 5000 },
        }),
      );

      expect(summary.status).toBe('attention');
      expect(summary.statusLabel).toBe('Data: 1 issue');
      expect(summary.issues.map((issue) => issue.code)).toEqual(['range-shortfall']);
      expect(summary.issues[0]).toMatchObject({ severity: 'material', rank: 1 });
      const [issue] = summary.issues;
      expect(issue?.label).toBe('Requested range not covered');
      // Calendar days missing at the start plus the single missing day at the end.
      expect(issue?.count).toBeGreaterThan(4000);
      expect(issue?.detail).toContain('5,000 bars');
      expect(summary.limitations.join(' ')).toContain('2006-12-06 to 2026-10-22');
      expect(summary.limitations.join(' ')).toContain(
        'Sessions outside the returned window are not part of this dataset.',
      );
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
        providerDataset({
          provider: {
            ...PROVIDER,
            requestedRange: { start: '2026-01-02', end: '2026-01-16' },
          },
        }),
      );

      expect(summary.status).toBe('clean');
      expect(summary.statusLabel).toBe('Data: no issues');
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
      const summary = buildProvenanceSummary(providerDataset());

      expect(summary.status).toBe('clean');
      expect(summary.statusLabel).toBe('Data: no issues');
      expect(summary.issues).toEqual([]);
      // `unverified` coverage stays unverified: only stored sessions are reported.
      expect(summary.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Coverage', note: '10 stored sessions' }),
        ]),
      );
      expect(summary.fields.some((field) => field.note?.includes('requested'))).toBe(false);
    });
  });
});
