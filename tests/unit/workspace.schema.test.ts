import { describe, expect, it } from 'vitest';
import { datasetSchema, parseWorkspace } from '../../src/lib/workspace/schema';
import { CHART_TYPES } from '../../src/domain/types';
import { CHART_TYPE_OPTIONS } from '../../src/lib/chartTypes';

interface Anchor {
  date: string;
  price: number;
}

function drawing(type: string, anchors: Anchor[]): Record<string, unknown> {
  return {
    id: 'drawing-1',
    type,
    anchors,
    visible: true,
    locked: false,
    style: { color: '#ffffff', lineWidth: 1 },
  };
}

function workspaceWith(drawings: unknown[]): Record<string, unknown> {
  return {
    id: 'ws-1',
    name: 'Workspace',
    schemaVersion: 1,
    layout: 'single',
    charts: [
      {
        id: 'chart-1',
        instrumentId: 'inst-1',
        datasetId: 'ds-1',
        timeframe: '1D',
        chartType: 'candlestick',
        showVolume: true,
        priceScaleMode: 'normal',
        visibleRange: null,
        indicators: [],
        drawings,
      },
    ],
    linkGroups: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const firstAnchor: Anchor = { date: '2024-01-02', price: 100 };
const secondAnchor: Anchor = { date: '2024-01-05', price: 110 };

describe('workspace drawing anchor counts', () => {
  it('accepts a two-anchor rectangle', () => {
    const result = parseWorkspace(workspaceWith([drawing('rectangle', [firstAnchor, secondAnchor])]));
    expect(result.ok).toBe(true);
  });

  it('rejects a rectangle with only one anchor', () => {
    const result = parseWorkspace(workspaceWith([drawing('rectangle', [firstAnchor])]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rectangle/i);
  });

  it('rejects a fibonacci drawing with only one anchor', () => {
    const result = parseWorkspace(workspaceWith([drawing('fibonacci', [firstAnchor])]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/fibonacci/i);
  });

  it('accepts a one-anchor horizontal line', () => {
    const result = parseWorkspace(workspaceWith([drawing('horizontal-line', [firstAnchor])]));
    expect(result.ok).toBe(true);
  });
});

describe('workspace date validation', () => {
  it('rejects an impossible calendar date in a drawing anchor', () => {
    const result = parseWorkspace(workspaceWith([drawing('horizontal-line', [{ date: '2026-02-31', price: 100 }])]));
    expect(result.ok).toBe(false);
  });

  it('rejects an impossible calendar date in the visible range', () => {
    const workspace = workspaceWith([]);
    const charts = workspace.charts as Array<Record<string, unknown>>;
    (charts[0] as Record<string, unknown>).visibleRange = { from: '2026-13-01', to: '2026-12-31' };
    const result = parseWorkspace(workspace);
    expect(result.ok).toBe(false);
  });
});

describe('workspace schema version', () => {
  it('rejects a non-numeric schema version instead of coercing it', () => {
    const workspace = { ...workspaceWith([]), schemaVersion: '2' };
    const result = parseWorkspace(workspace);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/schema version/i);
  });

  it('rejects a null schema version instead of coercing it', () => {
    const workspace = { ...workspaceWith([]), schemaVersion: null };
    const result = parseWorkspace(workspace);
    expect(result.ok).toBe(false);
  });

  it('rejects a workspace saved by a newer version', () => {
    const workspace = { ...workspaceWith([]), schemaVersion: 2 };
    const result = parseWorkspace(workspace);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });
});

describe('chart type coverage', () => {
  it('offers exactly the supported chart types, in the domain order', () => {
    expect(CHART_TYPE_OPTIONS.map((option) => option.value)).toEqual([...CHART_TYPES]);
  });

  it('gives every chart type a non-empty label', () => {
    for (const option of CHART_TYPE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('accepts the OHLC bar chart type in a saved workspace', () => {
    const workspace = workspaceWith([]);
    const charts = workspace.charts as Array<Record<string, unknown>>;
    (charts[0] as Record<string, unknown>).chartType = 'bar';
    expect(parseWorkspace(workspace).ok).toBe(true);
  });

  it('rejects an unknown chart type instead of coercing it', () => {
    const workspace = workspaceWith([]);
    const charts = workspace.charts as Array<Record<string, unknown>>;
    (charts[0] as Record<string, unknown>).chartType = 'hlc-area';
    expect(parseWorkspace(workspace).ok).toBe(false);
  });
});

describe('dataset provider coverage field', () => {
  function datasetWithProvider(provider: Record<string, unknown> | undefined): Record<string, unknown> {
    return {
      id: 'ds-1',
      instrumentId: 'inst-1',
      name: 'AAPL - daily (Yahoo Finance download)',
      sourceKind: 'provider-download',
      sourceDescription: 'Downloaded from Yahoo Finance via MarketLab’s market-data service.',
      frequency: 'daily',
      timezone: 'America/New_York',
      firstDate: '2026-09-14',
      lastDate: '2026-09-17',
      rowCount: 4,
      importedAt: '2026-09-18T00:00:00.000Z',
      contentHash: 'fnv1a-test',
      hasVolume: true,
      ...(provider ? { provider } : {}),
      validation: {
        acceptedRows: 4,
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

  const PROVIDER = {
    provider: 'yahoo-finance',
    providerSymbol: 'AAPL',
    exchange: 'NMS',
    exchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY',
    interval: '1d',
    adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
    retrievedAt: '2026-09-18T00:00:00.000Z',
    timezone: 'America/New_York',
    sourceNotes: [],
    corporateActions: [],
  };

  it('keeps a recorded requested range through a save/restore round trip', () => {
    const parsed = datasetSchema.safeParse(
      datasetWithProvider({ ...PROVIDER, requestedRange: { start: '2026-09-14', end: '2026-09-17' } }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.provider?.requestedRange).toEqual({
      start: '2026-09-14',
      end: '2026-09-17',
    });
  });

  it('accepts a dataset stored before coverage was recorded', () => {
    const parsed = datasetSchema.safeParse(datasetWithProvider(PROVIDER));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.provider?.requestedRange).toBeUndefined();
  });

  it('rejects an impossible requested date instead of trusting the shape', () => {
    const parsed = datasetSchema.safeParse(
      datasetWithProvider({ ...PROVIDER, requestedRange: { start: '2026-02-31', end: '2026-09-17' } }),
    );

    expect(parsed.success).toBe(false);
  });
});
