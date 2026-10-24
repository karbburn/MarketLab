/**
 * Browser client for the market-data service.
 *
 * The same client talks to two interchangeable deployments:
 * - localhost/loopback uses the optional FastAPI service in `services/`.
 * - any deployed hostname uses the same-origin proxy under `/api/market-data`,
 *   so users on phones or other computers do not need a local service.
 *
 * Every failure mode is a typed, first-class result — there is no state in
 * which the frontend silently shows an empty chart while a download actually
 * failed for a specific reason. The service contract is documented in
 * `services/market-data/README.md`.
 */

import type { CorporateAction, ProviderId } from '../../domain/types';
import { isDateString } from '../date';
import type { ProviderHistory, ProviderSearchResult } from './normalize';

export const LOCAL_SERVICE_URL = 'http://127.0.0.1:8787';
export const HOSTED_SERVICE_URL = '/api/market-data';

declare global {
  interface Window {
    /**
     * Optional runtime override used by tests and self-hosted deployments that
     * want to point at a same-origin proxy without rebuilding the bundle.
     */
    __MARKETLAB_MARKET_DATA_URL__?: string;
  }
}

export interface ResolveMarketDataServiceOptions {
  /** Override the hostname used for local-vs-deployed detection. */
  hostname?: string;
  /** Override the configured service URL; an empty string disables env overrides. */
  configuredUrl?: string | null;
}

/** True for addresses that can reach a service running on the same machine. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host === '0.0.0.0';
}

function withoutTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Resolves the service base URL without touching the network.
 *
 * Precedence: an explicit runtime override, then `VITE_MARKET_DATA_URL`, then
 * loopback detection. A deployed host therefore defaults to the same-origin
 * proxy, while local development keeps using the local FastAPI service.
 */
export function resolveMarketDataServiceUrl(
  options: ResolveMarketDataServiceOptions = {},
): string {
  const configured = options.configuredUrl !== undefined
    ? options.configuredUrl
    : (typeof window !== 'undefined' ? window.__MARKETLAB_MARKET_DATA_URL__ : undefined)
      ?? import.meta.env.VITE_MARKET_DATA_URL;

  if (typeof configured === 'string' && configured.trim().length > 0) {
    return withoutTrailingSlashes(configured.trim());
  }

  const hostname = options.hostname
    ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  return isLocalHostname(hostname) ? LOCAL_SERVICE_URL : HOSTED_SERVICE_URL;
}

/** The resolved URL for the current page. Tests may override it explicitly. */
export const DEFAULT_SERVICE_URL = resolveMarketDataServiceUrl();

/** True when the resolved URL points at the loopback FastAPI service. */
export function isLocalMarketDataService(baseUrl: string = DEFAULT_SERVICE_URL): boolean {
  return baseUrl.startsWith('http://127.0.0.1')
    || baseUrl.startsWith('http://localhost')
    || baseUrl.startsWith('http://[::1]')
    || baseUrl.startsWith('http://0.0.0.0');
}

/**
 * Builds one route on a service base URL.
 *
 * The local FastAPI contract is `/api/{route}`. The hosted proxy is mounted at
 * `/api/market-data/{route}` and does not repeat `/api`, so the two shapes are
 * not interchangeable. Any base that ends in `/api/market-data` (including a
 * configured absolute proxy URL) uses the hosted shape; every other base keeps
 * the documented local-compatible `/api/{route}` contract.
 */
export function marketDataEndpoint(
  baseUrl: string,
  route: 'health' | 'search' | 'history',
): string {
  const base = withoutTrailingSlashes(baseUrl);
  return base.endsWith('/api/market-data') ? `${base}/${route}` : `${base}/api/${route}`;
}

/** Human description used by the download dialogs and first-run panel. */
export function marketDataServiceDescription(baseUrl: string = DEFAULT_SERVICE_URL): string {
  if (isLocalMarketDataService(baseUrl)) {
    return `the local market-data service (${baseUrl})`;
  }
  if (baseUrl === HOSTED_SERVICE_URL) {
    return "MarketLab's hosted market-data service";
  }
  return `MarketLab's market-data service (${baseUrl})`;
}

