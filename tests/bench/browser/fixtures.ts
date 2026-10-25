/**
 * Deterministic fixtures for the browser chart benchmark.
 *
 * The bars are **synthetic test fixtures**, not market data: a fixed-seed random
 * walk over business days. They never leave the benchmark browser profile and
 * are never presented as real prices. The shape (session count, date overlap,
 * panels, indicators, overlays) is what the measurements need; the values are
 * irrelevant beyond being plausible OHLC.
 *
 * The library is written straight into the application's IndexedDB, exactly as
 * an import would, using the same seeding helper as the end-to-end suite.
 */

import type { Page } from '@playwright/test';
import type { ChartType, IndicatorInstance, PriceScaleMode, Timeframe, WorkspaceLayout } from '../../../src/domain/types';
import { barSeriesContentHash } from '../../../src/lib/validation/dataset';
import { defaultParameters, getIndicatorDefinition } from '../../../src/lib/indicators';
import type { FixtureRecords } from '../../e2e/fixtures/library';
import { seedLibrary } from '../../e2e/fixtures/library';

export interface BenchBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface BenchSeriesSpec {
  /** Dataset id, also the bars record id. */
  id: string;
  symbol: string;
  sessions: number;
  seed: number;
  startPrice: number;
  /** Last session date; differing end dates create partially overlapping panels. */
  endDate?: string;
}

export interface BenchPanelSpec {
  datasetId: string;
  timeframe?: Timeframe;
  chartType?: ChartType;
  showVolume?: boolean;
  priceScaleMode?: PriceScaleMode;
  /** Indicator type names, e.g. `sma`, `rsi`, `macd`. */
  indicators?: string[];
  compareDatasetIds?: string[];
}

export interface BenchLibrarySpec {
  series: BenchSeriesSpec[];
  panels: BenchPanelSpec[];
  layout?: WorkspaceLayout;
  /** Link property set stored on the workspace's single link group. */
  links?: Array<'symbol' | 'timeframe' | 'visible-range' | 'crosshair'>;
}

export const BENCH_DEFAULT_END = '2026-10-16';

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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Fixed-seed generator so every run charts byte-identical bars. */
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

export function buildBenchBars(spec: BenchSeriesSpec): BenchBar[] {
  const dates = businessDaysEndingAt(spec.endDate ?? BENCH_DEFAULT_END, spec.sessions);
  const next = random(spec.seed);
  const bars: BenchBar[] = [];
  let previousClose = spec.startPrice;
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

function indicatorInstances(types: readonly string[]): IndicatorInstance[] {
  return types.map((type, index) => {
    const definition = getIndicatorDefinition(type);
    if (!definition) throw new Error(`Unknown benchmark indicator: ${type}`);
    return {
      id: `ind_${index}_${type}`,
      type,
      version: definition.version,
      parameters: defaultParameters(definition),
      visible: true,
      placement: definition.placement,
      style: {},
    };
  });
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

/** Builds the IndexedDB records for one benchmark library. */
export function buildBenchLibrary(spec: BenchLibrarySpec): FixtureRecords {
  const instruments: Record<string, unknown>[] = [];
  const datasets: Record<string, unknown>[] = [];
  const bars: Record<string, unknown>[] = [];

  for (const series of spec.series) {
    const instrumentId = `inst_${series.id}`;
    const seriesBars = buildBenchBars(series);
    instruments.push({
      id: instrumentId,
      symbol: series.symbol,
      displayName: `${series.symbol} benchmark fixture`,
      assetType: 'equity',
      currency: 'USD',
      exchange: 'NMS',
    });
    datasets.push({
      id: series.id,
      instrumentId,
      name: `${series.symbol} - daily (benchmark fixture)`,
      sourceKind: 'user-csv',
      sourceDescription: 'Synthetic benchmark fixture; not market data.',
      frequency: 'daily',
      timezone: 'UTC',
      firstDate: seriesBars[0]?.date ?? '',
      lastDate: seriesBars[seriesBars.length - 1]?.date ?? '',
      rowCount: seriesBars.length,
      importedAt: '2026-10-16T00:00:00.000Z',
      contentHash: barSeriesContentHash(seriesBars),
      hasVolume: true,
      validation: validation(seriesBars.length),
    });
    bars.push({ id: series.id, bars: seriesBars });
  }

  const charts = spec.panels.map((panel, index) => ({
    id: `chart_${index}`,
    instrumentId: `inst_${panel.datasetId}`,
    datasetId: panel.datasetId,
    timeframe: panel.timeframe ?? '1D',
    chartType: panel.chartType ?? 'candlestick',
    showVolume: panel.showVolume ?? true,
    priceScaleMode: panel.priceScaleMode ?? 'normal',
    visibleRange: null,
    indicators: indicatorInstances(panel.indicators ?? []),
    drawings: [],
    compareDatasetIds: panel.compareDatasetIds ?? [],
  }));

  const workspaces = [
    {
      id: 'ws_bench',
      name: 'Benchmark',
      schemaVersion: 1,
      layout: spec.layout ?? (charts.length > 1 ? 'four' : 'single'),
      charts,
      linkGroups:
        spec.links && spec.links.length > 0
          ? [
              {
                id: 'link_bench',
                name: 'Linked panels',
                chartIds: charts.map((chart) => chart.id),
                properties: spec.links,
              },
            ]
          : [],
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    },
  ];

  const watchlists = [
    {
      id: 'wl_bench',
      name: 'Benchmark',
      instrumentIds: spec.series.map((series) => `inst_${series.id}`),
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

export async function seedBenchLibrary(page: Page, spec: BenchLibrarySpec): Promise<void> {
  await seedLibrary(page, buildBenchLibrary(spec));
}
