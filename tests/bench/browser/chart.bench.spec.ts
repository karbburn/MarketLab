/**
 * Browser chart benchmark: the workloads Sprint 8 is judged against.
 *
 * Every number here is produced by `harness.ts` on a **production build**
 * (`npm run bench:browser` builds first). Nothing in this file asserts a
 * threshold: it writes a report to `assets/bench-browser/` and prints a table.
 * Read it as "what this machine did, with this workload, this time".
 *
 * The fixtures are synthetic (see `fixtures.ts`); no real price data is used or
 * presented. The date ranges and session counts are the point, not the values.
 *
 * Scenario map:
 *   1  single short      one 320-session chart, price scale / volume / type changes
 *   2  single long       one 20,000-session chart, crosshair movement
 *   3  four aligned      four panels, identical sessions, crosshair movement
 *   4  four overlapping  four panels with different end dates, crosshair movement
 *   5  comparisons       one panel plus three rebased overlays, crosshair movement
 *   6  indicators        one panel with four indicators, crosshair movement
 *   7  timeframe churn   repeated 1D/1W/1M changes on a 3,200-session chart
 *   8  crosshair churn   200 crosshair moves on a 3,200-session chart
 *   9  layout + mount    layout switches and route unmount/remount
 *  10  mixed session     long mixed interaction run with heap measurement
 */

import { test, type Page } from '@playwright/test';
import {
  collectGarbage,
  enableDiagnostics,
  formatTable,
  installBenchHelpers,
  measureScenario,
  openChart,
  readMetrics,
  startMetrics,
  timedAction,
  waitForCharts,
  writeReport,
  type ScenarioResult,
} from './harness';
import { seedBenchLibrary, type BenchLibrarySpec } from './fixtures';

const results: ScenarioResult[] = [];

/** Deterministic spread of crosshair positions, never a single hot column. */
function hoverRatio(index: number): number {
  return 0.1 + ((index * 7) % 11) * 0.07;
}

function visiblePanels(spec: BenchLibrarySpec): number {
  const layoutCount = spec.layout === 'four' ? 4 : spec.layout === 'single' ? 1 : 2;
  return Math.min(spec.panels.length, layoutCount);
}

async function setup(page: Page, spec: BenchLibrarySpec): Promise<void> {
  await enableDiagnostics(page);
  await installBenchHelpers(page);
  await seedBenchLibrary(page, spec);
  await openChart(page);
  await waitForCharts(page, visiblePanels(spec));
}

const shortSeries = [{ id: 'ds_a', symbol: 'BNA', sessions: 320, seed: 11, startPrice: 100 }];

