/**
 * Chart-level provenance and data-quality summary.
 *
 * Everything here is derived from the stored `Dataset` record. Nothing is
 * inferred from the bars themselves, and no provider field is invented when it
 * is absent. The weekday-gap count is a real validation result but it cannot
 * distinguish a public holiday from a genuinely missing session without an
 * exchange calendar, so that limitation is reported alongside the count.
 *
 * Issues are split into two tiers. `material` issues can change what the chart
 * shows (dropped rows, a requested range the provider did not return); the
 * compact chip counts those. `advisory` notes are limits that may be normal
 * for the source (nullable volume, holiday-sized gaps) and are reported in the
 * dialog without inflating the chip.
 */

import type { Dataset, DatasetValidationSummary } from '../../domain/types';
import { PROVIDER_LABEL, providerLabel } from '../marketdata/normalize';
import { coverageFromDataset, type CoverageReport } from '../marketdata/coverage';

export type ProvenanceStatus = 'clean' | 'attention' | 'legacy' | 'empty';

export type IssueSeverity = 'material' | 'advisory';

export interface ProvenanceIssue {
  code:
    | 'rejected-rows'
    | 'duplicate-sessions'
    | 'missing-volume'
    | 'weekday-gaps'
    | 'order-corrections'
    | 'weekend-rows'
    | 'range-shortfall'
    | 'other-warning';
  label: string;
  count: number;
  detail: string;
  severity: IssueSeverity;
  /** Fixed display order, 1 (most consequential) to 8 (unknown warning). */
  rank: number;
}

export interface ProvenanceFreshness {
  ageDays: number;
  /** `retrieved 3 days ago`, `imported today`, etc. Descriptive, never a verdict. */
  label: string;
  source: 'provider' | 'import';
}

export interface ProvenanceCount {
  label: string;
  value: string;
  note?: string;
}

export interface ProvenanceField {
  label: string;
  value: string;
  note?: string;
}

export interface ProvenanceSummary {
  status: ProvenanceStatus;
  /** Short label used inside the chart chip, e.g. `Data: no issues`. */
  statusLabel: string;
  /** Headline used in the dialog and the chip's accessible name. */
  headline: string;
  /**
   * What the status actually claims. Without this, `Data: no issues` reads as a
   * certification of the prices rather than a report of what MarketLab checked.
   */
  statusNote: string;
  tone: 'up' | 'warn' | 'down';
  /** Highest severity present; null for clean, legacy and empty. */
  severity: IssueSeverity | null;
  materialCount: number;
  advisoryCount: number;
  sourceLabel: string;
  sourceDetail: string;
  coverage: string;
  fields: ProvenanceField[];
  counts: ProvenanceCount[];
  /** Sorted by rank, independent of the order the issues were discovered. */
  issues: ProvenanceIssue[];
  limitations: string[];
  freshness: ProvenanceFreshness | null;
  /** The dataset a deep link should select; always the record this was built from. */
  inspectDatasetId: string;
}

export interface ProvenanceContext {
  /** Exchange reported by the instrument, used only when the provider has none. */
  exchange?: string | null;
  /** Clock injection point so freshness labels are deterministic in tests. */
  now?: Date;
}

const WEEKDAY_GAP_LIMITATION =
  'Weekday gaps count Monday to Friday sessions with no bar between the first and last stored date. ' +
  'Without an exchange calendar, public holidays and genuinely missing sessions look identical, ' +
  'so a gap is a prompt to check the source rather than proof of bad data.';

const DAY_MS = 86_400_000;

/**
 * Severity and display order for every issue code.
 *
 * Rank is fixed, not derived from counts: a range shortfall outranks a rejected
 * row even when the rejected count is larger, because the shortfall changes
 * which history the user is looking at. Weekend rows are material because a bar
 * on a non-session day may indicate a calendar or timezone mapping defect;
 * there is not enough evidence to treat them as routine artefacts.
 */
