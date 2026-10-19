/**
 * Browser client for the optional local market-data service.
 *
 * Every failure mode is a typed, first-class result — there is no state in
 * which the frontend silently shows an empty chart while a download actually
 * failed for a specific reason. The service contract is documented in
 * `services/market-data/README.md`.
 */

import type { ProviderHistory, ProviderSearchResult } from './normalize';

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8787';

export type MarketDataFailureKind =
  | 'unavailable'
  | 'timeout'
  | 'server-error'
  | 'not-found'
  | 'throttled'
  | 'invalid-input'
  | 'malformed';

export class MarketDataError extends Error {
  readonly kind: MarketDataFailureKind;

  constructor(kind: MarketDataFailureKind, message: string) {
    super(message);
    this.name = 'MarketDataError';
    this.kind = kind;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function checkServiceHealth(baseUrl: string = DEFAULT_SERVICE_URL, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await request(`${baseUrl}/api/health`, signal ?? null);
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return response.ok && body?.ok === true;
  } catch {
    return false;
  }
}

export async function fetchProviderSearch(
  query: string,
  limit = 8,
  baseUrl: string = DEFAULT_SERVICE_URL,
  signal?: AbortSignal,
): Promise<ProviderSearchResult[]> {
  const response = await request(
    `${baseUrl}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    signal ?? null,
  );
  const body = await expectJson(response);
  assertShape(body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results), 'Search response is missing the results list.');
  const results = (body as { results: unknown[] }).results;
  return results.map((entry) => normaliseSearchResult(entry));
}

export interface ProviderHistoryRequest {
  symbol: string;
  start: string;
  end: string;
}

export async function fetchProviderHistory(
  input: ProviderHistoryRequest,
  baseUrl: string = DEFAULT_SERVICE_URL,
  signal?: AbortSignal,
): Promise<ProviderHistory> {
  const response = await request(
    `${baseUrl}/api/history?symbol=${encodeURIComponent(input.symbol)}&start=${encodeURIComponent(input.start)}&end=${encodeURIComponent(input.end)}`,
    signal ?? null,
  );
  const body = await expectJson(response);
  assertShape(
    body && typeof body === 'object'
      && typeof (body as { provider?: unknown }).provider === 'object' && (body as { provider?: unknown }).provider !== null
      && Array.isArray((body as { bars?: unknown }).bars),
    'History response is missing provider metadata or the bars list.',
  );
  const raw = body as { provider: Record<string, unknown>; bars: unknown[] };
  return { providerMetadata: normaliseProviderMetadata(raw.provider), bars: raw.bars.map(normaliseProviderBar) };
}

// ---------------------------------------------------------------- internals

async function request(url: string, signal: AbortSignal | null): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new MarketDataError('timeout', 'The market-data service did not respond in time.');
    }
    throw new MarketDataError('unavailable', 'The market-data service is not reachable. Start it with `uvicorn app:app --port 8787`.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function expectJson(response: Response): Promise<unknown> {
  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new MarketDataError('malformed', 'The market-data service returned a body that is not valid JSON.');
    }
  }
  const detail = await readDetail(response);
  switch (response.status) {
    case 400:
      throw new MarketDataError('invalid-input', detail ?? 'The download request was rejected as invalid.');
    case 404:
      throw new MarketDataError('not-found', detail ?? 'No data is available for this symbol and range.');
    case 429:
      throw new MarketDataError('throttled', detail ?? 'The data provider is throttling requests. Wait a moment and try again.');
    case 503:
      throw new MarketDataError('timeout', detail ?? 'The data provider timed out.');
    default:
      throw new MarketDataError('server-error', detail ?? 'The data provider failed unexpectedly.');
  }
}

async function readDetail(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof body?.detail === 'string' ? body.detail : null;
}

function assertShape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MarketDataError('malformed', message);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normaliseSearchResult(entry: unknown): ProviderSearchResult {
  assertShape(entry && typeof entry === 'object', 'Search response contained a non-object result.');
  const raw = entry as Record<string, unknown>;
  assertShape(typeof raw.symbol === 'string' && raw.symbol.length > 0, 'Search response contained a result without a symbol.');
  return {
    symbol: raw.symbol as string,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.symbol as string,
    exchange: nullableString(raw.exchange),
    exchangeName: nullableString(raw.exchangeName),
    type: nullableString(raw.type),
    sector: nullableString(raw.sector),
    industry: nullableString(raw.industry),
  };
}

function normaliseProviderMetadata(raw: Record<string, unknown>): ProviderHistory['providerMetadata'] {
  assertShape(typeof raw.provider === 'string' && raw.provider.length > 0, 'Provider metadata is missing its id.');
  assertShape(typeof raw.providerSymbol === 'string' && raw.providerSymbol.length > 0, 'Provider metadata is missing the original symbol.');
  const notes = raw.sourceNotes;
  const range = raw.rangeRequested;
  const actual = raw.rangeActual;
  return {
    provider: raw.provider as string,
    providerSymbol: raw.providerSymbol as string,
    displaySymbol: typeof raw.displaySymbol === 'string' && raw.displaySymbol.length > 0 ? raw.displaySymbol : raw.providerSymbol as string,
    displayName: nullableString(raw.displayName),
    exchange: nullableString(raw.exchange),
    exchangeName: nullableString(raw.exchangeName),
    instrumentType: nullableString(raw.instrumentType),
    currency: nullableString(raw.currency),
    timezone: nullableString(raw.timezone),
    interval: typeof raw.interval === 'string' ? raw.interval : '1d',
    adjustment: typeof raw.adjustment === 'string' && raw.adjustment.length > 0 ? raw.adjustment : 'adjustment policy not reported',
    rangeRequested: {
      start: shapeRangeSide(range, 'start'),
      end: shapeRangeSide(range, 'end'),
    },
    rangeActual: {
      start: shapeRangeSide(actual, 'start'),
      end: shapeRangeSide(actual, 'end'),
    },
    retrievedAt: typeof raw.retrievedAt === 'string' && raw.retrievedAt.length > 0 ? raw.retrievedAt : new Date().toISOString(),
    sourceNotes: Array.isArray(notes) ? notes.filter((note): note is string => typeof note === 'string') : [],
  };
}

function shapeRangeSide(range: unknown, side: 'start' | 'end'): string {
  if (range && typeof range === 'object') {
    const value = (range as Record<string, unknown>)[side];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function normaliseProviderBar(entry: unknown): ProviderHistory['bars'][number] {
  assertShape(entry && typeof entry === 'object', 'History responses must only contain bar objects.');
  const raw = entry as Record<string, unknown>;
  assertShape(typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date), 'A bar was returned without an ISO session date.');
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    date: raw.date as string,
    open: number(raw.open),
    high: number(raw.high),
    low: number(raw.low),
    close: number(raw.close),
    adjClose: number(raw.adjClose),
    volume: number(raw.volume),
  };
}
