/**
 * Hosted history policy: Yahoo first, optional Twelve Data fallback.
 *
 * The fallback is dormant unless the server has `TWELVE_DATA_API_KEY`. It never
 * runs for invalid caller input, for a window the primary provider says it
 * cannot serve, or after a successful Yahoo response. When both providers fail,
 * the error names both failures rather than presenting a partial result or a
 * fabricated empty series. The fallback itself must retrieve every requested
 * session for the download to exist at all: the adapter fetches long ranges in
 * bounded windows, and a window that fails (or a budget that refuses an
 * attempt) aborts the whole download honestly.
 */

import {
  YahooProviderError,
  fetchYahooHistory,
  type HistoryQuery,
  type YahooHistoryPayload,
} from './yahoo';
import {
  FallbackBudgetExhaustedError,
  fetchTwelveDataHistory,
} from './twelvedata';

export interface HostedHistoryOptions {
  /** Server-side key; never sent to the browser. */
  twelveDataApiKey?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Called by the Twelve Data adapter immediately before every one of its
   * provider attempts — one window per bounded range segment, including a
   * retried window — so a longer-range fallback spends one credit per real
   * call. Returning false spends nothing and aborts the fallback with an error
   * that names both the Yahoo failure and the exhausted budget. Charging only
   * happens when the provider is really contacted: invalid input, ineligible
   * Yahoo failures and successful Yahoo responses never consume budget.
   */
  spendFallbackCredit?: () => boolean;
}

/** True when a second provider could plausibly satisfy the request. */
export function isTwelveDataFallbackEligible(error: unknown): boolean {
  return error instanceof YahooProviderError && error.status !== 400 && error.fallbackEligible;
}

export async function fetchHostedHistory(
  input: HistoryQuery,
  options: HostedHistoryOptions = {},
): Promise<YahooHistoryPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.twelveDataApiKey?.trim() ?? '';

  try {
    return await fetchYahooHistory(input, fetchImpl);
  } catch (yahooError) {
    if (apiKey.length === 0 || !isTwelveDataFallbackEligible(yahooError)) {
      throw yahooError;
    }
    const messageOfYahoo = messageOf(yahooError);

    try {
      return await fetchTwelveDataHistory(input, apiKey, fetchImpl, {
        spendFallbackCredit: options.spendFallbackCredit,
      });
    } catch (twelveDataError) {
      if (twelveDataError instanceof FallbackBudgetExhaustedError) {
        throw new YahooProviderError(
          502,
          `Both market-data sources are unavailable right now. Yahoo Finance: ${messageOfYahoo}`
            + ' The fallback budget for Twelve Data is spent; try again after the budget window resets.',
        );
      }
      throw combinedProviderError(yahooError, twelveDataError, input.symbol);
    }
  }
}

/**
 * Reads the optional key from the server environment. Vercel exposes it to the
 * edge function at runtime; tests and other runtimes simply see no key.
 */
export function twelveDataApiKeyFromEnv(): string | null {
  const processLike = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const value = processLike?.env?.TWELVE_DATA_API_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

function combinedProviderError(
  yahooError: unknown,
  twelveDataError: unknown,
  symbol: string,
): YahooProviderError {
  const yahooStatus = statusOf(yahooError);
  const twelveDataStatus = statusOf(twelveDataError);

  if (yahooStatus === 404 && twelveDataStatus === 404) {
    return new YahooProviderError(
      404,
      `No data found for symbol ${symbol} in either Yahoo Finance or Twelve Data.`,
    );
  }
  // A shared condition is claimed only when both providers actually reported it.
  // Labelling a Yahoo throttle plus a Twelve Data key rejection as "both
  // throttling" would tell the user to retry a request that cannot succeed.
  if (yahooStatus === 429 && twelveDataStatus === 429) {
    return new YahooProviderError(
      429,
      'Both market-data providers are throttling requests. Wait a moment and try again.',
    );
  }
  if (yahooStatus === 503 && twelveDataStatus === 503) {
    return new YahooProviderError(
      503,
      `Both market-data providers timed out. Yahoo Finance: ${messageOf(yahooError)} Twelve Data: ${messageOf(twelveDataError)}`,
    );
  }
  return new YahooProviderError(
    502,
    `Both market-data providers failed. Yahoo Finance: ${messageOf(yahooError)} Twelve Data: ${messageOf(twelveDataError)}`,
  );
}

function statusOf(error: unknown): number | null {
  return error instanceof YahooProviderError ? error.status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'the provider request failed';
}
