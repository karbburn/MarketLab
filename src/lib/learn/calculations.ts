/**
 * Arithmetic used by the learning page.
 *
 * This is deliberately separate from `lib/quant/metrics.ts`: the page must not
 * change any production calculation. The CAGR example mirrors the app's
 * convention (calendar years measured with 365.25 days and a 30-day cutoff) so
 * the explanation and the product cannot drift apart without a test failing.
 */

export const CALENDAR_DAYS_PER_YEAR = 365.25;
export const MIN_CAGR_DAYS = 30;
export const SCREEN_DRILL_SESSIONS = 12;
export const SCREEN_DRILL_WINDOW = 6;

export interface ScreenDrillResult {
  /** Sessions available at the cutoff, including the cutoff session. */
  sessions: number;
  /** Sessions a return or drawdown window needs, including both endpoints. */
  required: number;
  available: boolean;
  /** Sessions after the cutoff, which the screen never reads. */
  after: number;
}

/**
 * The arithmetic behind the screener cutoff drill. A six-session return needs
 * seven closes, so a cutoff at S6 is one session too early.
 */
export function screenWindowDrill(
  cutoffSessions: number,
  windowSessions = SCREEN_DRILL_WINDOW,
): ScreenDrillResult {
  const sessions = Math.max(0, Math.min(SCREEN_DRILL_SESSIONS, Math.round(cutoffSessions)));
  const required = Math.max(2, Math.round(windowSessions) + 1);
  return {
    sessions,
    required,
    available: sessions >= required,
    after: SCREEN_DRILL_SESSIONS - sessions,
  };
}

export type CagrExampleResult =
  | { status: 'incomplete' }
  | { status: 'invalid'; message: string }
  | {
      status: 'ok';
      totalReturnPct: number;
      years: number;
      cagrPct: number | null;
      cagrWithheld: boolean;
    };

/**
 * Computes the example shown under "CAGR with your own numbers".
 *
 * `null` means the field is empty. Values are numbers rather than strings so
 * the page can parse its inputs once and the arithmetic stays testable.
 */
export function calculateCagrExample(
  start: number | null,
  end: number | null,
  days: number | null,
): CagrExampleResult {
  if (start === null || end === null || days === null) return { status: 'incomplete' };
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(days)) {
    return { status: 'invalid', message: 'Enter finite numbers.' };
  }
  if (start <= 0 || end <= 0) {
    return { status: 'invalid', message: 'Start and end values must be greater than zero.' };
  }
  if (days <= 0) {
    return { status: 'invalid', message: 'Calendar days must be greater than zero.' };
  }
  if (!Number.isInteger(days)) {
    return { status: 'invalid', message: 'Use a whole number of calendar days.' };
  }

  // Finite inputs can still overflow: 1e308 / 1e-308 is Infinity. Report that
  // as an input error instead of returning an `ok` result with blank fields.
  const growth = end / start;
  if (!Number.isFinite(growth)) {
    return {
      status: 'invalid',
      message: 'The start and end values are too far apart to compute a return.',
    };
  }

  const years = days / CALENDAR_DAYS_PER_YEAR;
  const totalReturnPct = (growth - 1) * 100;
  if (!Number.isFinite(totalReturnPct)) {
    return {
      status: 'invalid',
      message: 'The start and end values are too far apart to compute a return.',
    };
  }

  const cagrWithheld = days <= MIN_CAGR_DAYS;
  const cagrPct = cagrWithheld ? null : (growth ** (1 / years) - 1) * 100;
  if (cagrPct !== null && !Number.isFinite(cagrPct)) {
    return {
      status: 'invalid',
      message: 'The period is too long for these values to produce a finite CAGR.',
    };
  }

  return {
    status: 'ok',
    totalReturnPct,
    years,
    cagrPct,
    cagrWithheld,
  };
}
