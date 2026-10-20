/**
 * Test fixtures for the end-to-end suite.
 *
 * The application stores no bundled market data, so a fresh browser profile
 * starts with an empty library. The tests that need series to chart, screen
 * or simulate write a deterministic library straight into IndexedDB before
 * the app reads it, exactly as a CSV import or a provider download would.
 *
 * The fixture bars are test data: a fixed-seed random walk over business
 * days. They exist so the assertions have stable numbers to work with, and
 * they are never presented to a user.
 */

import type { Page } from '@playwright/test';

const DB_NAME = 'marketlab';
const DB_VERSION = 1;
const STORE_NAMES = [
  'instruments',
  'datasets',
  'bars',
  'workspaces',
  'watchlists',
  'screeners',
  'backtests',
  'preferences',
  'settings',
];

const SESSIONS = 320;
const LAST_SESSION = '2026-10-16';

export interface FixtureBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface FixtureRecords {
  instruments: Record<string, unknown>[];
  datasets: Record<string, unknown>[];
  bars: Record<string, unknown>[];
  workspaces: Record<string, unknown>[];
  watchlists: Record<string, unknown>[];
  screeners: Record<string, unknown>[];
  backtests: Record<string, unknown>[];
  preferences: Record<string, unknown>[];
}

export const FIXTURE_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ', 'IWM'];

