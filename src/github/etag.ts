/** ETag cache shape and 304 resolution. Filesystem access is injected. */

import { httpError } from '../errors.js';

export interface EtagEntry {
  etag: string;
  lastModified?: string | undefined;
  checkedAt: string;
  lastStatus: number;
  sourceRun?: string | undefined;
  sourcePath?: string | undefined;
}

/** Maps a fully qualified request URL to its last observed validator. */
export type EtagCache = Record<string, EtagEntry>;

export interface EtagObservation {
  etag: string | null;
  lastModified?: string | null | undefined;
  status: number;
  checkedAt: string;
  sourceRun?: string | null | undefined;
  sourcePath?: string | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): EtagEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.etag !== 'string' ||
    value.etag.length === 0 ||
    typeof value.checkedAt !== 'string' ||
    typeof value.lastStatus !== 'number'
  ) {
    return null;
  }
  const entry: EtagEntry = {
    etag: value.etag,
    checkedAt: value.checkedAt,
    lastStatus: value.lastStatus,
  };
  if (typeof value.lastModified === 'string') {
    entry.lastModified = value.lastModified;
  }
  if (typeof value.sourceRun === 'string') {
    entry.sourceRun = value.sourceRun;
  }
  if (typeof value.sourcePath === 'string') {
    entry.sourcePath = value.sourcePath;
  }
  return entry;
}

/** Reads `state/etags.json`, dropping entries that do not match the schema. */
export function parseEtagCache(raw: unknown): EtagCache {
  if (!isRecord(raw)) {
    return {};
  }
  const cache: EtagCache = {};
  for (const [url, value] of Object.entries(raw)) {
    const entry = parseEntry(value);
    if (entry !== null) {
      cache[url] = entry;
    }
  }
  return cache;
}

export function serializeEtagCache(cache: EtagCache): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

export function etagFor(cache: EtagCache, url: string): EtagEntry | undefined {
  return cache[url];
}

/**
 * Records the validator observed for a URL. A response without an ETag clears
 * the entry so the next run refetches unconditionally.
 */
export function recordEtag(
  cache: EtagCache,
  url: string,
  observation: EtagObservation,
): EtagEntry | null {
  if (observation.etag === null || observation.etag.length === 0) {
    delete cache[url];
    return null;
  }
  const entry: EtagEntry = {
    etag: observation.etag,
    checkedAt: observation.checkedAt,
    lastStatus: observation.status,
  };
  if (observation.lastModified != null) {
    entry.lastModified = observation.lastModified;
  }
  if (observation.sourceRun != null) {
    entry.sourceRun = observation.sourceRun;
  }
  if (observation.sourcePath != null) {
    entry.sourcePath = observation.sourcePath;
  }
  cache[url] = entry;
  return entry;
}

export interface ResolvedPayload<T> {
  payload: T;
  sourceRun: string;
  sourcePath: string;
}

/**
 * Resolves a `304` to the payload stored by the run that produced its ETag.
 * `read` is injected so this module never touches the filesystem.
 */
export async function resolveNotModified<T>(
  entry: EtagEntry,
  read: (runId: string, relativePath: string) => Promise<T>,
): Promise<ResolvedPayload<T>> {
  if (entry.sourceRun === undefined || entry.sourcePath === undefined) {
    throw httpError(
      304,
      'Cannot resolve a 304 response: the ETag cache has no stored source for this URL.',
    );
  }
  const payload = await read(entry.sourceRun, entry.sourcePath);
  return { payload, sourceRun: entry.sourceRun, sourcePath: entry.sourcePath };
}
