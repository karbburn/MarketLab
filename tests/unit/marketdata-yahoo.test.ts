import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HOSTED_SERVICE_URL,
  LOCAL_SERVICE_URL,
  fetchProviderHistory,
  marketDataServiceDescription,
  marketDataUnavailableMessage,
  resolveMarketDataServiceUrl,
} from '../../src/lib/marketdata/client';
import {
  YahooProviderError,
  fetchYahooHistory,
  fetchYahooSearch,
  normaliseYahooChart,
  normaliseYahooSearch,
  parseHistoryQuery,
  parseSearchQuery,
  sessionDate,
  yahooChartUrl,
  yahooSearchUrl,
} from '../../src/lib/marketdata/yahoo';
import historyHandler from '../../api/market-data/history';
import searchHandler from '../../api/market-data/search';
import healthHandler from '../../api/market-data/health';

/**
 * Deterministic tests for the hosted Yahoo adapter. No test touches the
 * network: responses are synthetic and the only fetch calls are stubbed.
 */

const TIMESTAMP_1 = 1_707_402_600; // 2024-02-08 14:30 UTC
const TIMESTAMP_2 = 1_707_489_000; // 2024-02-09 14:30 UTC
const SPLIT_TIMESTAMP = 1_598_880_600; // 2020-08-31 13:30 UTC

const CHART_PAYLOAD = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'AAPL',
          exchangeName: 'NMS',
          fullExchangeName: 'NasdaqGS',
          instrumentType: 'EQUITY',
          exchangeTimezoneName: 'America/New_York',
          shortName: 'Apple Inc.',
          longName: 'Apple Inc.',
        },
        timestamp: [TIMESTAMP_1, TIMESTAMP_2],
        indicators: {
          quote: [
            {
              open: [10, 11],
              high: [12, 13],
              low: [9, 10],
              close: [11.5, 12.5],
              volume: [1_200.4, 1_500.6],
            },
          ],
          adjclose: [{ adjclose: [11.4, 12.4] }],
        },
        events: {
          dividends: {
            [String(TIMESTAMP_2)]: { amount: 0.24, date: TIMESTAMP_2 },
          },
          splits: {
            [String(SPLIT_TIMESTAMP)]: {
              date: SPLIT_TIMESTAMP,
              numerator: 4,
              denominator: 1,
              splitRatio: '4:1',
            },
          },
        },
      },
    ],
    error: null,
  },
};

const SEARCH_PAYLOAD = {
  quotes: [
    {
      symbol: 'AAPL',
      longname: 'Apple Inc.',
      exchange: 'NMS',
      exchDisp: 'NASDAQ',
      typeDisp: 'Equity',
      sector: 'Technology',
      industry: 'Consumer Electronics',
    },
    {
      symbol: 'AAPL.MX',
      shortname: 'Apple in Mexico',
      exchange: 'MEX',
      quoteType: 'EQUITY',
    },
    { shortname: 'No symbol row' },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('service URL resolution', () => {
  it('uses the local service on loopback hostnames', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'app.localhost', '0.0.0.0']) {
      expect(resolveMarketDataServiceUrl({ hostname, configuredUrl: '' })).toBe(LOCAL_SERVICE_URL);
    }
  });

  it('uses the same-origin hosted proxy on deployed hostnames', () => {
    for (const hostname of ['marketlab.sourabhpradhan.in', 'marketlab.vercel.app', '192.168.1.20']) {
      expect(resolveMarketDataServiceUrl({ hostname, configuredUrl: '' })).toBe(HOSTED_SERVICE_URL);
    }
  });

  it('honours an explicit configured URL and trims trailing slashes', () => {
    expect(
      resolveMarketDataServiceUrl({
        hostname: 'marketlab.sourabhpradhan.in',
        configuredUrl: 'https://data.example.test/base/',
      }),
    ).toBe('https://data.example.test/base');
  });

  it('describes local and hosted modes without telling deployed users to start localhost', () => {
    expect(marketDataServiceDescription(LOCAL_SERVICE_URL)).toContain('local market-data service');
    expect(marketDataServiceDescription(HOSTED_SERVICE_URL)).toContain('hosted');
    expect(marketDataUnavailableMessage(LOCAL_SERVICE_URL)).toContain('uvicorn');
    expect(marketDataUnavailableMessage(HOSTED_SERVICE_URL)).not.toContain('uvicorn');
    expect(marketDataUnavailableMessage(HOSTED_SERVICE_URL)).toContain('hosted market-data service');
  });
});

