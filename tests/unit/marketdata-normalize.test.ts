import { describe, expect, it } from 'vitest';

/**
 * Deterministic normalisation/compatibility suite for provider downloads.
 * No network is used: provider payloads are fixtures shaped exactly like the
 * service contract documented in `services/market-data/README.md`.
 */

import type { Bar } from '../../src/domain/types';
import { aggregateBars } from '../../src/lib/timeframe';
import { isDateString } from '../../src/lib/date';
import {
  assetTypeFromProvider,
  buildDatasetBundle,
  validateProviderBars,
} from '../../src/lib/marketdata/normalize';
import { sma } from '../../src/lib/indicators/core';
import { totalReturnPct, maxDrawdownPct } from '../../src/lib/quant/metrics';

function barRow(date: string, open: number, high: number, low: number, close: number, volume: number | null) {
  return { date, open, high, low, close, adjClose: close, volume };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'yahoo-finance',
    providerSymbol: 'AAPL',
    displaySymbol: 'AAPL',
    displayName: 'Apple Inc.',
    exchange: 'NMS',
    exchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY',
    currency: 'USD',
    timezone: 'America/New_York',
    interval: '1d',
    adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
    rangeRequested: { start: '2024-01-01', end: '2024-01-31' },
    rangeActual: { start: '2024-01-02', end: '2024-01-04' },
    retrievedAt: '2026-10-19T12:00:00+00:00',
    sourceNotes: ['note-a'],
    corporateActions: [],
    ...overrides,
  };
}

const HISTORY = {
  providerMetadata: metadata(),
  bars: [
    barRow('2024-01-02', 10, 11, 9.5, 10.5, 1200),
    barRow('2024-01-03', 10.5, 12, 10.1, 11.25, 3400),
    barRow('2024-01-04', 11.25, 11.4, 10.8, 11.1, null),
  ],
};

describe('assetTypeFromProvider', () => {
  it('maps the provider instrument vocabulary onto canonical asset types', () => {
    expect(assetTypeFromProvider('EQUITY')).toBe('equity');
    expect(assetTypeFromProvider('INDEX')).toBe('index');
    expect(assetTypeFromProvider('CRYPTOCURRENCY')).toBe('crypto');
    expect(assetTypeFromProvider('CURRENCY')).toBe('fx');
    expect(assetTypeFromProvider('ETF')).toBe('fund');
    expect(assetTypeFromProvider('COMMODITY')).toBe('commodity');
    expect(assetTypeFromProvider(null)).toBe('other');
    expect(assetTypeFromProvider('???')).toBe('other');
  });
});

