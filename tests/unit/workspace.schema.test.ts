import { describe, expect, it } from 'vitest';
import { parseWorkspace } from '../../src/lib/workspace/schema';

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
