import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { etagBelongsToSubject, forgetSubjectEtags } from '../../src/store/etagCache.js';

const API = 'https://api.github.com';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-etags-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('repository ETags match only the exact owner/name path', () => {
  const subject = 'repo:octocat/hello-world';
  assert.equal(etagBelongsToSubject(`${API}/repos/octocat/hello-world`, subject), true);
  assert.equal(etagBelongsToSubject(`${API}/repos/octocat/hello-world/`, subject), true);
  assert.equal(etagBelongsToSubject(`${API}/repos/OctoCat/Hello-World?x=1`, subject), true);
  assert.equal(etagBelongsToSubject(`${API}/repos/octocat/hello-world-extra`, subject), false);
  assert.equal(etagBelongsToSubject(`${API}/repos/other/hello-world`, subject), false);
  assert.equal(etagBelongsToSubject(`${API}/users/octocat/followers`, subject), false);
  assert.equal(etagBelongsToSubject('not a url', subject), false);
});

test('account ETags match only its own followers and repos resources', () => {
  const subject = 'user:octocat';
  assert.equal(etagBelongsToSubject(`${API}/users/octocat/followers?per_page=100`, subject), true);
  assert.equal(etagBelongsToSubject(`${API}/users/octocat/repos?page=2`, subject), true);
  assert.equal(etagBelongsToSubject(`${API}/users/octocat-other/repos`, subject), false);
  assert.equal(etagBelongsToSubject(`${API}/repos/octocat/hello-world`, subject), false);
});

test('forgetSubjectEtags deletes only matching entries', async (t) => {
  const dataDir = await tempDir(t);
  const target = `${API}/repos/octocat/hello-world`;
  const sibling = `${API}/repos/octocat/hello-world-extra`;
  const account = `${API}/users/octocat/followers?page=1`;
  const other = `${API}/repos/other/tool`;
  const state = {
    [target]: { etag: 'a', checkedAt: '2026-10-01T00:00:00Z', lastStatus: 200 },
    [sibling]: { etag: 'b', checkedAt: '2026-10-01T00:00:00Z', lastStatus: 200 },
    [account]: { etag: 'c', checkedAt: '2026-10-01T00:00:00Z', lastStatus: 200 },
    [other]: { etag: 'd', checkedAt: '2026-10-01T00:00:00Z', lastStatus: 200 },
  };
  await mkdir(path.join(dataDir, 'state'), { recursive: true });
  await writeFile(path.join(dataDir, 'state', 'etags.json'), JSON.stringify(state));

  const removed = await forgetSubjectEtags(dataDir, 'repo:octocat/hello-world');
  assert.deepEqual(removed, [target]);
  const saved = JSON.parse(
    await readFile(path.join(dataDir, 'state', 'etags.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved).sort(), [account, other, sibling].sort());
});

test('forgetSubjectEtags tolerates a missing cache', async (t) => {
  const dataDir = await tempDir(t);
  assert.deepEqual(await forgetSubjectEtags(dataDir, 'user:octocat'), []);
});
