import { describe, expect, it } from 'vitest';
import { MarketDataError } from '../../src/lib/marketdata/client';
import {
  MAX_QUEUE_SYMBOLS,
  parseSymbolList,
  runDownloadQueue,
  type QueueItem,
} from '../../src/lib/marketdata/queue';
import type { ProviderHistory } from '../../src/lib/marketdata/normalize';

/**
 * Deterministic suite for the bulk download queue. No network and no real
 * timers: the fetch, save, clock and sleep are all injected, so the exact
 * request order, pause behaviour and failure isolation are asserted directly.
 */

function history(symbol: string, sessions = 3): ProviderHistory {
  const bars = Array.from({ length: sessions }, (_, index) => {
    const day = String(index + 2).padStart(2, '0');
    const close = 10 + index;
    return { date: `2024-01-${day}`, open: close, high: close + 1, low: close - 1, close, adjClose: close, volume: 100 };
  });
  return {
    providerMetadata: {
      provider: 'yahoo-finance',
      providerSymbol: symbol,
      displaySymbol: symbol,
      displayName: `${symbol} Inc.`,
      exchange: 'NMS',
      exchangeName: 'NasdaqGS',
      instrumentType: 'EQUITY',
      currency: 'USD',
      timezone: 'America/New_York',
      interval: '1d',
      adjustment: 'splits applied',
      rangeRequested: { start: '2024-01-01', end: '2024-01-31' },
      rangeActual: { start: bars[0]!.date, end: bars[bars.length - 1]!.date },
      retrievedAt: '2026-10-19T12:00:00+00:00',
      sourceNotes: [],
      corporateActions: [],
    },
    bars,
  };
}

const RANGE = { start: '2024-01-01', end: '2024-01-31' };

function collector() {
  const snapshots: QueueItem[][] = [];
  return { snapshots, onUpdate: (items: readonly QueueItem[]) => snapshots.push(items.map((item) => ({ ...item }))) };
}

describe('parseSymbolList', () => {
  it('splits on whitespace, commas and semicolons and upper-cases the tokens', () => {
    const parsed = parseSymbolList('aapl, msft\nNVDA;googl  amzn');
    expect(parsed.symbols).toEqual(['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN']);
    expect(parsed.invalid).toHaveLength(0);
    expect(parsed.duplicates).toHaveLength(0);
  });

  it('folds case-insensitive repeats into the first occurrence and reports them', () => {
    const parsed = parseSymbolList('AAPL aapl Aapl MSFT');
    expect(parsed.symbols).toEqual(['AAPL', 'MSFT']);
    expect(parsed.duplicates).toEqual(['AAPL', 'AAPL']);
  });

  it('reports invalid tokens instead of silently dropping them', () => {
    const parsed = parseSymbolList('AAPL ??bad?? this-token-is-far-too-long MSFT');
    expect(parsed.symbols).toEqual(['AAPL', 'MSFT']);
    expect(parsed.invalid.map((problem) => problem.token)).toEqual(['??bad??', 'this-token-is-far-too-long']);
    expect(parsed.invalid[0]?.reason).toMatch(/unsupported/i);
  });

  it('caps the batch and reports how many valid symbols were left out', () => {
    const parsed = parseSymbolList('AAPL MSFT NVDA AMZN', 2);
    expect(parsed.symbols).toEqual(['AAPL', 'MSFT']);
    expect(parsed.droppedForLimit).toBe(2);
  });

  it('exposes the cap used by the UI', () => {
    expect(MAX_QUEUE_SYMBOLS).toBeGreaterThan(0);
    expect(parseSymbolList('AAPL', MAX_QUEUE_SYMBOLS).symbols).toEqual(['AAPL']);
  });
});

