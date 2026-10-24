/**
 * Server-side Twelve Data adapter for the hosted market-data proxy.
 *
 * Twelve Data is an optional fallback, never a silent replacement for a
 * successful Yahoo response. It is only called when `TWELVE_DATA_API_KEY` is
 * configured on the server and Yahoo fails in a way that a second provider can
 * plausibly fix. The key is read from the server environment and sent in an
 * Authorization header; it is never included in a URL or in a response.
 *
 * Honesty rules:
 * - `adjust=splits` keeps OHLC split-adjusted and dividends unreinvested, which
 *   matches the primary adapter's declared convention.
 * - The time-series endpoint does not return a separate adjusted close or
 *   corporate-action rows. `adjClose` is null and `corporateActions` is empty;
 *   neither is inferred from prices.
 * - String values are parsed only when they are finite numbers. Missing values
 *   stay null and are rejected by the shared validator instead of being filled.
 *
 * Long-history rule: the time-series endpoint caps any single request at
 * 5,000 rows and exposes no continuation parameter, and an overlong range is
 * answered with the most recent 5,000 sessions. Ranges are therefore fetched
 * as sequential bounded windows of at most 4,500 calendar days (for the
 * 1day interval at most one session can exist per calendar day, so a window
 * can never need more than 4,500 rows). Every window must succeed for the
 * download to exist: a silent hole between windows is undetectable afterwards,
 * so a failed window aborts the whole download instead of trading completeness
 * for partial data. No bar is ever synthesized for a window a provider could
 * not supply.
 */

import { addDays, isDateString } from '../date';
import type { DateString } from '../../domain/types';
import {
  YahooProviderError,
  type HistoryQuery,
  type YahooBar,
  type YahooHistoryPayload,
} from './yahoo';

export const TWELVE_DATA_PROVIDER_ID = 'twelve-data';
export const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';
export const TWELVE_DATA_MAX_OUTPUTSIZE = 5000;
/**
 * Maximum calendar days per request window. For the 1day interval a session
 * can exist at most once per calendar day, so a window of 4,500 days can
 * contain at most 4,500 sessions — always below the provider's 5,000-row
 * request ceiling, independent of instrument or plan.
 */
export const TWELVE_DATA_MAX_WINDOW_DAYS = 4500;
const MAX_PAGE_ATTEMPTS = 2;
const MAX_WINDOW_COUNT = 40;
export const TWELVE_DATA_ADJUSTMENT =
  'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported';
export const TWELVE_DATA_SOURCE_NOTES = [
  'Twelve Data is a commercial data provider; availability depends on the configured plan and rate limits.',
  'Used only as a fallback when the primary provider fails and a server-side API key is configured.',
  'Daily exchange-session bars only; MarketLab aggregates weekly/monthly locally.',
  'The time-series response does not include corporate-action events, so none are attached.',
  'Adjusted close is not reported by this endpoint; adjClose stays null rather than being inferred.',
  `At most ${TWELVE_DATA_MAX_OUTPUTSIZE.toLocaleString('en-US')} bars are returned per request.`,
  `A range wider than one request is fetched as sequential windows of at most ${TWELVE_DATA_MAX_WINDOW_DAYS.toLocaleString('en-US')} calendar days, each charged separately.`,
] as const;

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Builds the time-series request. The API key deliberately does not appear
 * here: it belongs in the Authorization header so it cannot leak through URLs,
 * proxy logs or error messages.
 */
export function twelveDataTimeSeriesUrl(
  symbol: string,
  start: string,
  end: string,
  baseUrl: string = TWELVE_DATA_BASE_URL,
): string {
  const params = new URLSearchParams({
    symbol,
    interval: '1day',
    start_date: start,
    end_date: end,
    outputsize: String(TWELVE_DATA_MAX_OUTPUTSIZE),
    order: 'asc',
    adjust: 'splits',
  });
  return `${baseUrl.replace(/\/+$/, '')}/time_series?${params.toString()}`;
}

export async function fetchTwelveDataHistory(
  input: HistoryQuery,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  options: TwelveDataFetchOptions = {},
): Promise<YahooHistoryPayload> {
  const key = apiKey.trim();
  if (key.length === 0) {
    throw new YahooProviderError(502, 'Twelve Data is not configured on this server.');
  }

  const pages: TwelveDataPage[] = [];
  for (const window of twelveDataPageWindows(input.start, input.end)) {
    const page = await fetchTwelveDataPage(input.symbol, window, key, fetchImpl, options);
    if (page) pages.push(page);
  }
  return mergedTwelveDataPayload(pages, input);
}

// ---------------------------------------------------------------- internals

