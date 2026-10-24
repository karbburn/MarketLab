import {
  HISTORY_CACHE_CONTROL,
  errorResponse,
  jsonResponse,
  parseHistoryQuery,
} from '../../src/lib/marketdata/yahoo';
import {
  fetchHostedHistory,
  twelveDataApiKeyFromEnv,
} from '../../src/lib/marketdata/hosted';
import {
  FALLBACK_BUDGET_KEY,
  FALLBACK_BUDGET_WINDOWS,
  HISTORY_IP_LIMITS,
  clientKeyFromRequest,
  createQuotaGuard,
  tooManyRequests,
} from '../../src/lib/marketdata/quota';

export const config = { runtime: 'edge' } as const;

/** Module state survives across requests served by one warm isolate. */
const quota = createQuotaGuard();

/**
 * Hosted daily-history proxy.
 *
 * The browser only ever talks to this same-origin endpoint; providers are
 * contacted server-side. Yahoo Finance is the primary source. Twelve Data is
 * used only when it is configured on the server and Yahoo fails, so a provider
 * outage or throttle can be recovered without exposing an API key to the
 * browser, and only when the fallback budget still has room: a flood of
 * cache-miss requests must not drain the paid credits. The response keeps the
 * same `{ provider, bars }` contract as the local FastAPI service, including
 * honest provider provenance. Per-IP and budget limits are best-effort (see
 * `quota.ts`); platform-level rules remain the hard control for abuse.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ detail: 'Only GET is supported.' }, 405);
  }

  const ipDecision = quota.tryTake(clientKeyFromRequest(request, 'history'), HISTORY_IP_LIMITS);
  if (!ipDecision.allowed) {
    return tooManyRequests(
      'Too many history requests from this address. Wait a moment and try again.',
      ipDecision.retryAfterSeconds,
    );
  }

  try {
    const url = new URL(request.url);
    const query = parseHistoryQuery(url.searchParams);
    const payload = await fetchHostedHistory(query, {
      twelveDataApiKey: twelveDataApiKeyFromEnv(),
      spendFallbackCredit: () => quota.tryTake(FALLBACK_BUDGET_KEY, FALLBACK_BUDGET_WINDOWS).allowed,
    });
    return jsonResponse(payload, 200, HISTORY_CACHE_CONTROL);
  } catch (error) {
    return errorResponse(error);
  }
}