describe('runDownloadQueue', () => {
  it('downloads and saves every symbol in order', async () => {
    const requested: string[] = [];
    const saved: string[] = [];
    const sleepCalls: number[] = [];
    const { snapshots, onUpdate } = collector();

    const result = await runDownloadQueue(
      { symbols: ['AAPL', 'MSFT'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async (symbol) => {
          requested.push(symbol);
          return history(symbol);
        },
        save: async (bundle) => {
          saved.push(bundle.instrument.symbol);
        },
        onUpdate,
        now: () => '2026-10-19T00:00:00.000Z',
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        delayMs: 500,
      },
    );

    expect(requested).toEqual(['AAPL', 'MSFT']);
    expect(saved).toEqual(['AAPL', 'MSFT']);
    expect(result.savedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.cancelled).toBe(false);
    // One pause between exactly two requests; nothing before the first.
    expect(sleepCalls).toEqual([500]);
    expect(snapshots.at(-1)?.every((item) => item.status === 'saved')).toBe(true);
  });

  it('keeps each saved series with its own session count and range', async () => {
    const result = await runDownloadQueue(
      { symbols: ['AAPL', 'MSFT'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async (symbol) => history(symbol, symbol === 'AAPL' ? 3 : 5),
        save: async () => undefined,
        now: () => '2026-10-19T00:00:00.000Z',
      },
    );

    expect(result.items[0]?.rowCount).toBe(3);
    expect(result.items[1]?.rowCount).toBe(5);
    expect(result.items[0]?.firstDate).toBe('2024-01-02');
    expect(result.items[1]?.lastDate).toBe('2024-01-06');
  });

  it('isolates a failure: the batch continues and only that symbol is failed', async () => {
    const saved: string[] = [];
    const result = await runDownloadQueue(
      { symbols: ['AAPL', 'BAD', 'MSFT'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async (symbol) => {
          if (symbol === 'BAD') throw new MarketDataError('not-found', 'No data found for symbol BAD; it may be delisted or unknown.');
          return history(symbol);
        },
        save: async (bundle) => {
          saved.push(bundle.instrument.symbol);
        },
        now: () => '2026-10-19T00:00:00.000Z',
      },
    );

    expect(saved).toEqual(['AAPL', 'MSFT']);
    expect(result.savedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.items[1]?.status).toBe('failed');
    expect(result.items[1]?.message).toMatch(/delisted or unknown/);
  });

  it('pauses longer after a throttling failure than after an ordinary one', async () => {
    const sleepCalls: number[] = [];
    await runDownloadQueue(
      { symbols: ['AAPL', 'MSFT'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async (symbol) => {
          if (symbol === 'AAPL') throw new MarketDataError('throttled', 'Yahoo throttled this request.');
          return history(symbol);
        },
        save: async () => undefined,
        now: () => '2026-10-19T00:00:00.000Z',
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        delayMs: 500,
        throttleDelayMs: 5_000,
      },
    );

    // The throttle backoff fires right after the failure; the ordinary
    // inter-request pause follows before the next symbol.
    expect(sleepCalls).toEqual([4_500, 500]);
  });

  it('stops between requests when cancelled and marks the rest skipped', async () => {
    let cancelled = false;
    const requested: string[] = [];
    const result = await runDownloadQueue(
      { symbols: ['AAPL', 'MSFT', 'NVDA'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async (symbol) => {
          requested.push(symbol);
          cancelled = true; // Cancel after the first request completes.
          return history(symbol);
        },
        save: async () => undefined,
        isCancelled: () => cancelled,
        now: () => '2026-10-19T00:00:00.000Z',
      },
    );

    expect(requested).toEqual(['AAPL']);
    expect(result.savedCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(result.cancelled).toBe(true);
    expect(result.items[1]?.message).toMatch(/cancelled/);
  });

  it('fails a symbol whose rows are all invalid rather than saving an empty dataset', async () => {
    const saved: string[] = [];
    const result = await runDownloadQueue(
      { symbols: ['BROKEN'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async () => ({
          ...history('BROKEN'),
          bars: [{ date: '2024-01-02', open: 0, high: 1, low: 0.5, close: 0.8, adjClose: 0.8, volume: 1 }],
        }),
        save: async () => {
          saved.push('BROKEN');
        },
        now: () => '2026-10-19T00:00:00.000Z',
      },
    );

    expect(saved).toEqual([]);
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.message).toMatch(/no valid daily sessions/i);
  });

  it('publishes immutable progress snapshots', async () => {
    const { snapshots, onUpdate } = collector();
    await runDownloadQueue(
      { symbols: ['AAPL'], range: RANGE, duplicatePolicy: 'keep-first' },
      {
        fetchHistory: async () => history('AAPL'),
        save: async () => undefined,
        onUpdate,
        now: () => '2026-10-19T00:00:00.000Z',
      },
    );

    // First snapshot is pending/downloading; the last is saved. The earlier
    // snapshot must not have been mutated in place by the later transition.
    expect(snapshots[0]?.[0]?.status).toBe('downloading');
    expect(snapshots.at(-1)?.[0]?.status).toBe('saved');
    expect(snapshots[0]?.[0]?.rowCount).toBeNull();
  });
});
