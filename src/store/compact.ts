/** Compaction: select eligible days, extract metrics, and prune raw runs. */

import { UsageError } from '../errors.js';
import type { CompactedDay, CompactionResult, Manifest, PrunedRun } from '../types.js';
import { replaceHistoryDay } from './history.js';
import { findPrunableRuns, pruneRuns, runDay } from './prune.js';
import { listManifests, readRunPayload } from './runs.js';
import { readStateJson, STATE_COMPACTED_FILE, writeStateJson } from './state.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The UTC day at or before which raw data is retained. */
export function retentionCutoff(now: Date, keepDays: number): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - keepDays * DAY_MS).toISOString().slice(0, 10);
}

/** A day is eligible only when it is strictly older than the retention window. */
export function isEligibleDay(day: string, cutoff: string): boolean {
  return DAY_PATTERN.test(day) && day < cutoff;
}

export interface CompactCandidate {
  date: string;
  manifest: Manifest;
}

/**
 * One candidate per eligible day: the last complete run of that day wins.
 * `listManifests` is newest-first, so the first complete run seen for a day is
 * the latest one.
 */
export async function selectCompactCandidates(
  dataDir: string,
  cutoff: string,
): Promise<CompactCandidate[]> {
  const manifests = await listManifests(dataDir);
  const seen = new Set<string>();
  const candidates: CompactCandidate[] = [];

  for (const manifest of manifests) {
    if (manifest.status !== 'complete') {
      continue;
    }
    const day = runDay(manifest.id);
    if (!isEligibleDay(day, cutoff) || seen.has(day)) {
      continue;
    }
    seen.add(day);
    candidates.push({ date: day, manifest });
  }

  return candidates.sort((left, right) => left.date.localeCompare(right.date));
}

export interface DayMetrics {
  repos: Map<string, { stars: number; forks: number }>;
  users: Map<string, number>;
}

function repoMetrics(
  value: unknown,
): { repository: string; stars: number; forks: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const repository = value.full_name;
  const stars = value.stargazers_count;
  const forks = value.forks_count;
  if (
    typeof repository !== 'string' ||
    repository.length === 0 ||
    typeof stars !== 'number' ||
    !Number.isInteger(stars) ||
    typeof forks !== 'number' ||
    !Number.isInteger(forks)
  ) {
    return null;
  }
  return { repository, stars, forks };
}

function addRepo(metrics: DayMetrics, value: unknown): void {
  const repo = repoMetrics(value);
  if (repo === null) {
    return;
  }
  metrics.repos.set(repo.repository, { stars: repo.stars, forks: repo.forks });
}

async function readPayload(
  dataDir: string,
  manifest: Manifest,
  relativePath: string,
): Promise<unknown | null> {
  try {
    return await readRunPayload(dataDir, manifest.id, relativePath);
  } catch {
    return null;
  }
}

/**
 * Extracts stars/forks for every repository and the follower count for every
 * user from the payloads referenced by a manifest. Missing payloads are
 * skipped rather than failing the whole day.
 */
export async function extractDayMetrics(
  dataDir: string,
  manifest: Manifest,
): Promise<DayMetrics> {
  const metrics: DayMetrics = { repos: new Map(), users: new Map() };

  for (const entry of manifest.requests) {
    if (entry.path === undefined) {
      continue;
    }

    if (entry.resource === 'followers') {
      if (!entry.subject.startsWith('user:')) {
        continue;
      }
      const account = entry.subject.slice('user:'.length);
      if (account.length === 0) {
        continue;
      }
      const payload = await readPayload(dataDir, manifest, entry.path);
      if (Array.isArray(payload)) {
        metrics.users.set(account, (metrics.users.get(account) ?? 0) + payload.length);
      }
      continue;
    }

    if (entry.resource === 'repos') {
      const payload = await readPayload(dataDir, manifest, entry.path);
      if (Array.isArray(payload)) {
        for (const repo of payload) {
          addRepo(metrics, repo);
        }
      }
      continue;
    }

    if (entry.resource === 'repo') {
      addRepo(metrics, await readPayload(dataDir, manifest, entry.path));
    }
  }

  return metrics;
}

function parseCompactedDays(raw: unknown): Set<string> {
  if (!isRecord(raw) || !Array.isArray(raw.days)) {
    return new Set();
  }
  return new Set(raw.days.filter((day): day is string => typeof day === 'string' && DAY_PATTERN.test(day)));
}

/** UTC days previously compacted into history. */
export async function readCompactedDays(dataDir: string): Promise<Set<string>> {
  return parseCompactedDays(await readStateJson(dataDir, STATE_COMPACTED_FILE));
}

async function markCompactedDays(dataDir: string, days: Iterable<string>): Promise<void> {
  const current = await readCompactedDays(dataDir);
  let changed = false;
  for (const day of days) {
    if (!current.has(day)) {
      current.add(day);
      changed = true;
    }
  }
  if (changed) {
    await writeStateJson(dataDir, STATE_COMPACTED_FILE, {
      days: [...current].sort(),
    });
  }
}

export interface CompactionOptions {
  keepDays: number;
  now?: Date | undefined;
  dryRun?: boolean | undefined;
}

/**
 * Compacts eligible days into history and prunes their raw runs. With
 * `dryRun`, nothing is written or deleted; the result lists what would change.
 */
export async function runCompaction(
  dataDir: string,
  options: CompactionOptions,
): Promise<CompactionResult> {
  if (!Number.isInteger(options.keepDays) || options.keepDays < 1) {
    throw new UsageError('Retention days must be a positive integer.');
  }

  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const cutoff = retentionCutoff(now, options.keepDays);
  const candidates = await selectCompactCandidates(dataDir, cutoff);

  const compacted: CompactedDay[] = [];
  for (const candidate of candidates) {
    const metrics = await extractDayMetrics(dataDir, candidate.manifest);
    if (!dryRun) {
      await replaceHistoryDay(dataDir, candidate.date, metrics.repos, metrics.users);
      await markCompactedDays(dataDir, [candidate.date]);
    }
    compacted.push({
      date: candidate.date,
      repos: metrics.repos.size,
      users: metrics.users.size,
    });
  }

  const compactedDays = await readCompactedDays(dataDir);
  if (dryRun) {
    for (const candidate of candidates) {
      compactedDays.add(candidate.date);
    }
  }

  let pruned: PrunedRun[];
  if (dryRun) {
    pruned = await findPrunableRuns(dataDir, compactedDays);
  } else {
    pruned = await pruneRuns(dataDir, compactedDays);
  }

  return { dryRun, compacted, pruned };
}
