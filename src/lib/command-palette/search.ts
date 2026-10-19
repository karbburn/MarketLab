/**
 * Search and ranking for the command palette.
 *
 * Everything here is pure: it takes the current in-memory library and command
 * list and returns the sections the palette should render. There is no storage
 * access and no network, so the results always describe current state and the
 * ranking is directly unit-testable.
 */

import type {
  CommandPaletteItem,
  DatasetPaletteItem,
  PaletteGroupId,
  PaletteItem,
  PaletteSection,
} from './types';

export const PALETTE_GROUP_TITLES: Readonly<Record<PaletteGroupId, string>> = {
  recent: 'Recently used',
  datasets: 'Datasets',
  navigation: 'Navigation',
  actions: 'Actions',
};

/**
 * Normalises a raw query: case-folded, with runs of whitespace collapsed to a
 * single space and the ends trimmed, so a pasted or double-spaced query still
 * matches the same rows.
 */
export function normaliseQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokensOf(query: string): string[] {
  return query.length === 0 ? [] : query.split(' ');
}

/** True when every whitespace-separated token appears somewhere in `haystack`. */
function containsAllTokens(haystack: string, query: string): boolean {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return false;
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Dataset ranking tiers, highest first.
 *
 * Exact symbol, then symbol prefix, then name matches, then broader substring
 * matches - the order the palette promises to users.
 */
export const DATASET_SCORE = {
  symbolExact: 1000,
  symbolPrefix: 800,
  namePrefix: 640,
  nameContains: 560,
  symbolContains: 480,
  keywordContains: 300,
} as const;

export const COMMAND_SCORE = {
  labelExact: 1000,
  labelPrefix: 800,
  labelContains: 600,
  keywordExact: 500,
  keywordPrefix: 400,
  keywordContains: 200,
} as const;

/**
 * Rank for one dataset, or `null` when it does not match.
 * `query` must already be normalised with `normaliseQuery`.
 */
export function scoreDataset(item: DatasetPaletteItem, query: string): number | null {
  if (query.length === 0) return null;
  const symbol = item.label.toLowerCase();
  const names = item.names.map((entry) => entry.toLowerCase());
  const keywords = (item.keywords ?? []).map((entry) => entry.toLowerCase());

  if (symbol === query) return DATASET_SCORE.symbolExact;
  if (symbol.startsWith(query)) return DATASET_SCORE.symbolPrefix;
  if (names.some((name) => name.startsWith(query))) return DATASET_SCORE.namePrefix;
  if (names.some((name) => name.includes(query))) return DATASET_SCORE.nameContains;
  if (symbol.includes(query)) return DATASET_SCORE.symbolContains;
  const haystack = [symbol, ...names, ...keywords].join(' ');
  if (containsAllTokens(haystack, query)) return DATASET_SCORE.keywordContains;
  return null;
}

/**
 * Rank for one command, or `null` when it does not match.
 * `query` must already be normalised with `normaliseQuery`.
 */
export function scoreCommand(item: CommandPaletteItem, query: string): number | null {
  if (query.length === 0) return null;
  const label = item.label.toLowerCase();
  const keywords = (item.keywords ?? []).map((entry) => entry.toLowerCase());

  if (label === query) return COMMAND_SCORE.labelExact;
  if (label.startsWith(query)) return COMMAND_SCORE.labelPrefix;
  if (label.includes(query)) return COMMAND_SCORE.labelContains;
  if (keywords.includes(query)) return COMMAND_SCORE.keywordExact;
  if (keywords.some((keyword) => keyword.startsWith(query))) return COMMAND_SCORE.keywordPrefix;
  const haystack = [label, ...keywords].join(' ');
  if (containsAllTokens(haystack, query)) return COMMAND_SCORE.keywordContains;
  return null;
}

interface Ranked<T> {
  item: T;
  score: number;
  index: number;
}

/**
 * Keeps matching items, best score first. Ties preserve the caller's order;
 * datasets additionally prefer the shorter label, because a short symbol hinting
 * at the same match is the better guess (``AAL`` over ``AALX`` for ``aa``).
 */
function rank<T extends PaletteItem>(
  items: readonly T[],
  score: (item: T) => number | null,
  preferShorterLabel = false,
): T[] {
  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const value = score(item);
    if (value !== null) ranked.push({ item, score: value, index });
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (preferShorterLabel && a.item.label.length !== b.item.label.length) {
      return a.item.label.length - b.item.label.length;
    }
    return a.index - b.index;
  });
  return ranked.map((entry) => entry.item);
}