test.describe('browser chart benchmark', () => {
  test('1. single short chart: price scale, volume and chart type changes', async ({ page }) => {
    await setup(page, { series: shortSeries, panels: [{ datasetId: 'ds_a' }] });
    const session = await startMetrics(page);

    const scales = ['logarithmic', 'percentage', 'normal'];
    const types = ['line', 'area', 'candlestick'];
    const result = await measureScenario({
      page,
      session,
      scenario: 'single-short-controls',
      description: '320 sessions, one panel; price scale, volume pane and chart type changes',
      workload: { sessions: 320, panels: 1, operations: 'priceScale|volume|chartType' },
      warmup: 3,
      trials: 24,
      notes: [
        'A price-scale or volume change should not rebuild series it does not need; series churn per render is reported.',
      ],
      run: (index) => {
        const mode = index % 3;
        if (mode === 0) return timedAction(page, 'priceScale', { panel: 0, value: scales[index % scales.length] });
        if (mode === 1) return timedAction(page, 'volume');
        return timedAction(page, 'chartType', { panel: 0, value: types[index % types.length] });
      },
    });
    results.push(result);
  });

  test('2. single long chart: crosshair over 20,000 sessions', async ({ page }) => {
    await setup(page, {
      series: [{ id: 'ds_long', symbol: 'BNL', sessions: 20_000, seed: 23, startPrice: 50 }],
      panels: [{ datasetId: 'ds_long' }],
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'single-long-hover',
      description: '20,000 sessions, one panel; crosshair movement',
      workload: { sessions: 20_000, panels: 1, operations: 'hover' },
      warmup: 3,
      trials: 20,
      notes: [
        'Long series stress the crosshair index lookup, the legend readout and the overlay redraw on every move.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('3. four aligned panels: crosshair movement', async ({ page }) => {
    const series = [
      { id: 'ds_a', symbol: 'BNA', sessions: 1600, seed: 31, startPrice: 100 },
      { id: 'ds_b', symbol: 'BNB', sessions: 1600, seed: 32, startPrice: 60 },
      { id: 'ds_c', symbol: 'BNC', sessions: 1600, seed: 33, startPrice: 200 },
      { id: 'ds_d', symbol: 'BND', sessions: 1600, seed: 34, startPrice: 20 },
    ];
    await setup(page, {
      series,
      panels: series.map((entry) => ({ datasetId: entry.id })),
      layout: 'four',
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'four-aligned-hover',
      description: 'four panels over identical 1,600-session ranges; crosshair movement in the first panel',
      workload: { sessions: 1600, panels: 4, aligned: true, operations: 'hover' },
      warmup: 3,
      trials: 24,
      notes: [
        'Aligned panels can resolve a hovered session on every panel; partially overlapping panels cannot.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('4. four partially overlapping panels: crosshair movement', async ({ page }) => {
    const series = [
      { id: 'ds_a', symbol: 'BNA', sessions: 1600, seed: 41, startPrice: 100 },
      { id: 'ds_b', symbol: 'BNB', sessions: 1200, seed: 42, startPrice: 60, endDate: '2025-09-30' },
      { id: 'ds_c', symbol: 'BNC', sessions: 800, seed: 43, startPrice: 200, endDate: '2024-12-31' },
      { id: 'ds_d', symbol: 'BND', sessions: 400, seed: 44, startPrice: 20, endDate: '2025-03-14' },
    ];
    await setup(page, {
      series,
      panels: series.map((entry) => ({ datasetId: entry.id })),
      layout: 'four',
      links: ['crosshair'],
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'four-overlapping-hover',
      description: 'four panels with staggered end dates and a linked crosshair; movement in the first panel',
      workload: { sessions: 1600, panels: 4, aligned: false, links: ['crosshair'], operations: 'hover' },
      warmup: 3,
      trials: 24,
      notes: [
        'Panels whose ranges do not contain the hovered session must show no mirrored line, not the nearest bar.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('5. comparisons: three rebased overlays', async ({ page }) => {
    const series = [
      { id: 'ds_a', symbol: 'BNA', sessions: 1600, seed: 51, startPrice: 100 },
      { id: 'ds_b', symbol: 'BNB', sessions: 1600, seed: 52, startPrice: 60 },
      { id: 'ds_c', symbol: 'BNC', sessions: 1600, seed: 53, startPrice: 200 },
      { id: 'ds_d', symbol: 'BND', sessions: 1600, seed: 54, startPrice: 20 },
    ];
    await setup(page, {
      series,
      panels: [{ datasetId: 'ds_a', compareDatasetIds: ['ds_b', 'ds_c', 'ds_d'] }],
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'comparisons-hover',
      description: 'one panel with three rebased comparison overlays; crosshair movement',
      workload: { sessions: 1600, panels: 1, comparisons: 3, operations: 'hover' },
      warmup: 3,
      trials: 20,
      notes: [
        'Each overlay publishes its value for the hovered session into the legend; the index axis is visible.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('6. indicators: four indicators on one panel', async ({ page }) => {
    await setup(page, {
      series: [{ id: 'ds_a', symbol: 'BNA', sessions: 1600, seed: 61, startPrice: 100 }],
      panels: [{ datasetId: 'ds_a', indicators: ['sma', 'ema', 'rsi', 'macd'] }],
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'indicators-hover',
      description: 'one panel, four indicators (two overlays, two panes); crosshair movement',
      workload: { sessions: 1600, panels: 1, indicators: ['sma', 'ema', 'rsi', 'macd'], operations: 'hover' },
      warmup: 3,
      trials: 20,
      notes: [
        'Indicator legend rows read the hovered index; indicator series themselves are rebuilt only when data changes.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('7. timeframe churn: repeated 1D/1W/1M changes', async ({ page }) => {
    await setup(page, {
      series: [{ id: 'ds_a', symbol: 'BNA', sessions: 3200, seed: 71, startPrice: 100 }],
      panels: [{ datasetId: 'ds_a' }],
    });
    const session = await startMetrics(page);

    const timeframes = ['1W', '1M', '1D'];
    const result = await measureScenario({
      page,
      session,
      scenario: 'timeframe-churn',
      description: '3,200 sessions; alternating weekly, monthly and daily aggregation',
      workload: { sessions: 3200, panels: 1, operations: 'timeframe' },
      warmup: 3,
      trials: 12,
      notes: [
        'Aggregation is measured separately from the chart render; a timeframe change must reset series data, not series identity.',
      ],
      run: (index) => timedAction(page, 'timeframe', { panel: 0, value: timeframes[index % timeframes.length] }),
    });
    results.push(result);
  });

  test('8. crosshair churn: 200 moves', async ({ page }) => {
    await setup(page, {
      series: [{ id: 'ds_a', symbol: 'BNA', sessions: 3200, seed: 81, startPrice: 100 }],
      panels: [{ datasetId: 'ds_a' }],
    });
    const session = await startMetrics(page);

    const result = await measureScenario({
      page,
      session,
      scenario: 'crosshair-churn',
      description: '3,200 sessions; 200 consecutive crosshair moves across the plot',
      workload: { sessions: 3200, panels: 1, moves: 200 },
      warmup: 5,
      trials: 200,
      notes: [
        'This is the sustained-hover workload: per-move React commits and overlay redraws dominate here.',
      ],
      run: (index) => timedAction(page, 'hover', { panel: 0, ratio: hoverRatio(index) }),
    });
    results.push(result);
  });

  test('9. layout switches and route remounts', async ({ page }) => {
    const series = [
      { id: 'ds_a', symbol: 'BNA', sessions: 800, seed: 91, startPrice: 100 },
      { id: 'ds_b', symbol: 'BNB', sessions: 800, seed: 92, startPrice: 60 },
      { id: 'ds_c', symbol: 'BNC', sessions: 800, seed: 93, startPrice: 200 },
      { id: 'ds_d', symbol: 'BND', sessions: 800, seed: 94, startPrice: 20 },
    ];
    await setup(page, {
      series,
      panels: series.map((entry) => ({ datasetId: entry.id })),
      layout: 'single',
    });
    const session = await startMetrics(page);

    const layouts = ['Four panels', 'Single panel', 'Two stacked', 'Four panels'];
    const result = await measureScenario({
      page,
      session,
      scenario: 'layout-and-remount',
      description: 'four configured panels; alternating layout switches and a route unmount/remount',
      workload: { sessions: 800, panels: 4, layouts: layouts.length, remounts: 2 },
      warmup: 2,
      trials: 8,
      notes: [
        'A layout switch mounts or unmounts panels; a route change destroys every chart and rebuilds it.',
        'Each sample ends when every visible panel has been mounted and drawn once, not merely clicked.',
      ],
      run: (index) => {
        // Every fourth operation leaves the page and comes back.
        if (index % 4 === 3) return timedAction(page, 'remount', { panels: 4 });
        return timedAction(page, 'layout', { value: layouts[index % layouts.length], panels: 4 });
      },
    });
    results.push(result);
  });

  test('10. mixed session with heap drift', async ({ page }) => {
    const series = [
      { id: 'ds_a', symbol: 'BNA', sessions: 1600, seed: 101, startPrice: 100 },
      { id: 'ds_b', symbol: 'BNB', sessions: 1600, seed: 102, startPrice: 60 },
      { id: 'ds_c', symbol: 'BNC', sessions: 1600, seed: 103, startPrice: 200 },
      { id: 'ds_d', symbol: 'BND', sessions: 1600, seed: 104, startPrice: 20 },
    ];
    await setup(page, {
      series,
      panels: series.map((entry) => ({ datasetId: entry.id })),
      layout: 'four',
      links: ['crosshair'],
    });
    const session = await startMetrics(page);

    await collectGarbage(session);
    const heapStart = await readMetrics(session);

    const scales = ['logarithmic', 'percentage', 'normal'];
    const timeframes = ['1W', '1D', '1M'];
    const result = await measureScenario({
      page,
      session,
      scenario: 'mixed-session',
      description: 'four linked panels; hover, price scale, volume, timeframe and layout interleaved for 60 operations',
      workload: { sessions: 1600, panels: 4, operations: 60, mixed: true },
      warmup: 4,
      trials: 60,
      notes: ['Heap is measured after a forced collection before and after the run; the delta is retained memory.'],
      run: (index) => {
        const mode = index % 5;
        if (mode === 0 || mode === 1) return timedAction(page, 'hover', { panel: index % 4, ratio: hoverRatio(index) });
        if (mode === 2) return timedAction(page, 'priceScale', { panel: index % 4, value: scales[index % scales.length] });
        if (mode === 3) return timedAction(page, 'timeframe', { panel: index % 4, value: timeframes[index % timeframes.length] });
        return timedAction(page, 'volume');
      },
    });

    await collectGarbage(session);
    const heapEnd = await readMetrics(session);
    const deltaMiB = (heapEnd.jsHeapUsedSize - heapStart.jsHeapUsedSize) / (1024 * 1024);
    result.notes.push(
      `heap after GC: ${(heapStart.jsHeapUsedSize / (1024 * 1024)).toFixed(1)} MiB -> ${(heapEnd.jsHeapUsedSize / (1024 * 1024)).toFixed(1)} MiB (delta ${deltaMiB.toFixed(2)} MiB)`,
    );
    results.push(result);
  });
});

test.afterAll(() => {
  if (results.length === 0) return;
  const file = writeReport(results, {
    suite: 'browser chart benchmark',
    builtFrom: 'production build served by vite preview on 127.0.0.1:4174',
    fixture: 'synthetic deterministic bars, see tests/bench/browser/fixtures.ts',
    viewport: '1600x1000',
    caveat: 'Differences below roughly 10% on one machine are noise; compare medians, not single samples.',
  });
  console.log(`\n${formatTable(results)}\n\nreport: ${file}\n`);
});
