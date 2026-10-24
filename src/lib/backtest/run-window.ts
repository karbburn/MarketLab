/**
 * What a backtest run would actually consume, computed without running it.
 *
 * The engine filters the stored bars with `selectBacktestWindow`, then consumes
 * the first `warmup` sessions of that window to build its indicator series: the
 * equity curve, the benchmark and the trade metrics start after the warm-up. The
 * Results panel previously reported both facts indirectly ("N trade(s)
 * simulated", "this run covers M stored sessions") while never naming a single
 * date, so a requested window wider than the stored series stayed invisible.
 *
 * This module reuses the engine's own helpers so it cannot drift from what the
 * engine executes. It describes the stored reality only: a requested date
 * outside the stored series is disclosed as a shortfall, never diagnosed (a
 * later listing date, a holiday or an incomplete download look identical without
 * an exchange calendar) and never filled with invented sessions.
 */

import type { BacktestConfig, Bar } from '../../domain/types';
import { compareDates } from '../date';
import { selectBacktestWindow } from './engine';
import { requiredWarmup } from './rules';

/**
 * Severity for a rendered line. `warn` marks a reason the engine cannot
 * evaluate the requested window; `info` only explains a shift that still
 * produced an equity curve.
 */
export type RunWindowNoteTone = 'info' | 'warn';

/**
 * A stable reason code. The component chooses its heading from the code rather
 * than from the prose, so a warm-up case can never be described as a
 * missing-data case.
 */
export type RunWindowNoteCode =
  | 'no-stored-sessions'
  | 'requested-start-shortfall'
  | 'requested-end-shortfall'
  | 'too-few-sessions'
  | 'warmup-consumed-window'
  | 'warmup-shift';

export interface RunWindowNote {
  tone: RunWindowNoteTone;
  code: RunWindowNoteCode;
  text: string;
}

export interface RunWindowReport {
  /** Start/end dates as they were requested, possibly outside the stored series. */
  requestedStart: string | null;
  requestedEnd: string | null;
  /** First and last stored session the engine window actually contains. */
  effectiveStart: string | null;
  effectiveEnd: string | null;
  /** Sessions inside the engine window (before the warm-up excludes any). */
  storedSessions: number;
  /** Sessions consumed by indicator warm-up before the first equity point. */
  warmupSessions: number;
  /** Sessions the equity curve and trade metrics can cover. */
  evaluatedSessions: number;
  /** First session covered by the equity curve and metrics; null when none. */
  evaluatedStart: string | null;
  notes: RunWindowNote[];
}

/**
 * Describes the window a run of `config` over `bars` would simulate.
 *
 * The engine refuses nothing here and this module recomputes nothing: the
 * window slice and warm-up come from the same helpers the engine uses, so the
 * counts match the produced result 1:1 (evaluated sessions equal the equity
 * curve length whenever the engine produces one).
 */
export function describeRunWindow(config: BacktestConfig, bars: readonly Bar[]): RunWindowReport {
  const windowBars = selectBacktestWindow(bars, config.startDate, config.endDate);
  const storedSessions = windowBars.length;
  // The engine refuses a window under three bars before it even asks about
  // warm-up (`runBacktest` returns an empty result). Mirror that guard here or
  // the disclosure promises an evaluated session that cannot exist.
  const canSimulate = storedSessions >= 3;
  const warmup = canSimulate ? Math.max(requiredWarmup([...config.entry, ...config.exit]), 1) : 0;
  const evaluatedSessions = canSimulate ? Math.max(0, storedSessions - warmup) : 0;
  const effectiveStart = windowBars.length > 0 ? (windowBars[0] as Bar).date : null;
  const effectiveEnd = storedSessions > 0 ? (windowBars[storedSessions - 1] as Bar).date : null;
  const evaluatedStart = evaluatedSessions > 0 ? (windowBars[warmup] as Bar).date : null;

  const notes: RunWindowNote[] = [];

  if (storedSessions === 0) {
    notes.push({
      tone: 'warn',
      code: 'no-stored-sessions',
      text: 'No stored session falls inside the requested window, so nothing can be simulated.',
    });
  } else {
    if (config.startDate && effectiveStart && compareDates(config.startDate, effectiveStart) < 0) {
      notes.push({
        tone: 'warn',
        code: 'requested-start-shortfall',
        text:
          `The requested start ${config.startDate} is earlier than the first stored session; ` +
          `this run begins at ${effectiveStart}. Sessions before it are not stored in this dataset.`,
      });
    }
    if (config.endDate && effectiveEnd && compareDates(config.endDate, effectiveEnd) > 0) {
      notes.push({
        tone: 'warn',
        code: 'requested-end-shortfall',
        text:
          `The requested end ${config.endDate} is later than the last stored session; ` +
          `this run ends at ${effectiveEnd}.`,
      });
    }
    if (!canSimulate) {
      notes.push({
        tone: 'warn',
        code: 'too-few-sessions',
        text:
          `At least three stored sessions are needed to produce an equity curve; ` +
          `this window has ${storedSessions}, so no session is evaluated.`,
      });
    } else if (evaluatedSessions === 0) {
      notes.push({
        tone: 'warn',
        code: 'warmup-consumed-window',
        text: `The indicator warm-up needs all ${storedSessions} stored sessions in this window, so no session is evaluated.`,
      });
    } else if (warmup > 0) {
      notes.push({
        tone: 'info',
        code: 'warmup-shift',
        text:
          `The equity curve and metrics start ${warmup} sessions later, at ` +
          `${evaluatedStart ?? effectiveStart}, after the indicator warm-up.`,
      });
    }
  }

  return {
    requestedStart: config.startDate,
    requestedEnd: config.endDate,
    effectiveStart,
    effectiveEnd,
    storedSessions,
    warmupSessions: warmup,
    evaluatedSessions,
    evaluatedStart,
    notes,
  };
}