/** Options for the Twelve Data fetch when it is called as a policy fallback. */
export interface TwelveDataFetchOptions {
  /**
   * Called immediately before every Twelve Data HTTP attempt (including a
   * retry of one window). Returning false spends nothing and aborts with a
   * budget-exhausted failure the hosted policy turns into its combined
   * "both sources unavailable" message.
   */
  spendFallbackCredit?: () => boolean;
}

/** Thrown when the fallback budget refuses a Twelve Data attempt. */
export class FallbackBudgetExhaustedError extends Error {
  constructor() {
    super('The fallback budget for Twelve Data is spent.');
    this.name = 'FallbackBudgetExhaustedError';
  }
}

/**
 * Half-open session-date window. The provider's daily `end_date` is exclusive
 * (verified: requesting end 2024-01-18 returned sessions only through
 * 2024-01-17), so a window that must include through session `E` sends
 * `end_date = E + 1 day`. Inclusive or exclusive provider behaviour is both
 * safe: the merge deduplicates boundary sessions and filters to the requested
 * range.
 */
export interface TwelveDataWindow {
  start: DateString;
  end: DateString;
}

/**
 * Splits a requested range into sequential windows small enough that no
 * request can ever exceed the provider's per-request bar ceiling, whatever the
 * instrument's session density. Windows are adjacent (the next starts where
 * the previous ends), never parallel, and cover the range exactly.
 */
export function twelveDataPageWindows(
  start: DateString,
  end: DateString,
  maxWindowDays: number = TWELVE_DATA_MAX_WINDOW_DAYS,
): TwelveDataWindow[] {
  const requestedEnd = addDays(end, 1);
  const windows: TwelveDataWindow[] = [];
  let cursor = start;
  while (cursor < requestedEnd) {
    if (windows.length >= MAX_WINDOW_COUNT) {
      throw new YahooProviderError(502, 'The requested history range is too long to fetch safely.');
    }
    const naturalEnd = addDays(cursor, maxWindowDays);
    const windowEnd = naturalEnd < requestedEnd ? naturalEnd : requestedEnd;
    windows.push({ start: cursor, end: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

interface TwelveDataPage {
  meta: Record<string, unknown>;
  bars: YahooBar[];
}

/**
 * Fetches one window. Returns null when the window holds no sessions (an
 * empty page is normal for a window that predates the instrument or sits in a
 * long suspension) and throws for a provider failure. Transient faults get one
 * immediate second attempt; throttling, rejected input and key problems fail
 * fast because an immediate retry cannot win.
 */
async function fetchTwelveDataPage(
  symbol: string,
  window: TwelveDataWindow,
  key: string,
  fetchImpl: typeof fetch,
  options: TwelveDataFetchOptions,
): Promise<TwelveDataPage | null> {
  const url = twelveDataTimeSeriesUrl(symbol, window.start, window.end);
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    // Every real provider call is charged, including a retry inside a window.
    if (options.spendFallbackCredit && !options.spendFallbackCredit()) {
      throw new FallbackBudgetExhaustedError();
    }
    try {
      return parseTwelveDataPage(await fetchTwelveDataJson(url, key, fetchImpl));
    } catch (error) {
      if (error instanceof YahooProviderError && error.status === 404) return null;
      if (attempt < MAX_PAGE_ATTEMPTS && isTransientTwelveDataFailure(error)) continue;
      throw error;
    }
  }
  throw new YahooProviderError(502, 'The Twelve Data request failed.');
}

function isTransientTwelveDataFailure(error: unknown): boolean {
  return error instanceof YahooProviderError
    && (error.status === 502 || error.status === 503);
}

/**
 * Reads one provider window response. Returns null when the window carries no
 * rows (either an explicit not-found or an empty values list).
 */
function parseTwelveDataPage(payload: unknown): TwelveDataPage | null {
  const record = asRecord(payload);
  if (!record) {
    throw new YahooProviderError(502, 'Twelve Data returned a response that is not a JSON object.');
  }
  if (record.status === 'error') {
    const error = twelveDataEnvelopeError(record);
    if (error.status === 404) return null;
    throw error;
  }

  const values = record.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  const meta = asRecord(record.meta) ?? {};
  const bars: YahooBar[] = values.map((entry) => {
    const row = asRecord(entry);
    if (!row) {
      throw new YahooProviderError(502, 'Twelve Data returned a non-object time-series row.');
    }
    return {
      date: sessionDate(row.datetime),
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close: numberOrNull(row.close),
      // The endpoint has no separate adjusted-close series.
      adjClose: null,
      volume: volumeOrNull(row.volume),
    };
  });

  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { meta, bars };
}

/**
 * Merges page results into one payload. Adjacent windows never overlap, but
 * the provider could report a boundary session in both windows under different
 * end-date semantics: the earliest window's value is kept, exactly one bar is
 * emitted per session date, results are filtered to the requested range and
 * sorted ascending. Metadata is taken from the first successful page.
 */
function mergedTwelveDataPayload(
  pages: TwelveDataPage[],
  request: HistoryQuery,
  retrievedAt: string = new Date().toISOString(),
): YahooHistoryPayload {
  if (pages.length === 0) {
    throw new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
  }
  const byDate = new Map<string, YahooBar>();
  for (const page of pages) {
    for (const bar of page.bars) {
      if (byDate.has(bar.date)) continue;
      if (bar.date < request.start || bar.date > request.end) continue;
      byDate.set(bar.date, bar);
    }
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) {
    throw new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
  }

  const meta = pages[0]!.meta ?? {};
  return {
    provider: {
      provider: TWELVE_DATA_PROVIDER_ID,
      providerSymbol: request.symbol,
      displaySymbol: request.symbol,
      // The time-series metadata does not include a display name.
      displayName: null,
      exchange: nullableString(meta.mic_code) ?? nullableString(meta.exchange),
      exchangeName: nullableString(meta.exchange),
      instrumentType: nullableString(meta.type),
      currency: nullableString(meta.currency),
      timezone: nullableString(meta.exchange_timezone),
      interval: '1d',
      adjustment: TWELVE_DATA_ADJUSTMENT,
      rangeRequested: { start: request.start, end: request.end },
      rangeActual: { start: bars[0]!.date, end: bars[bars.length - 1]!.date },
      retrievedAt,
      sourceNotes: TWELVE_DATA_SOURCE_NOTES,
      // Twelve Data's time-series endpoint does not report these events.
      corporateActions: [],
    },
    bars,
  };
}

/**
 * Converts a single response into the shared contract. Kept as the public
 * normalisation entry point for callers that process one provider payload
 * directly; the multi-window fetch above uses the same page and merge logic.
 * Unlike the fetch path, an empty values list is reported as "no data" for the
 * requested range rather than as an empty page.
 */
export function normaliseTwelveDataSeries(
  payload: unknown,
  request: HistoryQuery,
  retrievedAt: string = new Date().toISOString(),
): YahooHistoryPayload {
  const page = parseTwelveDataPage(payload);
  if (!page) {
    throw new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
  }
  return mergedTwelveDataPayload([page], request, retrievedAt);
}

async function fetchTwelveDataJson(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `apikey ${apiKey}`,
      },
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw twelveDataHttpError(response.status, payload);
    }
    if (payload === null) {
      throw new YahooProviderError(502, 'Twelve Data returned a body that is not valid JSON.');
    }
    const record = asRecord(payload);
    if (record?.status === 'error') {
      throw twelveDataEnvelopeError(record);
    }
    return payload;
  } catch (error) {
    if (error instanceof YahooProviderError) throw error;
    if (isAbortError(error)) {
      throw new YahooProviderError(503, 'The Twelve Data request timed out.');
    }
    throw new YahooProviderError(502, 'The Twelve Data request failed.');
  } finally {
    clearTimeout(timer);
  }
}

