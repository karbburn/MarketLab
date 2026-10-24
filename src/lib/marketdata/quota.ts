/**
 * Best-effort request and credit guards for the hosted market-data handlers.
 *
 * Purpose and limits, stated honestly:
 * - The public endpoints proxy third-party providers from an unauthenticated
 *   origin. A flood of cache-miss requests pushes quota onto Yahoo, and when
 *   Yahoo throttles it pushes paid credits onto the configured Twelve Data
 *   key. This module bounds that consumption.
 * - The guard is a fixed-window counter held in module state. A warm edge
 *   isolate serves many requests through the same instance, so the window is
 *   shared by the requests that isolate handles; cold starts and additional
 *   isolates each get a fresh allowance. That is enough to bound accidental
 *   load and most scripted abuse. It is NOT a distributed rate limiter:
 *   platform-level rules (Vercel WAF / rate limiting) remain the hard control
 *   for sustained, multi-source abuse, which also needs infrastructure the
 *   project deliberately avoids.
 * - The fallback budget is global (not per IP) because the resource it
 *   protects - the Twelve Data key - is shared by every caller. It is spent
 *   at the moment of the provider call and only when the call is really made:
 *   Yahoo successes, ineligible failures and invalid requests never charge it.
 */

export interface QuotaWindowSpec {
  limit: number;
  windowMs: number;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Seconds until the tightest full window resets. 0 when allowed. */
  retryAfterSeconds: number;
}

interface WindowCounter {
  windowStart: number;
  count: number;
}

export interface QuotaGuard {
  /**
   * Checks every window for the key and, when all allow it, increments every
   * window's counter (all-or-nothing: a refusal charges no window).
   */
  tryTake(key: string, windows: readonly QuotaWindowSpec[]): QuotaDecision;
}

export function createQuotaGuard(now: () => number = (): number => Date.now()): QuotaGuard {
  const counters = new Map<string, WindowCounter>();

  const counterFor = (key: string, windowMs: number): WindowCounter => {
    const counterKey = `${key}#${windowMs}`;
    let counter = counters.get(counterKey);
    if (!counter) {
      counter = { windowStart: now(), count: 0 };
      counters.set(counterKey, counter);
    }
    // A window that has elapsed restarts and claims its slot immediately.
    if (now() - counter.windowStart >= windowMs) {
      counter.windowStart = now();
      counter.count = 0;
    }
    return counter;
  };

  function tryTake(key: string, windows: readonly QuotaWindowSpec[]): QuotaDecision {
    if (windows.length === 0) return { allowed: true, retryAfterSeconds: 0 };

    const countersForCheck = windows.map((entry) => ({
      spec: entry,
      counter: counterFor(key, entry.windowMs),
    }));

    const full = countersForCheck.filter((entry) => entry.counter.count >= entry.spec.limit);
    if (full.length > 0) {
      const secondsUntilReset = Math.max(
        ...full.map((entry) => Math.ceil((entry.counter.windowStart + entry.spec.windowMs - now()) / 1000)),
      );
      return { allowed: false, retryAfterSeconds: Math.max(1, secondsUntilReset) };
    }

    for (const entry of countersForCheck) entry.counter.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return { tryTake };
}

/** Per-endpoint window specs. Reviewed numbers, not secrets. */
export const HISTORY_IP_LIMITS: readonly QuotaWindowSpec[] = [{ limit: 60, windowMs: 60_000 }];
export const SEARCH_IP_LIMITS: readonly QuotaWindowSpec[] = [{ limit: 30, windowMs: 60_000 }];
/**
 * Global spend budget for the Twelve Data fallback: 20 per 5 minutes and
 * 200 per 24 hours. The daily figure deliberately sits inside the free plan's
 * allowance so even a fully cold-started fleet of isolates cannot drain the
 * day's credits from one honest budget path.
 */
export const FALLBACK_BUDGET_WINDOWS: readonly QuotaWindowSpec[] = [
  { limit: 20, windowMs: 5 * 60_000 },
  { limit: 200, windowMs: 24 * 60 * 60_000 },
];

/** IP identity: platform-provided first, then the first proxy hop, else shared. */
export function clientKeyFromRequest(request: Request, routeScope: string): string {
  const platformIp = request.headers.get('x-vercel-forwarded-for-ip');
  const proxiedIp = request.headers
    .get('x-forwarded-for')
    ?.split(',')[0]
    ?.trim();
  const ip = platformIp && platformIp.length > 0 ? platformIp : proxiedIp && proxiedIp.length > 0 ? proxiedIp : 'unidentified';
  return `${routeScope}:${ip}`;
}

export const FALLBACK_BUDGET_KEY = 'marketdata:fallback-budget';

/**
 * A 429 response with Retry-After, shaped like the provider error responses.
 */
export function tooManyRequests(detail: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Retry-After': String(Math.max(1, retryAfterSeconds)),
    },
  });
}
