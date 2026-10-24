/**
 * Server-side Yahoo Finance adapter for the hosted market-data proxy.
 *
 * This module is deliberately pure except for the two `fetchYahoo*` helpers:
 * the parsers take plain JSON and return the same `{ provider, bars }` /
 * `{ results }` contract the local FastAPI service exposes. Keeping the
 * transformation independent of the HTTP handler makes it unit-testable and
 * keeps the hosted and local paths honest about the same limitations.
 *
 * Honesty rules:
 * - Yahoo is unofficial, undocumented and may be delayed. Every response says
 *   so; failures are explicit HTTP errors with a JSON `detail`.
 * - Only daily bars are returned. The timestamp is converted to the exchange's
 *   local session date, never to the browser's timezone.
 * - Null provider values stay null. Nothing is invented or forward-filled.
 */

import { addDays, isDateString } from '../date';

export const YAHOO_PROVIDER_ID = 'yahoo-finance';
export const SERVICE_VERSION = '1.1.0';
export const ADJUSTMENT_POLICY = 'splits-applied, dividends not reinvested (as-traded OHLC)';
export const SOURCE_NOTES = [
  'Unofficial, undocumented Yahoo Finance data; may be delayed for some venues.',
  'Fetched on demand through MarketLab’s market-data service; availability and schema can change without notice.',
  'Daily exchange-session bars only; MarketLab aggregates weekly/monthly locally.',
  'Volume is nullable: Yahoo omits it for some instrument types.',
  'Corporate actions are provider-reported event dates and may be incomplete; '
    + 'split markers do not imply a price gap because the OHLC series is split-adjusted.',
] as const;

export const HISTORY_CACHE_CONTROL = 'public, s-maxage=600, stale-while-revalidate=86400';
export const SEARCH_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400';

const CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'] as const;
const SEARCH_HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'] as const;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SEARCH_RESULTS = 20;
const EARLIEST_START = '1900-01-01';
const SYMBOL_PATTERN = /^[A-Za-z0-9._^=:-]{1,16}$/;

export type YahooFailureStatus = 400 | 404 | 429 | 502 | 503;

export class YahooProviderError extends Error {
  readonly status: YahooFailureStatus;

  constructor(status: YahooFailureStatus, message: string) {
    super(message);
    this.name = 'YahooProviderError';
    this.status = status;
  }
}

export interface YahooBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjClose: number | null;
  volume: number | null;
}

export interface YahooCorporateAction {
  date: string;
  type: 'split' | 'dividend';
  value: number;
}

export interface YahooProviderMetadata {
  provider: string;
  providerSymbol: string;
  displaySymbol: string;
  displayName: string | null;
  exchange: string | null;
  exchangeName: string | null;
  instrumentType: string | null;
  currency: string | null;
  timezone: string | null;
  interval: string;
  adjustment: string;
  rangeRequested: { start: string; end: string };
  rangeActual: { start: string; end: string };
  retrievedAt: string;
  sourceNotes: readonly string[];
  corporateActions: YahooCorporateAction[];
}

export interface YahooHistoryPayload {
  provider: YahooProviderMetadata;
  bars: YahooBar[];
}

export interface YahooSearchResult {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeName: string | null;
  type: string | null;
  sector: string | null;
  industry: string | null;
}

export interface YahooSearchPayload {
  provider: string;
  query: string;
  results: YahooSearchResult[];
}

export interface HistoryQuery {
  symbol: string;
  start: string;
  end: string;
}

export interface SearchQuery {
  query: string;
  limit: number;
}

