import { z } from 'zod';
import { CHART_TYPES, type Workspace } from '../../domain/types';
import { isDateString } from '../date';
import { anchorsRequired } from '../drawings/geometry';

export const WORKSPACE_SCHEMA_VERSION = 1;

const dateString = z.string().refine((value) => isDateString(value), 'Expected a valid ISO session date (YYYY-MM-DD).');

const drawingAnchorSchema = z.object({
  date: dateString,
  price: z.number().finite(),
});

const drawingStyleSchema = z.object({
  color: z.string().min(1),
  lineWidth: z.number().min(0.5).max(8),
  fillOpacity: z.number().min(0).max(1).optional(),
  fontSize: z.number().min(8).max(48).optional(),
  lineStyle: z.enum(['solid', 'dashed']).optional(),
});

const drawingSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['trendline', 'ray', 'horizontal-line', 'vertical-line', 'rectangle', 'text', 'price-range', 'fibonacci']),
    anchors: z.array(drawingAnchorSchema).min(1),
    text: z.string().optional(),
    visible: z.boolean(),
    locked: z.boolean(),
    style: drawingStyleSchema,
    levels: z.array(z.number().min(0).max(1)).optional(),
  })
  .superRefine((drawing, ctx) => {
    const required = anchorsRequired(drawing.type);
    if (drawing.anchors.length < required) {
      ctx.addIssue({
        code: 'custom',
        path: ['anchors'],
        message: `${drawing.type} drawings require at least ${required} anchor(s).`,
      });
    }
  });

const indicatorStyleSchema = z.object({
  color: z.string().optional(),
  secondaryColor: z.string().optional(),
  lineWidth: z.number().min(0.5).max(8).optional(),
});

const indicatorInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().nonnegative(),
  parameters: z.record(z.string(), z.number().finite()),
  visible: z.boolean(),
  placement: z.enum(['overlay', 'pane']),
  style: indicatorStyleSchema,
});

const visibleRangeSchema = z
  .object({ from: dateString, to: dateString })
  .nullable();

const chartConfigSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  datasetId: z.string().min(1),
  timeframe: z.enum(['1D', '1W', '1M']),
  chartType: z.enum(CHART_TYPES),
  showVolume: z.boolean(),
  priceScaleMode: z.enum(['normal', 'logarithmic', 'percentage']),
  visibleRange: visibleRangeSchema,
  indicators: z.array(indicatorInstanceSchema),
  drawings: z.array(drawingSchema),
  // Absent in workspaces saved before comparison overlays existed; default to
  // none rather than rejecting the whole workspace.
  compareDatasetIds: z.array(z.string()).default([]),
});

const linkGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  chartIds: z.array(z.string()),
  properties: z.array(z.enum(['symbol', 'timeframe', 'visible-range', 'crosshair'])),
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  layout: z.enum(['single', 'two-horizontal', 'two-vertical', 'four']),
  charts: z.array(chartConfigSchema).min(1),
  linkGroups: z.array(linkGroupSchema),
  activeWatchlistId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const watchlistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instrumentIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light']),
  defaultWorkspaceId: z.string().nullable(),
  showVolumeByDefault: z.boolean(),
  defaultChartType: z.enum(CHART_TYPES),
  defaultTimeframe: z.enum(['1D', '1W', '1M']),
});

export const instrumentSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  displayName: z.string().min(1),
  assetType: z.enum(['equity', 'index', 'fx', 'crypto', 'commodity', 'fund', 'other']),
  currency: z.string(),
  exchange: z.string().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const barSchema = z.object({
  date: dateString,
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nullable(),
  bucket: z.string().optional(),
});

const corporateActionSchema = z.object({
  date: dateString,
  type: z.enum(['split', 'dividend']),
  value: z.number().finite().positive(),
});

