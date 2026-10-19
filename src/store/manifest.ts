/** `manifest.json` creation, parsing, and atomic read/write. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ioError } from '../errors.js';
import type {
  Manifest,
  ManifestErrorEntry,
  ManifestRequestEntry,
  ManifestStats,
  ManifestSubject,
  PendingRequest,
  Resource,
  RunStatus,
} from '../types.js';
import { writeFileAtomic } from './atomic.js';
import { runDir } from './paths.js';

export const SCHEMA_VERSION = 1;

const RUN_STATUSES = new Set<RunStatus>(['complete', 'partial', 'failed']);

export function emptyStats(): ManifestStats {
  return { repos: 0, followers: 0, requests: 0, notModified: 0 };
}

export function createManifest(
  id: string,
  startedAt: string,
  subjects: readonly ManifestSubject[],
): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    startedAt,
    finishedAt: null,
    status: 'partial',
    subjects: subjects.map((subject) => ({
      subject: subject.subject,
      resources: [...subject.resources],
    })),
    stats: emptyStats(),
    requests: [],
    pending: [],
    errors: [],
  };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asResource(value: unknown): Resource | null {
  return value === 'followers' || value === 'repos' || value === 'repo' ? value : null;
}

function parseRequest(value: unknown): ManifestRequestEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const resource = asResource(value.resource);
  if (
    typeof value.subject !== 'string' ||
    resource === null ||
    typeof value.url !== 'string' ||
    typeof value.page !== 'number' ||
    typeof value.status !== 'number'
  ) {
    return null;
  }
  const entry: ManifestRequestEntry = {
    subject: value.subject,
    resource,
    url: value.url,
    page: value.page,
    status: value.status,
  };
  if (typeof value.etag === 'string') {
    entry.etag = value.etag;
  }
  if (typeof value.path === 'string') {
    entry.path = value.path;
  }
  if (typeof value.sourceRun === 'string') {
    entry.sourceRun = value.sourceRun;
  }
  if (typeof value.sourcePath === 'string') {
    entry.sourcePath = value.sourcePath;
  }
  return entry;
}

function parsePending(value: unknown): PendingRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const resource = asResource(value.resource);
  if (
    typeof value.subject !== 'string' ||
    resource === null ||
    typeof value.url !== 'string' ||
    typeof value.page !== 'number'
  ) {
    return null;
  }
  return { subject: value.subject, resource, url: value.url, page: value.page };
}

function parseError(value: unknown): ManifestErrorEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const resource = asResource(value.resource);
  if (
    typeof value.subject !== 'string' ||
    resource === null ||
    typeof value.url !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }
  return {
    subject: value.subject,
    resource,
    url: value.url,
    status: typeof value.status === 'number' ? value.status : 0,
    code: value.code,
    message: value.message,
  };
}

function parseSubjects(value: unknown): ManifestSubject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const subjects: ManifestSubject[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.subject !== 'string' || !Array.isArray(entry.resources)) {
      continue;
    }
    const resources: Resource[] = [];
    for (const resource of entry.resources) {
      const parsed = asResource(resource);
      if (parsed !== null) {
        resources.push(parsed);
      }
    }
    subjects.push({ subject: entry.subject, resources });
  }
  return subjects;
}

function parseStats(value: unknown): ManifestStats {
  const stats = emptyStats();
  if (!isRecord(value)) {
    return stats;
  }
  for (const key of ['repos', 'followers', 'requests', 'notModified'] as const) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isInteger(raw)) {
      stats[key] = raw;
    }
  }
  return stats;
}

/** Parses a manifest, returning null when required fields are missing. */
export function parseManifest(raw: unknown): Manifest | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    raw.schemaVersion !== SCHEMA_VERSION ||
    typeof raw.id !== 'string' ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.status !== 'string' ||
    !RUN_STATUSES.has(raw.status as RunStatus)
  ) {
    return null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    startedAt: raw.startedAt,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    status: raw.status as RunStatus,
    subjects: parseSubjects(raw.subjects),
    stats: parseStats(raw.stats),
    requests: Array.isArray(raw.requests)
      ? raw.requests.map(parseRequest).filter((entry): entry is ManifestRequestEntry => entry !== null)
      : [],
    pending: Array.isArray(raw.pending)
      ? raw.pending.map(parsePending).filter((entry): entry is PendingRequest => entry !== null)
      : [],
    errors: Array.isArray(raw.errors)
      ? raw.errors.map(parseError).filter((entry): entry is ManifestErrorEntry => entry !== null)
      : [],
  };
}

export async function writeManifest(directory: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(path.join(directory, 'manifest.json'), serializeManifest(manifest));
}

/** Reads `runs/<id>/manifest.json`, returning null when absent or unusable. */
export async function readManifest(dataDir: string, id: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(path.join(runDir(dataDir, id), 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    return parseManifest(JSON.parse(text));
  } catch {
    return null;
  }
}
