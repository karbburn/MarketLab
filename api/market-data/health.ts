import {
  SERVICE_VERSION,
  YAHOO_PROVIDER_ID,
  jsonResponse,
} from '../../src/lib/marketdata/yahoo';
import { twelveDataApiKeyFromEnv } from '../../src/lib/marketdata/hosted';

export const config = { runtime: 'edge' } as const;

/**
 * Same-origin health endpoint for the hosted data path.
 *
 * The local FastAPI service exposes `/api/health`; this mirrors its shape so
 * `checkServiceHealth` can treat both deployments identically. The fallback
 * field reports only whether a key is configured, never the key itself.
 */
export default function handler(request: Request): Response {
  if (request.method !== 'GET') {
    return jsonResponse({ detail: 'Only GET is supported.' }, 405);
  }
  return jsonResponse(
    {
      ok: true,
      service: 'marketlab-market-data',
      version: SERVICE_VERSION,
      provider: YAHOO_PROVIDER_ID,
      fallbackProvider: twelveDataApiKeyFromEnv() ? 'twelve-data' : null,
      runtime: 'vercel-edge',
    },
    200,
    'public, s-maxage=300',
  );
}