describe('request parsing', () => {
  it('accepts one-character tickers such as F', () => {
    expect(parseHistoryQuery(new URLSearchParams({ symbol: 'F' }))).toMatchObject({ symbol: 'F' });
  });

  it('defaults an omitted range to five years through today', () => {
    const parsed = parseHistoryQuery(
      new URLSearchParams({ symbol: 'AAPL' }),
      new Date('2024-01-10T00:00:00Z'),
    );
    expect(parsed.end).toBe('2024-01-10');
    expect(parsed.start).toBe('2019-01-11');
  });

  it('rejects malformed dates and reversed ranges before any fetch', () => {
    expect(() => parseHistoryQuery(new URLSearchParams({ symbol: 'AAPL', start: '01/02/2024' })))
      .toThrow(YahooProviderError);
    expect(() => parseHistoryQuery(new URLSearchParams({ symbol: 'AAPL', end: '2024-13-01' })))
      .toThrow(YahooProviderError);
    expect(() => parseHistoryQuery(new URLSearchParams({ symbol: 'AAPL', start: '2024-05-01', end: '2024-01-01' })))
      .toThrow(YahooProviderError);
    expect(() => parseHistoryQuery(new URLSearchParams({ symbol: 'A APL' })))
      .toThrow(YahooProviderError);
  });

  it('validates search query length and result limit', () => {
    expect(parseSearchQuery(new URLSearchParams({ q: 'apple' }))).toEqual({ query: 'apple', limit: 10 });
    expect(() => parseSearchQuery(new URLSearchParams({ q: 'a' }))).toThrow(YahooProviderError);
    expect(() => parseSearchQuery(new URLSearchParams({ q: 'apple', limit: '0' }))).toThrow(YahooProviderError);
    expect(() => parseSearchQuery(new URLSearchParams({ q: 'apple', limit: '21' }))).toThrow(YahooProviderError);
  });
});

describe('Yahoo URLs', () => {
  it('makes the public end date inclusive for the provider', () => {
    const url = yahooChartUrl('AAPL', '2024-01-01', '2024-01-02');
    expect(url).toContain('/v8/finance/chart/AAPL?');
    expect(url).toContain('period1=1704067200');
    expect(url).toContain('period2=1704240000');
    expect(url).toContain('interval=1d');
    expect(url).toContain('events=div%2Csplits');
    expect(url).toContain('includeAdjustedClose=true');
  });

  it('encodes symbols and search text', () => {
    expect(yahooChartUrl('^GSPC', '2024-01-01', '2024-01-02')).toContain('%5EGSPC');
    expect(yahooSearchUrl('S&P 500', 8)).toContain('q=S%26P%20500');
  });
});

