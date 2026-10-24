import { describe, expect, it } from 'vitest';

/**
 * Deterministic coverage-disclosure suite for provider downloads.
 *
 * No network is used. The fixture that matters is the production-observed
 * Twelve Data case: a 1995-2026 request answered with exactly 5,000 bars
 * starting in 2006. The suite also pins the tolerance behaviour at a range
 * boundary, so a weekend start is never reported as a truncated download.
 */

import {
  COVERAGE_TOLERANCE_DAYS,
  PROVIDER_OUTPUT_CAPS,
  assessCoverage,
  coverageFromDataset,
  coverageLabel,
} from '../../src/lib/marketdata/coverage';
import { TWELVE_DATA_MAX_OUTPUTSIZE } from '../../src/lib/marketdata/twelvedata';
import type { Dataset } from '../../src/domain/types';

const LONG_REQUEST = { start: '1995-01-01', end: '2026-10-23' };
const TRUNCATED_ACTUAL = { start: '2006-12-06', end: '2026-10-22' };

describe('assessCoverage', () => {
  it('states nothing when the returned sessions reach both ends of the request', () => {
    const report = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-01-01', end: '2024-12-31' },
      actual: { start: '2024-01-02', end: '2024-12-30' },
      rowCount: 251,
    });

    expect(report.status).toBe('complete');
    expect(report.headline).toBeNull();
    expect(report.notes).toEqual([]);
    expect(report.limitation).toBeNull();
    expect(report.missingStartDays).toBe(1);
    expect(report.missingEndDays).toBe(1);
  });

  it('tolerates a range boundary that falls on a non-trading day', () => {
    // Requested on a Saturday, first session on the following Monday.
    const report = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2026-10-17', end: '2026-10-25' },
      actual: { start: '2026-10-19', end: '2026-10-23' },
      rowCount: 5,
    });

    expect(report.status).toBe('complete');
    expect(report.notes).toEqual([]);
  });

  it('reports a shortfall only once it exceeds the boundary tolerance', () => {
    const atTolerance = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-01-01', end: '2024-03-01' },
      actual: { start: '2024-01-11', end: '2024-03-01' },
      rowCount: 40,
    });
    const pastTolerance = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-01-01', end: '2024-03-01' },
      actual: { start: '2024-01-12', end: '2024-03-01' },
      rowCount: 40,
    });

    expect(atTolerance.missingStartDays).toBe(COVERAGE_TOLERANCE_DAYS);
    expect(atTolerance.status).toBe('complete');
    expect(pastTolerance.status).toBe('partial');
  });

  it('names the bar ceiling only when the row count proves it was reached', () => {
    const report = assessCoverage({
      provider: 'twelve-data',
      requested: LONG_REQUEST,
      actual: TRUNCATED_ACTUAL,
      rowCount: TWELVE_DATA_MAX_OUTPUTSIZE,
    });

    expect(report.status).toBe('partial');
    expect(report.atProviderCap).toBe(true);
    expect(report.providerCap).toBe(5000);
    expect(report.headline).toMatch(/does not cover the whole request/i);
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain('exactly 5,000 bars');
    expect(report.notes[0]).toContain('per-request ceiling');
    expect(report.notes[0]).toContain('2006-12-06');
    expect(report.limitation).toContain('1995-01-01 to 2026-10-23');
    expect(report.limitation).toContain('2006-12-06 to 2026-10-22');
    expect(report.limitation).toContain('5,000-bar request ceiling');
    expect(report.limitation).toContain('Sessions outside the returned window are not part of this dataset.');
  });

  it('does not claim a ceiling when one row below it was returned', () => {
    const report = assessCoverage({
      provider: 'twelve-data',
      requested: LONG_REQUEST,
      actual: TRUNCATED_ACTUAL,
      rowCount: TWELVE_DATA_MAX_OUTPUTSIZE - 1,
    });

    expect(report.status).toBe('partial');
    expect(report.atProviderCap).toBe(false);
    expect(report.notes[0]).not.toContain('ceiling');
    // The cause stays open: an instrument listed later looks identical.
    expect(report.notes[0]).toContain('MarketLab cannot tell which');
    expect(report.limitation).not.toContain('ceiling');
  });

  it('reports a missing tail without blaming the provider', () => {
    const report = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-01-01', end: '2026-10-23' },
      actual: { start: '2024-01-02', end: '2026-09-30' },
      rowCount: 700,
    });

    expect(report.status).toBe('partial');
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain('No sessions after 2026-09-30');
    expect(report.notes[0]).toContain('may not exist yet');
    expect(report.notes[0]).not.toMatch(/withheld|truncat/i);
  });

  it('claims nothing when the response did not report what was requested', () => {
    const missing = assessCoverage({
      provider: 'twelve-data',
      requested: null,
      actual: TRUNCATED_ACTUAL,
      rowCount: 5000,
    });
    const blank = assessCoverage({
      provider: 'twelve-data',
      requested: { start: '', end: '' },
      actual: TRUNCATED_ACTUAL,
      rowCount: 5000,
    });

    for (const report of [missing, blank]) {
      expect(report.status).toBe('unverified');
      expect(report.headline).toBeNull();
      expect(report.notes).toEqual([]);
      expect(report.limitation).toBeNull();
    }
  });

  it('treats an impossible stored date as unverified rather than guessing', () => {
    const report = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-01-01', end: '2024-12-31' },
      actual: { start: '2024-02-31', end: '2024-12-30' },
      rowCount: 200,
    });

    expect(report.status).toBe('unverified');
  });

  it('rejects a reversed requested range instead of reporting a negative shortfall', () => {
    const report = assessCoverage({
      provider: 'yahoo-finance',
      requested: { start: '2024-12-31', end: '2024-01-01' },
      actual: { start: '2024-01-02', end: '2024-12-30' },
      rowCount: 200,
    });

    expect(report.status).toBe('unverified');
    expect(report.requested).toBeNull();
  });

  it('keeps its provider-ceiling constant in step with the server adapter', () => {
    expect(PROVIDER_OUTPUT_CAPS['twelve-data']).toBe(TWELVE_DATA_MAX_OUTPUTSIZE);
    expect(PROVIDER_OUTPUT_CAPS['yahoo-finance']).toBeUndefined();
  });
});

