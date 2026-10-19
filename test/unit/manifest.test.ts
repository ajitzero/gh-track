import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createManifest,
  parseManifest,
  readManifest,
  serializeManifest,
  writeManifest,
} from '../../src/store/manifest.js';
import { runDir } from '../../src/store/paths.js';

const ID = '2026-10-19T21-30-05Z';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-manifest-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('createManifest starts partial with empty collections', () => {
  const manifest = createManifest(ID, '2026-10-19T21:30:05.123Z', [
    { subject: 'user:octocat', resources: ['followers', 'repos'] },
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, ID);
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.finishedAt, null);
  assert.deepEqual(manifest.subjects, [
    { subject: 'user:octocat', resources: ['followers', 'repos'] },
  ]);
  assert.deepEqual(manifest.requests, []);
  assert.deepEqual(manifest.pending, []);
  assert.deepEqual(manifest.errors, []);
});

test('serialize and parse round-trip a manifest', () => {
  const manifest = createManifest(ID, '2026-10-19T21:30:05.123Z', [
    { subject: 'user:octocat', resources: ['followers'] },
  ]);
  manifest.status = 'complete';
  manifest.finishedAt = '2026-10-19T21:30:09.812Z';
  manifest.stats = { repos: 1, followers: 2, requests: 1, notModified: 0 };
  manifest.requests.push({
    subject: 'user:octocat',
    resource: 'followers',
    url: 'https://api.github.com/users/octocat/followers?per_page=100&page=1',
    page: 1,
    status: 200,
    etag: 'W/"a"',
    path: 'accounts/octocat/followers/page-0001.json',
  });

  const parsed = parseManifest(JSON.parse(serializeManifest(manifest)));
  assert.deepEqual(parsed, manifest);
});

test('parseManifest rejects anything without the required shape', () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest({}), null);
  assert.equal(parseManifest({ schemaVersion: 2, id: ID, startedAt: 'x', status: 'complete' }), null);
  assert.equal(parseManifest({ schemaVersion: 1, id: ID, startedAt: 'x', status: 'nope' }), null);
});

test('parseManifest tolerates missing arrays and drops bad entries', () => {
  const parsed = parseManifest({
    schemaVersion: 1,
    id: ID,
    startedAt: '2026-10-19T21:30:05.123Z',
    status: 'partial',
    requests: [{ subject: 'x' }, { subject: 'user:a', resource: 'repo', url: 'u', page: 1, status: 200 }],
  });
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.subjects, []);
  assert.deepEqual(parsed.pending, []);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.requests.length, 1);
});

test('writeManifest stores a manifest that readManifest can load', async (t) => {
  const dataDir = await tempDir(t);
  const directory = runDir(dataDir, ID);
  await mkdir(directory, { recursive: true });

  const manifest = createManifest(ID, '2026-10-19T21:30:05.123Z', []);
  manifest.status = 'complete';
  manifest.finishedAt = '2026-10-19T21:30:09.812Z';
  await writeManifest(directory, manifest);

  assert.deepEqual(await readManifest(dataDir, ID), manifest);
  assert.equal(await readManifest(dataDir, '2026-01-01T00-00-00Z'), null);
});
