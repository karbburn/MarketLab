/**
 * Opt-in instrumentation for the browser performance harness.
 *
 * The monitor is inert unless the page sets `window.__MARKETLAB_DIAGNOSTICS__ = true`
 * before the bundle boots. Every recording call starts with a boolean test, so the
 * production cost is a branch and nothing is allocated, measured or exposed while
 * the flag is off.
 *
 * It exists so `tests/bench/browser/` can separate the phases that a single
 * end-to-end number would blend together: data preparation (timeframe aggregation,
 * indicator calculations, comparison preparation), React panel commits, and the
 * chart library's own series work. Without that separation "the chart takes 40 ms"
 * cannot be attributed to the application or to `lightweight-charts`.
 */

export type DiagnosticsPhase = 'timeframe' | 'indicators' | 'comparison';

export interface DiagnosticsSnapshot {
  /** Milliseconds and call counts per application preparation phase. */
  phases: Record<DiagnosticsPhase, { ms: number; count: number }>;
  /** `ChartController.render` calls, their total time and the series churn. */
  chart: {
    renders: number;
    ms: number;
    seriesAdded: number;
    seriesRemoved: number;
    barsLast: number;
  };
  /** Committed React renders per chart panel id. */
  panelCommits: Record<string, number>;
  totalPanelCommits: number;
}

const PHASES: DiagnosticsPhase[] = ['timeframe', 'indicators', 'comparison'];

let enabled = false;

const phases: Record<DiagnosticsPhase, { ms: number; count: number }> = {
  timeframe: { ms: 0, count: 0 },
  indicators: { ms: 0, count: 0 },
  comparison: { ms: 0, count: 0 },
};

const chart = { renders: 0, ms: 0, seriesAdded: 0, seriesRemoved: 0, barsLast: 0 };

const panelCommits = new Map<string, number>();
let totalPanelCommits = 0;

function readFlag(): boolean {
  if (typeof window === 'undefined') return false;
  const value = (window as unknown as Record<string, unknown>).__MARKETLAB_DIAGNOSTICS__;
  return value === true;
}

export function diagnosticsEnabled(): boolean {
  return enabled;
}

export function resetDiagnostics(): void {
  for (const phase of PHASES) {
    phases[phase].ms = 0;
    phases[phase].count = 0;
  }
  chart.renders = 0;
  chart.ms = 0;
  chart.seriesAdded = 0;
  chart.seriesRemoved = 0;
  chart.barsLast = 0;
  panelCommits.clear();
  totalPanelCommits = 0;
}

export function diagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    phases: {
      timeframe: { ...phases.timeframe },
      indicators: { ...phases.indicators },
      comparison: { ...phases.comparison },
    },
    chart: { ...chart },
    panelCommits: Object.fromEntries(panelCommits),
    totalPanelCommits,
  };
}

/**
 * Publishes the snapshot only when the instrumentation flag was set before boot.
 * Called once from `main.tsx`; a no-op in every ordinary visit.
 */
export function installDiagnostics(): void {
  enabled = readFlag();
  if (!enabled) return;
  (window as unknown as Record<string, unknown>).marketlabDiagnostics = {
    snapshot: diagnosticsSnapshot,
    reset: resetDiagnostics,
    enabled: true,
  };
}

/** Times one application preparation phase. Returns the callback result unchanged. */
export function measurePhase<T>(phase: DiagnosticsPhase, run: () => T): T {
  if (!enabled) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    phases[phase].ms += performance.now() - started;
    phases[phase].count += 1;
  }
}

/** Start marker for a chart-library render; 0 when instrumentation is off. */
export function beginChartRender(): number {
  return enabled ? performance.now() : 0;
}

export function recordChartRender(
  startedAt: number,
  input: { bars: number; seriesAdded: number; seriesRemoved: number },
): void {
  if (!enabled) return;
  chart.renders += 1;
  chart.ms += performance.now() - startedAt;
  chart.seriesAdded += input.seriesAdded;
  chart.seriesRemoved += input.seriesRemoved;
  chart.barsLast = input.bars;
}

/** Counts committed renders of a panel. Called from an effect, never from render. */
export function recordPanelCommit(chartId: string): void {
  if (!enabled) return;
  panelCommits.set(chartId, (panelCommits.get(chartId) ?? 0) + 1);
  totalPanelCommits += 1;
}
