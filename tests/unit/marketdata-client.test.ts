import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deterministic suite for the market-data provider client. Every response is
 * synthesised; the network is never touched, and Yahoo Finance availability
 * plays no role in these tests.
 */

import {
  DEFAULT_SERVICE_URL,
  MarketDataError,
  checkServiceHealth,
  fetchProviderHistory,
  fetchProviderSearch,
  marketDataEndpoint,
} from '../../src/lib/marketdata/client';

const SERVICE = DEFAULT_SERVICE_URL;

const okHistoryBody = {
  provider: {
    provider: 'yahoo-finance',
    providerSymbol: 'AAPL',
    displaySymbol: 'AAPL',
    displayName: 'Apple Inc.',
    exchange: 'NMS',
    exchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY',
    currency: 'USD',
    timezone: 'America/New_York',
    interval: '1d',
    adjustment: 'splits-applied, dividends not reinvested (as-traded OHLC)',
    rangeRequested: { start: '2024-01-01', end: '2024-01-10' },
    rangeActual: { start: '2024-01-02', end: '2024-01-03' },
    retrievedAt: '2026-10-19T12:00:00+00:00',
    sourceNotes: ['a', 'b'],
    corporateActions: [
      { date: '2024-01-02', type: 'split', value: 2 },
      { date: '2024-01-03', type: 'dividend', value: 0.24 },
    ],
  },
  bars: [
    { date: '2024-01-02', open: 10, high: 11, low: 9.5, close: 10.5, adjClose: 10.4, volume: 1200 },
    { date: '2024-01-03', open: 10.5, high: 12, low: 10.1, close: 11.25, adjClose: 11.15, volume: 3400 },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', handler as unknown as typeof fetch);
}

beforeEach(() => {
  vi.stubGlobal('AbortController', globalThis.AbortController);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketDataEndpoint', () => {
  it('uses the local FastAPI /api contract for a loopback base', () => {
    expect(marketDataEndpoint('http://127.0.0.1:8787', 'health')).toBe('http://127.0.0.1:8787/api/health');
    expect(marketDataEndpoint('http://127.0.0.1:8787/', 'history')).toBe('http://127.0.0.1:8787/api/history');
  });

  it('uses the hosted route without repeating /api', () => {
    expect(marketDataEndpoint('/api/market-data', 'search')).toBe('/api/market-data/search');
    expect(marketDataEndpoint('/api/market-data/', 'history')).toBe('/api/market-data/history');
  });

  it('recognises a configured absolute hosted proxy base', () => {
    expect(marketDataEndpoint('https://example.test/api/market-data', 'health')).toBe(
      'https://example.test/api/market-data/health',
    );
  });

  it('keeps the local-compatible contract for an unrecognised custom base', () => {
    expect(marketDataEndpoint('https://example.test/market-data', 'history')).toBe(
      'https://example.test/market-data/api/history',
    );
  });
});

describe('checkServiceHealth', () => {
  it('is true when the service answers ok', async () => {
    stubFetch(async (url) => {
      expect(String(url)).toBe(`${SERVICE}/health`);
      return jsonResponse({ ok: true, provider: 'yahoo-finance' });
    });
    await expect(checkServiceHealth(SERVICE)).resolves.toBe(true);
  });

  it('is false when it cannot reach the service', async () => {
    stubFetch(async () => {
      throw new TypeError('connection refused');
    });
    await expect(checkServiceHealth(SERVICE)).resolves.toBe(false);
  });
});

describe('fetchProviderSearch', () => {
  it('normalises a successful response', async () => {
    stubFetch(async (url) => {
      expect(String(url)).toBe(`${SERVICE}/search?q=app&limit=8`);
      return jsonResponse({
        results: [
          { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NMS', exchangeName: 'NASDAQ', type: 'Equity' },
          { symbol: 'AAPL.MX', name: 'Apple in Mexico', exchange: 'MEX', type: 'Equity', sector: null, industry: undefined },
        ],
      });
    });
    const results = await fetchProviderSearch('app');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', exchangeName: 'NASDAQ' });
    expect(results[1]).toMatchObject({ symbol: 'AAPL.MX', sector: null, industry: null });
  });

  it('maps HTTP 400 to invalid-input and keeps the service detail', async () => {
    stubFetch(async () => jsonResponse({ detail: 'Symbol contains unsupported characters.' }, 400));
    await expect(fetchProviderSearch('')).rejects.toMatchObject({
      kind: 'invalid-input',
      message: 'Symbol contains unsupported characters.',
    });
  });

  it('maps HTTP 429 to throttled', async () => {
    stubFetch(async () => jsonResponse({ detail: 'Yahoo throttled this request.' }, 429));
    await expect(fetchProviderSearch('app')).rejects.toMatchObject({ kind: 'throttled' });
  });

  it('flags a search body without a results list as malformed', async () => {
    stubFetch(async () => jsonResponse({ results: null }));
    await expect(fetchProviderSearch('app')).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('flags result rows without symbols as malformed', async () => {
    stubFetch(async () => jsonResponse({ results: [{ name: 'No symbol' }] }));
    await expect(fetchProviderSearch('app')).rejects.toMatchObject({ kind: 'malformed' });
  });
});

describe('fetchProviderHistory', () => {
  it('rejects an unsupported provider id instead of mislabelling the series', async () => {
    stubFetch(async () => jsonResponse({
      ...okHistoryBody,
      provider: { ...okHistoryBody.provider, provider: 'some-other-feed' },
    }));
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-01-10' }))
      .rejects.toMatchObject({ kind: 'malformed', message: expect.stringContaining('unsupported provider id') });
  });

  it('normalises a successful response with metadata and bars', async () => {
    stubFetch(async (url) => {
      expect(String(url)).toBe(`${SERVICE}/history?symbol=AAPL&start=2024-01-01&end=2024-01-10`);
      return jsonResponse(okHistoryBody);
    });
    const history = await fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-01-10' });
    expect(history.providerMetadata.provider).toBe('yahoo-finance');
    expect(history.providerMetadata.adjustment).toContain('dividends not reinvested');
    expect(history.providerMetadata.sourceNotes).toEqual(['a', 'b']);
    expect(history.providerMetadata.corporateActions).toEqual([
      { date: '2024-01-02', type: 'split', value: 2 },
      { date: '2024-01-03', type: 'dividend', value: 0.24 },
    ]);
    expect(history.bars).toHaveLength(2);
    expect(history.bars[0]).toEqual({
      date: '2024-01-02',
      open: 10,
      high: 11,
      low: 9.5,
      close: 10.5,
      adjClose: 10.4,
      volume: 1200,
    });
  });

  it('treats a service that predates corporate actions as reporting none', async () => {
    const legacyProvider: Record<string, unknown> = { ...okHistoryBody.provider };
    delete legacyProvider.corporateActions;
    stubFetch(async () => jsonResponse({ ...okHistoryBody, provider: legacyProvider }));
    const history = await fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-01-10' });
    expect(history.providerMetadata.corporateActions).toEqual([]);
  });

  it('deduplicates repeated provider actions without inventing new ones', async () => {
    stubFetch(async () =>
      jsonResponse({
        ...okHistoryBody,
        provider: {
          ...okHistoryBody.provider,
          corporateActions: [
            { date: '2024-01-02', type: 'dividend', value: 0.24 },
            { date: '2024-01-02', type: 'dividend', value: 0.24 },
          ],
        },
      }),
    );
    const history = await fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-01-10' });
    expect(history.providerMetadata.corporateActions).toEqual([{ date: '2024-01-02', type: 'dividend', value: 0.24 }]);
  });

  it('fails a malformed corporate-action row instead of silently dropping the event', async () => {
    stubFetch(async () =>
      jsonResponse({
        ...okHistoryBody,
        provider: {
          ...okHistoryBody.provider,
          corporateActions: [{ date: '2024-01-02', type: 'merger', value: 1 }],
        },
      }),
    );
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-01-10' })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('maps HTTP 404 (no data) to not-found', async () => {
    stubFetch(async () => jsonResponse({ detail: 'No sessions were returned for the requested range.' }, 404));
    await expect(fetchProviderHistory({ symbol: 'APPLWRONG', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('maps HTTP 502 (malformed provider answer) to server-error with kept detail', async () => {
    stubFetch(async () => jsonResponse({ detail: 'Provider response is missing required columns: Open.' }, 502));
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'server-error',
      message: 'Provider response is missing required columns: Open.',
    });
  });

  it('maps HTTP 503 to timeout', async () => {
    stubFetch(async () => jsonResponse({ detail: 'The provider request timed out.' }, 503));
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('flags malformed bar rows (missing session date) instead of accepting them', async () => {
    stubFetch(async () =>
      jsonResponse({
        ...okHistoryBody,
        bars: [{ open: 1, high: 1, low: 1, close: 1, volume: null }],
      }),
    );
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('degrades a broken metadata envelope to malformed, never to a partial success', async () => {
    stubFetch(async () => jsonResponse({ provider: null, bars: [] }));
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('maps a non-JSON success body to malformed', async () => {
    stubFetch(async () => new Response('<html>gateway error page</html>', { status: 200 }));
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('maps network failure to unavailable with actionable guidance', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toThrow(
      MarketDataError,
    );
    await expect(fetchProviderHistory({ symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
