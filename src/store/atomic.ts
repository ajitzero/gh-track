/** Atomic file writes: temp file in the destination directory, then rename. */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ioError } from '../errors.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
    throw ioError(`Failed to write ${filePath}: ${errorMessage(error)}`, { path: filePath });
  }
}
