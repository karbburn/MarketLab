import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Bar, Dataset, Instrument, ScreenerDefinition } from '../../src/domain/types';
import { createMemoryAdapter, type PersistenceAdapter } from '../../src/lib/persistence/db';
import { loadState } from '../../src/state/store';
import { datasetViews, sessionCount } from '../../src/state/selectors';
import { APP_SCHEMA_VERSION, createWorkspace } from '../../src/state/defaults';
import { aggregateBars, barsForTimeframe } from '../../src/lib/timeframe';
import { computeField } from '../../src/lib/screener/fields';
import { evaluateScreener, type ScreenerInput } from '../../src/lib/screener/evaluate';
import { prepareComparison } from '../../src/lib/chart/compare-overlays';
import { createBarDateIndex } from '../../src/lib/chart/bar-date-index';

/**
 * Reproducible benchmark suite for the performance programme.
 *
 * This is measurement, not a test: nothing here asserts a timing threshold, so
 * it cannot fail a build for being 2 ms slower on a busy machine. The only
 * assertions are sanity checks that the measured operation still returns a
 * plausible result. Run with `npm run bench`.
 *
 * Workload shapes:
 *   - "typical"   20 datasets x 1,250 sessions (25,000 sessions total)
 *   - "large"     40 datasets x 5,000 sessions (200,000 sessions total, the
 *                 provider's per-dataset ceiling)
 *   - one four-panel workspace with a primary series and three comparison
 *     overlays, all 5,000 sessions.
 *
 * Limitations, stated up front:
 *   - The persistence adapter is the in-process memory adapter. It clones with
 *     `structuredClone` on both staging and read, so the shape of the cost is
 *     the same as IndexedDB (serialise + copy every stored record), but the
 *     absolute numbers exclude real IndexedDB I/O and are optimistic.
 *   - No DOM, canvas or lightweight-charts work is measured. Chart rebuild cost
 *     needs a browser profiler; this suite covers the data and selector paths
 *     that feed it.
 *   - Single machine, single process, no CPU pinning. Medians and p95 are
 *     reported over 15 trials after warm-up; compare runs on the same machine
 *     and treat differences below ~10% as noise.
 */

const TYPICAL_DATASETS = 20;
const TYPICAL_BARS = 1_250;
const LARGE_DATASETS = 40;
const LARGE_BARS = 5_000;
const PANEL_BARS = 5_000;
const TRIALS = 15;

const NOW = '2026-01-01T00:00:00.000Z';

/* ------------------------------------------------------------------ data --- */

function makeBars(count: number, seed: number): Bar[] {
  let random = seed >>> 0;
  const next = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 2 ** 32;
  };
  const bars: Bar[] = [];
  let day = Date.UTC(2005, 0, 3);
  let close = 40 + (seed % 60);
  while (bars.length < count) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const open = close;
      close = Math.max(1, close * (1 + (next() - 0.5) * 0.03));
      const high = Math.max(open, close) * (1 + next() * 0.006);
      const low = Math.min(open, close) * (1 - next() * 0.006);
      bars.push({
        date: new Date(day).toISOString().slice(0, 10),
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.round(500_000 + next() * 1_500_000),
      });
    }
    day += 86_400_000;
  }
  return bars;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeInstrument(index: number): Instrument {
  return {
    id: `inst-${index}`,
    symbol: `SYM${index}`,
    displayName: `Synthetic series ${index}`,
    assetType: 'equity',
    currency: 'USD',
  };
}

function makeDataset(index: number, bars: readonly Bar[], frequency: Dataset['frequency'] = 'daily'): Dataset {
  return {
    id: `ds-${index}`,
    instrumentId: `inst-${index}`,
    name: `Synthetic series ${index}`,
    sourceKind: 'user-csv',
    sourceDescription: 'benchmark fixture',
    frequency,
    timezone: 'UTC',
    firstDate: (bars[0] as Bar).date,
    lastDate: (bars[bars.length - 1] as Bar).date,
    rowCount: bars.length,
    importedAt: NOW,
    contentHash: `hash-${index}-${bars.length}`,
    hasVolume: true,
    validation: {
      acceptedRows: bars.length,
      rejectedRows: 0,
      duplicateRows: 0,
      missingVolumeRows: 0,
      gapCount: 0,
      sortCorrections: 0,
      rejected: [],
      warnings: [],
    },
  };
}

interface Library {
  adapter: PersistenceAdapter;
  datasets: Dataset[];
  instruments: Instrument[];
  barsByDataset: Record<string, Bar[]>;
}

