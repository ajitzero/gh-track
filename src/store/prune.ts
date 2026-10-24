/** Retention deletion: raw run directories, confined to valid run ids. */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import { utcDay } from '../date.js';
import { ioError } from '../errors.js';
import { errorMessage, isRecord } from '../guards.js';
import type { PrunedRun } from '../types.js';
import { isValidRunId, runDir, runsDir } from './paths.js';
import { listRunIds } from './runs.js';
import { readStateJson, STATE_ETAGS_FILE, writeStateJson } from './state.js';

/** UTC day encoded in a run id. */
export const runDay = utcDay;

/** Runs whose day is in `days`, without deleting anything. */
export async function findPrunableRuns(
  dataDir: string,
  days: ReadonlySet<string>,
): Promise<PrunedRun[]> {
  const ids = await listRunIds(dataDir);
  return ids.filter((id) => days.has(runDay(id))).map((id) => ({ id, path: runDir(dataDir, id) }));
}

/** Refuses any path that is not exactly `runs/<valid-run-id>`. */
function assertPrunable(dataDir: string, entry: PrunedRun): void {
  if (!isValidRunId(entry.id)) {
    throw ioError(`Refusing to prune an invalid run id: ${entry.id}`, { path: entry.path });
  }
  const runs = path.resolve(runsDir(dataDir));
  const target = path.resolve(entry.path);
  if (path.dirname(target) !== runs || target !== path.resolve(runDir(dataDir, entry.id))) {
    throw ioError(`Refusing to prune a path outside the runs directory: ${entry.path}`, {
      path: entry.path,
    });
  }
}

/**
 * ETag entries that point at a pruned run can no longer resolve a `304`, so
 * they are dropped. The next fetch refetches those URLs unconditionally.
 */
async function forgetEtagSources(dataDir: string, prunedIds: ReadonlySet<string>): Promise<void> {
  const raw = await readStateJson(dataDir, STATE_ETAGS_FILE);
  if (!isRecord(raw)) {
    return;
  }

  let changed = false;
  for (const [url, entry] of Object.entries(raw)) {
    if (isRecord(entry) && typeof entry.sourceRun === 'string' && prunedIds.has(entry.sourceRun)) {
      delete raw[url];
      changed = true;
    }
  }
  if (changed) {
    await writeStateJson(dataDir, STATE_ETAGS_FILE, raw);
  }
}

/**
 * Deletes every run directory whose UTC day has been compacted. Only ids that
 * match the run-id pattern are considered, and each path is re-checked before
 * a recursive delete.
 */
export async function pruneRuns(dataDir: string, days: ReadonlySet<string>): Promise<PrunedRun[]> {
  const candidates = await findPrunableRuns(dataDir, days);
  const pruned: PrunedRun[] = [];

  for (const candidate of candidates) {
    assertPrunable(dataDir, candidate);
    try {
      await rm(candidate.path, { recursive: true, force: true });
    } catch (error) {
      const message = errorMessage(error);
      throw ioError(`Failed to prune run ${candidate.id}: ${message}`, { path: candidate.path });
    }
    pruned.push(candidate);
  }

  if (pruned.length > 0) {
    await forgetEtagSources(dataDir, new Set(pruned.map((entry) => entry.id)));
  }
  return pruned;
}
