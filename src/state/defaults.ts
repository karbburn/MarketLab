import type {
  BacktestConfig,
  ChartConfig,
  ScreenerDefinition,
  UserPreferences,
  Watchlist,
  Workspace,
  WorkspaceLayout,
} from '../domain/types';
import { createId } from '../lib/id';
import { FIB_LEVELS } from '../lib/drawings/geometry';

export const APP_SCHEMA_VERSION = 1;

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  defaultWorkspaceId: null,
  showVolumeByDefault: true,
  defaultChartType: 'candlestick',
  defaultTimeframe: '1D',
};

export const WORKSPACE_LAYOUTS: Array<{ id: WorkspaceLayout; label: string; chartCount: number }> = [
  { id: 'single', label: 'Single panel', chartCount: 1 },
  { id: 'two-horizontal', label: 'Two stacked', chartCount: 2 },
  { id: 'two-vertical', label: 'Two side by side', chartCount: 2 },
  { id: 'four', label: 'Four panels', chartCount: 4 },
];

export function chartCountForLayout(layout: WorkspaceLayout): number {
  return WORKSPACE_LAYOUTS.find((entry) => entry.id === layout)?.chartCount ?? 1;
}

export function createChartConfig(input: {
  instrumentId: string;
  datasetId: string;
  showVolume?: boolean;
  chartType?: ChartConfig['chartType'];
  timeframe?: ChartConfig['timeframe'];
}): ChartConfig {
  return {
    id: createId('chart'),
    instrumentId: input.instrumentId,
    datasetId: input.datasetId,
    timeframe: input.timeframe ?? '1D',
    chartType: input.chartType ?? 'candlestick',
    showVolume: input.showVolume ?? true,
    priceScaleMode: 'normal',
    visibleRange: null,
    indicators: [],
    drawings: [],
    compareDatasetIds: [],
  };
}

export function createWorkspace(input: {
  name: string;
  layout?: WorkspaceLayout;
  base: { instrumentId: string; datasetId: string; showVolume?: boolean; chartType?: ChartConfig['chartType']; timeframe?: ChartConfig['timeframe'] };
}): Workspace {
  const layout = input.layout ?? 'single';
  const count = chartCountForLayout(layout);
  const charts: ChartConfig[] = [];
  for (let i = 0; i < count; i += 1) {
    charts.push(
      createChartConfig({
        instrumentId: input.base.instrumentId,
        datasetId: input.base.datasetId,
        showVolume: input.base.showVolume,
        chartType: input.base.chartType,
        timeframe: input.base.timeframe,
      }),
    );
  }
  const now = new Date().toISOString();
  return {
    id: createId('ws'),
    name: input.name,
    schemaVersion: APP_SCHEMA_VERSION,
    layout,
    charts,
    linkGroups: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Copy a panel, giving the copy fresh indicator and drawing identities. */
export function duplicateChartConfig(chart: ChartConfig): ChartConfig {
  return {
    ...chart,
    id: createId('chart'),
    indicators: chart.indicators.map((instance) => ({ ...instance, id: createId('ind') })),
    drawings: [],
  };
}

/**
 * Apply a layout and add panels if the layout needs more than are stored.
 * Shrinking a layout never deletes panels, so hidden drawings are preserved.
 */
export function withLayout(workspace: Workspace, layout: WorkspaceLayout): Workspace {
  const needed = chartCountForLayout(layout);
  const charts = [...workspace.charts];
  while (charts.length < needed) {
    const source = charts[charts.length - 1];
    if (!source) break;
    charts.push(duplicateChartConfig(source));
  }
  return { ...workspace, layout, charts };
}

export function createWatchlist(name: string, instrumentIds: string[] = []): Watchlist {
  const now = new Date().toISOString();
  return { id: createId('wl'), name, instrumentIds: [...instrumentIds], createdAt: now, updatedAt: now };
}

export function createScreenerDefinition(universeDatasetIds: string[]): ScreenerDefinition {
  const now = new Date().toISOString();
  return {
    id: createId('scr'),
    name: 'Untitled screen',
    schemaVersion: APP_SCHEMA_VERSION,
    universeDatasetIds: [...universeDatasetIds],
    combinators: [],
    filters: [
      { id: createId('flt'), field: 'price-vs-sma', operator: 'gt', value: 0, window: 50 },
    ],
    cutoff: null,
    sortBy: 'return',
    sortDirection: 'desc',
    createdAt: now,
    updatedAt: now,
  };
}

export function createBacktestConfig(input: { datasetId: string; name?: string }): BacktestConfig {
  const now = new Date().toISOString();
  return {
    id: createId('bt'),
    name: input.name ?? 'Untitled strategy',
    datasetId: input.datasetId,
    startDate: null,
    endDate: null,
    initialCapital: 100_000,
    positionSizePct: 95,
    commissionBps: 5,
    slippageBps: 5,
    stopLossPct: 8,
    takeProfitPct: null,
    entry: [{ id: createId('rule'), field: 'sma-cross', operator: 'crosses-above', value: 0, window: 20, secondaryWindow: 50 }],
    exit: [{ id: createId('rule'), field: 'sma-cross', operator: 'crosses-below', value: 0, window: 20, secondaryWindow: 50 }],
    entryLogic: 'AND',
    exitLogic: 'AND',
    execution: 'next-open',
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultDrawingLevels(): number[] {
  return [...FIB_LEVELS];
}