/** Validates the public history query before any provider call. */
export function parseHistoryQuery(params: URLSearchParams, today: Date = new Date()): HistoryQuery {
  const symbol = (params.get('symbol') ?? '').trim();
  // One-character tickers are real (F, T, C, V), so the minimum is one.
  if (symbol.length < 1 || symbol.length > 16 || !SYMBOL_PATTERN.test(symbol)) {
    throw new YahooProviderError(400, 'Symbol contains unsupported characters or is too long.');
  }

  const todayDate = today.toISOString().slice(0, 10);
  const defaultStart = addDays(todayDate, -365 * 5);
  const start = params.get('start') === null ? defaultStart : (params.get('start') ?? '');
  const end = params.get('end') === null ? todayDate : (params.get('end') ?? '');

  if (!isDateString(start)) {
    throw new YahooProviderError(400, 'start must be an ISO date (YYYY-MM-DD).');
  }
  if (!isDateString(end)) {
    throw new YahooProviderError(400, 'end must be an ISO date (YYYY-MM-DD).');
  }
  if (start < EARLIEST_START) {
    throw new YahooProviderError(400, `start must be ${EARLIEST_START} or later.`);
  }
  if (start > end) {
    throw new YahooProviderError(400, 'start must be on or before end.');
  }
  return { symbol, start, end };
}

/** Validates the public search query before any provider call. */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const query = (params.get('q') ?? '').trim();
  if (query.length < 2 || query.length > 64) {
    throw new YahooProviderError(400, 'q must be between 2 and 64 characters.');
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new YahooProviderError(400, `limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}.`);
  }
  return { query, limit };
}

/** Yahoo treats `end` as exclusive; the public contract is inclusive. */
export function yahooChartUrl(
  symbol: string,
  start: string,
  end: string,
  host: string = CHART_HOSTS[0]!,
): string {
  const period1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${addDays(end, 1)}T00:00:00Z`) / 1000);
  return `${host}/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
}

export function yahooSearchUrl(query: string, limit: number, host: string = SEARCH_HOSTS[0]!): string {
  return `${host}/v1/finance/search?q=${encodeURIComponent(query)}`
    + `&quotesCount=${limit}&newsCount=0`;
}

export async function fetchYahooHistory(
  input: HistoryQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<YahooHistoryPayload> {
  const urls = CHART_HOSTS.map((host) => yahooChartUrl(input.symbol, input.start, input.end, host));
  const payload = await fetchFirstJson(urls, fetchImpl);
  return normaliseYahooChart(payload, input);
}

export async function fetchYahooSearch(
  input: SearchQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<YahooSearchPayload> {
  const urls = SEARCH_HOSTS.map((host) => yahooSearchUrl(input.query, input.limit, host));
  const payload = await fetchFirstJson(urls, fetchImpl);
  return normaliseYahooSearch(payload, input.query, input.limit);
}

/** Converts a Yahoo chart response into the existing provider contract. */
export function normaliseYahooChart(
  payload: unknown,
  request: HistoryQuery,
  retrievedAt: string = new Date().toISOString(),
): YahooHistoryPayload {
  const chart = asRecord(asRecord(payload)?.chart);
  if (!chart) {
    throw new YahooProviderError(502, 'Yahoo returned a response without a chart envelope.');
  }
  if (chart.error !== null && chart.error !== undefined) {
    throw chartError(chart.error, request.symbol);
  }

  const results = chart.result;
  if (!Array.isArray(results) || results.length === 0) {
    throw new YahooProviderError(404, `No data found for symbol ${request.symbol}; it may be delisted or unknown.`);
  }
  const result = asRecord(results[0]);
  if (!result) {
    throw new YahooProviderError(502, 'Yahoo returned a malformed chart result.');
  }

  const meta = asRecord(result.meta) ?? {};
  const timezone = nullableString(meta.exchangeTimezoneName);
  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    throw new YahooProviderError(404, 'No sessions were returned for the requested range.');
  }

  const indicators = asRecord(result.indicators);
  const quoteRows = indicators?.quote;
  const quote = Array.isArray(quoteRows) ? asRecord(quoteRows[0]) : null;
  if (!quote) {
    throw new YahooProviderError(502, 'Yahoo returned a chart without quote data.');
  }
  const opens = quote.open;
  const highs = quote.high;
  const lows = quote.low;
  const closes = quote.close;
  if (!Array.isArray(opens) || !Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) {
    throw new YahooProviderError(502, 'Yahoo returned a chart missing required OHLC series.');
  }

  const adjcloseRows = indicators?.adjclose;
  const adjclose = Array.isArray(adjcloseRows) ? asRecord(adjcloseRows[0]) : null;
  const adjustedCloses = adjclose?.adjclose;

  const bars: YahooBar[] = timestamps.map((timestamp, index) => {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw new YahooProviderError(502, 'Yahoo returned a non-numeric session timestamp.');
    }
    return {
      date: sessionDate(timestamp, timezone),
      open: numberOrNull(opens[index]),
      high: numberOrNull(highs[index]),
      low: numberOrNull(lows[index]),
      close: numberOrNull(closes[index]),
      adjClose: Array.isArray(adjustedCloses) ? numberOrNull(adjustedCloses[index]) : null,
      volume: volumeOrNull(quote.volume, index),
    };
  });

  if (bars.length === 0) {
    throw new YahooProviderError(404, 'No sessions were returned for the requested range.');
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));

  return {
    provider: {
      provider: YAHOO_PROVIDER_ID,
      providerSymbol: request.symbol,
      displaySymbol: request.symbol,
      displayName: nullableString(meta.shortName) ?? nullableString(meta.longName),
      exchange: nullableString(meta.exchangeName),
      exchangeName: nullableString(meta.fullExchangeName),
      instrumentType: nullableString(meta.instrumentType),
      currency: nullableString(meta.currency),
      timezone,
      interval: '1d',
      adjustment: ADJUSTMENT_POLICY,
      rangeRequested: { start: request.start, end: request.end },
      rangeActual: { start: bars[0]!.date, end: bars[bars.length - 1]!.date },
      retrievedAt,
      sourceNotes: SOURCE_NOTES,
      corporateActions: normaliseCorporateActions(result.events, timezone, request.start, request.end),
    },
    bars,
  };
}