async function seedLibrary(datasetCount: number, barCount: number): Promise<Library> {
  const adapter = createMemoryAdapter();
  const datasets: Dataset[] = [];
  const instruments: Instrument[] = [];
  const barsByDataset: Record<string, Bar[]> = {};
  for (let index = 0; index < datasetCount; index += 1) {
    const bars = makeBars(barCount, index + 1);
    const instrument = makeInstrument(index);
    const dataset = makeDataset(index, bars);
    datasets.push(dataset);
    instruments.push(instrument);
    barsByDataset[dataset.id] = bars;
    await adapter.put('instruments', instrument);
    await adapter.put('datasets', dataset);
    await adapter.put('bars', { id: dataset.id, bars });
  }
  const workspace = createWorkspace({
    name: 'Benchmark workspace',
    layout: 'four',
    base: { instrumentId: instruments[0]!.id, datasetId: datasets[0]!.id },
  });
  await adapter.put('workspaces', workspace);
  await adapter.put('settings', {
    id: 'app',
    schemaVersion: APP_SCHEMA_VERSION,
    installedAt: NOW,
    syntheticDataRemovedAt: NOW,
  });
  return { adapter, datasets, instruments, barsByDataset };
}

/* -------------------------------------------------------------- timings --- */

interface Row {
  group: string;
  name: string;
  medianMs: number;
  p95Ms: number;
  batch: number;
}

const rows: Row[] = [];

function percentile(sorted: readonly number[], fraction: number): number {
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[position] as number;
}

async function timeBatch(operation: () => unknown | Promise<unknown>, iterations: number): Promise<number> {
  const start = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) await operation();
  return performance.now() - start;
}

async function measure(group: string, name: string, operation: () => unknown | Promise<unknown>): Promise<void> {
  // Warm-up: let the JIT and any lazily built lookup tables settle.
  for (let warmup = 0; warmup < 3; warmup += 1) await operation();

  let batch = 1;
  for (;;) {
    const elapsed = await timeBatch(operation, batch);
    if (elapsed >= 25 || batch >= 128) break;
    batch = Math.min(128, batch * 2);
  }

  const samples: number[] = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    samples.push((await timeBatch(operation, batch)) / batch);
  }
  samples.sort((a, b) => a - b);
  rows.push({ group, name, medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), batch });
}