describe('coverageFromDataset', () => {
  const baseDataset: Dataset = {
    id: 'ds_test',
    instrumentId: 'inst_test',
    name: 'BRK.B - daily (Twelve Data download)',
    sourceKind: 'provider-download',
    sourceDescription: 'Downloaded from Twelve Data via MarketLab’s market-data service.',
    frequency: 'daily',
    timezone: 'America/New_York',
    firstDate: TRUNCATED_ACTUAL.start,
    lastDate: TRUNCATED_ACTUAL.end,
    rowCount: 5000,
    importedAt: '2026-10-24T09:30:00.000Z',
    contentHash: 'fnv1a-test',
    hasVolume: true,
    provider: {
      provider: 'twelve-data',
      providerSymbol: 'BRK.B',
      exchange: 'XNYS',
      exchangeName: 'NYSE',
      instrumentType: 'Common Stock',
      interval: '1d',
      adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
      retrievedAt: '2026-10-24T09:30:00.000Z',
      timezone: 'America/New_York',
      sourceNotes: ['At most 5,000 bars are returned per request.'],
    },
    validation: {
      acceptedRows: 5000,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
  };

  it('reports a stored shortfall from the persisted requested range', () => {
    const dataset: Dataset = {
      ...baseDataset,
      provider: { ...baseDataset.provider!, requestedRange: LONG_REQUEST },
    };
    const report = coverageFromDataset(dataset);

    expect(report?.status).toBe('partial');
    expect(report?.atProviderCap).toBe(true);
  });

  it('returns null for a download stored before coverage was recorded', () => {
    expect(coverageFromDataset(baseDataset)).toBeNull();
  });
});

describe('coverageLabel', () => {
  it('labels each coverage state for the review panel', () => {
    const common = { actual: TRUNCATED_ACTUAL, rowCount: 10 } as const;
    expect(coverageLabel(assessCoverage({ ...common, provider: 'yahoo-finance', requested: { start: '2006-12-06', end: '2026-10-22' } }))).toBe('Coverage checked');
    expect(coverageLabel(assessCoverage({ ...common, provider: 'yahoo-finance', requested: LONG_REQUEST }))).toBe('Coverage: partial');
    expect(coverageLabel(assessCoverage({ ...common, provider: 'yahoo-finance', requested: null }))).toBe('Coverage unreported');
  });
});