/** Converts a Yahoo search response into the existing provider contract. */
export function normaliseYahooSearch(
  payload: unknown,
  query: string,
  limit: number,
): YahooSearchPayload {
  const quotes = asRecord(payload)?.quotes;
  if (!Array.isArray(quotes)) {
    throw new YahooProviderError(502, 'Yahoo returned a search response without a quotes list.');
  }

  const results: YahooSearchResult[] = [];
  for (const entry of quotes) {
    const quote = asRecord(entry);
    if (!quote) continue;
    const symbol = nullableString(quote.symbol);
    if (!symbol) continue;
    results.push({
      symbol,
      name: nullableString(quote.longname) ?? nullableString(quote.shortname) ?? symbol,
      exchange: nullableString(quote.exchange),
      exchangeName: nullableString(quote.exchDisp) ?? nullableString(quote.exchange),
      type: nullableString(quote.typeDisp) ?? nullableString(quote.quoteType),
      sector: nullableString(quote.sector),
      industry: nullableString(quote.industry),
    });
    if (results.length >= limit) break;
  }

  return { provider: YAHOO_PROVIDER_ID, query, results };
}

/** JSON response helper shared by the three edge handlers. */
export function jsonResponse(
  body: unknown,
  status = 200,
  cacheControl = 'no-store',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Maps a typed provider failure to the JSON error shape the client expects. */
export function errorResponse(error: unknown): Response {
  if (error instanceof YahooProviderError) {
    return jsonResponse({ detail: error.message }, error.status);
  }
  return jsonResponse({ detail: 'The market-data service failed unexpectedly.' }, 502);
}

// ---------------------------------------------------------------- internals

async function fetchFirstJson(urls: readonly string[], fetchImpl: typeof fetch): Promise<unknown> {
  let lastError: YahooProviderError | null = null;
  for (const url of urls) {
    try {
      return await fetchJson(url, fetchImpl);
    } catch (error) {
      const mapped = error instanceof YahooProviderError
        ? error
        : new YahooProviderError(502, 'The provider request failed.');
      // A missing symbol is definitive; retrying the second host cannot help.
      if (mapped.status === 400 || mapped.status === 404) throw mapped;
      lastError = mapped;
    }
  }
  throw lastError ?? new YahooProviderError(502, 'The provider request failed.');
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw httpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new YahooProviderError(502, 'Yahoo returned a body that is not valid JSON.');
    }
  } catch (error) {
    if (error instanceof YahooProviderError) throw error;
    if (isAbortError(error)) {
      throw new YahooProviderError(503, 'The provider request timed out.');
    }
    throw new YahooProviderError(502, 'The provider request failed. Check the service connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

function httpError(status: number): YahooProviderError {
  if (status === 404) {
    return new YahooProviderError(404, 'No data is available for this symbol and range.');
  }
  if (status === 429) {
    return new YahooProviderError(429, 'Yahoo is throttling requests. Wait a moment and try again.');
  }
  if (status === 408 || status === 504) {
    return new YahooProviderError(503, 'The provider request timed out.');
  }
  return new YahooProviderError(502, `Yahoo request failed with HTTP ${status}.`);
}

function chartError(error: unknown, symbol: string): YahooProviderError {
  const record = asRecord(error);
  const code = nullableString(record?.code);
  const description = nullableString(record?.description) ?? nullableString(record?.message);
  const text = `${code ?? ''} ${description ?? ''}`.toLowerCase();
  if (text.includes('not found') || text.includes('delisted') || text.includes('no data')) {
    return new YahooProviderError(404, `No data found for symbol ${symbol}; it may be delisted or unknown.`);
  }
  if (text.includes('too many') || text.includes('rate limit') || text.includes('throttl')) {
    return new YahooProviderError(429, 'Yahoo is throttling requests. Wait a moment and try again.');
  }
  return new YahooProviderError(
    502,
    description ? `Yahoo returned an error: ${description}` : 'Yahoo returned an error.',
  );
}

function normaliseCorporateActions(
  events: unknown,
  timezone: string | null,
  start: string,
  end: string,
): YahooCorporateAction[] {
  const record = asRecord(events);
  if (!record) return [];

  const actions: YahooCorporateAction[] = [];
  const seen = new Set<string>();

  const add = (
    bucket: unknown,
    type: YahooCorporateAction['type'],
    valueOf: (entry: Record<string, unknown>) => number | null,
  ) => {
    const entries = asRecord(bucket);
    if (!entries) return;
    for (const [key, rawEntry] of Object.entries(entries)) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const value = valueOf(entry);
      if (value === null || !Number.isFinite(value) || value <= 0) continue;
      const stamp = numberOrNull(entry.date) ?? Number(key);
      if (!Number.isFinite(stamp)) continue;
      const date = sessionDate(stamp, timezone);
      if (date < start || date > end) continue;
      const dedupeKey = `${date}|${type}|${value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      actions.push({ date, type, value });
    }
  };

  add(record.dividends, 'dividend', (entry) => numberOrNull(entry.amount));
  add(record.splits, 'split', (entry) => {
    const numerator = numberOrNull(entry.numerator);
    const denominator = numberOrNull(entry.denominator);
    if (numerator !== null && denominator !== null && denominator > 0) {
      return numerator / denominator;
    }
    const ratio = nullableString(entry.splitRatio);
    if (!ratio) return null;
    const parts = ratio.split(':').map(Number);
    return parts.length === 2 && parts[0]! > 0 && parts[1]! > 0 ? parts[0]! / parts[1]! : null;
  });

  return actions.sort((a, b) => (
    a.date === b.date
      ? (a.type === b.type ? a.value - b.value : a.type === 'split' ? -1 : 1)
      : a.date.localeCompare(b.date)
  ));
}

/** Formats a Yahoo epoch timestamp as the exchange-local session date. */
export function sessionDate(timestampSeconds: number, timezone: string | null): string {
  const date = new Date(timestampSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new YahooProviderError(502, 'Yahoo returned a timestamp that is not a valid date.');
  }
  const zone = validTimeZone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) {
    throw new YahooProviderError(502, 'Yahoo returned a timestamp that is not a valid session date.');
  }
  return `${year}-${month}-${day}`;
}

function validTimeZone(timezone: string | null): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return 'UTC';
  }
}

function volumeOrNull(values: unknown, index: number): number | null {
  if (!Array.isArray(values)) return null;
  const value = numberOrNull(values[index]);
  return value === null ? null : Math.round(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}
