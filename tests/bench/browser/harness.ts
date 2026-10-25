/**
 * Measurement harness for the browser chart benchmark.
 *
 * Method (kept deliberately simple so a reader can reproduce it by hand):
 *
 *  1. The action is dispatched from inside the page in one task. `sync` is the
 *     time the click handler and React's synchronous discrete-event render take.
 *  2. `paint` is measured to two `requestAnimationFrame` callbacks after the
 *     dispatch, so it includes React's commit, the passive effects that call
 *     into the chart library, and the frame in which the canvas is repainted.
 *  3. Main-thread cost is read from the Chrome DevTools Protocol
 *     (`Performance.getMetrics`) around a fixed number of operations, so it does
 *     not depend on frame timing.
 *  4. The application's own opt-in diagnostics (`src/lib/diagnostics.ts`) split
 *     data preparation from chart-library series work.
 *
 * No threshold is asserted anywhere: the report is the product. Differences
 * below roughly 10% on one machine are noise.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';

export interface TimingSample {
  /** Milliseconds from dispatch to the click handler returning. */
  sync: number;
  /** Milliseconds from dispatch to the second animation frame afterwards. */
  paint: number;
}

export interface DiagnosticsLike {
  phases: Record<string, { ms: number; count: number }>;
  chart: { renders: number; ms: number; seriesAdded: number; seriesRemoved: number; barsLast: number };
  panelCommits: Record<string, number>;
  totalPanelCommits: number;
}

export interface MetricSnapshot {
  scriptDuration: number;
  taskDuration: number;
  layoutDuration: number;
  recalcStyleDuration: number;
  jsHeapUsedSize: number;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  workload: Record<string, unknown>;
  operations: number;
  timings: { median: number; p95: number; min: number; max: number; samples: number[] };
  sync: { median: number; p95: number };
  mainThread: {
    scriptMsPerOp: number;
    taskMsPerOp: number;
    layoutMsPerOp: number;
    styleMsPerOp: number;
  };
  diagnostics: {
    chartRenders: number;
    chartMsPerOp: number;
    seriesAddedPerRender: number;
    seriesRemovedPerRender: number;
    prepMsPerOp: Record<string, number>;
    panelCommitsPerOp: number;
  };
  notes: string[];
}

/* ------------------------------------------------------------ statistics --- */

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* --------------------------------------------------------------- browser --- */

/**
 * Installs the page-side measurement helpers. `addInitScript` re-installs them
 * after every navigation and reload, so seeding the library does not remove them.
 */