describe('normaliseYahooChart', () => {
  const request = { symbol: 'AAPL', start: '2024-02-01', end: '2024-02-10' };

  it('maps daily bars, provenance and in-range corporate actions', () => {
    const payload = normaliseYahooChart(CHART_PAYLOAD, request, '2026-10-24T12:00:00Z');
    expect(payload.provider).toMatchObject({
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
      retrievedAt: '2026-10-24T12:00:00Z',
      rangeRequested: { start: '2024-02-01', end: '2024-02-10' },
      rangeActual: { start: '2024-02-08', end: '2024-02-09' },
    });
    expect(payload.bars).toEqual([
      { date: '2024-02-08', open: 10, high: 12, low: 9, close: 11.5, adjClose: 11.4, volume: 1200 },
      { date: '2024-02-09', open: 11, high: 13, low: 10, close: 12.5, adjClose: 12.4, volume: 1501 },
    ]);
    // The 2020 split is outside the requested range and is not attached to it.
    expect(payload.provider.corporateActions).toEqual([
      { date: '2024-02-09', type: 'dividend', value: 0.24 },
    ]);
  });

  it('preserves null volume and adjusted close instead of inventing values', () => {
    const payload = normaliseYahooChart(
      {
        chart: {
          result: [
            {
              meta: { exchangeTimezoneName: 'America/New_York' },
              timestamp: [TIMESTAMP_1],
              indicators: {
                quote: [{ open: [1], high: [2], low: [0.5], close: [1.5] }],
              },
            },
          ],
        },
      },
      request,
    );
    expect(payload.bars[0]).toMatchObject({ adjClose: null, volume: null });
  });

  it('maps a provider error envelope to an explicit status', () => {
    expect(() =>
      normaliseYahooChart(
        { chart: { result: null, error: { code: 'Not Found', description: 'Quote not found' } } },
        request,
      ),
    ).toThrowError(expect.objectContaining({ status: 404 }));

    expect(() =>
      normaliseYahooChart(
        { chart: { result: null, error: { code: 'Too Many Requests', description: 'Rate limited' } } },
        request,
      ),
    ).toThrowError(expect.objectContaining({ status: 429 }));
  });

  it('treats an empty result as no data, not as a successful empty series', () => {
    expect(() => normaliseYahooChart({ chart: { result: [] } }, request))
      .toThrowError(expect.objectContaining({ status: 404 }));
    expect(() =>
      normaliseYahooChart({ chart: { result: [{ meta: {}, timestamp: [] }] } }, request),
    ).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('rejects a malformed chart instead of returning partial bars', () => {
    expect(() =>
      normaliseYahooChart(
        { chart: { result: [{ timestamp: [TIMESTAMP_1], indicators: {} }] } },
        request,
      ),
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });
});

describe('session dates and search', () => {
  it('formats timestamps in the exchange timezone', () => {
    expect(sessionDate(TIMESTAMP_2, 'America/New_York')).toBe('2024-02-09');
    expect(sessionDate(1_704_067_200, 'America/New_York')).toBe('2023-12-31');
    expect(sessionDate(TIMESTAMP_2, null)).toBe('2024-02-09');
  });

  it('normalises Yahoo search rows and skips rows without a symbol', () => {
    const payload = normaliseYahooSearch(SEARCH_PAYLOAD, 'apple', 8);
    expect(payload.provider).toBe('yahoo-finance');
    expect(payload.results).toEqual([
      {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NMS',
        exchangeName: 'NASDAQ',
        type: 'Equity',
        sector: 'Technology',
        industry: 'Consumer Electronics',
      },
      {
        symbol: 'AAPL.MX',
        name: 'Apple in Mexico',
        exchange: 'MEX',
        exchangeName: 'MEX',
        type: 'EQUITY',
        sector: null,
        industry: null,
      },
    ]);
  });
});

describe('fetchYahooHistory', () => {
  const request = { symbol: 'AAPL', start: '2024-02-01', end: '2024-02-10' };

  it('retries the alternate Yahoo host after a throttling response', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? jsonResponse({ detail: 'slow down' }, 429)
        : jsonResponse(CHART_PAYLOAD);
    });

    const payload = await fetchYahooHistory(request);
    expect(payload.bars).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('query1.finance.yahoo.com');
    expect(calls[1]).toContain('query2.finance.yahoo.com');
  });

  it('does not retry a definitive 404', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return jsonResponse({ detail: 'not found' }, 404);
    });

    await expect(fetchYahooHistory(request)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });
});

describe('fetchYahooSearch', () => {
  it('normalises a successful search response', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(SEARCH_PAYLOAD));
    const payload = await fetchYahooSearch({ query: 'apple', limit: 8 });
    expect(payload.results).toHaveLength(2);
  });
});

describe('hosted edge handlers', () => {
  it('serves health with the same contract as the local service', async () => {
    const response = healthHandler(new Request('https://example.test/api/market-data/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: 'marketlab-market-data',
      provider: 'yahoo-finance',
    });
  });

  it('serves history through the same-origin path', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(CHART_PAYLOAD));
    const response = await historyHandler(
      new Request('https://example.test/api/market-data/history?symbol=AAPL&start=2024-02-01&end=2024-02-10'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('s-maxage=600');
    await expect(response.json()).resolves.toMatchObject({
      provider: { providerSymbol: 'AAPL' },
      bars: [{ date: '2024-02-08' }, { date: '2024-02-09' }],
    });
  });

  it('rejects an invalid query with 400 and no provider call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await historyHandler(
      new Request('https://example.test/api/market-data/history?symbol=AAPL&start=not-a-date'),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves search and rejects non-GET methods', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(SEARCH_PAYLOAD));
    const response = await searchHandler(
      new Request('https://example.test/api/market-data/search?q=apple&limit=8'),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ provider: 'yahoo-finance' });

    const rejected = await searchHandler(
      new Request('https://example.test/api/market-data/search?q=apple', { method: 'POST' }),
    );
    expect(rejected.status).toBe(405);
  });
});

describe('client hosted-path failure copy', () => {
  it('does not tell a deployed user to start localhost', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      fetchProviderHistory(
        { symbol: 'AAPL', start: '2024-01-01', end: '2024-02-01' },
        HOSTED_SERVICE_URL,
      ),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('hosted market-data service'),
    });
  });
});