function twelveDataHttpError(status: number, payload: unknown): YahooProviderError {
  const record = asRecord(payload);
  const message = nullableString(record?.message);
  return twelveDataStatusError(status, message);
}

function twelveDataEnvelopeError(record: Record<string, unknown>): YahooProviderError {
  const status = typeof record.code === 'number'
    ? record.code
    : Number(nullableString(record.code));
  const message = nullableString(record.message);
  return twelveDataStatusError(Number.isFinite(status) ? status : 502, message);
}

function twelveDataStatusError(status: number, message: string | null): YahooProviderError {
  if (status === 404) {
    return new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
  }
  if (status === 429) {
    return new YahooProviderError(429, 'Twelve Data is throttling requests. Wait a moment and try again.');
  }
  if (status === 400) {
    const text = (message ?? '').toLowerCase();
    if (text.includes('not found') || text.includes('no data') || text.includes('invalid symbol')) {
      return new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
    }
    return new YahooProviderError(502, 'Twelve Data rejected the request parameters.');
  }
  if (status === 401 || status === 403) {
    return new YahooProviderError(
      502,
      'Twelve Data rejected the server API key or the key does not cover this request.',
    );
  }
  if (status === 408 || status === 504) {
    return new YahooProviderError(503, 'The Twelve Data request timed out.');
  }
  return new YahooProviderError(502, `Twelve Data request failed with HTTP ${status}.`);
}

function sessionDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw new YahooProviderError(502, 'Twelve Data returned a row without a session date.');
  }
  // Daily responses use an exchange-local date; an ISO timestamp is reduced to
  // its date prefix without converting between timezones.
  const date = value.slice(0, 10);
  if (!isDateString(date)) {
    throw new YahooProviderError(502, 'Twelve Data returned a row with an invalid session date.');
  }
  return date;
}

function volumeOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
