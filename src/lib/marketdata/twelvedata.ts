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
 */

import { isDateString } from '../date';
import {
  YahooProviderError,
  type HistoryQuery,
  type YahooBar,
  type YahooHistoryPayload,
} from './yahoo';

export const TWELVE_DATA_PROVIDER_ID = 'twelve-data';
export const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';
export const TWELVE_DATA_MAX_OUTPUTSIZE = 5000;
export const TWELVE_DATA_ADJUSTMENT =
  'splits-applied, dividends not reinvested (as-traded OHLC); adjusted close not reported';
export const TWELVE_DATA_SOURCE_NOTES = [
  'Twelve Data is a commercial data provider; availability depends on the configured plan and rate limits.',
  'Used only as a fallback when the primary provider fails and a server-side API key is configured.',
  'Daily exchange-session bars only; MarketLab aggregates weekly/monthly locally.',
  'The time-series response does not include corporate-action events, so none are attached.',
  'Adjusted close is not reported by this endpoint; adjClose stays null rather than being inferred.',
  `At most ${TWELVE_DATA_MAX_OUTPUTSIZE.toLocaleString('en-US')} bars are returned per request.`,
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
): Promise<YahooHistoryPayload> {
  const key = apiKey.trim();
  if (key.length === 0) {
    throw new YahooProviderError(502, 'Twelve Data is not configured on this server.');
  }

  const payload = await fetchTwelveDataJson(
    twelveDataTimeSeriesUrl(input.symbol, input.start, input.end),
    key,
    fetchImpl,
  );
  return normaliseTwelveDataSeries(payload, input);
}

/** Converts a Twelve Data time-series response into the shared contract. */
export function normaliseTwelveDataSeries(
  payload: unknown,
  request: HistoryQuery,
  retrievedAt: string = new Date().toISOString(),
): YahooHistoryPayload {
  const record = asRecord(payload);
  if (!record) {
    throw new YahooProviderError(502, 'Twelve Data returned a response that is not a JSON object.');
  }
  if (record.status === 'error') {
    throw twelveDataEnvelopeError(record);
  }

  const values = record.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new YahooProviderError(404, 'No data found for this symbol and range in Twelve Data.');
  }

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

// ---------------------------------------------------------------- internals

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
