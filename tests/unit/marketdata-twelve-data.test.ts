import { afterEach, describe, expect, it, vi } from 'vitest';

import { addDays } from '../../src/lib/date';
import {
  YahooProviderError,
} from '../../src/lib/marketdata/yahoo';
import {
  TWELVE_DATA_PROVIDER_ID,
  TWELVE_DATA_MAX_WINDOW_DAYS,
  fetchTwelveDataHistory,
  normaliseTwelveDataSeries,
  twelveDataPageWindows,
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

// ------------------------------------------------------------ long history

/**
 * A session can exist at most once per calendar day, so a window of N calendar
 * days can contain at most N daily sessions. Keeping every window below the
 * provider's per-request ceiling is therefore provable without knowing an
 * instrument's session calendar.
 */
const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function tdValues(dates: string[]): { values: Array<Record<string, string>> } {
  return {
    values: dates.map((date) => ({ datetime: date, open: '1', high: '2', low: '0.5', close: '1.5' })),
  };
}

describe('Twelve Data window planning', () => {
  it('answers a short request with one window and includes the requested end', () => {
    expect(twelveDataPageWindows('2024-02-01', '2024-02-10')).toEqual([
      { start: '2024-02-01', end: '2024-02-11' },
    ]);
  });

  it('splits a long request into adjacent windows that cover it exactly', () => {
    const windows = twelveDataPageWindows('1995-01-01', '2026-10-23');
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]!.start).toBe('1995-01-01');
    // Windows are half-open and adjacent: the next begins where the last ends.
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    }
    // The exclusive last end is one day past the requested end, consistent
    // with the provider's observed exclusive end_date semantics.
    expect(windows[windows.length - 1]!.end).toBe(addDays('2026-10-23', 1));
  });

  it('never plans a window that could exceed the per-request bar ceiling', () => {
    const windows = twelveDataPageWindows('1900-01-01', '2026-10-24');
    for (const window of windows) {
      expect(dayNumber(window.end) - dayNumber(window.start)).toBeLessThanOrEqual(
        TWELVE_DATA_MAX_WINDOW_DAYS * DAY_MS,
      );
    }
  });
});