describe('validateProviderBars', () => {
  it('accepts valid OHLCV rows and keeps null volume', () => {
    const result = validateProviderBars(HISTORY.bars, 'keep-first');
    expect(result.fatalErrors).toHaveLength(0);
    expect(result.bars).toHaveLength(3);
    expect(result.hasVolume).toBe(true);
    expect(result.bars[2]?.volume).toBeNull();
    expect(result.summary.missingVolumeRows).toBe(1);
  });

  it('rejects non-positive prices and OHLC invariant violations per row', () => {
    const bad = [
      barRow('2024-01-02', 0, 1, 0.5, 0.8, 10),
      { date: '2024-01-03', open: 10, high: 5, low: 4, close: 8, adjClose: 10, volume: 10 }, // high below max(open, close)
      { date: '2024-01-04', open: 10, high: 11, low: 11.5, close: 10, adjClose: 10, volume: 10 }, // low above min(open, close)
      barRow('2024-01-05', 10, 12, 9, 11, -5), // negative volume
    ];
    const result = validateProviderBars(bad, 'keep-first');
    expect(result.bars).toHaveLength(0);
    expect(result.summary.rejectedRows).toBe(4);
    expect(result.summary.rejected[0]?.reason).toMatch(/greater than zero/);
    expect(result.summary.rejected[1]?.reason).toMatch(/High/);
    expect(result.summary.rejected[2]?.reason).toMatch(/Low/);
    expect(result.summary.rejected[3]?.reason).toMatch(/Volume/);
  });

  it('treats malformed numeric fields as rejected rows, never as invented bars', () => {
    const bad = [
      barRow('2024-01-02', 10, 11, 9.5, 10.5, 10),
      { date: '2024-01-03', open: null, high: 11, low: 9.5, close: 10.5, adjClose: null, volume: 10 },
    ];
    const result = validateProviderBars(bad as never, 'keep-first');
    expect(result.bars).toHaveLength(1);
    expect(result.summary.rejectedRows).toBe(1);
    expect(result.summary.rejected[0]?.reason).toMatch(/finite numbers/);
  });

  it('applies duplicate-session policies explicitly', () => {
    const rows = [
      barRow('2024-01-02', 10, 11, 9.5, 10, 1),
      barRow('2024-01-02', 11, 12, 10, 11, 2),
      barRow('2024-01-03', 11, 12, 10.5, 11.5, 3),
    ];
    expect(validateProviderBars(rows, 'reject').bars).toHaveLength(1);
    expect(validateProviderBars(rows, 'keep-first').bars.map((b) => b.close)).toEqual([10, 11.5]);
    expect(validateProviderBars(rows, 'keep-last').bars.map((b) => b.close)).toEqual([11, 11.5]);
  });

  it('sorts out-of-order downloads and reports the correction', () => {
    const rows = [
      barRow('2024-01-05', 12, 13, 11, 12.5, 1),
      barRow('2024-01-03', 10, 11, 9.5, 10.5, 1),
      barRow('2024-01-04', 11, 12, 10.5, 11.5, 1),
    ];
    const result = validateProviderBars(rows, 'keep-first');
    expect(result.bars.map((b) => b.date)).toEqual(['2024-01-03', '2024-01-04', '2024-01-05']);
    expect(result.summary.sortCorrections).toBe(1);
  });

  it('repairs nothing: a result with zero valid rows fails loudly', () => {
    const result = validateProviderBars([], 'keep-first');
    expect(result.bars).toHaveLength(0);
    expect(result.fatalErrors).toEqual(['No valid daily sessions were returned for this symbol and range.']);
  });

  it('produces a stable content hash that changes with the data', () => {
    const a = validateProviderBars(HISTORY.bars, 'keep-first').contentHash;
    const b = validateProviderBars(HISTORY.bars, 'keep-first').contentHash;
    const c = validateProviderBars(
      [barRow('2024-01-02', 10, 11, 9.5, 10.5, 1200), barRow('2024-01-03', 10.5, 12, 10.1, 11.25, 3400)],
      'keep-first',
    ).contentHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('fnv1a-')).toBe(true);
  });

  it('is deterministic for the same payload regardless of received order sorting', () => {
    const forward = validateProviderBars(HISTORY.bars, 'keep-first');
    const reversed = validateProviderBars([...HISTORY.bars].reverse(), 'keep-first');
    expect(reversed.bars.map((bar) => bar.date)).toEqual(forward.bars.map((bar) => bar.date));
    expect(reversed.contentHash).toBe(forward.contentHash);
  });
});

