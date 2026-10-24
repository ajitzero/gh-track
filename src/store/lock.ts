/** A pid lock so only one fetch writes to a data directory at a time. */

import { readFile, unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { ioError, locked } from '../errors.js';
import { errorMessage } from '../guards.js';
import { ensureDir, locksDir } from './paths.js';

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export interface LockHandle {
  path: string;
  info: LockInfo;
  release(): Promise<void>;
}

export interface LockOptions {
  isAlive?: ((pid: number) => boolean) | undefined;
  now?: (() => Date) | undefined;
  pid?: number | undefined;
}

export const LOCK_FILE = 'fetch.lock';

/** A pid is alive if `kill(pid, 0)` succeeds or reports EPERM. */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLockInfo(raw: string): LockInfo | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { pid?: unknown }).pid === 'number' &&
      Number.isInteger((value as { pid: number }).pid)
    ) {
      const record = value as { pid: number; startedAt?: unknown };
      return {
        pid: record.pid,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquires the fetch lock. A lock held by a live pid throws `locked`; a lock
 * left by a dead pid is reclaimed.
 */
export async function acquireLock(dataDir: string, options: LockOptions = {}): Promise<LockHandle> {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? ((): Date => new Date());
  const pid = options.pid ?? process.pid;

  const dir = locksDir(dataDir);
  await ensureDir(dir);
  const file = path.join(dir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      const info: LockInfo = { pid, startedAt: now().toISOString() };
      await handle.writeFile(JSON.stringify(info, null, 2));
      await handle.close();
      return {
        path: file,
        info,
        release: async () => {
          await unlink(file).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        const message = errorMessage(error);
        throw ioError(`Failed to create lock ${file}: ${message}`, { path: file });
      }
      const raw = await readFile(file, 'utf8').catch(() => null);
      const existing = raw === null ? null : parseLockInfo(raw);
      if (existing !== null && isAlive(existing.pid)) {
        throw locked(file, existing.pid);
      }
      await unlink(file).catch(() => undefined);
    }
  }

  throw locked(file, 0);
}
