/** Fetch-resource parsing shared by `watch add` and `dashboard add`. */

import { UsageError } from './errors.js';
import type { Resource } from './types.js';

export const USER_RESOURCES: readonly Resource[] = ['followers', 'repos'];

const USER_RESOURCE_SET = new Set<string>(USER_RESOURCES);

/** Parses a comma-separated subset of `followers,repos` in canonical order. */
export function parseResources(value: string): Resource[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new UsageError(
      `Invalid --resources value ${JSON.stringify(value)}. Expected a comma-separated subset of followers,repos.`,
    );
  }

  const resources = new Set<Resource>();
  for (const part of parts) {
    if (!USER_RESOURCE_SET.has(part)) {
      throw new UsageError(
        `Invalid --resources value ${JSON.stringify(value)}. Expected a comma-separated subset of followers,repos.`,
      );
    }
    resources.add(part as Resource);
  }
  return USER_RESOURCES.filter((resource) => resources.has(resource));
}
