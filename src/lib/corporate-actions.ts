import type { Bar, CorporateAction, CorporateActionType, DateString } from '../domain/types';
import { isDateString } from './date';

/**
 * Provider-reported corporate actions as chart markers.
 *
 * Only events that fall on a session actually present in the rendered series
 * can be marked. A split marker records that the provider reported a split on
 * that date; it does not imply a visible price gap, because the stored OHLC is
 * already split-adjusted. Dividends are cash per share and are never
 * reinvested or folded into the marker.
 */

export interface CorporateActionMarkerSpec {
  date: DateString;
  type: CorporateActionType;
  /** Compact marker label, e.g. `4:1 split` or `Div $0.24`. */
  label: string;
}

export interface CorporateActionPlan {
  markers: CorporateActionMarkerSpec[];
  splits: number;
  dividends: number;
  /**
   * Provider action dates that do not match a rendered session. They are
   * counted and reported instead of being moved to a nearby bar.
   */
  unmatched: number;
  hasActions: boolean;
  /** Explicit provenance and limitation text; null when there is nothing to say. */
  note: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '\u20ac',
  GBP: '\u00a3',
  JPY: '\u00a5',
  CNY: '\u00a5',
  INR: '\u20b9',
  CAD: 'C$',
  AUD: 'A$',
  CHF: 'CHF ',
};

/** Formats a split ratio as new shares per old share, including reverse splits. */
export function formatSplitRatio(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'split';
  if (value >= 1) return `${trimNumber(value)}:1 split`;
  return `1:${trimNumber(1 / value)} reverse split`;
}

/** Formats a cash dividend per share with the instrument currency when known. */
export function formatDividendAmount(value: number, currency?: string | null): string {
  const code = (currency ?? '').trim().toUpperCase();
  const prefix = CURRENCY_SYMBOLS[code];
  const amount = trimNumber(value);
  if (prefix) return `Div ${prefix}${amount}`;
  return code ? `Div ${amount} ${code}` : `Div ${amount}`;
}

/**
 * Turns stored provider actions into marker specs for the series on screen.
 *
 * The caller passes the rendered bars, not the source bars, so a weekly or
 * monthly panel cannot place a marker on a date the chart does not display.
 * Events that fall between displayed sessions are counted as `unmatched` and
 * named in the note rather than being snapped to a neighbouring bar.
 */
export function planCorporateActionMarkers(input: {
  actions: readonly CorporateAction[];
  bars: readonly Bar[];
  currency?: string | null;
}): CorporateActionPlan {
  const sessions = new Set(input.bars.map((bar) => bar.date));
  const markers: CorporateActionMarkerSpec[] = [];
  let splits = 0;
  let dividends = 0;
  let unmatched = 0;

  for (const action of input.actions) {
    if (!isDateString(action.date) || !Number.isFinite(action.value) || action.value <= 0) continue;
    if (action.type !== 'split' && action.type !== 'dividend') continue;

    if (!sessions.has(action.date)) {
      unmatched += 1;
      continue;
    }

    const label =
      action.type === 'split'
        ? formatSplitRatio(action.value)
        : formatDividendAmount(action.value, input.currency);
    markers.push({ date: action.date, type: action.type, label });
    if (action.type === 'split') splits += 1;
    else dividends += 1;
  }

  markers.sort((a, b) => (a.date === b.date ? a.type.localeCompare(b.type) : a.date.localeCompare(b.date)));

  const counted = splits + dividends + unmatched;
  if (counted === 0) {
    return { markers, splits, dividends, unmatched, hasActions: input.actions.length > 0, note: null };
  }

  let note =
    `Provider-reported corporate actions: ${countLabel(splits, 'split')}, ` +
    `${countLabel(dividends, 'cash dividend')}. ` +
    'Markers sit at provider event dates; prices are split-adjusted, so a split marker does not imply a price gap. ' +
    'Dividends are cash per share and are not reinvested.';
  if (unmatched > 0) {
    note += ` ${countLabel(unmatched, 'action date')} ${
      unmatched === 1 ? 'does' : 'do'
    } not coincide with a displayed session and ${unmatched === 1 ? 'is' : 'are'} not marked.`;
  }

  return {
    markers,
    splits,
    dividends,
    unmatched,
    hasActions: input.actions.length > 0,
    note,
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function trimNumber(value: number): string {
  return value
    .toFixed(4)
    .replace(/\.?0+$/, '')
    .replace(/^-0$/, '0');
}