function businessDaysEndingAt(endDate: string, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${endDate}T00:00:00.000Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

/** A small deterministic pseudo-random generator for the fixture bars. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function buildFixtureBars(seed: number, startPrice: number): FixtureBar[] {
  const dates = businessDaysEndingAt(LAST_SESSION, SESSIONS);
  const next = random(seed);
  const bars: FixtureBar[] = [];
  let previousClose = startPrice;
  for (const date of dates) {
    const change = (next() - 0.48) * 0.04;
    const close = Math.max(1, previousClose * (1 + change));
    const open = previousClose;
    const high = Math.max(open, close) * (1 + next() * 0.01);
    const low = Math.min(open, close) * (1 - next() * 0.01);
    bars.push({
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(1_000_000 + next() * 4_000_000),
    });
    previousClose = close;
  }
  return bars;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function validation(rows: number) {
  return {
    acceptedRows: rows,
    rejectedRows: 0,
    duplicateRows: 0,
    missingVolumeRows: 0,
    gapCount: 0,
    sortCorrections: 0,
    rejected: [],
    warnings: [],
  };
}

/** The library the end-to-end tests chart, screen and simulate against. */
export function buildFixtureLibrary(): FixtureRecords {
  const instruments: Record<string, unknown>[] = [];
  const datasets: Record<string, unknown>[] = [];
  const bars: Record<string, unknown>[] = [];

  FIXTURE_SYMBOLS.forEach((symbol, index) => {
    const instrumentId = `inst_${symbol.toLowerCase()}`;
    const datasetId = `ds_${symbol.toLowerCase()}`;
    const series = buildFixtureBars(1013 + index * 97, 100 + index * 40);
    instruments.push({
      id: instrumentId,
      symbol,
      displayName: `${symbol} Test Series`,
      assetType: symbol === 'SPY' || symbol === 'QQQ' || symbol === 'IWM' ? 'fund' : 'equity',
      currency: 'USD',
      exchange: 'NMS',
    });
    datasets.push({
      id: datasetId,
      instrumentId,
      name: `${symbol} - daily (imported)`,
      sourceKind: 'user-csv',
      sourceDescription: 'End-to-end test fixture series.',
      frequency: 'daily',
      timezone: 'UTC',
      firstDate: series[0]?.date ?? '',
      lastDate: series[series.length - 1]?.date ?? '',
      rowCount: series.length,
      importedAt: '2026-10-16T00:00:00.000Z',
      contentHash: `fixture-${symbol.toLowerCase()}`,
      hasVolume: true,
      validation: validation(series.length),
    });
    bars.push({ id: datasetId, bars: series });
  });

  const workspaces = [
    {
      id: 'ws_primary',
      name: 'Primary',
      schemaVersion: 1,
      layout: 'single',
      charts: [
        {
          id: 'chart_primary',
          instrumentId: 'inst_aapl',
          datasetId: 'ds_aapl',
          timeframe: '1D',
          chartType: 'candlestick',
          showVolume: true,
          priceScaleMode: 'normal',
          visibleRange: null,
          indicators: [],
          drawings: [],
        },
      ],
      linkGroups: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    },
  ];

  const watchlists = [
    {
      id: 'wl_primary',
      name: 'Watchlist',
      instrumentIds: FIXTURE_SYMBOLS.map((symbol) => `inst_${symbol.toLowerCase()}`),
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    },
  ];

  return {
    instruments,
    datasets,
    bars,
    workspaces,
    watchlists,
    screeners: [],
    backtests: [],
    preferences: [],
  };
}

/**
 * A library where one stored series shares a single session with the primary.
 * Used to prove that the comparison reports insufficient shared history
 * instead of drawing a one-point line or forward-filling.
 */
export function buildSparseOverlapLibrary(): FixtureRecords {
  const records = buildFixtureLibrary();
  const bars = records.bars.find((entry) => entry.id === 'ds_msft');
  const dataset = records.datasets.find((entry) => entry.id === 'ds_msft');
  if (bars && dataset) {
    const series = bars.bars as FixtureBar[];
    const last = series[series.length - 1] as FixtureBar;
    bars.bars = [last];
    dataset.firstDate = last.date;
    dataset.lastDate = last.date;
    dataset.rowCount = 1;
  }
  return records;
}

/** A library holding only the primary series, for the no-comparison state. */
export function buildSingleSeriesLibrary(): FixtureRecords {
  const records = buildFixtureLibrary();
  return {
    ...records,
    instruments: records.instruments.filter((entry) => entry.id === 'inst_aapl'),
    datasets: records.datasets.filter((entry) => entry.id === 'ds_aapl'),
    bars: records.bars.filter((entry) => entry.id === 'ds_aapl'),
    watchlists: records.watchlists.map((entry) => ({
      ...entry,
      instrumentIds: ['inst_aapl'],
    })),
  };
}

/**
 * A provider-download library carrying two provider-reported corporate
 * actions: a split on a Friday and a dividend on the following Monday. On a
 * daily panel both dates are sessions; on a weekly panel the Monday falls
 * between weekly bars, which proves actions are not snapped to a neighbour.
 */
export function buildCorporateActionLibrary(): FixtureRecords {
  const records = buildFixtureLibrary();
  const dataset = records.datasets.find((entry) => entry.id === 'ds_aapl');
  const barRecord = records.bars.find((entry) => entry.id === 'ds_aapl');
  if (!dataset || !barRecord) return records;
  const series = barRecord.bars as FixtureBar[];
  const pair = findFridayThenMonday(series);
  if (!pair) throw new Error('The fixture series did not contain a Friday/Monday pair.');

  dataset.sourceKind = 'provider-download';
  dataset.name = 'AAPL - daily (Yahoo Finance download)';
  dataset.sourceDescription =
    'Downloaded from Yahoo Finance via the local market-data service. splits-applied, dividends not reinvested (as-traded OHLC).';
  dataset.provider = {
    provider: 'yahoo-finance',
    providerSymbol: 'AAPL',
    exchange: 'NMS',
    exchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY',
    interval: '1d',
    adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
    retrievedAt: '2026-10-16T00:00:00.000Z',
    timezone: 'America/New_York',
    sourceNotes: ['Unofficial, undocumented Yahoo Finance data; corporate actions may be incomplete.'],
    corporateActions: [
      { date: pair.friday, type: 'split', value: 4 },
      { date: pair.monday, type: 'dividend', value: 0.24 },
    ],
  };
  return records;
}

function findFridayThenMonday(series: FixtureBar[]): { friday: string; monday: string } | null {
  // Prefer a pair near the end so it falls inside the chart's default visible
  // range; `index + 4` guarantees the following week still has a Friday bar.
  for (let index = series.length - 5; index >= 5; index -= 1) {
    const friday = series[index] as FixtureBar;
    const monday = series[index + 1] as FixtureBar;
    if (new Date(`${friday.date}T00:00:00Z`).getUTCDay() === 5 && new Date(`${monday.date}T00:00:00Z`).getUTCDay() === 1) {
      return { friday: friday.date, monday: monday.date };
    }
  }
  return null;
}

/**
 * A library in the shape an earlier build left behind: one bundled demo
 * series, one imported series, a workspace pointing at the demo series and a
 * watchlist that holds the demo instrument.
 */
export function buildLegacyLibrary(): FixtureRecords {
  const demoBars = buildFixtureBars(1013, 148.2);
  const importedBars = buildFixtureBars(2027, 42.5);
  return {
    instruments: [
      {
        id: 'inst_atx',
        symbol: 'ATX',
        displayName: 'Aurora Tech (Demo)',
        assetType: 'equity',
        currency: 'USD',
        exchange: 'DEMO',
        metadata: { synthetic: true },
      },
      {
        id: 'inst_acme',
        symbol: 'ACME',
        displayName: 'Acme Import (CSV)',
        assetType: 'equity',
        currency: 'USD',
      },
    ],
    datasets: [
      {
        id: 'ds_sample_atx',
        instrumentId: 'inst_atx',
        name: 'Aurora Tech (Demo) - daily',
        sourceKind: 'bundled-sample',
        sourceDescription: 'Bundled synthetic sample data (deterministic, not real market data)',
        frequency: 'daily',
        timezone: 'UTC',
        firstDate: demoBars[0]?.date ?? '',
        lastDate: demoBars[demoBars.length - 1]?.date ?? '',
        rowCount: demoBars.length,
        importedAt: '2026-01-01T00:00:00.000Z',
        contentHash: 'sample-1017',
        hasVolume: true,
        validation: {
          ...validation(demoBars.length),
          warnings: [{ code: 'synthetic-data', message: 'Synthetic demo series generated locally. Not real market data.' }],
        },
      },
      {
        id: 'ds_acme',
        instrumentId: 'inst_acme',
        name: 'ACME - daily (imported)',
        sourceKind: 'user-csv',
        sourceDescription: 'Imported from a CSV file.',
        frequency: 'daily',
        timezone: 'UTC',
        firstDate: importedBars[0]?.date ?? '',
        lastDate: importedBars[importedBars.length - 1]?.date ?? '',
        rowCount: importedBars.length,
        importedAt: '2026-10-01T00:00:00.000Z',
        contentHash: 'fixture-acme',
        hasVolume: true,
        validation: validation(importedBars.length),
      },
    ],
    bars: [
      { id: 'ds_sample_atx', bars: demoBars },
      { id: 'ds_acme', bars: importedBars },
    ],
    workspaces: [
      {
        id: 'ws_demo',
        name: 'Primary',
        schemaVersion: 1,
        layout: 'single',
        charts: [
          {
            id: 'chart_demo',
            instrumentId: 'inst_atx',
            datasetId: 'ds_sample_atx',
            timeframe: '1D',
            chartType: 'candlestick',
            showVolume: true,
            priceScaleMode: 'normal',
            visibleRange: null,
            indicators: [],
            drawings: [],
          },
        ],
        linkGroups: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    watchlists: [
      {
        id: 'wl_demo',
        name: 'Demo watchlist',
        instrumentIds: ['inst_atx'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    screeners: [
      {
        id: 'scr_demo',
        name: 'Demo screen',
        schemaVersion: 1,
        universeDatasetIds: ['ds_sample_atx'],
        combinators: [],
        filters: [],
        cutoff: null,
        sortBy: 'return',
        sortWindow: 20,
        sortDirection: 'desc',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    backtests: [
      {
        id: 'bt_demo',
        name: 'Demo strategy',
        datasetId: 'ds_sample_atx',
        startDate: null,
        endDate: null,
        initialCapital: 100_000,
        positionSizePct: 95,
        commissionBps: 5,
        slippageBps: 5,
        stopLossPct: 8,
        takeProfitPct: null,
        entry: [],
        exit: [],
        entryLogic: 'AND',
        exitLogic: 'AND',
        execution: 'next-open',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    preferences: [],
  };
}

/**
 * Writes the records into the application's IndexedDB database. The function
 * runs inside the page, so it cannot close over anything from this module.
 */
async function writeRecords(records: FixtureRecords): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('marketlab', 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const store of [
        'instruments',
        'datasets',
        'bars',
        'workspaces',
        'watchlists',
        'screeners',
        'backtests',
        'preferences',
        'settings',
      ]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    open.onerror = () => reject(open.error ?? new Error('Could not open the database'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(
        ['instruments', 'datasets', 'bars', 'workspaces', 'watchlists', 'screeners', 'backtests', 'preferences'],
        'readwrite',
      );
      const put = (store: string, values: Record<string, unknown>[]) => {
        const objectStore = tx.objectStore(store);
        for (const value of values) objectStore.put(value);
      };
      put('instruments', records.instruments);
      put('datasets', records.datasets);
      put('bars', records.bars);
      put('workspaces', records.workspaces);
      put('watchlists', records.watchlists);
      put('screeners', records.screeners);
      put('backtests', records.backtests);
      put('preferences', records.preferences);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('Could not write the records'));
    };
  });
}

/**
 * Seeds a library into the browser profile and reloads the application so it
 * reads the seeded records. The first visit is used only to get a same-origin
 * page to write from; the reload is what the assertions run against.
 */
export async function seedLibrary(page: Page, records: FixtureRecords = buildFixtureLibrary()): Promise<void> {
  await page.goto('/');
  await page.evaluate(writeRecords, records);
  await page.reload();
}

/** Seeds the library an earlier build of the application would have left. */
export async function seedLegacyLibrary(page: Page): Promise<void> {
  await seedLibrary(page, buildLegacyLibrary());
}

/** Reads a whole store out of the browser profile, for migration assertions. */
export async function readStore(page: Page, store: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (name) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const open = indexedDB.open('marketlab', 1);
        open.onerror = () => reject(open.error ?? new Error('Could not open the database'));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(name)) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction(name, 'readonly');
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result as Record<string, unknown>[]);
          };
          request.onerror = () => reject(request.error ?? new Error('Could not read the store'));
        };
      }),
    store,
  );
}

export { DB_NAME, DB_VERSION, STORE_NAMES };
