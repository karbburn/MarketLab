/**
 * Types for the global command palette.
 *
 * The palette presents two kinds of row. A dataset row points at a series that
 * already lives in the local library; a command row runs one explicit action.
 * Both are described by the same shape so one search/ranking pass and one
 * keyboard-navigation list can cover them.
 */

export type PaletteGroupId = 'recent' | 'datasets' | 'navigation' | 'actions';

interface PaletteItemBase {
  id: string;
  /** Primary text: the symbol for a dataset, the action name for a command. */
  label: string;
  /** Secondary text shown under the label. */
  detail?: string;
  /** Right-aligned supporting text (frequency, session count, panel count). */
  meta?: string;
  /** Extra searchable text beyond the label. Never rendered. */
  keywords?: readonly string[];
  /** Keyboard hint rendered on the right, when the action has one. */
  shortcut?: string;
}

/**
 * A locally stored series.
 *
 * `label` is the symbol (the field that must rank first), `names` holds the
 * human names searched after it, and `keywords` holds looser provenance terms.
 */
export interface DatasetPaletteItem extends PaletteItemBase {
  kind: 'dataset';
  group: 'datasets';
  datasetId: string;
  instrumentId: string;
  names: readonly string[];
  /** Provenance tag (CSV / Download / Sample) rendered as a status tag. */
  tag?: string;
  tagTone?: 'accent' | 'warn';
}

/** An invokable action: navigate, open a dialog, change a setting. */
export interface CommandPaletteItem extends PaletteItemBase {
  kind: 'command';
  group: 'navigation' | 'actions';
  run: () => void;
}

export type PaletteItem = DatasetPaletteItem | CommandPaletteItem;

export interface PaletteSection {
  group: PaletteGroupId;
  title: string;
  items: PaletteItem[];
  /** Muted line shown when the group is relevant but has nothing to offer. */
  note?: string;
}
