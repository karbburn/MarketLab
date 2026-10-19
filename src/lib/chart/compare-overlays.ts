import type { Bar, Dataset, Frequency, Timeframe } from '../../domain/types';
import { rebasedComparison, type ComparisonStatus } from '../quant/comparison';
import { availableTimeframes, barsForTimeframe, resolveTimeframe } from '../timeframe';

/**
 * Turning stored datasets into comparable overlay lines.
 *
 * The overlay is a percentage-style index comparison: every series is rebased
 * to 100 at the first session shared by all of them, so instruments quoted at
 * very different price levels can be compared honestly on one chart. The lines
 * live on their own secondary index scale; the primary price axis is untouched.
 *
 * Nothing here fabricates data. A series that cannot produce the panel's
 * timeframe, or that shares too few sessions with the others, is excluded with a
 * stated reason rather than approximated.
 */

/** Colours for comparison lines; distinct from the up/down/accent tokens. */
export const COMPARISON_COLORS: readonly string[] = [
  '#3fb8a3',
  '#d8a13f',
  '#5b9bd5',
  '#e2586a',
  '#35c48d',
  '#8aa0b8',
  '#c07be0',
  '#4fd0c9',
];

export type ComparisonLineStyle = 'solid' | 'dashed' | 'dotted' | 'large-dashed';

/** Line styles cycle independently of colour so more series stay distinguishable. */
export const COMPARISON_LINE_STYLES: readonly ComparisonLineStyle[] = ['solid', 'dashed', 'dotted', 'large-dashed'];

export interface ComparisonTarget {
  datasetId: string;
  label: string;
  dataset: Dataset;
  bars: readonly Bar[];
}

export interface ComparisonLineSpec {
  datasetId: string;
  label: string;
  primary: boolean;
  color: string;
  lineStyle: ComparisonLineStyle;
  /** Rebased index points, one per shared session, ascending. */
  points: Array<{ date: string; value: number }>;
}

export interface ExcludedComparison {
  datasetId: string;
  label: string;
  reason: string;
}

export interface ComparisonPreparation {
  /** Timeframe the overlay is actually drawn on. */
  timeframe: Timeframe;
  baselineDate: string | null;
  sessionCount: number;
  /** The primary series first, then each comparable overlay. Empty unless `ok`. */
  lines: ComparisonLineSpec[];
  /** Selected series that could not be shown, each with a reason. */
  excluded: ExcludedComparison[];
  status: ComparisonStatus | 'ineligible';
  /** One-line, user-facing explanation of the current state. */
  message: string;
  methodNote: string;
}

export const COMPARISON_METHOD_NOTE =
  'Comparison series are rebased to an index of 100 at the first session shared by every selected series. ' +
  'Observations are aligned on exchange session dates, never by array position, and no session is ' +
  'forward-filled or interpolated. All values sit on the separate Compare index axis; the primary price axis is unchanged.';

export function comparisonLineStyle(index: number): ComparisonLineStyle {
  return COMPARISON_LINE_STYLES[index % COMPARISON_LINE_STYLES.length] as ComparisonLineStyle;
}

export function comparisonColor(index: number): string {
  return COMPARISON_COLORS[index % COMPARISON_COLORS.length] as string;
}

/**
 * Builds the overlay for one panel.
 *
 * `primary` is the panel's own series; `candidates` are the datasets the user
 * selected to compare, in the order they should be drawn. The panel's requested
 * timeframe is resolved against the primary dataset first, so a comparison is
 * only ever prepared on a timeframe the panel can actually render.
 */
export function prepareComparison(input: {
  primary: ComparisonTarget;
  candidates: readonly ComparisonTarget[];
  timeframe: Timeframe;
}): ComparisonPreparation {
  const { primary, candidates, timeframe } = input;
  const effective = resolveTimeframe(primary.dataset, timeframe);
  const primaryBars = barsForTimeframe(primary.bars, primary.dataset, effective);

  const series: Array<{ key: string; label: string; bars: readonly Bar[] }> = [
    { key: primary.datasetId, label: primary.label, bars: primaryBars },
  ];
  const excluded: ExcludedComparison[] = [];

  for (const candidate of candidates) {
    if (candidate.bars.length === 0) {
      excluded.push({ datasetId: candidate.datasetId, label: candidate.label, reason: 'No stored sessions.' });
      continue;
    }
    if (!availableTimeframes(candidate.dataset.frequency).includes(effective)) {
      excluded.push({
        datasetId: candidate.datasetId,
        label: candidate.label,
        reason: `${frequencyLabel(candidate.dataset.frequency)} series cannot be shown on a ${effective} panel without inventing values.`,
      });
      continue;
    }
    series.push({
      key: candidate.datasetId,
      label: candidate.label,
      bars: barsForTimeframe(candidate.bars, candidate.dataset, effective),
    });
  }

  const result = rebasedComparison(series);
  const base: Omit<ComparisonPreparation, 'status' | 'message' | 'lines'> = {
    timeframe: effective,
    baselineDate: result.baselineDate,
    sessionCount: result.dates.length,
    excluded,
    methodNote: COMPARISON_METHOD_NOTE,
  };

  if (result.status !== 'ok') {
    return { ...base, status: result.status, lines: [], message: describeStatus(result.status, result.dates.length, result.minSessions) };
  }

  const lines: ComparisonLineSpec[] = result.series.map((entry, index) => ({
    datasetId: entry.key,
    label: entry.label,
    primary: index === 0,
    color: comparisonColor(index),
    lineStyle: comparisonLineStyle(index),
    points: result.dates.map((date, pointIndex) => ({ date, value: entry.values[pointIndex] as number })),
  }));

  return {
    ...base,
    status: 'ok',
    lines,
    message: `Rebased to 100 at ${result.baselineDate}; ${result.dates.length} shared session(s).`,
  };
}

/** Every dataset is comparable unless its stored frequency cannot fill the panel. */
export function comparisonEligibility(
  candidateFrequency: Frequency,
  panelTimeframe: Timeframe,
): { eligible: boolean; reason: string | null } {
  if (availableTimeframes(candidateFrequency).includes(panelTimeframe)) return { eligible: true, reason: null };
  return {
    eligible: false,
    reason: `${frequencyLabel(candidateFrequency)} only — a ${panelTimeframe} panel would need values it does not have.`,
  };
}

function describeStatus(status: ComparisonStatus, sharedSessions: number, minSessions: number): string {
  switch (status) {
    case 'no-overlap':
      return 'No trading session is shared by every selected series, so nothing is drawn.';
    case 'insufficient-history':
      return `${sharedSessions} shared session(s); at least ${minSessions} are needed to rebase a comparison.`;
    case 'invalid-baseline':
      return 'A selected series has a non-positive baseline close, so the comparison cannot be rebased honestly.';
    case 'no-series':
      return 'No series selected.';
    case 'ok':
      return '';
  }
}

function frequencyLabel(frequency: Frequency): string {
  switch (frequency) {
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
  }
}
