import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  extractDayMetrics,
  isEligibleDay,
  retentionCutoff,
  runCompaction,
  selectCompactCandidates,
} from '../../src/store/compact.js';
import { readAllHistory } from '../../src/store/history.js';
import { readManifest } from '../../src/store/manifest.js';
import { readStateJson, STATE_COMPACTED_FILE, STATE_ETAGS_FILE, writeStateJson } from '../../src/store/state.js';
import type { Manifest, Resource, RunStatus } from '../../src/types.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-compact-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

interface SeedRequest {
  subject: string;
  resource: Resource;
  path: string;
  payload: unknown;
}

async function seedRun(
  dataDir: string,
  id: string,
  status: RunStatus,
  requests: readonly SeedRequest[],
): Promise<void> {
  const directory = path.join(dataDir, 'runs', id);
  await mkdir(directory, { recursive: true });

  const subjects = new Map<string, Set<Resource>>();
  for (const request of requests) {
    const resources = subjects.get(request.subject) ?? new Set<Resource>();
    resources.add(request.resource);
    subjects.set(request.subject, resources);

    const target = path.join(directory, request.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(request.payload, null, 2)}\n`, 'utf8');
  }

  const timestamp = `${id.slice(0, 10)}T${id.slice(11, 19).replaceAll('-', ':')}.000Z`;
  const manifest: Manifest = {
    schemaVersion: 1,
    id,
    startedAt: timestamp,
    finishedAt: timestamp,
    status,
    subjects: [...subjects].map(([subject, resources]) => ({
      subject,
      resources: [...resources],
    })),
    stats: { repos: 0, followers: 0, requests: requests.length, notModified: 0 },
    requests: requests.map((request, index) => ({
      ...request,
      url: `https://example.test/${id}/${index}`,
      page: 1,
      status: 200,
    })),
    pending: [],
    errors: [],
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

function repo(fullName: string, stars: number, forks: number): Record<string, unknown> {
  return { full_name: fullName, stargazers_count: stars, forks_count: forks };
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

test('retention cutoff is midnight UTC minus the retention window', () => {
  const now = new Date('2026-10-20T12:34:56.000Z');
  assert.equal(retentionCutoff(now, 30), '2026-09-20');
  assert.equal(retentionCutoff(now, 1), '2026-10-19');
  assert.equal(isEligibleDay('2026-09-19', '2026-09-20'), true);
  assert.equal(isEligibleDay('2026-09-20', '2026-09-20'), false);
  assert.equal(isEligibleDay('nope', '2026-09-20'), false);
});

test('the last complete run of an eligible day wins', async (t) => {
  const dataDir = await tempDir(t);
  const requests: SeedRequest[] = [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [],
    },
  ];

  await seedRun(dataDir, '2026-09-01T01-00-00Z', 'complete', requests);
  await seedRun(dataDir, '2026-09-01T10-00-00Z', 'complete', requests);
  await seedRun(dataDir, '2026-09-01T11-00-00Z', 'partial', requests);
  await seedRun(dataDir, '2026-09-02T10-00-00Z', 'complete', requests);

  const candidates = await selectCompactCandidates(dataDir, '2026-09-02');
  assert.deepEqual(
    candidates.map((candidate) => [candidate.date, candidate.manifest.id]),
    [['2026-09-01', '2026-09-01T10-00-00Z']],
  );
});

test('metrics extract followers and both repository shapes', async (t) => {
  const dataDir = await tempDir(t);
  const id = '2026-09-01T10-00-00Z';
  await seedRun(dataDir, id, 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a' }, { login: 'b' }],
    },
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0002.json',
      payload: [{ login: 'c' }, { login: 'd' }, { login: 'e' }],
    },
    {
      subject: 'user:octocat',
      resource: 'repos',
      path: 'accounts/octocat/repos/page-0001.json',
      payload: [repo('octocat/hello-world', 5, 1)],
    },
    {
      subject: 'repo:torvalds/linux',
      resource: 'repo',
      path: 'repos/torvalds__linux.json',
      payload: repo('torvalds/linux', 7, 2),
    },
  ]);

  const manifest = await readManifest(dataDir, id);
  assert.ok(manifest !== null);
  const metrics = await extractDayMetrics(dataDir, manifest);
  assert.deepEqual([...metrics.users], [['octocat', 5]]);
  assert.deepEqual(
    [...metrics.repos].sort(([left], [right]) => left.localeCompare(right)),
    [
      ['octocat/hello-world', { stars: 5, forks: 1 }],
      ['torvalds/linux', { stars: 7, forks: 2 }],
    ],
  );
});