export interface PlanPaletteInput {
  query: string;
  /** Number of datasets in the local library; drives the empty-state wording. */
  librarySize: number;
  datasets: readonly DatasetPaletteItem[];
  commands: readonly CommandPaletteItem[];
  /** Recently used datasets, newest first, already resolved against the library. */
  recents: readonly DatasetPaletteItem[];
}

export interface PalettePlan {
  sections: PaletteSection[];
  /** Every selectable row in visual order; the active index addresses this. */
  flat: PaletteItem[];
  /** Set when nothing at all matched, so the palette shows one empty state. */
  emptyMessage: string | null;
  /** Set when datasets matched but no command did. */
  commandsNote: string | null;
}

/**
 * Builds the palette's sections for a query.
 *
 * An empty query shows recently used datasets plus the commands in their
 * declared order. A non-empty query ranks datasets first (exact symbol, prefix,
 * name, substring), then navigation, then actions.
 */
export function planPalette(input: PlanPaletteInput): PalettePlan {
  const query = normaliseQuery(input.query);
  const sections: PaletteSection[] = [];

  if (query.length === 0) {
    if (input.recents.length > 0) {
      sections.push({ group: 'recent', title: PALETTE_GROUP_TITLES.recent, items: [...input.recents] });
    }
    const navigation = input.commands.filter((item) => item.group === 'navigation');
    if (navigation.length > 0) {
      sections.push({ group: 'navigation', title: PALETTE_GROUP_TITLES.navigation, items: [...navigation] });
    }
    const actions = input.commands.filter((item) => item.group === 'actions');
    if (actions.length > 0) {
      sections.push({ group: 'actions', title: PALETTE_GROUP_TITLES.actions, items: [...actions] });
    }
    return { sections, flat: sections.flatMap((section) => section.items), emptyMessage: null, commandsNote: null };
  }

  const datasets = rank(input.datasets, (item) => scoreDataset(item, query), true);
  const navigation = rank(
    input.commands.filter((item) => item.group === 'navigation'),
    (item) => scoreCommand(item, query),
  );
  const actions = rank(
    input.commands.filter((item) => item.group === 'actions'),
    (item) => scoreCommand(item, query),
  );

  const datasetNote =
    datasets.length > 0
      ? undefined
      : input.librarySize === 0
        ? 'No datasets in the local library yet.'
        : 'No matching datasets.';
  if (datasetNote !== undefined) {
    sections.push({ group: 'datasets', title: PALETTE_GROUP_TITLES.datasets, items: [], note: datasetNote });
  } else {
    sections.push({ group: 'datasets', title: PALETTE_GROUP_TITLES.datasets, items: datasets });
  }
  if (navigation.length > 0) {
    sections.push({ group: 'navigation', title: PALETTE_GROUP_TITLES.navigation, items: navigation });
  }
  if (actions.length > 0) {
    sections.push({ group: 'actions', title: PALETTE_GROUP_TITLES.actions, items: actions });
  }

  const flat = sections.flatMap((section) => section.items);
  if (flat.length === 0) {
    return {
      sections: [],
      flat: [],
      emptyMessage: `No results for “${input.query.trim()}”.`,
      commandsNote: null,
    };
  }

  return {
    sections,
    flat,
    emptyMessage: null,
    commandsNote: navigation.length + actions.length === 0 ? 'No matching commands.' : null,
  };
}
