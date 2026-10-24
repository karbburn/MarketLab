import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  YahooProviderError,
} from '../../src/lib/marketdata/yahoo';
import {
  TWELVE_DATA_PROVIDER_ID,
  fetchTwelveDataHistory,
  normaliseTwelveDataSeries,
  twelveDataTimeSeriesUrl,
} from '../../src/lib/marketdata/twelvedata';
import {
  fetchHostedHistory,
  isTwelveDataFallbackEligible,
  twelveDataApiKeyFromEnv,
} from '../../src/lib/marketdata/hosted';

/**
 * Deterministic tests for the optional Twelve Data fallback. The network is
 * never touched: every provider response is synthetic and every fetch is
 * stubbed. These tests also assert that the key stays out of the URL and that
 * the fallback is dormant when no key is configured.
 */

const REQUEST = { symbol: 'AAPL', start: '2024-02-01', end: '2024-02-10' };

const YAHOO_CHART_PAYLOAD = {
  chart: {
    result: [
      {
        meta: { symbol: 'AAPL', exchangeTimezoneName: 'America/New_York' },
        timestamp: [1_707_402_600],
        indicators: {
          quote: [{ open: [10], high: [12], low: [9], close: [11.5], volume: [1_200] }],
        },
      },
    ],
    error: null,
  },
};

const TWELVE_DATA_PAYLOAD = {
  meta: {
    symbol: 'AAPL',
    interval: '1day',
    currency: 'USD',
    exchange_timezone: 'America/New_York',
    exchange: 'NASDAQ',
    mic_code: 'XNAS',
    type: 'Common Stock',
  },
  values: [
    {
      datetime: '2024-02-09',
      open: '11',
      high: '13',
      low: '10',
      close: '12.5',
      volume: '1500.6',
    },
    {
      datetime: '2024-02-08',
      open: '10',
      high: '12',
      low: '9',
      close: '11.5',
      volume: '1200',
    },
  ],
  status: 'ok',
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

describe('Twelve Data request shape', () => {
  it('requests daily split-adjusted bars without putting the key in the URL', () => {
    const url = twelveDataTimeSeriesUrl('AAPL', '2024-02-01', '2024-02-10');
    expect(url).toContain('https://api.twelvedata.com/time_series?');
    expect(url).toContain('symbol=AAPL');
    expect(url).toContain('interval=1day');
    expect(url).toContain('start_date=2024-02-01');
    expect(url).toContain('end_date=2024-02-10');
    expect(url).toContain('adjust=splits');
    expect(url).toContain('outputsize=5000');
    expect(url).not.toContain('apikey');
  });

  it('sends the key only in the Authorization header', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return jsonResponse(TWELVE_DATA_PAYLOAD);
    });

    const payload = await fetchTwelveDataHistory(REQUEST, 'test-key');
    expect(payload.provider.provider).toBe(TWELVE_DATA_PROVIDER_ID);
    expect(captured).not.toBeNull();
    expect(captured!.url).not.toContain('test-key');
    expect(captured!.init?.headers).toMatchObject({ Authorization: 'apikey test-key' });
  });
});