/** Actionable failure text that never tells deployed users to start localhost. */
export function marketDataUnavailableMessage(baseUrl: string = DEFAULT_SERVICE_URL): string {
  if (isLocalMarketDataService(baseUrl)) {
    return 'The local market-data service is not reachable. Start it with `uvicorn app:app --port 8787` from `services/market-data`, then try again.';
  }
  return "MarketLab's hosted market-data service is not reachable. Check your internet connection and try again.";
}

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

/**
 * Turns any download failure into one actionable sentence for the UI.
 *
 * Shared by the single-symbol and bulk download paths so a failure reads the
 * same way regardless of how many symbols were requested.
 */
export function describeMarketDataFailure(error: unknown): string {
  if (error instanceof MarketDataError) return error.message;
  return error instanceof Error ? error.message : 'The download failed for an unexpected reason.';
}

/** True only for a provider-throttling failure, which warrants a longer pause. */
export function isMarketDataThrottled(error: unknown): boolean {
  return error instanceof MarketDataError && error.kind === 'throttled';
}

export async function checkServiceHealth(baseUrl: string = DEFAULT_SERVICE_URL, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await request(marketDataEndpoint(baseUrl, 'health'), signal ?? null, baseUrl);
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
    `${marketDataEndpoint(baseUrl, 'search')}?q=${encodeURIComponent(query)}&limit=${limit}`,
    signal ?? null,
    baseUrl,
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
    `${marketDataEndpoint(baseUrl, 'history')}?symbol=${encodeURIComponent(input.symbol)}&start=${encodeURIComponent(input.start)}&end=${encodeURIComponent(input.end)}`,
    signal ?? null,
    baseUrl,
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

async function request(
  url: string,
  signal: AbortSignal | null,
  baseUrl: string = DEFAULT_SERVICE_URL,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (isLocalMarketDataService(baseUrl)) {
      // `X-MarketLab-Client` is deliberately a non-simple header: it forces a
      // CORS preflight even for plain GETs, so the local service can declare its
      // `Access-Control-Allow-Private-Network` opt-in. Chrome otherwise blocks a
      // public HTTPS page from reaching a user's localhost before any preflight
      // could happen (Private Network Access / Local Network Access policies).
      headers['X-MarketLab-Client'] = '1';
    }
    return await fetch(url, { signal: controller.signal, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new MarketDataError('timeout', 'The market-data service did not respond in time.');
    }
    throw new MarketDataError('unavailable', marketDataUnavailableMessage(baseUrl));
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

function normaliseProviderId(value: unknown): ProviderId | null {
  if (value === 'yahoo-finance' || value === 'twelve-data') return value;
  return null;
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
  const provider = normaliseProviderId(raw.provider);
  assertShape(provider !== null, 'Provider metadata has an unsupported provider id.');
  assertShape(typeof raw.providerSymbol === 'string' && raw.providerSymbol.length > 0, 'Provider metadata is missing the original symbol.');
  const notes = raw.sourceNotes;
  const range = raw.rangeRequested;
  const actual = raw.rangeActual;
  return {
    provider,
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
    corporateActions: normaliseCorporateActions(raw.corporateActions),
  };
}

/**
 * Validates provider action rows. A malformed row fails the download as a whole
 * instead of being dropped: silently losing an event would let the chart imply
 * the provider reported no action on that session.
 */
function normaliseCorporateActions(raw: unknown): CorporateAction[] {
  if (raw === undefined || raw === null) return [];
  assertShape(Array.isArray(raw), 'Provider corporate actions must be an array.');
  const seen = new Set<string>();
  const actions: CorporateAction[] = [];
  raw.forEach((entry, index) => {
    assertShape(entry !== null && typeof entry === 'object', `Corporate-action entry ${index + 1} is not an object.`);
    const record = entry as Record<string, unknown>;
    assertShape(isDateString(record.date), `Corporate-action entry ${index + 1} has an invalid session date.`);
    assertShape(
      record.type === 'split' || record.type === 'dividend',
      `Corporate-action entry ${index + 1} has an unsupported type.`,
    );
    assertShape(
      typeof record.value === 'number' && Number.isFinite(record.value) && record.value > 0,
      `Corporate-action entry ${index + 1} needs a finite value greater than zero.`,
    );
    const action: CorporateAction = {
      date: record.date,
      type: record.type,
      value: record.value,
    };
    const key = `${action.date}|${action.type}|${action.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  });
  return actions.sort((a, b) => (a.date === b.date ? a.type.localeCompare(b.type) : a.date.localeCompare(b.date)));
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
