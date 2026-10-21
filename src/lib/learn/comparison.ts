/**
 * Teaching-only verdict for the saved-run comparison drill.
 *
 * These rules mirror the product's comparison semantics but are deliberately
 * independent of the production helpers. The learning page must never change
 * what the backtest comparison actually does.
 */

export interface ComparisonDrillInput {
  datasetChanged: boolean;
  windowChanged: boolean;
  engineChanged: boolean;
  assumptionsChanged: boolean;
  settingsChanged: boolean;
  datasetMissing: boolean;
}

export type ComparisonDrillState =
  | 'same'
  | 'different-strategy'
  | 'snapshot-only'
  | 'not-comparable';

export type ComparisonDrillOptionKey = keyof ComparisonDrillInput;

export interface ComparisonDrillOption {
  key: ComparisonDrillOptionKey;
  label: string;
  note: string;
}

export interface ComparisonDrillVerdict {
  state: ComparisonDrillState;
  label: string;
  detail: string;
  notes: string[];
  /** Recorded dataset, window, engine and assumptions all match. */
  inputsComparable: boolean;
}

export const COMPARISON_DRILL_OPTIONS: readonly ComparisonDrillOption[] = [
  {
    key: 'datasetChanged',
    label: 'Different market data',
    note: 'The stored dataset identity or content hash differs.',
  },
  {
    key: 'windowChanged',
    label: 'Different window',
    note: 'The runs cover different stored dates or frequencies.',
  },
  {
    key: 'engineChanged',
    label: 'Different engine version',
    note: 'The saved results came from different execution engine versions.',
  },
  {
    key: 'assumptionsChanged',
    label: 'Different assumptions',
    note: 'The recorded cost or execution assumptions differ.',
  },
  {
    key: 'settingsChanged',
    label: 'Different strategy settings',
    note: 'The strategies use different rules, position size, costs, stops or targets.',
  },
  {
    key: 'datasetMissing',
    label: 'Dataset missing now',
    note: 'The snapshot remains readable, but the dataset is no longer in the library.',
  },
];

export const EMPTY_COMPARISON_DRILL: ComparisonDrillInput = {
  datasetChanged: false,
  windowChanged: false,
  engineChanged: false,
  assumptionsChanged: false,
  settingsChanged: false,
  datasetMissing: false,
};

export function comparisonDrill(input: ComparisonDrillInput): ComparisonDrillVerdict {
  const notes = COMPARISON_DRILL_OPTIONS.filter((option) => input[option.key]).map(
    (option) => option.note,
  );
  const inputsComparable = !(
    input.datasetChanged ||
    input.windowChanged ||
    input.engineChanged ||
    input.assumptionsChanged
  );

  if (!inputsComparable) {
    return {
      state: 'not-comparable',
      label: 'Not directly comparable',
      detail:
        'Market data, window, engine or assumptions differ. The app still shows the recorded snapshots and labels the deltas as descriptive, not as proof that one strategy is better.',
      notes,
      inputsComparable: false,
    };
  }

  if (input.datasetMissing) {
    return {
      state: 'snapshot-only',
      label: 'Snapshot-only comparison',
      detail:
        'The recorded dataset, window, engine and assumptions match, but at least one dataset is no longer in the library. The saved values stay readable; the current input check is unavailable and the comparison cannot be rerun.',
      notes,
      inputsComparable: true,
    };
  }

  if (input.settingsChanged) {
    return {
      state: 'different-strategy',
      label: 'Comparable inputs, different strategy',
      detail:
        'Market data, window, engine and assumptions match. The strategies do not, so the deltas describe different settings rather than one isolated change.',
      notes,
      inputsComparable: true,
    };
  }

  return {
    state: 'same',
    label: 'No differences selected',
    detail: 'Both sides are the same snapshot. Turn on a difference to test the verdict.',
    notes,
    inputsComparable: true,
  };
}
