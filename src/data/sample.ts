import type { Bar, Dataset, Instrument } from '../domain/types';
import { addDays, compareDates, isoWeekday } from '../lib/date';

/**
 * Deterministic synthetic sample data.
 *
 * This fixture is generated locally from a fixed seed. It is explicitly labelled
 * as synthetic and must never be presented as real market data. It exists so the
 * application is useful without any external data service or account.
 */

const SAMPLE_END_DATE = '2026-10-16';
const SAMPLE_SESSIONS = 1300;

interface SampleSpec {
  id: string;
  symbol: string;
  displayName: string;
  assetType: Instrument['assetType'];
  currency: string;
  exchange: string;
  seed: number;
  startPrice: number;
  annualDrift: number;
  annualVolatility: number;
  baseVolume: number;
}

const SPECS: SampleSpec[] = [
  {
    id: 'inst_atx',
    symbol: 'ATX',
    displayName: 'Aurora Tech (Demo)',
    assetType: 'equity',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 1017,
    startPrice: 148.2,
    annualDrift: 0.13,
    annualVolatility: 0.27,
    baseVolume: 2_400_000,
  },
  {
    id: 'inst_nrg',
    symbol: 'NRG',
    displayName: 'Northwind Energy (Demo)',
    assetType: 'equity',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 2911,
    startPrice: 74.5,
    annualDrift: 0.06,
    annualVolatility: 0.21,
    baseVolume: 1_750_000,
  },
  {
    id: 'inst_fnx',
    symbol: 'FNX',
    displayName: 'Fenix Financial (Demo)',
    assetType: 'equity',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 4127,
    startPrice: 212.9,
    annualDrift: 0.09,
    annualVolatility: 0.19,
    baseVolume: 1_100_000,
  },
  {
    id: 'inst_hlx',
    symbol: 'HLX',
    displayName: 'Helix Healthcare (Demo)',
    assetType: 'equity',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 5581,
    startPrice: 96.4,
    annualDrift: 0.04,
    annualVolatility: 0.24,
    baseVolume: 940_000,
  },
  {
    id: 'inst_qtm',
    symbol: 'QTM',
    displayName: 'Quantum Materials (Demo)',
    assetType: 'equity',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 6793,
    startPrice: 41.15,
    annualDrift: -0.02,
    annualVolatility: 0.38,
    baseVolume: 3_200_000,
  },
  {
    id: 'inst_mkt',
    symbol: 'MLAB-IDX',
    displayName: 'MarketLab Composite Index (Demo)',
    assetType: 'index',
    currency: 'USD',
    exchange: 'DEMO',
    seed: 8389,
    startPrice: 1000,
    annualDrift: 0.08,
    annualVolatility: 0.14,
    baseVolume: 0,
  },
];

/** Small, fast, deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Box-Muller transform producing a standard normal sample. */
function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function businessDaysEndingAt(endDate: string, count: number): string[] {
  const dates: string[] = [];
  let cursor = endDate;
  while (dates.length < count) {
    if (isoWeekday(cursor) <= 5) dates.push(cursor);
    cursor = addDays(cursor, -1);
  }
  return dates.reverse();
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function generateSampleBars(spec: SampleSpec): Bar[] {
  const dates = businessDaysEndingAt(SAMPLE_END_DATE, SAMPLE_SESSIONS);
  const random = mulberry32(spec.seed);
  const sessionsPerYear = 252;
  const dailyDrift = spec.annualDrift / sessionsPerYear;
  const dailyVol = spec.annualVolatility / Math.sqrt(sessionsPerYear);

  const bars: Bar[] = [];
  let close = spec.startPrice;
  let previousClose = spec.startPrice;
  let volumeTrend = 1;

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i] as string;
    const shock = gaussian(random) * dailyVol;
    // A mild mean-reverting component keeps the walk visually plausible.
    const reversion = ((spec.startPrice - close) / spec.startPrice) * 0.004;
    close = Math.max(0.5, previousClose * (1 + dailyDrift + shock + reversion));

    const open = previousClose * (1 + gaussian(random) * dailyVol * 0.35);
    const spread = Math.abs(gaussian(random)) * dailyVol * 0.9 + dailyVol * 0.25;
    const high = Math.max(open, close) * (1 + spread);
    const low = Math.min(open, close) * (1 - spread);

    volumeTrend = Math.max(0.45, Math.min(2.4, volumeTrend + (random() - 0.5) * 0.08));
    const volume =
      spec.baseVolume > 0
        ? Math.round(spec.baseVolume * volumeTrend * (0.7 + Math.abs(shock) * 12 + random() * 0.5))
        : 0;

    bars.push({
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: spec.baseVolume > 0 ? volume : null,
    });

    previousClose = close;
  }

  return bars;
}

export interface SampleBundle {
  instrument: Instrument;
  dataset: Dataset;
  bars: Bar[];
}

export function buildSampleBundles(): SampleBundle[] {
  return SPECS.map((spec) => {
    const bars = generateSampleBars(spec);
    const first = bars[0] as Bar;
    const last = bars[bars.length - 1] as Bar;
    const instrument: Instrument = {
      id: spec.id,
      symbol: spec.symbol,
      displayName: spec.displayName,
      assetType: spec.assetType,
      currency: spec.currency,
      exchange: spec.exchange,
      metadata: { synthetic: true },
    };
    const dataset: Dataset = {
      id: `ds_sample_${spec.symbol.toLowerCase()}`,
      instrumentId: spec.id,
      name: `${spec.displayName} - daily`,
      sourceKind: 'bundled-sample',
      sourceDescription: 'Bundled synthetic sample data (deterministic, not real market data)',
      frequency: 'daily',
      timezone: 'UTC',
      firstDate: first.date,
      lastDate: last.date,
      rowCount: bars.length,
      importedAt: '2026-01-01T00:00:00.000Z',
      contentHash: `sample-${spec.seed}`,
      hasVolume: spec.baseVolume > 0,
      validation: {
        acceptedRows: bars.length,
        rejectedRows: 0,
        duplicateRows: 0,
        missingVolumeRows: 0,
        gapCount: 0,
        sortCorrections: 0,
        rejected: [],
        warnings: [
          {
            code: 'synthetic-data',
            message: 'Synthetic demo series generated locally. Not real market data.',
          },
        ],
      },
    };
    return { instrument, dataset, bars };
  });
}

export function sampleDateRange(bundles: SampleBundle[]): { from: string; to: string } {
  let from = bundles[0]?.dataset.firstDate ?? SAMPLE_END_DATE;
  let to = bundles[0]?.dataset.lastDate ?? SAMPLE_END_DATE;
  for (const bundle of bundles) {
    if (compareDates(bundle.dataset.firstDate, from) < 0) from = bundle.dataset.firstDate;
    if (compareDates(bundle.dataset.lastDate, to) > 0) to = bundle.dataset.lastDate;
  }
  return { from, to };
}

export { SAMPLE_END_DATE };
