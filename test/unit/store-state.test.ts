import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { CliError } from '../../src/errors.js';
import { readRunPayload } from '../../src/store/runs.js';
import { readStateJson, writeStateJson } from '../../src/store/state.js';

const RUN_ID = '2026-10-19T21-30-05Z';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-store-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('readStateJson tolerates missing and corrupt files', async (t) => {
  const dir = await tempDir(t);
  assert.equal(await readStateJson(dir, 'etags.json'), null);

  await mkdir(path.join(dir, 'state'), { recursive: true });
  await writeFile(path.join(dir, 'state', 'etags.json'), 'not json', 'utf8');
  assert.equal(await readStateJson(dir, 'etags.json'), null);
});

test('writeStateJson round-trips atomically', async (t) => {
  const dir = await tempDir(t);
  await writeStateJson(dir, 'limits.json', { limit: 60, remaining: 10 });
  assert.deepEqual(await readStateJson(dir, 'limits.json'), { limit: 60, remaining: 10 });
});

test('readRunPayload reads a stored payload from a run directory', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(
    dir,
    'runs',
    RUN_ID,
    'accounts',
    'octocat',
    'followers',
    'page-0001.json',
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify([{ login: 'a' }]), 'utf8');

  assert.deepEqual(await readRunPayload(dir, RUN_ID, 'accounts/octocat/followers/page-0001.json'), [
    { login: 'a' },
  ]);
});

test('readRunPayload refuses to escape the run directory', async (t) => {
  const dir = await tempDir(t);
  for (const relativePath of ['../secrets.json', '/etc/passwd', '']) {
    await assert.rejects(
      readRunPayload(dir, RUN_ID, relativePath),
      (error) => (error as CliError).code === 'io_error',
    );
  }
});