export async function installBenchHelpers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bench = {
      now: () => performance.now(),
      frame: () => new Promise<number>((resolve) => requestAnimationFrame(resolve)),
      /**
       * Yields once through a message-channel task. React's scheduler also posts
       * its work through a message channel, and a message posted after the
       * action therefore runs after React has committed — without the timer
       * clamping a `setTimeout(0)` would add.
       */
      flush(): Promise<void> {
        return new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
          };
          channel.port2.postMessage(0);
        });
      },
      /** Runs `action` and measures dispatch cost plus time to the painted frame. */
      async timed<T>(action: () => T | Promise<T>): Promise<{ sync: number; paint: number; value: T }> {
        const started = performance.now();
        const result = action();
        const sync = performance.now() - started;
        const value = await result;
        await bench.frame();
        await bench.frame();
        return { sync, paint: performance.now() - started, value };
      },
      panels(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-grid > .chart-panel'));
      },
      panel(index: number): HTMLElement {
        const found = bench.panels()[index];
        if (!found) throw new Error(`No chart panel at index ${index}`);
        return found;
      },
      /** Every canvas in the pane, including the panes' layers. */
      chartCanvases(panel: HTMLElement): HTMLCanvasElement[] {
        const host = panel.querySelector('.chart-canvas-host');
        if (!host) throw new Error('No chart canvas host');
        return Array.from(host.querySelectorAll('canvas'));
      },
      /**
       * The canvas the library listens on: each widget attaches its mouse handler
       * to its own top-layer canvas (z-index 2), and the price pane is the
       * largest. Dispatching to a price-scale or time-axis canvas instead would
       * move the crosshair from the wrong widget.
       */
      chartTargetCanvas(panel: HTMLElement): HTMLCanvasElement {
        const canvases = bench.chartCanvases(panel);
        const topLayers = canvases.filter((canvas) => canvas.style.zIndex === '2');
        const candidates = topLayers.length > 0 ? topLayers : canvases;
        let best: HTMLCanvasElement | null = null;
        let bestArea = 0;
        for (const canvas of candidates) {
          const area = canvas.clientWidth * canvas.clientHeight;
          if (area > bestArea) {
            best = canvas;
            bestArea = area;
          }
        }
        if (!best) throw new Error('No chart canvas');
        return best;
      },
      button(root: ParentNode, name: string): void {
        const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
        if (!button) throw new Error(`No button labelled ${name}`);
        button.click();
      },
      /** Polls a predicate on animation frames; resolves once it holds. */
      async until(predicate: () => boolean, timeoutMs = 30_000): Promise<number> {
        const started = performance.now();
        while (!predicate()) {
          if (performance.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition');
          await bench.frame();
        }
        return performance.now() - started;
      },
      /** Mounted panels whose overlay canvas has been sized, i.e. drawn at least once. */
      ready(expected: number): boolean {
        const overlays = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas.chart-overlay'));
        return overlays.length === expected && overlays.every((canvas) => Number(canvas.getAttribute('width')) > 100);
      },
      layoutPanels(label: string): number {
        if (label === 'Four panels') return 4;
        if (label === 'Single panel') return 1;
        if (label === 'Two stacked' || label === 'Two side by side') return 2;
        throw new Error(`Unknown layout ${label}`);
      },
      currentLayoutLabel(): string {
        const group = document.querySelector('[role="group"][aria-label="Panel layout"]');
        if (!group) throw new Error('No layout control');
        const pressed = Array.from(group.querySelectorAll('button')).find(
          (entry) => entry.getAttribute('aria-pressed') === 'true',
        );
        return pressed?.textContent?.trim() ?? '';
      },
      /**
       * Switches layout and waits until every panel the layout shows has been
       * mounted and drawn, so the sample covers the work a user waits for.
       */
      async applyLayout(label: string, configuredPanels: number): Promise<void> {
        bench.segmented(document, 'Panel layout', label);
        await bench.until(() => bench.ready(Math.min(configuredPanels, bench.layoutPanels(label))));
      },
      /**
       * Leaves the chart route and comes back, which destroys and rebuilds every
       * chart. The hash change keeps one document, so the timer survives it.
       */
      async remount(configuredPanels: number): Promise<number> {
        const expected = Math.min(configuredPanels, bench.layoutPanels(bench.currentLayoutLabel()));
        const started = performance.now();
        window.history.pushState(null, '', '/workspaces');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await bench.until(() => document.querySelector('.workspace-grid') === null);
        window.history.pushState(null, '', '/chart');
        window.dispatchEvent(new PopStateEvent('popstate'));
        await bench.until(() => bench.ready(expected));
        return performance.now() - started;
      },
      segmented(root: ParentNode, label: string, value: string): void {
        const group = root.querySelector(`[role="group"][aria-label="${label}"]`);
        if (!group) throw new Error(`No segmented control ${label}`);
        const button = Array.from(group.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === value);
        if (!button) throw new Error(`No ${value} in ${label}`);
        (button as HTMLButtonElement).click();
      },
      select(root: ParentNode, label: string, value: string): void {
        const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
        if (!select) throw new Error(`No select ${label}`);
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
      /** Legend session date, the observable proof that a hover landed. */
      legendDate(panel: HTMLElement): string | null {
        const row = panel.querySelector('.chart-legend .legend-values');
        const value = row?.querySelector('.faint');
        return value?.textContent?.trim() ?? null;
      },
      /**
       * Starts a pointer sample. The move itself is dispatched by Playwright
       * (`page.mouse.move`) because a synthetic `mousemove` cannot be relied on
       * here: lightweight-charts only subscribes to `mousemove` during a
       * `mouseenter` on the canvas that owns its handler, and that handshake is
       * not reproducible from script — an unprimed synthetic move is silently
       * dropped, which would have measured "nothing happened" as a fast hover.
       * The timestamp is still taken in the page, so the sample covers dispatch
       * to painted frame; it includes Playwright's transport, which is the same
       * for every run and therefore cancels out in a before/after comparison.
       */
      mark(): void {
        (bench as unknown as Record<string, unknown>).__mark = performance.now();
      },
      /** Ends a pointer sample: dispatch -> two animation frames. */
      async sinceMark(): Promise<number> {
        const started = (bench as unknown as Record<string, unknown>).__mark as number | undefined;
        await bench.frame();
        await bench.frame();
        return performance.now() - (started ?? performance.now());
      },
    };
    (window as unknown as Record<string, unknown>).__bench = bench;
  });
}

/**
 * The plot-area rectangle of a panel's interactive canvas, in CSS pixels.
 * Hover ratios are always taken over this rectangle, not the panel or the host,
 * so a ratio means "this far across the plotted sessions".
 */