const ISSUE_META: Record<ProvenanceIssue['code'], { severity: IssueSeverity; rank: number }> = {
  'range-shortfall': { severity: 'material', rank: 1 },
  'rejected-rows': { severity: 'material', rank: 2 },
  'duplicate-sessions': { severity: 'material', rank: 3 },
  'weekend-rows': { severity: 'material', rank: 4 },
  'missing-volume': { severity: 'advisory', rank: 5 },
  'weekday-gaps': { severity: 'advisory', rank: 6 },
  'order-corrections': { severity: 'advisory', rank: 7 },
  'other-warning': { severity: 'advisory', rank: 8 },
};

function issue(
  code: ProvenanceIssue['code'],
  label: string,
  count: number,
  detail: string,
): ProvenanceIssue {
  return { code, label, count, detail, ...ISSUE_META[code] };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

function warningLabel(code: string): string {
  return code
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Warnings already represented by a first-class counter are not repeated. */
const COUNTER_WARNING_CODES = new Set(['session-gaps', 'missing-volume', 'sort-order']);

function buildIssues(dataset: Dataset, coverage: CoverageReport | null): ProvenanceIssue[] {
  const validation: DatasetValidationSummary = dataset.validation;
  const issues: ProvenanceIssue[] = [];

  if (coverage?.status === 'partial') {
    issues.push(
      issue(
        'range-shortfall',
        'Requested range not covered',
        coverage.missingStartDays + coverage.missingEndDays,
        'Calendar days of the requested window that the provider did not return, summed across both ends. ' +
          coverage.notes.join(' '),
      ),
    );
  }
  if (validation.rejectedRows > 0) {
    issues.push(
      issue(
        'rejected-rows',
        'Rejected rows',
        validation.rejectedRows,
        'Rows that failed validation and are not part of the stored series.',
      ),
    );
  }
  if (validation.duplicateRows > 0) {
    issues.push(
      issue(
        'duplicate-sessions',
        'Duplicate session rows',
        validation.duplicateRows,
        'Rows sharing a session date. The import policy decided which one was kept.',
      ),
    );
  }
  if (validation.missingVolumeRows > 0 && dataset.hasVolume) {
    issues.push(
      issue(
        'missing-volume',
        'Rows without volume',
        validation.missingVolumeRows,
        'Volume is absent for these sessions. Volume-based indicators withhold output there.',
      ),
    );
  }
  if (validation.gapCount > 0) {
    issues.push(
      issue(
        'weekday-gaps',
        'Missing weekday sessions',
        validation.gapCount,
        'Weekdays inside the stored range with no bar. Gaps are shown as gaps and never filled.',
      ),
    );
  }
  if (validation.sortCorrections > 0) {
    issues.push(
      issue(
        'order-corrections',
        'Order corrections',
        validation.sortCorrections,
        'Rows arrived out of chronological order and were sorted before saving.',
      ),
    );
  }

  for (const warning of validation.warnings) {
    if (COUNTER_WARNING_CODES.has(warning.code)) continue;
    const count = warning.count ?? 1;
    if (warning.code === 'weekend-rows') {
      issues.push(issue('weekend-rows', 'Weekend rows', count, warning.message));
      continue;
    }
    issues.push(issue('other-warning', warningLabel(warning.code), count, warning.message));
  }

  return issues.sort((left, right) => left.rank - right.rank);
}

function buildLimitations(dataset: Dataset, coverage: CoverageReport | null): string[] {
  const limitations: string[] = [];
  const provider = dataset.provider;

  if (dataset.sourceKind === 'bundled-sample') {
    limitations.push('Synthetic demo series. It is not real market data and must not be used for research conclusions.');
  }
  if (coverage?.limitation) {
    limitations.push(coverage.limitation);
  }
  if (dataset.validation.gapCount > 0) {
    limitations.push(WEEKDAY_GAP_LIMITATION);
  }
  if (!dataset.hasVolume && dataset.rowCount > 0) {
    limitations.push(
      'This dataset carries no volume. Volume-based indicators and screens withhold output rather than inventing a value.',
    );
  }
  if (dataset.sourceKind === 'user-csv') {
    limitations.push(
      'An import records what the file contained. MarketLab does not verify those prices against an exchange or a second source.',
    );
  }
  if (provider) {
    const label = providerLabel(provider.provider);
    limitations.push(
      provider.provider === 'yahoo-finance'
        ? `${label} data is unofficial and may be delayed or revised. It is not licensed for redistribution.`
        : `${label} data may be delayed or revised and is not licensed for redistribution.`,
    );
    for (const note of provider.sourceNotes ?? []) limitations.push(note);
  }

  return limitations;
}

function buildFields(
  dataset: Dataset,
  context: ProvenanceContext,
  coverage: CoverageReport | null,
  freshness: ProvenanceFreshness | null,
): ProvenanceField[] {
  const provider = dataset.provider;
  const exchange =
    provider?.exchangeName ?? provider?.exchange ?? context.exchange ?? 'Not reported';
  const timezone = provider?.timezone ?? dataset.timezone ?? 'Not reported';
  const adjustment =
    provider?.adjustment ??
    (dataset.sourceKind === 'user-csv'
      ? 'Not recorded for this import'
      : dataset.sourceKind === 'bundled-sample'
        ? 'Not applicable (synthetic series)'
        : 'Not reported');

  const sourceLabel = provider ? providerLabel(provider.provider) : PROVIDER_LABEL;
  const fields: ProvenanceField[] = [
    {
      label: 'Source',
      value:
        dataset.sourceKind === 'provider-download'
          ? `${sourceLabel} download`
          : dataset.sourceKind === 'user-csv'
            ? 'Imported CSV'
            : 'Bundled demo series',
      note:
        dataset.sourceKind === 'provider-download' && provider
          ? `${provider.providerSymbol}, interval ${provider.interval}`
          : dataset.sourceDescription,
    },
    { label: 'Exchange', value: exchange },
    { label: 'Timezone', value: timezone },
    { label: 'Adjustment', value: adjustment },
    {
      label: 'Coverage',
      value: dataset.rowCount > 0 ? `${dataset.firstDate} to ${dataset.lastDate}` : 'No stored sessions',
      note:
        coverage?.requested
          ? `${countLabel(dataset.rowCount, 'stored session', 'stored sessions')}; requested ${coverage.requested.start} to ${coverage.requested.end}`
          : countLabel(dataset.rowCount, 'stored session', 'stored sessions'),
    },
    {
      label: 'Imported',
      value: dataset.importedAt.slice(0, 10),
      note:
        freshness?.source === 'import'
          ? `${freshness.label} · when this browser stored the series`
          : 'When this browser stored the series',
    },
  ];

  if (provider) {
    fields.push({
      label: 'Retrieved',
      value: provider.retrievedAt.slice(0, 16).replace('T', ' '),
      note:
        freshness?.source === 'provider'
          ? `${freshness.label} · provider timestamp, UTC`
          : 'Provider timestamp, UTC',
    });
  }

  return fields;
}

function buildCounts(dataset: Dataset): ProvenanceCount[] {
  const validation = dataset.validation;
  return [
    { label: 'Accepted rows', value: validation.acceptedRows.toLocaleString('en-US') },
    { label: 'Rejected rows', value: validation.rejectedRows.toLocaleString('en-US') },
    { label: 'Duplicate sessions', value: validation.duplicateRows.toLocaleString('en-US') },
    {
      label: 'Rows without volume',
      value: validation.missingVolumeRows.toLocaleString('en-US'),
      note: dataset.hasVolume ? undefined : 'No volume in this source',
    },
    {
      label: 'Weekday gaps',
      value: validation.gapCount.toLocaleString('en-US'),
      note: 'Holidays and missing sessions are indistinguishable',
    },
    { label: 'Order corrections', value: validation.sortCorrections.toLocaleString('en-US') },
  ];
}

/** Whole UTC calendar days, so a DST shift cannot turn 1 day into 0 or 2. */
function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Age of the stored data. Provider downloads use the provider's retrieval
 * timestamp; imports use the local import timestamp. Anything unparseable or
 * in the future yields null: no negative age and no invented precision.
 * Age never changes the status.
 */
function buildFreshness(dataset: Dataset, now: Date): ProvenanceFreshness | null {
  const fromProvider = dataset.provider !== undefined;
  const timestamp = fromProvider ? dataset.provider?.retrievedAt : dataset.importedAt;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;

  const parsed = new Date(timestamp);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;

  const ageDays = Math.round((utcDayStart(now) - utcDayStart(parsed)) / DAY_MS);
  if (ageDays < 0) return null;

  const verb = fromProvider ? 'retrieved' : 'imported';
  const label =
    ageDays === 0
      ? `${verb} today`
      : ageDays === 1
        ? `${verb} yesterday`
        : ageDays > 365
          ? `${verb} over a year ago`
          : `${verb} ${ageDays.toLocaleString('en-US')} days ago`;

  return { ageDays, label, source: fromProvider ? 'provider' : 'import' };
}

export function buildProvenanceSummary(dataset: Dataset, context: ProvenanceContext = {}): ProvenanceSummary {
  const coverage = coverageFromDataset(dataset);
  const issues = buildIssues(dataset, coverage);
  const limitations = buildLimitations(dataset, coverage);
  const freshness = buildFreshness(dataset, context.now ?? new Date());
  const hasRows = dataset.rowCount > 0 && dataset.validation.acceptedRows > 0;
  const legacy = dataset.sourceKind === 'bundled-sample';

  const materialCount = issues.filter((entry) => entry.severity === 'material').length;
  const advisoryCount = issues.filter((entry) => entry.severity === 'advisory').length;
  const materialLabel = countLabel(materialCount, 'issue', 'issues');
  const advisoryLabel = countLabel(advisoryCount, 'note', 'notes');

  let status: ProvenanceStatus;
  let headline: string;
  let statusLabel: string;
  let statusNote: string;
  let tone: ProvenanceSummary['tone'];
  let severity: IssueSeverity | null;

  if (!hasRows) {
    status = 'empty';
    severity = null;
    headline = 'No stored rows';
    statusLabel = 'Data: no rows';
    statusNote = 'No rows are stored, so there is nothing to validate.';
    tone = 'down';
  } else if (legacy) {
    status = 'legacy';
    severity = null;
    headline = 'Legacy demo data';
    statusLabel = 'Data: legacy demo';
    statusNote = 'Synthetic demo series, not real market data.';
    tone = 'warn';
  } else if (issues.length > 0) {
    status = 'attention';
    severity = materialCount > 0 ? 'material' : 'advisory';
    headline =
      materialCount > 0 && advisoryCount > 0
        ? `${materialLabel}, ${advisoryLabel}`
        : materialCount > 0
          ? materialLabel
          : advisoryLabel;
    statusLabel =
      materialCount > 0 ? `Data: ${materialLabel}` : `Data: ${advisoryLabel}`;
    statusNote =
      materialCount > 0
        ? 'Import-time validation recorded issues that may affect what this chart shows. Each one is listed below.'
        : 'Import-time validation recorded no material issues. The notes below describe limits that may be normal for this source.';
    tone = 'warn';
  } else {
    status = 'clean';
    severity = null;
    headline = 'No recorded issues';
    statusLabel = 'Data: no issues';
    statusNote =
      dataset.sourceKind === 'provider-download'
        ? 'Import-time validation recorded no issues. This is not a certification: provider data can be delayed or revised, and MarketLab does not re-check the prices.'
        : 'Import-time validation recorded no issues. MarketLab does not verify imported prices against an exchange or a second source.';
    tone = 'up';
  }

  return {
    status,
    statusLabel,
    headline,
    statusNote,
    tone,
    severity,
    materialCount,
    advisoryCount,
    sourceLabel:
      dataset.sourceKind === 'provider-download'
        ? (dataset.provider ? providerLabel(dataset.provider.provider) : PROVIDER_LABEL)
        : dataset.sourceKind === 'user-csv'
          ? 'Imported CSV'
          : 'Legacy demo',
    sourceDetail: dataset.sourceDescription,
    coverage:
      dataset.rowCount > 0
        ? `${dataset.firstDate} to ${dataset.lastDate} (${countLabel(dataset.rowCount, 'session', 'sessions')})`
        : 'No stored sessions',
    fields: buildFields(dataset, context, coverage, freshness),
    counts: buildCounts(dataset),
    issues,
    limitations,
    freshness,
    inspectDatasetId: dataset.id,
  };
}
