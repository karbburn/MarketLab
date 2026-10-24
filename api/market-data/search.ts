import {
  SEARCH_CACHE_CONTROL,
  errorResponse,
  fetchYahooSearch,
  jsonResponse,
  parseSearchQuery,
} from '../../src/lib/marketdata/yahoo';

export const config = { runtime: 'edge' } as const;

/**
 * Hosted symbol-search proxy.
 *
 * Search is a convenience, not a data source: a failure is reported explicitly
 * and the download dialog still lets the operator request the typed ticker
 * directly.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ detail: 'Only GET is supported.' }, 405);
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