function format(value: number): string {
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

/* ----------------------------------------------------------------- suite --- */

describe('performance benchmarks', () => {
  it('reports timings for the measured workloads', async () => {
    const typical = await seedLibrary(TYPICAL_DATASETS, TYPICAL_BARS);
    const large = await seedLibrary(LARGE_DATASETS, LARGE_BARS);
    const panelBars = (large.barsByDataset['ds-0'] as Bar[]);
    const panelDataset = large.datasets[0] as Dataset;
    const panelInstrument = large.instruments[0] as Instrument;

    /* Load and cross-tab refresh cost. */
    await measure('load', `loadState ${TYPICAL_DATASETS} x ${TYPICAL_BARS} sessions`, () => loadState(typical.adapter));
    await measure('load', `loadState ${LARGE_DATASETS} x ${LARGE_BARS} sessions`, () => loadState(large.adapter));

    // Cross-tab refresh: the same read with every series already in memory.
    const { snapshot: loadedLarge } = await loadState(large.adapter);
    const barsCache = { datasets: loadedLarge.datasets, barsByDataset: loadedLarge.barsByDataset };
    await measure(
      'load',
      `loadState ${LARGE_DATASETS} x ${LARGE_BARS} sessions, warm bars cache`,
      () => loadState(large.adapter, { barsCache }),
    );

    /* Timeframe resolution: the path every panel takes before it draws. */
    await measure('timeframe', `barsForTimeframe 1D (${PANEL_BARS} bars)`, () =>
      barsForTimeframe(panelBars, panelDataset, '1D'),
    );
    await measure('timeframe', `barsForTimeframe 1W (${PANEL_BARS} daily bars)`, () =>
      barsForTimeframe(panelBars, panelDataset, '1W'),
    );
    await measure('timeframe', `barsForTimeframe 1M (${PANEL_BARS} daily bars)`, () =>
      barsForTimeframe(panelBars, panelDataset, '1M'),
    );
    await measure('timeframe', `aggregateBars 1W (${PANEL_BARS} sorted daily bars)`, () =>
      aggregateBars(panelBars, '1W'),
    );

    /* Screener fields and a full universe run. */
    for (const field of ['return', 'price-vs-sma', 'rsi', 'relative-volume', 'volatility'] as const) {
      const window = field === 'rsi' ? 14 : field === 'price-vs-sma' ? 50 : 20;
      await measure('screener', `computeField ${field} (window ${window}, ${PANEL_BARS} bars)`, () =>
        computeField(field, window, panelBars),
      );
    }

    const definition: ScreenerDefinition = {
      id: 'screen-bench',
      name: 'Benchmark screen',
      schemaVersion: 1,
      universeDatasetIds: large.datasets.map((dataset) => dataset.id),
      combinators: ['AND', 'AND'],
      filters: [
        { id: 'f1', field: 'return', operator: 'gt', value: 0, window: 20 },
        { id: 'f2', field: 'price-vs-sma', operator: 'gt', value: 0, window: 50 },
        { id: 'f3', field: 'rsi', operator: 'lt', value: 70, window: 14 },
      ],
      cutoff: null,
      sortBy: 'return',
      sortWindow: 20,
      sortDirection: 'desc',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const inputs: ScreenerInput[] = large.datasets.map((dataset, index) => ({
      dataset,
      instrument: large.instruments[index] as Instrument,
      bars: large.barsByDataset[dataset.id] as Bar[],
    }));
    await measure(
      'screener',
      `evaluateScreener ${LARGE_DATASETS} series, 3 filters + sort (${LARGE_BARS} bars each)`,
      () => evaluateScreener(definition, inputs),
    );

    /* Comparison overlays: primary plus three candidates. */
    const comparisonInput = {
      primary: { datasetId: panelDataset.id, label: panelInstrument.symbol, dataset: panelDataset, bars: panelBars },
      candidates: large.datasets.slice(1, 4).map((dataset, offset) => ({
        datasetId: dataset.id,
        label: (large.instruments[offset + 1] as Instrument).symbol,
        dataset,
        bars: large.barsByDataset[dataset.id] as Bar[],
      })),
      timeframe: '1D' as const,
    };
    await measure('comparison', `prepareComparison 4 series (${PANEL_BARS} bars each, 1D)`, () =>
      prepareComparison(comparisonInput),
    );
    await measure('comparison', `prepareComparison 4 series (${PANEL_BARS} bars each, 1W)`, () =>
      prepareComparison({ ...comparisonInput, timeframe: '1W' }),
    );

    /* State selectors: cheap but run by every page render. */
    const stateSlice = {
      status: 'ready' as const,
      loadError: null,
      adapterKind: 'memory' as const,
      instruments: large.instruments,
      datasets: large.datasets,
      barsByDataset: large.barsByDataset,
      workspaces: [],
      activeWorkspaceId: null,
      watchlists: [],
      preferences: { theme: 'dark' as const, defaultWorkspaceId: null, showVolumeByDefault: true, defaultChartType: 'candlestick' as const, defaultTimeframe: '1D' as const },
      screeners: [],
      backtests: [],
      chartTemplates: [],
      backtestRuns: [],
      toasts: [],
    };
    await measure('selectors', `datasetViews (${LARGE_DATASETS} datasets)`, () => datasetViews(stateSlice));
    await measure('selectors', `sessionCount (${LARGE_DATASETS} datasets)`, () => sessionCount(stateSlice));

    /* Crosshair lookup: once per pointer event over the rendered bars. */
    const probes = Array.from({ length: 200 }, (_, index) => {
      const position = Math.floor((index / 200) * panelBars.length);
      return (panelBars[position] as Bar).date;
    });
    await measure('crosshair', `200 session lookups via findIndex (${PANEL_BARS} bars)`, () => {
      let found = 0;
      for (const date of probes) found += panelBars.findIndex((bar) => bar.date === date);
      return found;
    });
    await measure('crosshair', `200 session lookups via date index (${PANEL_BARS} bars)`, () => {
      const index = createBarDateIndex(panelBars);
      let found = 0;
      for (const date of probes) found += index.get(date) ?? -1;
      return found;
    });
    await measure('crosshair', `build date index (${PANEL_BARS} bars)`, () => createBarDateIndex(panelBars));

    /* Sanity checks only: these are not timing assertions. */
    expect(panelBars.length).toBe(PANEL_BARS);
    expect(evaluateScreener(definition, inputs).evaluatedCount).toBe(LARGE_DATASETS);

    const cpu = os.cpus()[0];
    console.log(
      [
        '',
        'MarketLab benchmark',
        `node ${process.version} | ${process.platform} ${process.arch} | ${cpu?.model ?? 'unknown CPU'} | ${os.cpus().length} logical cores`,
        `${TRIALS} trials after warm-up; batch = iterations per timed pass; median/p95 are per operation`,
        '',
        '| group | operation | median ms | p95 ms | batch |',
        '| --- | --- | ---: | ---: | ---: |',
        ...rows.map(
          (row) => `| ${row.group} | ${row.name} | ${format(row.medianMs)} | ${format(row.p95Ms)} | ${row.batch} |`,
        ),
        '',
      ].join('\n'),
    );
  });
});