export async function chartCanvasBox(page: Page, panelIndex = 0): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((index) => {
    const panel = document.querySelectorAll<HTMLElement>('.workspace-grid > .chart-panel')[index];
    if (!panel) throw new Error(`No chart panel at index ${index}`);
    const canvases = Array.from(panel.querySelectorAll<HTMLCanvasElement>('.chart-canvas-host canvas'));
    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const canvas of canvases) {
      const area = canvas.clientWidth * canvas.clientHeight;
      if (area > bestArea) {
        best = canvas;
        bestArea = area;
      }
    }
    if (!best) throw new Error('No chart canvas');
    const rect = best.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, panelIndex);
}

export async function waitForCharts(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (count) => {
      const overlays = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas.chart-overlay'));
      return overlays.length === count && overlays.every((canvas) => Number(canvas.getAttribute('width')) > 100);
    },
    expected,
    { timeout: 60_000 },
  );
}

export async function openChart(page: Page): Promise<void> {
  await page.goto('/chart');
  await page.waitForSelector('.workspace-grid');
}

export async function enableDiagnostics(page: Page): Promise<void> {
  // The flag has to exist before the bundle boots; addInitScript does that for
  // every navigation, including the reload performed by `seedLibrary`.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__MARKETLAB_DIAGNOSTICS__ = true;
  });
}

/* ------------------------------------------------------------------- CDP --- */

export async function startMetrics(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  return session;
}

export async function readMetrics(session: CDPSession): Promise<MetricSnapshot> {
  const { metrics } = (await session.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const byName = new Map(metrics.map((metric) => [metric.name, metric.value]));
  return {
    scriptDuration: byName.get('ScriptDuration') ?? 0,
    taskDuration: byName.get('TaskDuration') ?? 0,
    layoutDuration: byName.get('LayoutDuration') ?? 0,
    recalcStyleDuration: byName.get('RecalcStyleDuration') ?? 0,
    jsHeapUsedSize: byName.get('JSHeapUsedSize') ?? 0,
  };
}

export async function collectGarbage(session: CDPSession): Promise<void> {
  await session.send('HeapProfiler.collectGarbage');
}

export async function readDiagnostics(page: Page): Promise<DiagnosticsLike> {
  return page.evaluate(() => {
    const api = (window as unknown as Record<string, unknown>).marketlabDiagnostics as
      | { snapshot: () => DiagnosticsLike }
      | undefined;
    if (!api) throw new Error('Diagnostics are not installed; enable the flag before boot');
    return api.snapshot();
  });
}

export async function resetDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as Record<string, unknown>).marketlabDiagnostics as { reset: () => void } | undefined;
    api?.reset();
  });
}

/** Runs one in-page action under the shared timer. */
export async function timedAction(page: Page, action: string, args: Record<string, unknown> = {}): Promise<TimingSample> {
  if (action === 'hover') {
    // Trusted mouse move, timed from the page. See the `mark`/`sinceMark` note.
    await page.evaluate(() => {
      const bench = (window as unknown as Record<string, unknown>).__bench as { mark: () => void };
      bench.mark();
    });
    const box = await chartCanvasBox(page, Number(args.panel ?? 0));
    const ratio = Number(args.ratio ?? 0.5);
    await page.mouse.move(box.x + box.width * ratio, box.y + box.height * 0.5);
    const paint = await page.evaluate(async () => {
      const bench = (window as unknown as Record<string, unknown>).__bench as { sinceMark: () => Promise<number> };
      return bench.sinceMark();
    });
    return { sync: 0, paint };
  }
  if (action === 'park') {
    await page.evaluate(() => {
      const bench = (window as unknown as Record<string, unknown>).__bench as { mark: () => void };
      bench.mark();
    });
    await page.mouse.move(2, 2);
    const paint = await page.evaluate(async () => {
      const bench = (window as unknown as Record<string, unknown>).__bench as { sinceMark: () => Promise<number> };
      return bench.sinceMark();
    });
    return { sync: 0, paint };
  }
  const sample = await page.evaluate(
    ({ action, args }) => {
      const bench = (window as unknown as Record<string, unknown>).__bench as {
        timed: (run: () => unknown | Promise<unknown>) => Promise<{ sync: number; paint: number; value: unknown }>;
        panel: (index: number) => HTMLElement;
        panels: () => HTMLElement[];
        segmented: (root: ParentNode, label: string, value: string) => void;
        select: (root: ParentNode, label: string, value: string) => void;
        button: (root: ParentNode, name: string) => void;
        legendDate: (panel: HTMLElement) => string | null;
        applyLayout: (label: string, configuredPanels: number) => Promise<void>;
        remount: (configuredPanels: number) => Promise<number>;
      };
      const panelIndex = Number(args.panel ?? 0);
      switch (action) {
        case 'timeframe':
          return bench.timed(() => bench.segmented(bench.panel(panelIndex), 'Timeframe', String(args.value)));
        case 'chartType':
          return bench.timed(() => bench.select(bench.panel(panelIndex), 'Chart type', String(args.value)));
        case 'priceScale':
          return bench.timed(() => bench.select(bench.panel(panelIndex), 'Price scale', String(args.value)));
        case 'volume':
          return bench.timed(() => bench.button(document, 'Volume pane'));
        case 'layout':
          return bench.timed(() => bench.applyLayout(String(args.value), Number(args.panels ?? 4)));
        case 'remount':
          return bench.timed(() => bench.remount(Number(args.panels ?? 4)));
        default:
          throw new Error(`Unknown benchmark action: ${action}`);
      }
    },
    { action, args },
  );
  return { sync: sample.sync, paint: sample.paint };
}

