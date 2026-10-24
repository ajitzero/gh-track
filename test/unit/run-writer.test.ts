import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createManifest } from '../../src/store/manifest.js';
import { runsDir } from '../../src/store/paths.js';
import {
  accountRepoPath,
  cleanupTempRuns,
  createRunWriter,
  followerPagePath,
  openRunWriter,
  repoPagePath,
  standaloneRepoPath,
} from '../../src/store/runWriter.js';

const ID = '2026-10-19T21-30-05Z';
const OTHER_ID = '2026-10-20T09-00-00Z';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-writer-'));
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

test('payload path helpers use the documented layout', () => {
  assert.equal(followerPagePath('octocat', 1), 'accounts/octocat/followers/page-0001.json');
  assert.equal(repoPagePath('octocat', 12), 'accounts/octocat/repos/page-0012.json');
  assert.equal(
    accountRepoPath('octocat', 'octocat/hello-world'),
    'accounts/octocat/repos/octocat__hello-world.json',
  );
  assert.equal(standaloneRepoPath('torvalds/linux'), 'repos/torvalds__linux.json');
});

test('a fresh writer writes into .tmp-<id> and promotes atomically', async (t) => {
  const dataDir = await tempDir(t);
  const writer = await createRunWriter(dataDir, ID);
  assert.equal(writer.fresh, true);
  assert.equal(path.basename(writer.directory), `.tmp-${ID}`);

  await writer.writePayload(followerPagePath('octocat', 1), [{ login: 'a' }]);
  assert.deepEqual(await writer.readPayload(followerPagePath('octocat', 1)), [{ login: 'a' }]);

  const manifest = createManifest(ID, '2026-10-19T21:30:05.123Z', []);
  await writer.writeManifest(manifest);
  await writer.promote();

  const final = path.join(runsDir(dataDir), ID);
  assert.equal(await exists(final), true);
  assert.equal(await exists(writer.directory), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(final, 'manifest.json'), 'utf8')), manifest);
});

test('discard removes a fresh temp directory', async (t) => {
  const dataDir = await tempDir(t);
  const writer = await createRunWriter(dataDir, ID);
  await writer.discard();
  assert.equal(await exists(writer.directory), false);
});

test('openRunWriter writes into an existing run directory', async (t) => {
  const dataDir = await tempDir(t);
  const final = path.join(runsDir(dataDir), ID);
  await mkdir(final, { recursive: true });

  const writer = await openRunWriter(dataDir, ID);
  assert.equal(writer.fresh, false);
  await writer.writePayload(repoPagePath('octocat', 1), []);
  assert.deepEqual(await writer.readPayload(repoPagePath('octocat', 1)), []);
  await writer.promote();
  assert.equal(await exists(final), true);
});

test('cleanupTempRuns removes only leftover temp directories', async (t) => {
  const dataDir = await tempDir(t);
  const runs = runsDir(dataDir);
  await mkdir(path.join(runs, `.tmp-${ID}`), { recursive: true });
  await mkdir(path.join(runs, OTHER_ID), { recursive: true });
  await writeFile(path.join(runs, 'notes.txt'), 'keep', 'utf8');

  const removed = await cleanupTempRuns(dataDir);
  assert.deepEqual(removed, [`.tmp-${ID}`]);
  assert.deepEqual((await readdir(runs)).sort(), [OTHER_ID, 'notes.txt'].sort());
});
