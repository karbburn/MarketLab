import type { DateString } from '../domain/types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: unknown): value is DateString {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

export function toDateString(date: Date): DateString {
  return date.toISOString().slice(0, 10);
}

export function parseDate(value: DateString): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Returns the ISO weekday (1 = Monday ... 7 = Sunday) for a session date. */
export function isoWeekday(value: DateString): number {
  const day = parseDate(value).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Normalises assorted date-ish input into a session date. Returns null when the
 * value cannot be interpreted unambiguously. Time components are discarded on
 * purpose: bars are date-only.
 */
export function normaliseDate(input: string): DateString | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isDateString(trimmed)) return trimmed;

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    const year = Number(dmy[3]);
    // Ambiguous numeric dates are not guessed; require an explicit ISO value.
    if (first > 12 || second > 12) {
      const day = first > 12 ? first : second;
      const month = first > 12 ? second : first;
      const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return isDateString(candidate) ? candidate : null;
    }
    return null;
  }

  // ISO timestamps are reduced to their date prefix and validated as a session
  // date. The time and offset are discarded, never converted between zones.
  const isoTimestamp = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(trimmed);
  if (isoTimestamp) {
    const date = isoTimestamp[1] as string;
    return isDateString(date) ? date : null;
  }

  // Anything else (bare numbers, slash dates, month names) is rejected rather
  // than handed to Date.parse, which is timezone- and implementation-dependent.
  return null;
}

export function addDays(value: DateString, days: number): DateString {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateString(date);
}

export function compareDates(a: DateString, b: DateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function clampDate(value: DateString, min: DateString, max: DateString): DateString {
  if (compareDates(value, min) < 0) return min;
  if (compareDates(value, max) > 0) return max;
  return value;
}

/** Monday-based week bucket key, e.g. `2024-W07`. */
export function weekKey(value: DateString): string {
  const monday = addDays(value, -(isoWeekday(value) - 1));
  const thursday = addDays(monday, 3);
  const year = parseDate(thursday).getUTCFullYear();
  // ISO week 1 is the week containing January 4 of the ISO week-year.
  const jan4 = `${year}-01-04`;
  const firstThursdayDate = addDays(jan4, 4 - isoWeekday(jan4));
  const week = 1 + Math.round((parseDate(thursday).getTime() - parseDate(firstThursdayDate).getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Calendar-month bucket key, e.g. `2024-07`. */
export function monthKey(value: DateString): string {
  return value.slice(0, 7);
}

/** Number of calendar years between two session dates, used for CAGR only. */
export function yearsBetween(from: DateString, to: DateString): number {
  const days = (parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000;
  return days / 365.25;
}

export function daysBetween(from: DateString, to: DateString): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}

export function lastNDates(from: DateString, count: number): DateString {
  return addDays(from, -(count - 1));
}

export function today(): DateString {
  return toDateString(new Date());
}

export function formatDateLabel(value: DateString): string {
  const date = parseDate(value);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}