describe('buildDatasetBundle', () => {
  it('assembles instrument, dataset and provenance from a validated download', () => {
    const validation = validateProviderBars(HISTORY.bars, 'keep-first');
    const bundle = buildDatasetBundle({ history: HISTORY, validation, importedAt: '2026-10-19T12:00:05.000Z' });
    const { instrument, dataset, bars } = bundle;

    expect(instrument.symbol).toBe('AAPL');
    expect(instrument.displayName).toBe('Apple Inc.');
    expect(instrument.assetType).toBe('equity');
    expect(instrument.currency).toBe('USD');
    expect(instrument.exchange).toBe('NasdaqGS');

    expect(dataset.sourceKind).toBe('provider-download');
    expect(dataset.frequency).toBe('daily');
    expect(dataset.timezone).toBe('America/New_York');
    expect(dataset.rowCount).toBe(3);
    expect(dataset.firstDate).toBe('2024-01-02');
    expect(dataset.lastDate).toBe('2024-01-04');
    expect(dataset.contentHash).toBe(validation.contentHash);
    expect(dataset.instrumentId).toBe(instrument.id);
    expect(dataset.name).toContain('daily');

    expect(dataset.provider).toBeDefined();
    expect(dataset.provider?.provider).toBe('yahoo-finance');
    expect(dataset.provider?.providerSymbol).toBe('AAPL');
    expect(dataset.provider?.interval).toBe('1d');
    expect(dataset.provider?.adjustment).toContain('dividends not reinvested');
    expect(dataset.provider?.retrievedAt).toBe('2026-10-19T12:00:00+00:00');
    expect(dataset.provider?.timezone).toBe('America/New_York');
    expect(dataset.provider?.sourceNotes).toEqual(['note-a']);

    bars.forEach((bar: Bar) => expect(isDateString(bar.date)).toBe(true));
  });

  it('stores provider corporate actions and leaves their dates untouched', () => {
    const history = {
      ...HISTORY,
      providerMetadata: metadata({
        corporateActions: [
          { date: '2024-01-03', type: 'dividend', value: 0.24 },
          { date: '2024-01-02', type: 'split', value: 2 },
        ],
      }),
    };
    const validation = validateProviderBars(HISTORY.bars, 'keep-first');
    const bundle = buildDatasetBundle({ history, validation, importedAt: '2026-10-19T12:00:05.000Z' });
    expect(bundle.dataset.provider?.corporateActions).toEqual([
      { date: '2024-01-03', type: 'dividend', value: 0.24 },
      { date: '2024-01-02', type: 'split', value: 2 },
    ]);
  });

  it('treats a legacy provider payload without corporate actions as reporting none', () => {
    const legacyMetadata: Record<string, unknown> = { ...metadata() };
    delete legacyMetadata.corporateActions;
    const validation = validateProviderBars(HISTORY.bars, 'keep-first');
    const bundle = buildDatasetBundle({
      history: { ...HISTORY, providerMetadata: legacyMetadata as typeof HISTORY.providerMetadata },
      validation,
      importedAt: '2026-10-19T12:00:05.000Z',
    });
    expect(bundle.dataset.provider?.corporateActions).toEqual([]);
  });

  it('keeps the adjustment policy on the dataset so conventions can never be mixed silently', () => {
    const validation = validateProviderBars(HISTORY.bars, 'keep-first');
    const asTraded = buildDatasetBundle({ history: HISTORY, validation, importedAt: '2026-10-19T12:00:05.000Z' });
    const fullyAdjusted = buildDatasetBundle({
      history: {
        ...HISTORY,
        providerMetadata: metadata({ adjustment: 'dividends reinvested (fully adjusted)' }),
      },
      validation,
      importedAt: '2026-10-19T12:00:05.000Z',
    });
    expect(asTraded.dataset.provider?.adjustment).toContain('dividends not reinvested');
    expect(fullyAdjusted.dataset.provider?.adjustment).toBe('dividends reinvested (fully adjusted)');
    expect(fullyAdjusted.dataset.sourceDescription).not.toBe(asTraded.dataset.sourceDescription);
  });

  it('rejects empty downloads instead of building an empty dataset', () => {
    const validation = validateProviderBars([], 'keep-first');
    expect(() => buildDatasetBundle({ history: HISTORY, validation, importedAt: 'x' })).toThrow(/no valid bars/);
  });
});

describe('compatibility with existing research modules', () => {
  it('downloaded bars aggregate to weekly and monthly exactly like imported CSV bars', () => {
    const bars = validateProviderBars(HISTORY.bars, 'keep-first').bars;
    const weekly = aggregateBars(bars, '1W');
    expect(weekly).toHaveLength(1); // 2024-01-02..04 is all one ISO week
    expect(weekly[0]?.date).toBe('2024-01-04'); // weekly bars are labelled with their last session
    expect(weekly[0]?.close).toBe(11.1);
    expect(weekly[0]?.volume).toBeNull(); // one session lacks volume, so the sum is withheld
    const monthly = aggregateBars(bars, '1M');
    expect(monthly).toHaveLength(1);
    expect(monthly[0]?.date).toBe('2024-01-04');
    expect(monthly[0]?.open).toBe(10);
    expect(monthly[0]?.high).toBe(12);
    expect(monthly[0]?.low).toBe(9.5);
  });

  it('indicators compute over downloaded bars with the documented warm-up nulls', () => {
    const bars = validateProviderBars(HISTORY.bars, 'keep-first').bars;
    const closes = bars.map((bar) => bar.close);
    const values = sma(closes, 5);
    expect(values).toHaveLength(3);
    expect(values.every((value) => value === null)).toBe(true); // fewer bars than window
    const smallWindow = sma(closes, 2);
    expect(smallWindow[0]).toBeNull();
    expect(smallWindow[1]).toBeCloseTo((10.5 + 11.25) / 2, 10);
    expect(smallWindow[2]).toBeCloseTo((11.25 + 11.1) / 2, 10);
  });

  it('metrics compute over downloaded bars with no provider-specific code path', () => {
    const bars = validateProviderBars(HISTORY.bars, 'keep-first').bars;
    expect(totalReturnPct(bars)).not.toBeNull();
    expect(maxDrawdownPct(bars.map((bar) => bar.close))).not.toBeNull();
  });
});
