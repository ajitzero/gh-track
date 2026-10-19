/** Reads of a stored run directory. Writing runs is M3. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ioError } from '../errors.js';
import { runDir } from './paths.js';

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
