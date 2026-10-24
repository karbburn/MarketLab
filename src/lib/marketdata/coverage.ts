/**
 * Coverage disclosure for provider downloads.
 *
 * A provider can answer a request with fewer sessions than were asked for. The
 * consequential case is a per-request bar ceiling: Twelve Data returns at most
 * 5,000 daily bars. Since long-history pagination arrived (the adapter fetches
 * such ranges as bounded windows and never stores a windowed result), the cap
 * mainly matters for datasets saved before that change, where the rows came
 * back in exactly one capped request. The app compares what was requested with
 * what came back either way.
 *
 * Two claims are kept apart deliberately:
 *
 * - "the provider's bar ceiling was reached" is verified, because the returned
 *   row count equals the documented cap;
 * - "no sessions were returned for part of the window" is an observation, not
 *   a diagnosis — a later listing date looks exactly like withheld data, so the
 *   cause is never asserted.
 *
 * Dates without a session are normal at a range boundary (weekends, holidays,
 * suspensions), so a shortfall only counts once it exceeds a tolerance at
 * either end. Nothing here invents a session or repairs a range.
 */

import type { Dataset, ProviderId } from '../../domain/types';
import { providerLabel } from './normalize';

export interface DateRange {
  start: string;
  end: string;
}

/**
 * Documented per-request bar ceilings, mirrored from the server adapters.
 *
 * The browser bundle must not import the server modules (`yahoo.ts` /
 * `twelvedata.ts`) just for a constant, so the numbers live here and a unit
 * test asserts they still match `TWELVE_DATA_MAX_OUTPUTSIZE`.
 */
export const PROVIDER_OUTPUT_CAPS: Partial<Record<ProviderId, number>> = {
  'twelve-data': 5000,
};

/**
 * Calendar days a returned range may fall short at either end before the gap is
 * reported. This absorbs weekends and ordinary exchange holidays; a longer gap
 * is material enough to disclose.
 */
export const COVERAGE_TOLERANCE_DAYS = 10;

export type CoverageStatus = 'complete' | 'partial' | 'unverified';

export interface CoverageInput {
  provider: ProviderId;
  /** The range sent to the provider, when the response reported it. */
  requested: DateRange | null | undefined;
  /** The first and last session actually stored. */
  actual: DateRange;
  /** Rows the provider returned, used to recognise a bar ceiling. */
  rowCount: number;
  /** Overrides the default boundary tolerance; tests and callers only. */
  toleranceDays?: number;
}

export interface CoverageReport {
  status: CoverageStatus;
  requested: DateRange | null;
  actual: DateRange;
  /** Calendar days between the requested start and the first returned session. */
  missingStartDays: number;
  /** Calendar days between the last returned session and the requested end. */
  missingEndDays: number;
  /** The provider's documented bar ceiling, or null when it has none. */
  providerCap: number | null;
  /**
   * True when the row count equals the provider ceiling exactly, the signature
   * of a single capped request. Post-pagination row counts can legitimately
   * exceed the cap, and a larger count says nothing about which window was
   * truncated, so a threshold comparison would mis-attribute the cause.
   */
  atProviderCap: boolean;
  /** Heading for the review panel; null when there is nothing to disclose. */
  headline: string | null;
  /** Facts about the shortfall, in display order. Empty when complete. */
  notes: string[];
  /** One sentence for provenance limitations; null when complete or unknown. */
  limitation: string | null;
}

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight in milliseconds, or null when the value is not a real date. */
function utcDay(value: string): number | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) return null;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Rejects overflow such as 2026-02-31, which Date.UTC would roll forward.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

function readRange(range: { start?: unknown; end?: unknown } | null | undefined): DateRange | null {
  if (!range) return null;
  const { start, end } = range;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = utcDay(start);
  const endMs = utcDay(end);
  if (startMs === null || endMs === null || startMs > endMs) return null;
  return { start, end };
}

function countDays(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / DAY_MS);
}

/**
 * Compares the requested window with the returned one.
 *
 * Returns `unverified` when the response did not report a usable requested
 * range (older stored downloads, or a provider that omits it). In that state
 * nothing is claimed: absence of evidence is not evidence of full coverage.
 */
export function assessCoverage(input: CoverageInput): CoverageReport {
  const tolerance = input.toleranceDays ?? COVERAGE_TOLERANCE_DAYS;
  const requested = readRange(input.requested);
  const actual = { start: input.actual.start, end: input.actual.end };
  const providerCap = PROVIDER_OUTPUT_CAPS[input.provider] ?? null;
  const atProviderCap = providerCap !== null && input.rowCount === providerCap;
  const actualStart = utcDay(actual.start);
  const actualEnd = utcDay(actual.end);

  if (!requested || actualStart === null || actualEnd === null || actualStart > actualEnd) {
    return {
      status: 'unverified',
      requested,
      actual,
      missingStartDays: 0,
      missingEndDays: 0,
      providerCap,
      atProviderCap,
      headline: null,
      notes: [],
      limitation: null,
    };
  }

  const missingStartDays = Math.max(0, countDays(utcDay(requested.start)!, actualStart));
  const missingEndDays = Math.max(0, countDays(actualEnd, utcDay(requested.end)!));
  const startShort = missingStartDays > tolerance;
  const endShort = missingEndDays > tolerance;

  if (!startShort && !endShort) {
    return {
      status: 'complete',
      requested,
      actual,
      missingStartDays,
      missingEndDays,
      providerCap,
      atProviderCap,
      headline: null,
      notes: [],
      limitation: null,
    };
  }

  const label = providerLabel(input.provider);
  const notes: string[] = [];
  if (startShort) {
    notes.push(
      atProviderCap
        ? `${label} returned exactly ${providerCap.toLocaleString('en-US')} bars, its per-request ceiling, so sessions before ${actual.start} were not returned.`
        : `No sessions before ${actual.start} were returned for a request starting ${requested.start}. The instrument may not have traded earlier, or the provider may not have supplied those sessions; MarketLab cannot tell which.`,
    );
  }
  if (endShort) {
    notes.push(
      `No sessions after ${actual.end} were returned for a request ending ${requested.end}. Later bars may not exist yet or the provider may not have supplied them.`,
    );
  }

  const ceiling = atProviderCap && startShort ? ` at its ${providerCap.toLocaleString('en-US')}-bar request ceiling` : '';
  const limitation =
    `Requested ${requested.start} to ${requested.end}; the provider returned ${actual.start} to ${actual.end}${ceiling}. ` +
    'Sessions outside the returned window are not part of this dataset.';

  return {
    status: 'partial',
    requested,
    actual,
    missingStartDays,
    missingEndDays,
    providerCap,
    atProviderCap,
    headline: 'The returned range does not cover the whole request.',
    notes,
    limitation,
  };
}

/**
 * Coverage of a stored dataset, or null when it never recorded a request.
 *
 * Uses the stored first/last session rather than the provider's reported range:
 * what matters is the data the chart can actually draw.
 */
export function coverageFromDataset(dataset: Dataset): CoverageReport | null {
  const provider = dataset.provider;
  if (!provider?.requestedRange) return null;
  return assessCoverage({
    provider: provider.provider,
    requested: provider.requestedRange,
    actual: { start: dataset.firstDate, end: dataset.lastDate },
    rowCount: dataset.rowCount,
  });
}

/** Short label such as `Coverage: partial`, used by the review panel. */
export function coverageLabel(report: CoverageReport): string {
  if (report.status === 'complete') return 'Coverage checked';
  if (report.status === 'partial') return 'Coverage: partial';
  return 'Coverage unreported';
}
