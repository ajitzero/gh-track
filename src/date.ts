/** UTC calendar-day helpers shared by config, history, export, and refs. */

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
