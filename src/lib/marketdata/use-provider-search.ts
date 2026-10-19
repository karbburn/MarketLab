/**
 * Provider-backed symbol suggestions, shared by the single and batch download
 * dialogs.
 *
 * The hook only owns the external async call lifecycle: a search is debounced,
 * the previous request is aborted, and results are keyed to the query they
 * answer, so a slow response for an older query can never be shown as if it
 * belonged to what the operator is typing now. When the service is not running
 * the failure is reported (`unavailable`) instead of looking like "no matches".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SERVICE_URL, fetchProviderSearch } from './client';
import type { ProviderSearchResult } from './normalize';
import { SYMBOL_PATTERN } from './queue';
import { MIN_SUGGEST_QUERY_LENGTH } from './symbol-suggest';

/** Long enough that typing a word asks the provider once, short enough to feel live. */
export const SEARCH_DEBOUNCE_MS = 400;

interface SearchResult {
  query: string;
  items: ProviderSearchResult[];
  failed: boolean;
}

export interface ProviderSymbolSearch {
  /** Matches for the current query, or null while there is nothing to show. */
  suggestions: ProviderSearchResult[] | null;
  searching: boolean;
  /** The service could not be reached, which is not the same as "no matches". */
  unavailable: boolean;
  /**
   * Hides the list for the exact text that was just inserted, so accepting a
   * ticker does not immediately reopen the dropdown on top of it. Typing
   * anything else searches again.
   */
  dismiss: (value: string) => void;
}

export function useProviderSymbolSearch(
  query: string,
  enabled: boolean,
  limit = 8,
  baseUrl: string = DEFAULT_SERVICE_URL,
): ProviderSymbolSearch {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [suppressed, setSuppressed] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();
  const searchable =
    enabled &&
    trimmed.length >= MIN_SUGGEST_QUERY_LENGTH &&
    SYMBOL_PATTERN.test(trimmed) &&
    suppressed !== trimmed;

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      fetchProviderSearch(trimmed, limit, baseUrl, controller.signal)
        .then((items) => {
          if (!controller.signal.aborted) setResult({ query: trimmed, items, failed: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ query: trimmed, items: [], failed: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [searchable, trimmed, limit, baseUrl]);

  const dismiss = useCallback((value: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResult(null);
    setSuppressed(value.trim());
  }, []);

  // Results are only ever shown for the query they were fetched for.
  const settled = searchable && result !== null && result.query === trimmed ? result : null;

  return {
    suggestions: settled && !settled.failed ? settled.items : null,
    searching: searchable && settled === null,
    unavailable: settled?.failed === true,
    dismiss,
  };
}
