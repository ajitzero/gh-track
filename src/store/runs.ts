/** Reads of stored runs: payloads, listings, and per-subject summaries. */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ioError } from '../errors.js';
import type { LastRunSummary, Manifest } from '../types.js';
import { readManifest } from './manifest.js';
import { isValidRunId, runDir, runsDir } from './paths.js';
import { parseSubject, subjectKey } from '../subjects.js';

/** Rejects absolute paths and any `..` segment so a read stays inside the run. */
function safeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw ioError(`Refusing to read outside the run directory: ${relativePath}`, {
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
    const message = error instanceof Error ? error.message : String(error);
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

/** Reads every valid manifest, newest first, skipping unreadable runs. */
export async function listManifests(dataDir: string): Promise<Manifest[]> {
  const ids = await listRunIds(dataDir);
  const manifests: Manifest[] = [];
  for (const id of ids) {
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

/** The most recent complete-or-partial run that includes a subject. */
export async function latestRunForSubject(
  dataDir: string,
  subject: string,
): Promise<Manifest | null> {
  let key: string;
  try {
    key = subjectKey(parseSubject(subject));
  } catch {
    key = subject.toLowerCase();
  }
  for (const id of await listRunIds(dataDir)) {
    const manifest = await readManifest(dataDir, id);
    if (manifest === null || manifest.status === 'failed') {
      continue;
    }
    if (manifest.subjects.some((entry) => manifestSubjectKey(entry.subject) === key)) {
      return manifest;
    }
  }
  return null;
}

/** Case-insensitive identity for a canonical subject string stored in a manifest. */
function manifestSubjectKey(subject: string): string {
  try {
    return subjectKey(parseSubject(subject));
  } catch {
    return subject.toLowerCase();
  }
}

async function payloadLength(dataDir: string, manifest: Manifest, relativePath: string): Promise<number> {
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

/** Builds the `lastRun` summary for a subject, or null when it has no runs. */
export async function summarizeLastRun(
  dataDir: string,
  subject: string,
): Promise<LastRunSummary | null> {
  const manifest = await latestRunForSubject(dataDir, subject);
  if (manifest === null) {
    return null;
  }
  const key = manifestSubjectKey(subject);
  const stored = manifest.subjects.find((entry) => manifestSubjectKey(entry.subject) === key);
  const counts = await subjectCounts(dataDir, manifest, stored?.subject ?? subject);
  return {
    id: manifest.id,
    status: manifest.status,
    finishedAt: manifest.finishedAt ?? manifest.startedAt,
    repos: counts.repos,
    followers: counts.followers,
  };
}
