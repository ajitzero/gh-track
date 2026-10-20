/** Small config mutations shared by `watch add` and `dashboard add`. */

import { subjectKey, type ParsedSubject } from './subjects.js';
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
