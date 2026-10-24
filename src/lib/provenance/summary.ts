/**
 * Chart-level provenance and data-quality summary.
 *
 * Everything here is derived from the stored `Dataset` record. Nothing is
 * inferred from the bars themselves, and no provider field is invented when it
 * is absent. The weekday-gap count is a real validation result but it cannot
 * distinguish a public holiday from a genuinely missing session without an
 * exchange calendar, so that limitation is reported alongside the count.
 */

import type { Dataset, DatasetValidationSummary } from '../../domain/types';
import { PROVIDER_LABEL, providerLabel } from '../marketdata/normalize';
import { coverageFromDataset, type CoverageReport } from '../marketdata/coverage';

export type ProvenanceStatus = 'clean' | 'attention' | 'legacy' | 'empty';

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
  /** Short label used inside the chart chip, e.g. `Data: clean`. */
  statusLabel: string;
  /** Headline used in the dialog and the chip's accessible name. */
  headline: string;
  tone: 'up' | 'warn' | 'down';
  sourceLabel: string;
  sourceDetail: string;
  coverage: string;
  fields: ProvenanceField[];
  counts: ProvenanceCount[];
  issues: ProvenanceIssue[];
  limitations: string[];
  /** The dataset a deep link should select; always the record this was built from. */
  inspectDatasetId: string;
}

export interface ProvenanceContext {
  /** Exchange reported by the instrument, used only when the provider has none. */
  exchange?: string | null;
}

const WEEKDAY_GAP_LIMITATION =
  'Weekday gaps count Monday to Friday sessions with no bar between the first and last stored date. ' +
  'Without an exchange calendar, public holidays and genuinely missing sessions look identical, ' +
  'so a gap is a prompt to check the source rather than proof of bad data.';

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
    issues.push({
      code: 'range-shortfall',
      label: 'Requested range not covered',
      count: coverage.missingStartDays + coverage.missingEndDays,
      detail:
        'Calendar days of the requested window that the provider did not return, summed across both ends. ' +
        coverage.notes.join(' '),
    });
  }
  if (validation.rejectedRows > 0) {
    issues.push({
      code: 'rejected-rows',
      label: 'Rejected rows',
      count: validation.rejectedRows,
      detail: 'Rows that failed validation and are not part of the stored series.',
    });
  }
  if (validation.duplicateRows > 0) {
    issues.push({
      code: 'duplicate-sessions',
      label: 'Duplicate session rows',
      count: validation.duplicateRows,
      detail: 'Rows sharing a session date. The import policy decided which one was kept.',
    });
  }
  if (validation.missingVolumeRows > 0 && dataset.hasVolume) {
    issues.push({
      code: 'missing-volume',
      label: 'Rows without volume',
      count: validation.missingVolumeRows,
      detail: 'Volume is absent for these sessions. Volume-based indicators withhold output there.',
    });
  }
  if (validation.gapCount > 0) {
    issues.push({
      code: 'weekday-gaps',
      label: 'Missing weekday sessions',
      count: validation.gapCount,
      detail: 'Weekdays inside the stored range with no bar. Gaps are shown as gaps and never filled.',
    });
  }
  if (validation.sortCorrections > 0) {
    issues.push({
      code: 'order-corrections',
      label: 'Order corrections',
      count: validation.sortCorrections,
      detail: 'Rows arrived out of chronological order and were sorted before saving.',
    });
  }

  for (const warning of validation.warnings) {
    if (COUNTER_WARNING_CODES.has(warning.code)) continue;
    const count = warning.count ?? 1;
    issues.push({
      code: warning.code === 'weekend-rows' ? 'weekend-rows' : 'other-warning',
      label: warning.code === 'weekend-rows' ? 'Weekend rows' : warningLabel(warning.code),
      count,
      detail: warning.message,
    });
  }

  return issues;
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
    for (const note of provider.sourceNotes) limitations.push(note);
  }

  return limitations;
}

function buildFields(
  dataset: Dataset,
  context: ProvenanceContext,
  coverage: CoverageReport | null,
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
      note: 'When this browser stored the series',
    },
  ];

  if (provider) {
    fields.push({
      label: 'Retrieved',
      value: provider.retrievedAt.slice(0, 16).replace('T', ' '),
      note: 'Provider timestamp, UTC',
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

export function buildProvenanceSummary(dataset: Dataset, context: ProvenanceContext = {}): ProvenanceSummary {
  const coverage = coverageFromDataset(dataset);
  const issues = buildIssues(dataset, coverage);
  const limitations = buildLimitations(dataset, coverage);
  const hasRows = dataset.rowCount > 0 && dataset.validation.acceptedRows > 0;
  const legacy = dataset.sourceKind === 'bundled-sample';

  let status: ProvenanceStatus;
  let headline: string;
  let statusLabel: string;
  let tone: ProvenanceSummary['tone'];

  if (!hasRows) {
    status = 'empty';
    headline = 'No stored rows';
    statusLabel = 'Data: no rows';
    tone = 'down';
  } else if (legacy) {
    status = 'legacy';
    headline = 'Legacy demo data';
    statusLabel = 'Data: legacy demo';
    tone = 'warn';
  } else if (issues.length > 0) {
    status = 'attention';
    headline = countLabel(issues.length, 'issue', 'issues');
    statusLabel = `Data: ${countLabel(issues.length, 'issue', 'issues')}`;
    tone = 'warn';
  } else {
    status = 'clean';
    headline = 'Clean';
    statusLabel = 'Data: clean';
    tone = 'up';
  }

  return {
    status,
    statusLabel,
    headline,
    tone,
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
    fields: buildFields(dataset, context, coverage),
    counts: buildCounts(dataset),
    issues,
    limitations,
    inspectDatasetId: dataset.id,
  };
}
