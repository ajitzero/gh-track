/** Run directory writes: payload files, manifest, and atomic promotion. */

import { readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ioError } from '../errors.js';
import { errorMessage } from '../guards.js';
import type { Manifest } from '../types.js';
import { writeFileAtomic } from './atomic.js';
import { writeManifest } from './manifest.js';
import { ensureDir, runsDir, runDir, tempRunDir } from './paths.js';

const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

export function safeSegment(value: string): string {
  return value.replace(SAFE_SEGMENT, '-');
}

/** `owner__name` for a repository file name. */
export function repoFileStem(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `${safeSegment(owner)}__${safeSegment(name)}`;
}

function pageNumber(page: number): string {
  return String(page).padStart(4, '0');
}

export function followerPagePath(login: string, page: number): string {
  return path.posix.join(
    'accounts',
    safeSegment(login),
    'followers',
    `page-${pageNumber(page)}.json`,
  );
}

export function repoPagePath(login: string, page: number): string {
  return path.posix.join('accounts', safeSegment(login), 'repos', `page-${pageNumber(page)}.json`);
}

export function accountRepoPath(login: string, fullName: string): string {
  return path.posix.join('accounts', safeSegment(login), 'repos', `${repoFileStem(fullName)}.json`);
}

export function standaloneRepoPath(fullName: string): string {
  return path.posix.join('repos', `${repoFileStem(fullName)}.json`);
}

export interface RunWriter {
  readonly id: string;
  /** Temp directory for a fresh run; the run directory when resuming. */
  readonly directory: string;
  readonly fresh: boolean;
  writePayload(relativePath: string, payload: unknown): Promise<string>;
  readPayload(relativePath: string): Promise<unknown>;
  writeManifest(manifest: Manifest): Promise<void>;
  /** Moves a fresh temp directory into `runs/<id>/`; a no-op when resuming. */
  promote(): Promise<void>;
  /** Removes a fresh temp directory after a failure; a no-op when resuming. */
  discard(): Promise<void>;
}

async function makeWriter(
  id: string,
  directory: string,
  finalDir: string,
  fresh: boolean,
): Promise<RunWriter> {
  await ensureDir(directory);

  return {
    id,
    directory,
    fresh,
    async writePayload(relativePath: string, payload: unknown): Promise<string> {
      await writeFileAtomic(
        path.join(directory, relativePath),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
      return relativePath;
    },
    async readPayload(relativePath: string): Promise<unknown> {
      const text = await readFile(path.join(directory, relativePath), 'utf8');
      return JSON.parse(text) as unknown;
    },
    async writeManifest(manifest: Manifest): Promise<void> {
      await writeManifest(directory, manifest);
    },
    async promote(): Promise<void> {
      if (!fresh) {
        return;
      }
      try {
        await rename(directory, finalDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw ioError(
            `A run with id ${id} already exists; run ids are second-precision, so retry in a moment.`,
            { path: finalDir },
          );
        }
        const message = errorMessage(error);
        throw ioError(`Failed to promote run ${id}: ${message}`, { path: finalDir });
      }
    },
    async discard(): Promise<void> {
      if (!fresh) {
        return;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Creates a writer for a new run, working in `runs/.tmp-<id>/`. */
export async function createRunWriter(dataDir: string, id: string): Promise<RunWriter> {
  await ensureDir(runsDir(dataDir));
  return makeWriter(id, tempRunDir(dataDir, id), runDir(dataDir, id), true);
}

/** Opens an already-promoted run for a resume; writes land in place. */
export async function openRunWriter(dataDir: string, id: string): Promise<RunWriter> {
  const dir = runDir(dataDir, id);
  return makeWriter(id, dir, dir, false);
}

/** Removes every leftover `.tmp-*` run directory. Called after the lock is held. */
export async function cleanupTempRuns(dataDir: string): Promise<string[]> {
  const dir = runsDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('.tmp-')) {
      continue;
    }
    await rm(path.join(dir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
