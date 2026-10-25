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

/** Days from 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Calendar year containing a day counted from 1970-01-01. */
function civilYearFromDays(days: number): number {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) for a count of days from 1970-01-01. */
function isoWeekdayFromDays(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/**
 * Monday-based week bucket key, e.g. `2024-W07`.
 *
 * Pure integer arithmetic: the previous implementation built several `Date`
 * objects and ISO strings per bar, which made weekly aggregation of a 5,000-bar
 * series an order of magnitude slower than monthly aggregation. The ISO
 * week-year is still the year containing the week's Thursday, so the key is
 * unchanged (verified against the calendar implementation across 46 years).
 */
export function weekKey(value: DateString): string {
  const days = daysFromCivil(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)));
  const monday = days - (isoWeekdayFromDays(days) - 1);
  const isoYear = civilYearFromDays(monday + 3);
  const jan4 = daysFromCivil(isoYear, 1, 4);
  // ISO week 1 is the week containing January 4 of the ISO week-year.
  const week1Monday = jan4 - (isoWeekdayFromDays(jan4) - 1);
  const week = 1 + Math.floor((monday - week1Monday) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
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