test('compaction writes history, prunes compacted days, and is idempotent', async (t) => {
  const dataDir = await tempDir(t);
  const oldId = '2026-09-01T10-00-00Z';
  const partialId = '2026-09-02T10-00-00Z';

  await seedRun(dataDir, oldId, 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a' }, { login: 'b' }],
    },
    {
      subject: 'user:octocat',
      resource: 'repos',
      path: 'accounts/octocat/repos/page-0001.json',
      payload: [repo('octocat/hello-world', 5, 1)],
    },
  ]);
  await seedRun(dataDir, partialId, 'partial', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a' }],
    },
  ]);
  await writeStateJson(dataDir, STATE_ETAGS_FILE, {
    'https://example.test/followers': {
      etag: 'W/"x"',
      checkedAt: '2026-09-01T10:00:00.000Z',
      lastStatus: 200,
      sourceRun: oldId,
      sourcePath: 'accounts/octocat/followers/page-0001.json',
    },
    'https://example.test/other': {
      etag: 'W/"y"',
      checkedAt: '2026-09-01T10:00:00.000Z',
      lastStatus: 200,
      sourceRun: partialId,
      sourcePath: 'accounts/octocat/followers/page-0001.json',
    },
  });

  const now = new Date('2026-10-20T00:00:00.000Z');
  const dry = await runCompaction(dataDir, { keepDays: 30, now, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.compacted, [{ date: '2026-09-01', repos: 1, users: 1 }]);
  assert.equal(dry.pruned.length, 1);
  assert.equal(dry.pruned[0]?.id, oldId);
  assert.deepEqual(await readAllHistory(dataDir), { repos: [], users: [] });
  assert.equal(await readStateJson(dataDir, STATE_COMPACTED_FILE), null);
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), true);

  const result = await runCompaction(dataDir, { keepDays: 30, now });
  assert.deepEqual(result.compacted, [{ date: '2026-09-01', repos: 1, users: 1 }]);
  assert.equal(result.pruned.length, 1);
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), false);
  assert.equal(await exists(path.join(dataDir, 'runs', partialId)), true);

  assert.deepEqual(await readAllHistory(dataDir), {
    repos: [{ date: '2026-09-01', repository: 'octocat/hello-world', stars: 5, forks: 1 }],
    users: [{ date: '2026-09-01', account: 'octocat', followers: 2 }],
  });
  assert.deepEqual(await readStateJson(dataDir, STATE_COMPACTED_FILE), {
    days: ['2026-09-01'],
  });

  // The pruned run's validator can no longer resolve a 304.
  assert.deepEqual(Object.keys((await readStateJson(dataDir, STATE_ETAGS_FILE)) as object), [
    'https://example.test/other',
  ]);

  const again = await runCompaction(dataDir, { keepDays: 30, now });
  assert.deepEqual(again.compacted, []);
  assert.deepEqual(again.pruned, []);
  assert.deepEqual(await readAllHistory(dataDir), {
    repos: [{ date: '2026-09-01', repository: 'octocat/hello-world', stars: 5, forks: 1 }],
    users: [{ date: '2026-09-01', account: 'octocat', followers: 2 }],
  });
});

test('days inside the retention window are not compacted', async (t) => {
  const dataDir = await tempDir(t);
  await seedRun(dataDir, '2026-09-20T10-00-00Z', 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [],
    },
  ]);

  const result = await runCompaction(dataDir, {
    keepDays: 30,
    now: new Date('2026-10-20T00:00:00.000Z'),
  });
  assert.deepEqual(result.compacted, []);
  assert.deepEqual(result.pruned, []);
  assert.equal(await exists(path.join(dataDir, 'runs', '2026-09-20T10-00-00Z')), true);
});
