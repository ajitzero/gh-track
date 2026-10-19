import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { findPrunableRuns, pruneRuns, runDay } from '../../src/store/prune.js';
import { runsDir } from '../../src/store/paths.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-prune-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function makeRun(dataDir: string, name: string): Promise<void> {
  await mkdir(path.join(runsDir(dataDir), name), { recursive: true });
}

test('runDay reads the UTC date prefix of a run id', () => {
  assert.equal(runDay('2026-09-01T10-00-00Z'), '2026-09-01');
});

test('only valid run directories on compacted days are pruned', async (t) => {
  const dataDir = await tempDir(t);
  await makeRun(dataDir, '2026-09-01T10-00-00Z');
  await makeRun(dataDir, '2026-09-01T11-00-00Z');
  await makeRun(dataDir, '2026-09-02T10-00-00Z');
  await makeRun(dataDir, '2026-09-01T10-00-00Z-evil');
  await makeRun(dataDir, '.tmp-2026-09-01T12-00-00Z');

  const candidates = await findPrunableRuns(dataDir, new Set(['2026-09-01']));
  assert.deepEqual(
    candidates.map((entry) => entry.id),
    ['2026-09-01T11-00-00Z', '2026-09-01T10-00-00Z'],
  );

  const pruned = await pruneRuns(dataDir, new Set(['2026-09-01']));
  assert.deepEqual(
    pruned.map((entry) => entry.id),
    ['2026-09-01T11-00-00Z', '2026-09-01T10-00-00Z'],
  );
  assert.equal(await exists(path.join(runsDir(dataDir), '2026-09-01T10-00-00Z')), false);
  assert.equal(await exists(path.join(runsDir(dataDir), '2026-09-01T11-00-00Z')), false);
  assert.equal(await exists(path.join(runsDir(dataDir), '2026-09-02T10-00-00Z')), true);
  assert.equal(await exists(path.join(runsDir(dataDir), '2026-09-01T10-00-00Z-evil')), true);
  assert.equal(await exists(path.join(runsDir(dataDir), '.tmp-2026-09-01T12-00-00Z')), true);

  assert.deepEqual(await pruneRuns(dataDir, new Set(['2026-09-01'])), []);
});
