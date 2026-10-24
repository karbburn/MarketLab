import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BUDGET_KEY,
  FALLBACK_BUDGET_WINDOWS,
  clientKeyFromRequest,
  createQuotaGuard,
  tooManyRequests,
} from '../../src/lib/marketdata/quota';
import { fetchHostedHistory } from '../../src/lib/marketdata/hosted';
import historyHandler from '../../api/market-data/history';

/**
 * Deterministic tests for the hosted quota guard. No test touches the
 * network: clocks are injected and every fetch is a stub.
 */

describe('fixed-window quota guard', () => {
  it('allows the first request and reports retry-after 0', () => {
    const now = 1_000_000;
    const guard = createQuotaGuard(() => now);
    expect(guard.tryTake('k', [{ limit: 3, windowMs: 60_000 }])).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('denies once the limit is reached and reports the remaining seconds', () => {
    let now = 1_000_000;
    const guard = createQuotaGuard(() => now);
    expect(guard.tryTake('k', [{ limit: 2, windowMs: 60_000 }]).allowed).toBe(true);
    expect(guard.tryTake('k', [{ limit: 2, windowMs: 60_000 }]).allowed).toBe(true);
    const denied = guard.tryTake('k', [{ limit: 2, windowMs: 60_000 }]);
    expect(denied.allowed).toBe(false);
    // Window started at t=1_000_000; at t=1_000_000 the remaining time to the
    // window edge at 1_060_000 is 60_000 ms => 60 s.
    expect(denied.retryAfterSeconds).toBe(60);
    now += 60_001;
    expect(guard.tryTake('k', [{ limit: 2, windowMs: 60_000 }]).allowed).toBe(true);
  });

  it('keeps keys independent and is all-or-nothing across windows', () => {
    let now = 0;
    const guard = createQuotaGuard(() => now);
    // Minute limit 1 (60 s), long limit 4 (600 s). The distinguishing probe:
    // after two minute-denials, the next minute-expiry take is allowed ONLY
    // because refusals charge nothing to the long window (a charged variant
    // would already be full: 2 refusals + 2 allowances = 4).
    const windows = [
      { limit: 1, windowMs: 60_000 },
      { limit: 4, windowMs: 600_000 },
    ];
    expect(guard.tryTake('k', windows).allowed).toBe(true); // t=0: m1, l1
    expect(guard.tryTake('k', windows).allowed).toBe(false); // t=0: minute full
    now += 60_001; // t=60_001: minute resets
    expect(guard.tryTake('k', windows).allowed).toBe(true); // m1; l2
    expect(guard.tryTake('k', windows).allowed).toBe(false); // minute full again
    now += 60_001; // t=120_002: minute resets, long window (t=0) NOT expired (120_002 < 600_000)
    // Allowed only because both refusals above charged the long window zero.
    expect(guard.tryTake('k', windows).allowed).toBe(true); // m1; l3
    expect(guard.tryTake('k', windows).allowed).toBe(false);
    now += 60_001; // t=180_003
    expect(guard.tryTake('k', windows).allowed).toBe(true); // l4
    expect(guard.tryTake('k', windows).allowed).toBe(false);
    now += 60_001; // t=240_004: minute expired, long (l4) full and not expired
    expect(guard.tryTake('k', windows).allowed).toBe(false); // exactly 4 allowances filled it
    now += 359_997; // t=600_001: long window expires
    expect(guard.tryTake('k', windows).allowed).toBe(true); // both reset
    // A different key never saw any of it.
    expect(guard.tryTake('other', windows).allowed).toBe(true);
  });

  it('takes the tightest binding window for retry-after when several are full', () => {
    const now = 0;
    const guard = createQuotaGuard(() => now);
    const windows = [
      { limit: 1, windowMs: 10_000 },
      { limit: 1, windowMs: 600_000 },
    ];
    guard.tryTake('k', windows);
    const denied = guard.tryTake('k', windows);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(600);
  });

  it('empty window list always allows', () => {
    const guard = createQuotaGuard(() => 0);
    expect(guard.tryTake('k', [])).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('the fallback budget specs own two windows on one key', () => {
    const now = 0;
    const guard = createQuotaGuard(() => now);
    for (let index = 0; index < FALLBACK_BUDGET_WINDOWS[0]!.limit; index += 1) {
      expect(guard.tryTake(FALLBACK_BUDGET_KEY, FALLBACK_BUDGET_WINDOWS).allowed).toBe(true);
    }
    const denied = guard.tryTake(FALLBACK_BUDGET_KEY, FALLBACK_BUDGET_WINDOWS);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(300);
  });
});

describe('client identity', () => {
  it('prefers the platform-provided IP, then the first forwarded hop, else one shared key', () => {
    expect(clientKeyFromRequest(new Request('https://x/', { headers: { 'x-vercel-forwarded-for-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }), 'history')).toBe('history:1.2.3.4');
    expect(clientKeyFromRequest(new Request('https://x/', { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }), 'search')).toBe('search:9.9.9.9');
    expect(clientKeyFromRequest(new Request('https://x/'), 'history')).toBe('history:unidentified');
  });
});

describe('tooManyRequests response shape', () => {
  it('returns 429 with Retry-After and a detail', async () => {
    const response = tooManyRequests('Slow down.', 45);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ detail: 'Slow down.' });
  });
});

describe('hosted fallback budget enforcement', () => {
  const TD_PAYLOAD = {
    status: 'ok',
    meta: { exchange: 'NASDAQ', currency: 'USD' },
    values: [{ datetime: '2024-02-08', open: '1', high: '2', low: '0.5', close: '1.5', volume: '100' }],
  };

  it('refuses the fallback without spending a credit when the budget is out', async () => {
    let tdCalls = 0;
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const tdFetch = (async (_input: string | URL | Request) => {
      tdCalls += 1;
      return new Response(JSON.stringify(TD_PAYLOAD), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      fetchHostedHistory(
        { symbol: 'BRK.B', start: '2024-02-01', end: '2024-02-10' },
        {
          twelveDataApiKey: 'key',
          fetchImpl: (url) => (String(url).includes('twelvedata') ? tdFetch(url) : (fetchImpl(url) as Promise<Response>)),
          spendFallbackCredit: () => false,
        },
      ),
    ).rejects.toMatchObject({ status: 502 });

    // The refusal message names both the Yahoo failure and the budget, and the
    // Twelve Data endpoint was never contacted.
    const message = await fetchHostedHistory(
      { symbol: 'BRK.B', start: '2024-02-01', end: '2024-02-10' },
      {
        twelveDataApiKey: 'key',
        fetchImpl: (url) => (String(url).includes('twelvedata') ? tdFetch(url) : (fetchImpl(url) as Promise<Response>)),
        spendFallbackCredit: () => false,
      },
    ).catch((error: unknown) => (error as Error).message);
    expect(message).toContain('fallback budget for Twelve Data is spent');
    expect(message).toContain('Yahoo Finance');
    expect(tdCalls).toBe(0);
  });

  it('allows and charges the fallback when the budget is available', async () => {
    let yahooCalls = 0;
    let tdCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('twelvedata')) {
        tdCalls += 1;
        return new Response(JSON.stringify(TD_PAYLOAD), { status: 200 });
      }
      yahooCalls += 1;
      return new Response('throttled', { status: 429 });
    }) as unknown as typeof fetch;

    const payload = await fetchHostedHistory(
      { symbol: 'BRK.B', start: '2024-02-01', end: '2024-02-10' },
      { twelveDataApiKey: 'key', fetchImpl, spendFallbackCredit: () => true },
    );
    expect(payload.bars).toHaveLength(1);
    expect(payload.provider.provider).toBe('twelve-data');
    // Two Yahoo hosts were tried, then exactly one TD call was charged.
    expect(yahooCalls).toBe(2);
    expect(tdCalls).toBe(1);
  });
});

describe('history handler per-address limit', () => {
  it('answers 429 with Retry-After after the per-IP history limit', async () => {
    // Valid-but-empty route is irrelevant: the limit is taken before parsing,
    // so an invalid start date keeps every request off the network and cheap.
    let response = null as null | Response;
    for (let index = 0; index < 61; index += 1) {
      response = await historyHandler(
        new Request('https://example.test/api/market-data/history?symbol=AAPL&start=not-a-date'),
      );
      if (index < 59) {
        expect([400, 429]).toContain(response.status);
      }
    }
    expect(response!.status).toBe(429);
    expect(Number(response!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(response!.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    await expect(response!.json()).resolves.toMatchObject({ detail: expect.any(String) });
  });
});
