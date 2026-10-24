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

export const config = { runtime: 'edge' } as const;

/**
 * Hosted daily-history proxy.
 *
 * The browser only ever talks to this same-origin endpoint; providers are
 * contacted server-side. Yahoo Finance is the primary source. Twelve Data is
 * used only when it is configured on the server and Yahoo fails, so a provider
 * outage or throttle can be recovered without exposing an API key to the
 * browser. The response keeps the same `{ provider, bars }` contract as the
 * local FastAPI service, including honest provider provenance.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ detail: 'Only GET is supported.' }, 405);
  }

  try {
    const url = new URL(request.url);
    const query = parseHistoryQuery(url.searchParams);
    const payload = await fetchHostedHistory(query, {
      twelveDataApiKey: twelveDataApiKeyFromEnv(),
    });
    return jsonResponse(payload, 200, HISTORY_CACHE_CONTROL);
  } catch (error) {
    return errorResponse(error);
  }
}