describe('normaliseTwelveDataSeries', () => {
  it('maps string OHLCV, provenance and ascending session order', () => {
    const payload = normaliseTwelveDataSeries(
      TWELVE_DATA_PAYLOAD,
      REQUEST,
      '2026-10-24T12:00:00Z',
    );

    expect(payload.provider).toMatchObject({
      provider: 'twelve-data',
      providerSymbol: 'AAPL',
      displaySymbol: 'AAPL',
      displayName: null,
      exchange: 'XNAS',
      exchangeName: 'NASDAQ',
      instrumentType: 'Common Stock',
      currency: 'USD',
      timezone: 'America/New_York',
      interval: '1d',
      retrievedAt: '2026-10-24T12:00:00Z',
      rangeRequested: { start: '2024-02-01', end: '2024-02-10' },
      rangeActual: { start: '2024-02-08', end: '2024-02-09' },
      corporateActions: [],
    });
    expect(payload.bars).toEqual([
      { date: '2024-02-08', open: 10, high: 12, low: 9, close: 11.5, adjClose: null, volume: 1200 },
      { date: '2024-02-09', open: 11, high: 13, low: 10, close: 12.5, adjClose: null, volume: 1501 },
    ]);
    expect(payload.provider.sourceNotes.join(' ')).toContain('does not include corporate-action events');
  });

  it('preserves missing values instead of inventing them', () => {
    const payload = normaliseTwelveDataSeries(
      {
        meta: {},
        values: [{ datetime: '2024-02-08', open: null, high: '2', low: '0.5', close: '1.5' }],
        status: 'ok',
      },
      REQUEST,
    );
    expect(payload.bars[0]).toMatchObject({ open: null, adjClose: null, volume: null });
  });

  it('maps an error envelope to an explicit status', () => {
    expect(() =>
      normaliseTwelveDataSeries(
        { status: 'error', code: 404, message: 'symbol not found' },
        REQUEST,
      ),
    ).toThrowError(expect.objectContaining({ status: 404 }));

    expect(() =>
      normaliseTwelveDataSeries(
        { status: 'error', code: 429, message: 'rate limit' },
        REQUEST,
      ),
    ).toThrowError(expect.objectContaining({ status: 429 }));
  });

  it('treats an empty values array as no data, not as a successful empty series', () => {
    expect(() =>
      normaliseTwelveDataSeries({ meta: {}, values: [], status: 'ok' }, REQUEST),
    ).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('rejects an invalid session date rather than shifting it', () => {
    expect(() =>
      normaliseTwelveDataSeries(
        { meta: {}, values: [{ datetime: '2024-02-31', open: '1', high: '2', low: '1', close: '2' }], status: 'ok' },
        REQUEST,
      ),
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });
});

describe('hosted fallback policy', () => {
  it('falls back to Twelve Data only after Yahoo fails and a key is configured', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('finance.yahoo.com')) return jsonResponse({ detail: 'slow down' }, 429);
      return jsonResponse(TWELVE_DATA_PAYLOAD);
    });

    const payload = await fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' });

    expect(payload.provider.provider).toBe('twelve-data');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain('query1.finance.yahoo.com');
    expect(calls[1]!.url).toContain('query2.finance.yahoo.com');
    expect(calls[2]!.url).toContain('api.twelvedata.com');
    expect(calls[2]!.init?.headers).toMatchObject({ Authorization: 'apikey test-key' });
  });

  it('stays dormant when no key is configured', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return jsonResponse({ detail: 'slow down' }, 429);
    });

    await expect(fetchHostedHistory(REQUEST)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.includes('finance.yahoo.com'))).toBe(true);
  });

  it('does not treat invalid caller input as a fallback opportunity', () => {
    expect(isTwelveDataFallbackEligible(new YahooProviderError(400, 'bad symbol'))).toBe(false);
    expect(isTwelveDataFallbackEligible(new YahooProviderError(429, 'throttled'))).toBe(true);
    expect(isTwelveDataFallbackEligible(new YahooProviderError(404, 'not found'))).toBe(true);
    // A request the primary provider says it cannot serve is reported to the
    // caller as "no data" but must not spend a paid credit.
    expect(
      isTwelveDataFallbackEligible(
        new YahooProviderError(404, 'unserviceable window', { fallbackEligible: false }),
      ),
    ).toBe(false);
  });

  it('does not spend a paid credit when Yahoo says the window is unserviceable', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return new Response('', { status: 400 });
    });

    await expect(
      fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('HTTP 400'),
    });

    expect(calls).toHaveLength(1);
    expect(calls.every((url) => url.includes('finance.yahoo.com'))).toBe(true);
  });

  it('retries the free alternate host before falling back to Twelve Data', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('query1.finance.yahoo.com')) {
        // A provider-level error carried by a 200 response used to end the
        // free path immediately and hand the request to the paid provider.
        return jsonResponse({ chart: { result: null, error: { code: '429', description: 'Too Many Requests' } } });
      }
      if (url.includes('query2.finance.yahoo.com')) return jsonResponse(YAHOO_CHART_PAYLOAD);
      return jsonResponse(TWELVE_DATA_PAYLOAD);
    });

    const payload = await fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' });

    expect(payload.provider.provider).toBe('yahoo-finance');
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.includes('api.twelvedata.com'))).toBe(false);
  });

  it('does not call a mixed throttle and key rejection "throttling"', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('finance.yahoo.com')) return jsonResponse({ detail: 'slow down' }, 429);
      return jsonResponse({ status: 'error', code: 401, message: 'apikey is invalid' });
    });

    const failure = await fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YahooProviderError);
    expect((failure as YahooProviderError).status).toBe(502);
    expect((failure as YahooProviderError).message).not.toContain('Both market-data providers are throttling');
    expect((failure as YahooProviderError).message).toContain('Twelve Data rejected the server API key');
  });

  it('does not call a timeout plus a missing series "both timed out"', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('finance.yahoo.com')) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return jsonResponse({ status: 'error', code: 404, message: 'symbol not found' });
    });

    const failure = await fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' })
      .then(() => null)
      .catch((error: unknown) => error);

    expect((failure as YahooProviderError).status).toBe(502);
    expect((failure as YahooProviderError).message).toContain('Both market-data providers failed');
    expect((failure as YahooProviderError).message).not.toContain('Both market-data providers timed out');
  });

  it('never repeats the API key in a combined failure message', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('finance.yahoo.com')) return jsonResponse({ detail: 'not found' }, 404);
      return jsonResponse({ status: 'error', code: 429, message: 'apikey test-key has run out of credits' });
    });

    const failure = await fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' })
      .then(() => null)
      .catch((error: unknown) => error);

    expect((failure as YahooProviderError).message).not.toContain('test-key');
  });

  it('reports both failures when neither provider has the series', async () => {
    vi.stubGlobal('fetch', async (url: string) => (
      url.includes('finance.yahoo.com')
        ? jsonResponse({ detail: 'not found' }, 404)
        : jsonResponse({ status: 'error', code: 404, message: 'symbol not found' })
    ));

    await expect(
      fetchHostedHistory(REQUEST, { twelveDataApiKey: 'test-key' }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('either Yahoo Finance or Twelve Data'),
    });
  });

  it('reads a trimmed key from the server environment and treats a blank key as absent', () => {
    const env = (globalThis as unknown as {
      process: { env: Record<string, string | undefined> };
    }).process.env;
    const previous = env.TWELVE_DATA_API_KEY;
    try {
      env.TWELVE_DATA_API_KEY = '  secret  ';
      expect(twelveDataApiKeyFromEnv()).toBe('secret');
      env.TWELVE_DATA_API_KEY = '   ';
      expect(twelveDataApiKeyFromEnv()).toBeNull();
    } finally {
      if (previous === undefined) delete env.TWELVE_DATA_API_KEY;
      else env.TWELVE_DATA_API_KEY = previous;
    }
  });
});
