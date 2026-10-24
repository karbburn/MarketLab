import { describe, expect, it } from 'vitest';
import type { BacktestConfig, Bar, StrategyRule } from '../../src/domain/types';
import { runBacktest } from '../../src/lib/backtest/engine';
import { describeRunWindow } from '../../src/lib/backtest/run-window';
import { addDays } from '../../src/lib/date';

function bar(date: string, close: number): Bar {
  return { date, open: close, high: close + 1, low: close - 1, close, volume: null };
}

/**
 * 40 rising sessions from 2020-01-20, so an SMA cross fires cleanly.
 * `addDays` steps calendar days, so the series spans 2020-01-20 to 2020-02-28;
 * any window dates used below must fall inside that span (or before/after it
 * deliberately for the shortfall cases).
 */
function series(count: number): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(addDays('2020-01-20', index), 100 + index));
}

function rule(field: StrategyRule['field'], operator: StrategyRule['operator'], value: number, window: number): StrategyRule {
  return { id: `${field}-${window}`, field, operator, value, window };
}

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    id: 'bt',
    name: 'test',
    datasetId: 'ds',
    startDate: null,
    endDate: null,
    initialCapital: 10_000,
    positionSizePct: 100,
    commissionBps: 10,
    slippageBps: 0,
    stopLossPct: null,
    takeProfitPct: null,
    entry: [rule('sma-cross', 'crosses-above', 0, 5)],
    exit: [rule('sma-cross', 'crosses-below', 0, 3)],
    entryLogic: 'AND',
    exitLogic: 'AND',
    execution: 'next-open',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('describeRunWindow', () => {
  const bars = series(40);

  it('reports the full stored window with no notes when no range is requested', () => {
    const report = describeRunWindow(config(), bars);
    expect(report.effectiveStart).toBe(bars[0]?.date);
    expect(report.effectiveEnd).toBe(bars[39]?.date);
    expect(report.storedSessions).toBe(40);
    expect(report.notes.filter((note) => note.tone === 'warn')).toHaveLength(0);
  });

  it('reproduces the engine result the run would produce', () => {
    const cfg = config();
    const report = describeRunWindow(cfg, bars);
    const result = runBacktest(bars, cfg);
    expect(result.equityCurve.length).toBe(report.evaluatedSessions);
    expect(result.equityCurve.length).toBe(report.storedSessions - report.warmupSessions);
    expect(result.equityCurve[0]?.date).toBe(report.evaluatedStart);
  });

  it('discloses a requested start earlier than the first stored session', () => {
    const report = describeRunWindow(config({ startDate: '2019-01-01' }), bars);
    expect(report.effectiveStart).toBe(bars[0]?.date);
    const warns = report.notes.filter((note) => note.tone === 'warn');
    expect(warns.some((note) => note.text.includes('requested start 2019-01-01'))).toBe(true);
    expect(warns.some((note) => note.text.includes(`begins at ${bars[0]?.date}`))).toBe(true);
    expect(warns.some((note) => note.text.includes('not stored in this dataset'))).toBe(true);
    expect(warns.some((note) => note.text.includes('requested end'))).toBe(false);
  });

  it('discloses a requested end later than the last stored session', () => {
    const report = describeRunWindow(config({ startDate: '2001-01-01', endDate: '2030-01-01' }), bars);
    const warns = report.notes.filter((note) => note.tone === 'warn');
    expect(warns.some((note) => note.text.includes('requested end 2030-01-01'))).toBe(true);
    expect(warns.some((note) => note.text.includes(`ends at ${bars[39]?.date}`))).toBe(true);
    expect(warns.some((note) => note.text.includes('requested start'))).toBe(true);
  });

  it('notes nothing when the requested range falls inside the stored series', () => {
    const report = describeRunWindow(
      config({ startDate: '2020-02-01', endDate: '2020-02-20' }),
      bars,
    );
    expect(report.notes.filter((note) => note.tone === 'warn')).toHaveLength(0);
    expect(report.effectiveStart).toBe('2020-02-01');
    expect(report.storedSessions).toBeGreaterThan(0);
    expect(report.storedSessions).toBeLessThan(40);
  });

  it('reports the warm-up split so the evaluated start matches the equity curve', () => {
    const report = describeRunWindow(config(), bars);
    expect(report.warmupSessions).toBeGreaterThan(0);
    expect(report.evaluatedSessions).toBe(40 - report.warmupSessions);
    expect(report.evaluatedStart).toBe(bars[report.warmupSessions]?.date);
  });

  it('says nothing is evaluated when the whole window is consumed by warm-up', () => {
    const report = describeRunWindow(
      config({ startDate: '2020-01-21', endDate: '2020-01-23' }),
      bars,
    );
    expect(report.storedSessions).toBeGreaterThanOrEqual(1);
    expect(report.evaluatedSessions).toBe(0);
    expect(report.evaluatedStart).toBeNull();
    expect(report.notes.some((note) => note.text.includes('no session is evaluated'))).toBe(true);
    expect(report.notes.map((note) => note.code)).toContain('warmup-consumed-window');
  });

  it('mirrors the engine guard for a window shorter than three sessions', () => {
    const cfg = config({ startDate: '2020-01-20', endDate: '2020-01-21' });
    const report = describeRunWindow(cfg, bars);
    const result = runBacktest(bars, cfg);
    expect(report.storedSessions).toBe(2);
    expect(report.evaluatedSessions).toBe(0);
    expect(report.evaluatedStart).toBeNull();
    expect(report.notes.map((note) => note.code)).toContain('too-few-sessions');
    // The disclosure must not promise a session the engine refuses to simulate.
    expect(result.equityCurve).toEqual([]);
    expect(report.evaluatedSessions).toBe(result.equityCurve.length);
  });

  it('reports an empty window with a warn note and null dates', () => {
    const report = describeRunWindow(config({ startDate: '2025-01-01', endDate: '2025-01-05' }), bars);
    expect(report.storedSessions).toBe(0);
    expect(report.effectiveStart).toBeNull();
    expect(report.evaluatedStart).toBeNull();
    expect(report.notes.filter((note) => note.tone === 'warn')).toHaveLength(1);
    expect(report.notes[0]?.text).toContain('No stored session falls inside');
    expect(report.notes[0]?.code).toBe('no-stored-sessions');
  });

  it('gives shortfall, warm-up and empty windows distinct note codes', () => {
    const shortfall = describeRunWindow(config({ startDate: '2019-01-01' }), bars);
    const warmup = describeRunWindow(config({ startDate: '2020-01-21', endDate: '2020-01-23' }), bars);
    const empty = describeRunWindow(config({ startDate: '2025-01-01', endDate: '2025-01-05' }), bars);
    const shortfallCodes = shortfall.notes.map((note) => note.code);
    const warmupCodes = warmup.notes.map((note) => note.code);
    const emptyCodes = empty.notes.map((note) => note.code);
    expect(shortfallCodes).toContain('requested-start-shortfall');
    expect(warmupCodes).toContain('warmup-consumed-window');
    expect(emptyCodes).toEqual(['no-stored-sessions']);
    expect(new Set([...shortfallCodes, ...warmupCodes, ...emptyCodes]).size).toBeGreaterThanOrEqual(3);
  });
});
