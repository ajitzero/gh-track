import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildObservationData } from '../../src/dashboard/observations.js';
import { readTrackedSince, recordTrackedSince } from '../../src/store/trackedSince.js';
import { repoPayload, seedRun } from '../helpers/seed.js';

const SUBJECT = 'repo:octocat/hello-world';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-tracked-since-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function seedRepo(dataDir: string, id: string, stars: number): Promise<void> {
  await seedRun(dataDir, id, 'complete', [
    {
      subject: SUBJECT,
      resource: 'repo',
      path: 'repos/octocat__hello-world.json',
      payload: repoPayload(1, 'octocat/hello-world', stars, 1),
    },
  ]);
}

test('tracked-since records are read and merged by subject key', async (t) => {
  const dataDir = await tempDir(t);
  await recordTrackedSince(
    dataDir,
    ['repo:octocat/hello-world', 'user:octocat'],
    '2026-10-03T00:00:00.000Z',
  );
  await recordTrackedSince(dataDir, ['repo:octocat/hello-world'], '2026-10-10T12:00:00.000Z');

  const trackedSince = await readTrackedSince(dataDir);
  assert.equal(trackedSince.get('repo:octocat/hello-world'), '2026-10-10T12:00:00.000Z');
  assert.equal(trackedSince.get('user:octocat'), '2026-10-03T00:00:00.000Z');
});

test('observations before the tracked-since marker are hidden', async (t) => {
  const dataDir = await tempDir(t);
  await seedRepo(dataDir, '2026-10-01T10-00-00Z', 100);
  await seedRepo(dataDir, '2026-10-05T10-00-00Z', 130);

  const subjects = [{ subject: SUBJECT, kind: 'repo' as const }];
  const before = await buildObservationData(dataDir, subjects);
  assert.deepEqual(
    before.series.get(SUBJECT)?.map((observation) => observation.id),
    ['2026-10-01T10-00-00Z', '2026-10-05T10-00-00Z'],
  );

  await recordTrackedSince(dataDir, [SUBJECT], '2026-10-03T00:00:00.000Z');
  const after = await buildObservationData(dataDir, subjects);
  assert.deepEqual(
    after.series.get(SUBJECT)?.map((observation) => observation.id),
    ['2026-10-05T10-00-00Z'],
  );
});

test('an add-day compacted baseline is kept and older history is hidden', async (t) => {
  const dataDir = await tempDir(t);
  await mkdir(path.join(dataDir, 'history/repos'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'history/repos/octocat__hello-world.ndjson'),
    [
      JSON.stringify({
        date: '2026-09-01',
        repository: 'octocat/hello-world',
        stars: 50,
        forks: 1,
      }),
      JSON.stringify({
        date: '2026-10-05',
        repository: 'octocat/hello-world',
        stars: 90,
        forks: 1,
      }),
    ].join('\n') + '\n',
  );

  await recordTrackedSince(dataDir, [SUBJECT], '2026-10-05T08:00:00.000Z');
  const data = await buildObservationData(dataDir, [{ subject: SUBJECT, kind: 'repo' }]);
  assert.deepEqual(
    data.series.get(SUBJECT)?.map((observation) => observation.id),
    ['2026-10-05'],
  );
});
