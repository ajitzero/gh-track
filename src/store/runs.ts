/** Reads of stored runs: payloads, listings, and per-subject summaries. */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ioError } from '../errors.js';
import { errorMessage } from '../guards.js';
import { tolerantSubjectKey } from '../subjects.js';
import type { LastRunSummary, Manifest } from '../types.js';
import { readManifest } from './manifest.js';
import { isValidRunId, runDir, runsDir } from './paths.js';

/**
 * Rejects absolute paths and any `..` segment so a read or write stays inside
 * the run directory.
 */
export function safeRelativePath(relativePath: string, action: 'read' | 'write' = 'read'): string {
  const normalized = path.normalize(relativePath);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw ioError(`Refusing to ${action} outside the run directory: ${relativePath}`, {
      path: relativePath,
    });
  }
  return normalized;
}

/** Reads one JSON payload from a stored run. */
export async function readRunPayload(
  dataDir: string,
  runId: string,
  relativePath: string,
): Promise<unknown> {
  const target = path.join(runDir(dataDir, runId), safeRelativePath(relativePath));
  try {
    const text = await readFile(target, 'utf8');
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = errorMessage(error);
    throw ioError(`Failed to read stored payload ${target}: ${message}`, { path: target });
  }
}

/** Run ids present on disk, newest first. `.tmp-*` directories are ignored. */
export async function listRunIds(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir(dataDir));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.startsWith('.') && isValidRunId(entry))
    .sort()
    .reverse();
}

/** Reads valid manifests, newest first, skipping unreadable runs. */
export async function listManifests(dataDir: string, limit?: number): Promise<Manifest[]> {
  const ids = await listRunIds(dataDir);
  const manifests: Manifest[] = [];
  for (const id of ids) {
    if (limit !== undefined && manifests.length >= limit) {
      break;
    }
    const manifest = await readManifest(dataDir, id);
    if (manifest !== null) {
      manifests.push(manifest);
    }
  }
  return manifests;
}

/** The most recent partial run, if any. */
export async function latestPartialRun(dataDir: string): Promise<Manifest | null> {
  for (const id of await listRunIds(dataDir)) {
    const manifest = await readManifest(dataDir, id);
    if (manifest !== null && manifest.status === 'partial') {
      return manifest;
    }
  }
  return null;
}

/** Case-insensitive identity for a canonical subject string stored in a manifest. */
function manifestSubjectKey(subject: string): string {
  return tolerantSubjectKey(subject);
}

async function payloadLength(
  dataDir: string,
  manifest: Manifest,
  relativePath: string,
): Promise<number> {
  try {
    const payload = await readRunPayload(dataDir, manifest.id, relativePath);
    return Array.isArray(payload) ? payload.length : 0;
  } catch {
    return 0;
  }
}

/** Derives the `repos`/`followers` counts a subject contributed to a run. */
export async function subjectCounts(
  dataDir: string,
  manifest: Manifest,
  subject: string,
): Promise<{ repos: number; followers: number }> {
  let repos = 0;
  let followers = 0;
  for (const entry of manifest.requests) {
    if (entry.subject !== subject || entry.path === undefined) {
      continue;
    }
    if (entry.resource === 'followers') {
      followers += await payloadLength(dataDir, manifest, entry.path);
    } else if (entry.resource === 'repos') {
      repos += await payloadLength(dataDir, manifest, entry.path);
    } else if (entry.resource === 'repo') {
      repos += 1;
    }
  }
  return { repos, followers };
}

interface PendingSummary {
  subject: string;
  key: string;
  manifest: Manifest | null;
}

/**
 * Builds `lastRun` summaries for several subjects while reading the run list
 * once. This is the batched form used by list views.
 */
export async function summarizeLastRuns(
  dataDir: string,
  subjects: readonly string[],
): Promise<Map<string, LastRunSummary | null>> {
  const pending: PendingSummary[] = subjects.map((subject) => ({
    subject,
    key: tolerantSubjectKey(subject),
    manifest: null,
  }));
  let unresolved = pending.length;

  for (const id of await listRunIds(dataDir)) {
    if (unresolved === 0) {
      break;
    }
    const manifest = await readManifest(dataDir, id);
    if (manifest === null || manifest.status === 'failed') {
      continue;
    }
    for (const entry of pending) {
      if (entry.manifest !== null) {
        continue;
      }
      if (manifest.subjects.some((subject) => manifestSubjectKey(subject.subject) === entry.key)) {
        entry.manifest = manifest;
        unresolved -= 1;
      }
    }
  }

  const summaries = new Map<string, LastRunSummary | null>();
  for (const entry of pending) {
    if (entry.manifest === null) {
      summaries.set(entry.subject, null);
      continue;
    }
    const stored = entry.manifest.subjects.find(
      (subject) => manifestSubjectKey(subject.subject) === entry.key,
    );
    const counts = await subjectCounts(dataDir, entry.manifest, stored?.subject ?? entry.subject);
    summaries.set(entry.subject, {
      id: entry.manifest.id,
      status: entry.manifest.status,
      finishedAt: entry.manifest.finishedAt ?? entry.manifest.startedAt,
      repos: counts.repos,
      followers: counts.followers,
    });
  }
  return summaries;
}

/** Builds the `lastRun` summary for a subject, or null when it has no runs. */
export async function summarizeLastRun(
  dataDir: string,
  subject: string,
): Promise<LastRunSummary | null> {
  const summaries = await summarizeLastRuns(dataDir, [subject]);
  return summaries.get(subject) ?? null;
}
