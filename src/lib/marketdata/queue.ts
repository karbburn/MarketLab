/**
 * Bulk download planning and execution.
 *
 * The queue is provider-agnostic and side-effect free: the caller injects the
 * network fetch and the save action, so an entire run can be unit tested with
 * fakes and no real timers. It never invents a dataset — a symbol that fails is
 * reported as failed with the provider's own message, and the run continues, so
 * one bad ticker cannot discard the rest of the batch.
 */

import type { DuplicatePolicy } from '../validation/dataset';
import { describeMarketDataFailure, isMarketDataThrottled } from './client';
import {
  buildDatasetBundle,
  validateProviderBars,
  type DatasetBundle,
  type ProviderHistory,
} from './normalize';

/** Symbols follow the same provider convention the single download enforces. */
export const SYMBOL_PATTERN = /^[A-Za-z0-9._^=:-]{1,16}$/;

/** A batch is capped so a paste of a whole universe cannot be requested by accident. */
export const MAX_QUEUE_SYMBOLS = 50;

export interface SymbolListProblem {
  token: string;
  reason: string;
}

export interface ParsedSymbolList {
  /** Valid, de-duplicated symbols in the order they first appeared. */
  symbols: string[];
  invalid: SymbolListProblem[];
  /** Repeated tokens that were folded into an earlier occurrence. */
  duplicates: string[];
  /** Valid symbols left out because the list exceeded the cap. */
  droppedForLimit: number;
}

const TOKEN_SEPARATOR = /[\s,;]+/;

/**
 * Parses a free-form symbol list.
 *
 * Tokens are upper-cased, validated, de-duplicated case-insensitively (order
 * preserved) and capped. Nothing is discarded silently: invalid tokens, repeats
 * and over-limit symbols are all reported so the UI can say exactly what will
 * and will not be requested.
 */
export function parseSymbolList(raw: string, limit: number = MAX_QUEUE_SYMBOLS): ParsedSymbolList {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const invalid: SymbolListProblem[] = [];
  const duplicates: string[] = [];
  let droppedForLimit = 0;

  for (const token of raw.split(TOKEN_SEPARATOR)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const symbol = trimmed.toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) {
      invalid.push({ token: trimmed, reason: 'Unsupported characters or length' });
      continue;
    }
    if (seen.has(symbol)) {
      duplicates.push(symbol);
      continue;
    }
    if (symbols.length >= limit) {
      droppedForLimit += 1;
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
  }

  return { symbols, invalid, duplicates, droppedForLimit };
}

export type QueueItemStatus = 'pending' | 'downloading' | 'saved' | 'failed' | 'skipped';

export interface QueueItem {
  symbol: string;
  status: QueueItemStatus;
  /** Failure text as reported by the provider, or null. */
  message: string | null;
  rowCount: number | null;
  firstDate: string | null;
  lastDate: string | null;
}

export interface DownloadRange {
  start: string;
  end: string;
}

export interface DownloadQueueDeps {
  fetchHistory(symbol: string, range: DownloadRange): Promise<ProviderHistory>;
  save(bundle: DatasetBundle): Promise<void>;
  /** Called after any item changes so the caller can render progress. */
  onUpdate?(items: readonly QueueItem[]): void;
  /** Cooperative cancellation, checked before each symbol is requested. */
  isCancelled?(): boolean;
  /** Injected for deterministic tests; defaults to the real clock. */
  now?(): string;
  sleep?(ms: number): Promise<void>;
  /** Polite pause kept between successful requests to the provider. */
  delayMs?: number;
  /** Longer pause applied after a throttling failure. */
  throttleDelayMs?: number;
}

export interface DownloadQueueOptions {
  symbols: readonly string[];
  range: DownloadRange;
  duplicatePolicy: DuplicatePolicy;
}

export interface DownloadQueueResult {
  items: QueueItem[];
  savedCount: number;
  failedCount: number;
  skippedCount: number;
  cancelled: boolean;
}

/** Runs the batch sequentially; each symbol is downloaded, validated and saved on its own. */
export async function runDownloadQueue(
  options: DownloadQueueOptions,
  deps: DownloadQueueDeps,
): Promise<DownloadQueueResult> {
  const delayMs = Math.max(0, deps.delayMs ?? 0);
  const throttleDelayMs = Math.max(delayMs, deps.throttleDelayMs ?? delayMs);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date().toISOString());

  const items: QueueItem[] = options.symbols.map((symbol) => ({
    symbol,
    status: 'pending',
    message: null,
    rowCount: null,
    firstDate: null,
    lastDate: null,
  }));
  const publish = () => deps.onUpdate?.(items.map((item) => ({ ...item })));

  let cancelled = false;
  let requested = 0;

  for (const item of items) {
    if (deps.isCancelled?.()) {
      cancelled = true;
      break;
    }
    // Pause only between two real requests, never before the first one.
    if (requested > 0 && delayMs > 0) await sleep(delayMs);
    requested += 1;

    item.status = 'downloading';
    publish();

    try {
      const history = await deps.fetchHistory(item.symbol, options.range);
      const validation = validateProviderBars(history.bars, options.duplicatePolicy);
      if (validation.fatalErrors.length > 0) {
        throw new Error('No valid daily sessions were returned for this symbol and range.');
      }
      const bundle = buildDatasetBundle({ history, validation, importedAt: now() });
      await deps.save(bundle);
      item.status = 'saved';
      item.rowCount = bundle.bars.length;
      item.firstDate = bundle.dataset.firstDate;
      item.lastDate = bundle.dataset.lastDate;
    } catch (error) {
      item.status = 'failed';
      item.message = describeMarketDataFailure(error);
      const wait = waitAfterFailure(error, delayMs, throttleDelayMs);
      if (wait > 0) await sleep(wait);
    }
    publish();
  }

  if (cancelled) {
    for (const item of items) {
      if (item.status === 'pending') {
        item.status = 'skipped';
        item.message = 'Not requested: the batch was cancelled.';
      }
    }
    publish();
  }

  return {
    items,
    savedCount: items.filter((item) => item.status === 'saved').length,
    failedCount: items.filter((item) => item.status === 'failed').length,
    skippedCount: items.filter((item) => item.status === 'skipped').length,
    cancelled,
  };
}

/**
 * Extra pause owed after a failure. Throttling (HTTP 429) is the provider
 * explicitly asking for patience, so it earns the longer delay; every other
 * failure just carries the ordinary inter-request pause.
 */
function waitAfterFailure(error: unknown, delayMs: number, throttleDelayMs: number): number {
  return isMarketDataThrottled(error) ? Math.max(0, throttleDelayMs - delayMs) : 0;
}
