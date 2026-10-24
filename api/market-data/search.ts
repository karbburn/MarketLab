import {
  SEARCH_CACHE_CONTROL,
  errorResponse,
  jsonResponse,
  parseSearchQuery,
} from '../../src/lib/marketdata/yahoo';
import { fetchYahooSearch } from '../../src/lib/marketdata/yahoo';
import {
  SEARCH_IP_LIMITS,
  clientKeyFromRequest,
  createQuotaGuard,
  tooManyRequests,
} from '../../src/lib/marketdata/quota';

export const config = { runtime: 'edge' } as const;

/** Module state survives across requests served by one warm isolate. */
const quota = createQuotaGuard();

/**
 * Hosted symbol-search proxy.
 *
 * Search is a convenience, not a data source: a failure is reported explicitly
 * and the download dialog still lets the operator request the typed ticker
 * directly. Requests are best-effort rate limited per address (see `quota.ts`);
 * search only ever touches the free Yahoo endpoint.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ detail: 'Only GET is supported.' }, 405);
  }

  const ipDecision = quota.tryTake(clientKeyFromRequest(request, 'search'), SEARCH_IP_LIMITS);
  if (!ipDecision.allowed) {
    return tooManyRequests(
      'Too many search requests from this address. Wait a moment and try again.',
      ipDecision.retryAfterSeconds,
    );
  }

  try {
    const url = new URL(request.url);
    const query = parseSearchQuery(url.searchParams);
    const payload = await fetchYahooSearch(query);
    return jsonResponse(payload, 200, SEARCH_CACHE_CONTROL);
  } catch (error) {
    return errorResponse(error);
  }
}
