/** Classifies `--from`/`--to` references for diff and dashboard. */

import { isCalendarDay } from './date.js';
import { UsageError } from './errors.js';
import { isValidRunId } from './store/paths.js';

export type RefKind = 'latest' | 'previous' | 'date' | 'run';

export interface ClassifyRefOptions {
  /** Label used in the error message, e.g. `diff` or `--from`. */
  label: string;
}

export function classifyRef(
  ref: string,
  options: ClassifyRefOptions = { label: 'diff' },
): RefKind {
  if (ref === 'latest' || ref === 'previous') {
    return ref;
  }
  if (isCalendarDay(ref)) {
    return 'date';
  }
  if (isValidRunId(ref)) {
    return 'run';
  }
  throw new UsageError(
    `Invalid ${options.label} reference: ${JSON.stringify(ref)}. Use latest, previous, a run id, or YYYY-MM-DD.`,
  );
}

export function classifyRangeRef(ref: string, flag: string): RefKind {
  return classifyRef(ref, { label: flag });
}

export function rejectPreviousTo(ref: string | undefined): void {
  if (ref !== undefined && classifyRangeRef(ref, '--to') === 'previous') {
    throw new UsageError('--to cannot be "previous"; use latest, a run id, or YYYY-MM-DD.');
  }
}