export const datasetSchema = z.object({
  id: z.string().min(1),
  instrumentId: z.string().min(1),
  name: z.string(),
  sourceKind: z.enum(['bundled-sample', 'user-csv', 'provider-download']),
  sourceDescription: z.string(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  timezone: z.string(),
  firstDate: dateString,
  lastDate: dateString,
  rowCount: z.number().int().nonnegative(),
  importedAt: z.string(),
  contentHash: z.string(),
  hasVolume: z.boolean(),
  provider: z
    .object({
      provider: z.enum(['yahoo-finance']),
      providerSymbol: z.string().min(1),
      exchange: z.string().nullable(),
      exchangeName: z.string().nullable(),
      instrumentType: z.string().nullable(),
      interval: z.string(),
      adjustment: z.string(),
      retrievedAt: z.string(),
      timezone: z.string().nullable(),
      sourceNotes: z.array(z.string()),
      // Older downloads predate corporate-action capture; default to none
      // instead of rejecting the dataset.
      corporateActions: z.array(corporateActionSchema).default([]),
    })
    .optional(),
  validation: z.object({
    acceptedRows: z.number(),
    rejectedRows: z.number(),
    duplicateRows: z.number(),
    missingVolumeRows: z.number(),
    gapCount: z.number(),
    sortCorrections: z.number(),
    rejected: z.array(z.object({ rowNumber: z.number(), reason: z.string(), raw: z.string().optional() })),
    warnings: z.array(z.object({ code: z.string(), message: z.string(), count: z.number().optional() })),
  }),
});

export const screenerDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  universeDatasetIds: z.array(z.string()),
  combinators: z.array(z.enum(['AND', 'OR'])),
  filters: z.array(
    z.object({
      id: z.string(),
      field: z.enum([
        'return',
        'price-vs-sma',
        'price-vs-ema',
        'rsi',
        'volatility',
        'max-drawdown',
        'relative-volume',
        'close',
      ]),
      operator: z.enum(['gt', 'gte', 'lt', 'lte', 'crosses-above', 'crosses-below']),
      value: z.number().finite(),
      window: z.number().int().min(1).max(500),
    }),
  ),
  cutoff: dateString.nullable(),
  sortBy: z.string(),
  sortDirection: z.enum(['asc', 'desc']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const backtestConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  datasetId: z.string().min(1),
  startDate: dateString.nullable(),
  endDate: dateString.nullable(),
  initialCapital: z.number().positive(),
  positionSizePct: z.number().min(1).max(100),
  commissionBps: z.number().min(0).max(1000),
  slippageBps: z.number().min(0).max(1000),
  stopLossPct: z.number().min(0).max(99).nullable(),
  takeProfitPct: z.number().min(0).max(1000).nullable(),
  entry: z.array(
    z.object({
      id: z.string(),
      field: z.enum(['price-vs-sma', 'sma-cross', 'rsi', 'price-vs-ema', 'macd-cross', 'breakout-high', 'breakout-low']),
      operator: z.enum(['gt', 'gte', 'lt', 'lte', 'crosses-above', 'crosses-below']),
      value: z.number().finite(),
      secondaryValue: z.number().finite().optional(),
      window: z.number().int().min(1).max(500),
      secondaryWindow: z.number().int().min(1).max(500).optional(),
    }),
  ),
  exit: z.array(
    z.object({
      id: z.string(),
      field: z.enum(['price-vs-sma', 'sma-cross', 'rsi', 'price-vs-ema', 'macd-cross', 'breakout-high', 'breakout-low']),
      operator: z.enum(['gt', 'gte', 'lt', 'lte', 'crosses-above', 'crosses-below']),
      value: z.number().finite(),
      secondaryValue: z.number().finite().optional(),
      window: z.number().int().min(1).max(500),
      secondaryWindow: z.number().int().min(1).max(500).optional(),
    }),
  ),
  entryLogic: z.enum(['AND', 'OR']),
  exitLogic: z.enum(['AND', 'OR']),
  execution: z.literal('next-open'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Parses and, when needed, upgrades a stored or imported workspace.
 *
 * Unknown top-level keys are dropped. A workspace with a schema version newer
 * than this build is rejected rather than silently coerced, so a newer file is
 * never downgraded into data loss.
 */
export function parseWorkspace(input: unknown): { ok: true; value: Workspace } | { ok: false; error: string } {
  let candidate = input;
  if (candidate && typeof candidate === 'object' && 'schemaVersion' in candidate) {
    const version = (candidate as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      return { ok: false, error: 'The workspace schema version is missing or invalid.' };
    }
    if (version > WORKSPACE_SCHEMA_VERSION) {
      return { ok: false, error: `This workspace was saved by a newer version (schema ${version}).` };
    }
    candidate = migrateWorkspace(candidate as Record<string, unknown>, version);
  }
  const parsed = workspaceSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'workspace'}: ${issue.message}`).join('; ') };
  }
  return { ok: true, value: parsed.data as Workspace };
}

function migrateWorkspace(input: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let working = { ...input };
  if (fromVersion < 1) {
    // Version 0 had no `linkGroups`; default it to an empty list rather than guessing groups.
    if (!Array.isArray(working.linkGroups)) working = { ...working, linkGroups: [] };
    working = { ...working, schemaVersion: 1 };
  }
  return working;
}
