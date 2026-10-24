/** Classifies `--from`/`--to` references for diff, dashboard, and export. */

import { isCalendarDay, isRelativeDay, relativeDay } from './date.js';
import { UsageError } from './errors.js';
import { isValidRunId } from './store/paths.js';

export type RefKind = 'latest' | 'previous' | 'date' | 'relative' | 'run';

export interface ParsedRef {
  kind: RefKind;
  /** The value as supplied, except that offsets and days both expose their day below. */
  ref: string;
  /** Absolute UTC day for `date` and `relative` references. */
  day?: string;
}

export interface ParseRefOptions {
  /** Label used in the error message, e.g. `diff` or `--from`. */
  label: string;
  /** Instant relative offsets are measured from; defaults to now. */
  now?: Date | undefined;
}

const REF_FORMS =
  'latest, previous, a run id, YYYY-MM-DD, or a past offset like 1y (units: d, w, m, y)';

/**
 * Parses a reference once. Relative offsets are resolved to an absolute UTC day
 * against `now`, so every consumer can treat them exactly like `YYYY-MM-DD`.
 */
export function parseRef(ref: string, options: ParseRefOptions = { label: 'diff' }): ParsedRef {
  if (ref === 'latest' || ref === 'previous') {
    return { kind: ref, ref };
  }
  if (isCalendarDay(ref)) {
    return { kind: 'date', ref, day: ref };
  }
  if (isRelativeDay(ref)) {
    const day = relativeDay(ref, options.now);
    if (day !== null) {
      return { kind: 'relative', ref, day };
    }
  }
  if (isValidRunId(ref)) {
    return { kind: 'run', ref };
  }
  throw new UsageError(
    `Invalid ${options.label} reference: ${JSON.stringify(ref)}. Use ${REF_FORMS}.`,
  );
}

/** The reference form only; use `parseRef` when the resolved day is needed. */
export function classifyRef(ref: string, options: ParseRefOptions = { label: 'diff' }): RefKind {
  return parseRef(ref, options).kind;
}

export function classifyRangeRef(ref: string, flag: string, now?: Date): RefKind {
  return classifyRef(ref, { label: flag, now });
}

export function rejectPreviousTo(ref: string | undefined, now?: Date): void {
  if (ref !== undefined && classifyRangeRef(ref, '--to', now) === 'previous') {
    throw new UsageError(`--to cannot be "previous"; use ${REF_FORMS}.`);
  }
}
