/** Persisted JSON state under `state/`, tolerant of missing or corrupt files. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { stateDir } from './paths.js';

export const STATE_ETAGS_FILE = 'etags.json';
export const STATE_LIMITS_FILE = 'limits.json';

/**
 * Reads a JSON state file. A missing, unreadable, or malformed file returns
 * null: the caches are advisory and rebuild themselves.
 */
export async function readStateJson(dataDir: string, name: string): Promise<unknown | null> {
  try {
    const text = await readFile(path.join(stateDir(dataDir), name), 'utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function writeStateJson(
  dataDir: string,
  name: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(path.join(stateDir(dataDir), name), `${JSON.stringify(value, null, 2)}\n`);
}
