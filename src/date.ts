/** UTC calendar-day helpers shared by config, history, export, and refs. */

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Strict `-<n><unit>` offset: days, weeks, calendar months, or calendar years. */
export const RELATIVE_DAY_PATTERN = /^-(\d+)([dwmy])$/;

/** Loose shape used by the CLI parser to accept `--from -1y` as an option value. */
export const RELATIVE_VALUE_PATTERN = /^-\d+[a-z]+$/i;

/** True for a real UTC calendar day in `YYYY-MM-DD` form. */
export function isCalendarDay(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The last instant of a UTC day, used to make date ranges inclusive. */
export function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/** The UTC day encoded in an ISO-8601 timestamp or run id. */
export function utcDay(value: string): string {
  return value.slice(0, 'YYYY-MM-DD'.length);
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function daysInMonth(year: number, monthIndex: number): number {
  return utcDate(year, monthIndex + 1, 0).getUTCDate();
}

function isoDay(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function formatDay(year: number, monthIndex: number, day: number): string | null {
  return isoDay(utcDate(year, monthIndex, day));
}

/** True for the `-1y`/`-6m`/`-2w`/`-30d` offset shape, without validating the amount. */
export function isRelativeDay(value: string): boolean {
  return RELATIVE_DAY_PATTERN.test(value);
}

/**
 * Resolves a relative offset against `now` (default: the current instant) to a
 * UTC calendar day. Days and weeks shift whole days; months and years use
 * calendar arithmetic with day clamping, so `2026-03-31 -1m` is `2026-02-28`.
 * Returns null for malformed or out-of-range offsets.
 */
export function relativeDay(ref: string, now: Date = new Date()): string | null {
  const match = RELATIVE_DAY_PATTERN.exec(ref);
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return null;
  }
  const unit = match[2];
  const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const year = base.getUTCFullYear();
  const monthIndex = base.getUTCMonth();
  const day = base.getUTCDate();

  if (unit === 'd' || unit === 'w') {
    const days = unit === 'w' ? amount * 7 : amount;
    const shifted = utcDate(year, monthIndex, day);
    shifted.setUTCDate(shifted.getUTCDate() - days);
    return isoDay(shifted);
  }

  if (unit === 'm') {
    const total = year * 12 + monthIndex - amount;
    const targetYear = Math.floor(total / 12);
    const targetMonth = ((total % 12) + 12) % 12;
    return formatDay(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
  }

  const targetYear = year - amount;
  return formatDay(targetYear, monthIndex, Math.min(day, daysInMonth(targetYear, monthIndex)));
}

/** True when `value` is a relative offset that resolves to a real UTC day. */
export function isValidRelativeDay(value: string): boolean {
  return relativeDay(value) !== null;
}