/* ----------------------------------------------------------------- report --- */

export function summarise(
  scenario: string,
  description: string,
  workload: Record<string, unknown>,
  timings: readonly TimingSample[],
  deltas: { script: number; task: number; layout: number; style: number },
  diagnostics: DiagnosticsLike,
  notes: string[] = [],
): ScenarioResult {
  const operations = timings.length;
  const paint = timings.map((sample) => sample.paint);
  const sync = timings.map((sample) => sample.sync);
  const perOp = (total: number) => (operations === 0 ? 0 : round(total / operations, 3));
  const prep: Record<string, number> = {};
  for (const [phase, entry] of Object.entries(diagnostics.phases)) prep[phase] = round(entry.ms / Math.max(1, operations), 3);
  const renders = Math.max(1, diagnostics.chart.renders);
  return {
    scenario,
    description,
    workload,
    operations,
    timings: {
      median: round(median(paint)),
      p95: round(percentile(paint, 0.95)),
      min: round(Math.min(...paint)),
      max: round(Math.max(...paint)),
      samples: paint.map((value) => round(value)),
    },
    sync: { median: round(median(sync)), p95: round(percentile(sync, 0.95)) },
    mainThread: {
      scriptMsPerOp: perOp(deltas.script),
      taskMsPerOp: perOp(deltas.task),
      layoutMsPerOp: perOp(deltas.layout),
      styleMsPerOp: perOp(deltas.style),
    },
    diagnostics: {
      chartRenders: diagnostics.chart.renders,
      chartMsPerOp: round(diagnostics.chart.ms / Math.max(1, operations), 3),
      seriesAddedPerRender: round(diagnostics.chart.seriesAdded / renders, 2),
      seriesRemovedPerRender: round(diagnostics.chart.seriesRemoved / renders, 2),
      prepMsPerOp: prep,
      panelCommitsPerOp: round(diagnostics.totalPanelCommits / Math.max(1, operations), 2),
    },
    notes,
  };
}

/**
 * Runs one measured scenario: warm-up operations first (never recorded), then N
 * recorded operations with the diagnostics reset in between so the per-operation
 * averages describe only the recorded work.
 */
export async function measureScenario(options: {
  page: Page;
  session: CDPSession;
  scenario: string;
  description: string;
  workload: Record<string, unknown>;
  warmup: number;
  trials: number;
  /** One action, including its Playwright-side setup if it needs any. */
  run: (index: number) => Promise<TimingSample>;
  notes?: string[];
}): Promise<ScenarioResult> {
  const { page, session, warmup, trials, run } = options;

  for (let index = 0; index < warmup; index += 1) await run(index);

  await resetDiagnostics(page);
  const before = await readMetrics(session);
  const samples: TimingSample[] = [];
  for (let index = 0; index < trials; index += 1) samples.push(await run(index));
  const after = await readMetrics(session);
  const diagnostics = await readDiagnostics(page);

  return summarise(
    options.scenario,
    options.description,
    options.workload,
    samples,
    {
      script: after.scriptDuration - before.scriptDuration,
      task: after.taskDuration - before.taskDuration,
      layout: after.layoutDuration - before.layoutDuration,
      style: after.recalcStyleDuration - before.recalcStyleDuration,
    },
    diagnostics,
    options.notes ?? [],
  );
}

export function writeReport(results: readonly ScenarioResult[], meta: Record<string, unknown>): string {
  const directory = path.join('assets', 'bench-browser');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ meta, results }, null, 2)}\n`, 'utf8');
  return file;
}

export function formatTable(results: readonly ScenarioResult[]): string {
  const header = ['scenario', 'ops', 'median ms', 'p95 ms', 'script/op', 'chart/op', 'series +/−', 'commits/op'];
  const rows = results.map((result) => [
    result.scenario,
    String(result.operations),
    result.timings.median.toFixed(2),
    result.timings.p95.toFixed(2),
    result.mainThread.scriptMsPerOp.toFixed(3),
    result.diagnostics.chartMsPerOp.toFixed(3),
    `${result.diagnostics.seriesAddedPerRender}/${result.diagnostics.seriesRemovedPerRender}`,
    result.diagnostics.panelCommitsPerOp.toFixed(2),
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}
