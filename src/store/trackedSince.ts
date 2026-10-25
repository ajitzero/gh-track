/** Per-subject add times that hide observations from before a re-add. */

import { stat } from 'node:fs/promises';

import { isRecord } from '../guards.js';
import { subjectKeyOf } from '../subjects.js';
import { readStateJson, STATE_TRACKED_SINCE_FILE, writeStateJson } from './state.js';

async function hasDataDir(dataDir: string): Promise<boolean> {
  try {
    await stat(dataDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Reads a `{ subjectKey: isoTimestamp }` document, dropping invalid entries. */
export function parseTrackedSince(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isRecord(raw)) {
    return map;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isNaN(time)) {
      map.set(key, new Date(time).toISOString());
    }
  }
  return map;
}

export async function readTrackedSince(dataDir: string): Promise<Map<string, string>> {
  return parseTrackedSince(await readStateJson(dataDir, STATE_TRACKED_SINCE_FILE));
}

/**
 * Records the instant a brand-new subject entry was added. Observations saved
 * before it are hidden for that subject, so deleting and re-adding a subject
 * starts a fresh dashboard baseline instead of resurfacing old history.
 */
export async function recordTrackedSince(
  dataDir: string,
  subjects: readonly string[],
  since: string,
): Promise<void> {
  if (subjects.length === 0) {
    return;
  }
  // Without a data directory there are no stored observations to hide.
  if (!(await hasDataDir(dataDir))) {
    return;
  }
  const trackedSince = await readTrackedSince(dataDir);
  for (const subject of subjects) {
    trackedSince.set(subjectKeyOf(subject), since);
  }
  const sorted = [...trackedSince.entries()].sort(([left], [right]) => left.localeCompare(right));
  await writeStateJson(dataDir, STATE_TRACKED_SINCE_FILE, Object.fromEntries(sorted));
}