describe('Twelve Data long-range fetch', () => {
  /** A request that yard-sticks into exactly the number of windows below. */
  const LONG_RANGE = { symbol: 'AAPL', start: '2024-01-01', end: '2036-12-31' };
  const LONG_WINDOWS = twelveDataPageWindows(LONG_RANGE.start, LONG_RANGE.end);

  const YAHOO_THROTTLED = async (url: string | URL | Request): Promise<Response> => {
    throw new Error(`unexpected provider call: ${String(url)}`);
  };

  function tdFetch(responses: Array<(() => Response) | null>): typeof fetch {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const requested = String(url);
      if (!requested.includes('api.twelvedata.com')) return YAHOO_THROTTLED(url);
      const index = calls.length;
      if (index < responses.length) {
        const factory = responses[index];
        if (factory) {
          calls.push(requested);
          return factory();
        }
      }
      throw new Error(`unexpected TD call ${index}: ${requested}`);
    }) as unknown as typeof fetch;
    (fetchImpl as unknown as { calls: string[]; }).calls = calls;
    return fetchImpl;
  }

  it('fetches each window once, sequentially, and merges them ascending without duplicates', async () => {
    const window1 = LONG_WINDOWS[0]!;
    const window2 = LONG_WINDOWS[1]!;
    expect(LONG_WINDOWS).toHaveLength(2);

    // Page 1 also reports a session AT window 1's exclusive end, which an
    // inclusive-end provider would repeat; page 2 reports it again, two
    // sessions beyond page 1's site, plus one session beyond the requested
    // end. The merge must emit that boundary date once and nothing outside.
    const leakedBoundary = window1.end;
    const beyondRequest = addDays(addDays(LONG_RANGE.end, 1), 5);
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start, addDays(leakedBoundary, -1), leakedBoundary])),
      () => jsonResponse({
        // The boundary session is reported again with a different close — the
        // merge must keep the first window's value, and drop the leaked
        // session beyond the requested range entirely.
        values: [
          { datetime: leakedBoundary, open: '1', high: '2', low: '0.5', close: '9.9' },
          { datetime: addDays(window2.end, -1), open: '1', high: '2', low: '0.5', close: '1.5' },
          { datetime: beyondRequest, open: '1', high: '2', low: '0.5', close: '1.5' },
        ],
      }),
    ]);
    const calls = (fetchImpl as unknown as { calls: string[] }).calls;

    const payload = await fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl);

    expect(calls).toHaveLength(2);
    const [firstUrl, secondUrl] = calls.map((url) => new URLSearchParams(url.split('?')[1]));
    expect(firstUrl!.get('start_date')).toBe(window1.start);
    expect(firstUrl!.get('end_date')).toBe(window1.end);
    expect(secondUrl!.get('start_date')).toBe(window2.start);
    expect(secondUrl!.get('end_date')).toBe(window2.end);

    const dates = payload.bars.map((bar) => bar.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates.filter((date) => date === leakedBoundary)).toHaveLength(1);
    // The first window's value is kept for a session the provider reported twice.
    expect(payload.bars.find((bar) => bar.date === leakedBoundary)!.close).toBe(1.5);
    expect(dates).not.toContain(beyondRequest);
    expect(dates[0]).toBe(LONG_RANGE.start);
    expect(dates[dates.length - 1]).toBe(addDays(window2.end, -1));
  });

  it('keeps provider provenance for the whole requested range, not a window', async () => {
    const fetchImpl = tdFetch([
      () => jsonResponse({ ...tdValues([LONG_RANGE.start]), meta: { exchange: 'NASDAQ', currency: 'USD' } }),
      () => jsonResponse({ ...tdValues([LONG_RANGE.end]), meta: { exchange: 'NASDAQ', currency: 'USD' } }),
    ]);

    const payload = await fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl);

    expect(payload.provider.provider).toBe(TWELVE_DATA_PROVIDER_ID);
    expect(payload.provider.rangeRequested).toEqual({ start: LONG_RANGE.start, end: LONG_RANGE.end });
    expect(payload.provider.rangeActual).toEqual({ start: LONG_RANGE.start, end: LONG_RANGE.end });
    expect(payload.provider.adjustment).toContain('splits-applied');
    expect(payload.provider.exchange).toBe('NASDAQ');
    expect(payload.bars.map((bar) => bar.date)).toEqual([LONG_RANGE.start, LONG_RANGE.end]);
  });

  it('skips an empty window in the middle and reports absence only when every window is empty', async () => {
    const TRIPLE = { symbol: 'AAPL', start: '1995-01-01', end: '2026-10-23' };
    const windows = twelveDataPageWindows(TRIPLE.start, TRIPLE.end);
    expect(windows).toHaveLength(3);

    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([TRIPLE.start])),
      () => jsonResponse({ status: 'error', code: '404', message: 'No data for this window.' }),
      () => jsonResponse(tdValues([TRIPLE.end])),
    ]);
    const payload = await fetchTwelveDataHistory(TRIPLE, 'test-key', fetchImpl);
    expect(payload.bars.map((bar) => bar.date)).toEqual([TRIPLE.start, TRIPLE.end]);

    const fetchAllEmpty = tdFetch([
      () => jsonResponse({ status: 'error', code: '404', message: 'No data for this window.' }),
      () => jsonResponse({ status: 'error', code: '404', message: 'No data for this window.' }),
      () => jsonResponse({ status: 'error', code: '404', message: 'No data for this window.' }),
    ]);
    await expect(fetchTwelveDataHistory(TRIPLE, 'test-key', fetchAllEmpty)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('No data found'),
    });
  });

  it('allows an HTTP-level empty-window 404 the same as an envelope one', async () => {
    const windows = LONG_WINDOWS;
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start])),
      () => new Response(JSON.stringify({ status: 'error', code: 404 }), { status: 404 }),
    ]);

    const payload = await fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl);

    // Only window 1's sessions exist; window 2 was empty and the download still
    // succeeded.
    expect(payload.bars).toHaveLength(1);
    expect(payload.bars[0]!.date).toBe(LONG_RANGE.start);
    for (const window of [windows[1]]) {
      for (const bar of payload.bars) {
        expect(dayNumber(bar.date)).toBeLessThan(dayNumber(window!.start));
      }
    }
  });

  it('aborts the whole download without inventing pages when a window is malformed', async () => {
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start])),
      () => jsonResponse({ status: 'ok', meta: {}, values: ['not-an-object'] }),
      () => jsonResponse({ status: 'ok', meta: {}, values: ['not-an-object'] }),
    ]);

    await expect(
      fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('non-object time-series row'),
    });
  });

  it('retries a transient window failure once and succeeds, charging that attempt too', async () => {
    const spends: boolean[] = [];
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start])),
      () => new Response('boom', { status: 500 }),
      () => jsonResponse(tdValues([LONG_WINDOWS[0]!.end])),
    ]);
    const calls = (fetchImpl as unknown as { calls: string[] }).calls;

    const payload = await fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl, {
      spendFallbackCredit: () => (spends.push(true), true),
    });
    // Window 1 succeeded on its first attempt; window 2 needed both attempts.
    expect(calls).toHaveLength(3);
    const urls = calls.map((url) => new URLSearchParams(url.split('?')[1]));
    expect(urls[0]!.get('start_date')).toBe(LONG_WINDOWS[0]!.start);
    expect(urls[1]!.get('start_date')).toBe(LONG_WINDOWS[1]!.start);
    expect(urls[2]!.get('start_date')).toBe(LONG_WINDOWS[1]!.start);
    expect(spends).toEqual([true, true, true]);
    expect(payload.bars.map((bar) => bar.date)).toEqual([LONG_RANGE.start, LONG_WINDOWS[0]!.end]);
  });

  it('fails the whole download when a window exhausts its retry budget', async () => {
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start])),
      () => new Response('boom', { status: 500 }),
      () => new Response('boom', { status: 500 }),
    ]);

    await expect(
      fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('never retries throttling', async () => {
    const fetchImpl = tdFetch([
      () => jsonResponse(tdValues([LONG_RANGE.start])),
      () => new Response('slow down', { status: 429 }),
    ]);

    await expect(
      fetchTwelveDataHistory(LONG_RANGE, 'test-key', fetchImpl),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('throttling'),
    });
  });

  it('charges one credit per window for a successful multi-window fallback', async () => {
    let spends = 0;
    let tdCalls = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const requested = String(url);
      if (requested.includes('finance.yahoo.com')) return jsonResponse({ detail: 'slow down' }, 429);
      tdCalls += 1;
      return jsonResponse(tdValues([LONG_RANGE.start, LONG_WINDOWS[0]!.end, LONG_RANGE.end]));
    }) as unknown as typeof fetch;

    const payload = await fetchHostedHistory(LONG_RANGE, {
      twelveDataApiKey: 'test-key',
      fetchImpl,
      spendFallbackCredit: () => {
        spends += 1;
        return true;
      },
    });

    expect(payload.bars.map((bar) => bar.date)).toEqual([LONG_RANGE.start, LONG_WINDOWS[0]!.end, LONG_RANGE.end]);
    expect(tdCalls).toBe(2);
    expect(spends).toBe(2);
  });

  it('aborts mid-range with the combined budget message when the budget refuses', async () => {
    // A three-window range: two pages are retrieved, the third attempt is
    // refused before any provider contact. Windows that succeeded keep
    // nothing — the caller gets a failure, never a partial history that
    // pretends to be complete.
    const TRIPLE = { symbol: 'AAPL', start: '1995-01-01', end: '2026-10-23' };
    expect(twelveDataPageWindows(TRIPLE.start, TRIPLE.end)).toHaveLength(3);
    let tdCalls = 0;
    let takeCalls = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const requested = String(url);
      if (requested.includes('finance.yahoo.com')) return jsonResponse({ detail: 'slow down' }, 429);
      tdCalls += 1;
      return jsonResponse(tdValues([TRIPLE.start, TRIPLE.end]));
    }) as unknown as typeof fetch;

    const failure = await fetchHostedHistory(TRIPLE, {
      twelveDataApiKey: 'test-key',
      fetchImpl,
      spendFallbackCredit: () => {
        takeCalls += 1;
        return takeCalls <= 2;
      },
    }).then(() => null).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YahooProviderError);
    expect((failure as Error).message).toContain('Yahoo Finance: Yahoo is throttling requests');
    expect((failure as Error).message).toContain('fallback budget for Twelve Data is spent');
    expect(tdCalls).toBe(2);
    // The refused third attempt asked the budget before contacting the provider.
    expect(takeCalls).toBe(3);
  });
});
