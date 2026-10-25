/** Small config mutations shared by `watch add` and `dashboard add`. */

import { subjectKey, subjectKeyOf, type ParsedSubject } from './subjects.js';
import type { Config, ConfigSubject, Resource } from './types.js';

/** Builds a `[[subjects]]` entry from a parsed subject and its resources. */
export function toConfigSubject(
  parsed: ParsedSubject,
  resources: readonly Resource[],
): ConfigSubject {
  return parsed.type === 'user'
    ? {
        subject: parsed.subject,
        type: 'user',
        account: parsed.account,
        resources: [...resources],
      }
    : {
        subject: parsed.subject,
        type: 'repo',
        repo: parsed.repo,
        resources: ['repo'],
      };
}

/** Appends or replaces a subject by case-insensitive identity. */
export function upsertSubject(config: Config, entry: ConfigSubject): boolean {
  const key = subjectKey(entry);
  const index = config.subjects.findIndex((subject) => subjectKey(subject) === key);
  if (index >= 0) {
    config.subjects[index] = entry;
    return false;
  }
  config.subjects.push(entry);
  return true;
}

export interface RemovedConfiguredSubject {
  subject: string;
  removedFromTracking: boolean;
  /** Names of views removed because the subject was their last item. */
  emptyViews: string[];
  warnings: string[];
}

/**
 * Fully removes a configured subject: the watchlist, the default tracking
 * selection, and every saved view. Views left without items are dropped.
 * Returns null when the subject is not configured.
 */
export function removeConfiguredSubject(
  config: Config,
  subject: string,
): RemovedConfiguredSubject | null {
  const key = subjectKeyOf(subject);
  const index = config.subjects.findIndex((entry) => subjectKey(entry) === key);
  const existing = index < 0 ? undefined : config.subjects[index];
  if (existing === undefined) {
    return null;
  }

  config.subjects.splice(index, 1);

  const trackedBefore = config.tracking.length;
  config.tracking = config.tracking.filter((entry) => subjectKeyOf(entry.subject) !== key);
  const removedFromTracking = config.tracking.length !== trackedBefore;

  const emptyViews: string[] = [];
  config.views = config.views.filter((view) => {
    const items = view.items.filter((entry) => subjectKeyOf(entry.subject) !== key);
    if (items.length === 0) {
      emptyViews.push(view.name);
      return false;
    }
    view.items = items;
    return true;
  });

  const warnings: string[] = [];
  if (removedFromTracking) {
    warnings.push(`Removed ${existing.subject} from the dashboard selection.`);
  }
  for (const name of emptyViews) {
    warnings.push(`Removed empty dashboard view ${name}.`);
  }

  return {
    subject: existing.subject,
    removedFromTracking,
    emptyViews,
    warnings,
  };
}
