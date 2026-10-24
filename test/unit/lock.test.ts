import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { CliError } from '../../src/errors.js';
import { acquireLock, LOCK_FILE } from '../../src/store/lock.js';
import { locksDir } from '../../src/store/paths.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-lock-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('acquire writes a pid lock and release removes it', async (t) => {
  const dir = await tempDir(t);
  const lock = await acquireLock(dir);
  assert.equal(lock.info.pid, process.pid);

  const raw = await readFile(path.join(locksDir(dir), LOCK_FILE), 'utf8');
  assert.equal((JSON.parse(raw) as { pid: number }).pid, process.pid);

  await lock.release();
  assert.equal(await readFile(path.join(locksDir(dir), LOCK_FILE), 'utf8').catch(() => null), null);
});

test('a live lock refuses a second fetch with locked', async (t) => {
  const dir = await tempDir(t);
  const first = await acquireLock(dir);
  t.after(async () => {
    await first.release();
  });

  await assert.rejects(
    acquireLock(dir),
    (error) => (error as CliError).code === 'locked' && (error as CliError).exitCode === 1,
  );
});

test('a stale lock is reclaimed', async (t) => {
  const dir = await tempDir(t);
  await mkdir(locksDir(dir), { recursive: true });
  await writeFile(
    path.join(locksDir(dir), LOCK_FILE),
    JSON.stringify({ pid: 999_999, startedAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  );

  const lock = await acquireLock(dir, { isAlive: () => false });
  assert.equal(lock.info.pid, process.pid);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(locksDir(dir), LOCK_FILE), 'utf8')),
    lock.info,
  );
  await lock.release();
});

test('release is idempotent', async (t) => {
  const dir = await tempDir(t);
  const lock = await acquireLock(dir);
  await lock.release();
  await lock.release();
});
