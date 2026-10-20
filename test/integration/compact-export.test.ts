import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { GITHUB_API_BASE, type FetchLike } from '../../src/github/client.js';
import { followersUrl } from '../../src/github/resources/followers.js';
import { reposUrl } from '../../src/github/resources/repos.js';
import { formatRunId } from '../../src/store/paths.js';
import type { Manifest, PromptApi, Resource } from '../../src/types.js';

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

interface Workspace {
  configPath: string;
  dataDir: string;
}

const inertPrompts: PromptApi = {
  watchAdd: async () => null,
  selectSubject: async () => null,
  confirmRemoval: async () => null,
  selectAddType: async () => null,
  askUserLogin: async () => null,
  askRepoInput: async () => null,
  askRepoName: async () => null,
  selectRepos: async () => null,
  selectSubjects: async () => null,
  selectMetrics: async () => null,
  selectLayout: async () => null,
  selectFrom: async () => null,
  confirmSelection: async () => null,
};

async function invoke(argv: readonly string[], overrides: Partial<CliIO> = {}): Promise<Capture> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    env: {},
    cwd: process.cwd(),
    platform: process.platform,
    home: '/home/tester',
    prompts: inertPrompts,
    ...overrides,
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

async function workspace(t: TestContext): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-compact-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { configPath: path.join(dir, 'config.toml'), dataDir: path.join(dir, 'data') };
}

function repo(fullName: string, stars: number, forks: number): Record<string, unknown> {
  return { full_name: fullName, stargazers_count: stars, forks_count: forks };
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
  status: Manifest['status'],
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

  const manifest: Manifest = {
    schemaVersion: 1,
    id,
    startedAt: `${id.slice(0, 10)}T10:00:00.000Z`,
    finishedAt: `${id.slice(0, 10)}T10:00:05.000Z`,
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

async function seedStandardRun(dataDir: string, id: string): Promise<void> {
  await seedRun(dataDir, id, 'complete', [
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
      payload: [repo('octocat/hello-world', 10, 2)],
    },
    {
      subject: 'repo:torvalds/linux',
      resource: 'repo',
      path: 'repos/torvalds__linux.json',
      payload: repo('torvalds/linux', 3, 1),
    },
  ]);
}

function daysAgo(days: number): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 10, 0, 0),
  );
  return formatRunId(date);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function router(routes: Record<string, () => Response>): FetchLike {
  return async (url) => {
    const handler = routes[url];
    if (handler === undefined) {
      throw new Error(`unexpected request: ${url}`);
    }
    return handler();
  };
}

async function addUser(configPath: string): Promise<void> {
  const result = await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);
  assert.equal(result.code, 0);
}

test('compact --dry-run reports changes and writes nothing', async (t) => {
  const { dataDir } = await workspace(t);
  const oldId = '2026-09-01T10-00-00Z';
  await seedStandardRun(dataDir, oldId);

  const result = await invoke(['compact', '--dry-run', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(result.code, 0, result.stderr);
  const doc = JSON.parse(result.stdout) as {
    dryRun: boolean;
    compacted: Array<{ date: string; repos: number; users: number }>;
    pruned: Array<{ id: string }>;
  };
  assert.equal(doc.dryRun, true);
  assert.deepEqual(doc.compacted, [{ date: '2026-09-01', repos: 2, users: 1 }]);
  assert.deepEqual(doc.pruned.map((entry) => entry.id), [oldId]);

  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), true);
  assert.equal(await exists(path.join(dataDir, 'history', 'repos')), false);
  assert.equal(await exists(path.join(dataDir, 'state', 'compacted.json')), false);

  const exported = await invoke(['export', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(exported.code, 1);
  assert.match(exported.stderr, /no_history/);
});

test('a live fetch lock blocks compact but not compact --dry-run', async (t) => {
  const { dataDir } = await workspace(t);
  await mkdir(path.join(dataDir, 'locks'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'locks', 'fetch.lock'),
    JSON.stringify({ pid: process.pid, startedAt: '2026-10-20T00:00:00.000Z' }),
    'utf8',
  );

  const blocked = await invoke(['compact', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /locked/);

  const dry = await invoke(['compact', '--dry-run', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((JSON.parse(dry.stdout) as { dryRun: boolean }).dryRun, true);
});

test('compact rejects a non-positive retention window', async (t) => {
  const { dataDir } = await workspace(t);
  const result = await invoke(['compact', '--keep-days', '0', '--data-dir', dataDir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--keep-days must be a positive integer/);
});

test('compact writes history, prunes the day, and exports every format', async (t) => {
  const { dataDir } = await workspace(t);
  const oldId = '2026-09-01T10-00-00Z';
  await seedStandardRun(dataDir, oldId);

  const result = await invoke(['compact', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(result.code, 0, result.stderr);
  const doc = JSON.parse(result.stdout) as {
    dryRun: boolean;
    compacted: Array<{ date: string; repos: number; users: number }>;
    pruned: Array<{ id: string; path: string }>;
  };
  assert.equal(doc.dryRun, false);
  assert.deepEqual(doc.compacted, [{ date: '2026-09-01', repos: 2, users: 1 }]);
  assert.deepEqual(doc.pruned.map((entry) => entry.id), [oldId]);
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), false);

  const json = await invoke(['export', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  const exported = JSON.parse(json.stdout) as {
    exportedAt: string;
    rows: Array<Record<string, unknown>>;
  };
  assert.equal(Number.isNaN(Date.parse(exported.exportedAt)), false);
  assert.deepEqual(exported.rows, [
    { date: '2026-09-01', kind: 'repo', subject: 'octocat/hello-world', stars: 10, forks: 2 },
    { date: '2026-09-01', kind: 'repo', subject: 'torvalds/linux', stars: 3, forks: 1 },
    { date: '2026-09-01', kind: 'user', subject: 'octocat', followers: 2 },
  ]);

  const jsonl = await invoke(['export', '--data-dir', dataDir]);
  assert.equal(jsonl.code, 0, jsonl.stderr);
  const lines = jsonl.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0] ?? '{}') as unknown, exported.rows[0]);

  const csv = await invoke(['export', '--format', 'csv', '--data-dir', dataDir]);
  assert.equal(csv.code, 0, csv.stderr);
  assert.deepEqual(csv.stdout.trimEnd().split('\n'), [
    'date,kind,subject,stars,forks,followers',
    '2026-09-01,repo,octocat/hello-world,10,2,',
    '2026-09-01,repo,torvalds/linux,3,1,',
    '2026-09-01,user,octocat,,,2',
  ]);
});

test('export filters by subject and date range', async (t) => {
  const { dataDir } = await workspace(t);
  await seedRun(dataDir, '2026-08-01T10-00-00Z', 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a' }],
    },
  ]);
  await seedRun(dataDir, '2026-08-02T10-00-00Z', 'complete', [
    {
      subject: 'repo:torvalds/linux',
      resource: 'repo',
      path: 'repos/torvalds__linux.json',
      payload: repo('torvalds/linux', 3, 1),
    },
  ]);
  await seedRun(dataDir, '2026-08-03T10-00-00Z', 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a' }, { login: 'b' }],
    },
  ]);

  const compact = await invoke(['compact', '--data-dir', dataDir]);
  assert.equal(compact.code, 0, compact.stderr);

  const user = await invoke([
    'export', '--format', 'json', '--subject', 'octocat', '--data-dir', dataDir,
  ]);
  assert.equal(user.code, 0, user.stderr);
  const userRows = (JSON.parse(user.stdout) as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(userRows.map((row) => [row.date, row.followers]), [
    ['2026-08-01', 1],
    ['2026-08-03', 2],
  ]);

  const repoOnly = await invoke([
    'export', '--format', 'json', '--subject', 'repo:torvalds/linux', '--data-dir', dataDir,
  ]);
  assert.equal(repoOnly.code, 0, repoOnly.stderr);
  assert.deepEqual((JSON.parse(repoOnly.stdout) as { rows: unknown[] }).rows, [
    { date: '2026-08-02', kind: 'repo', subject: 'torvalds/linux', stars: 3, forks: 1 },
  ]);

  const range = await invoke([
    'export', '--format', 'json', '--from', '2026-08-02', '--to', '2026-08-02', '--data-dir', dataDir,
  ]);
  assert.equal(range.code, 0, range.stderr);
  assert.deepEqual((JSON.parse(range.stdout) as { rows: unknown[] }).rows, [
    { date: '2026-08-02', kind: 'repo', subject: 'torvalds/linux', stars: 3, forks: 1 },
  ]);

  const none = await invoke([
    'export', '--format', 'json', '--from', '2027-01-01', '--data-dir', dataDir,
  ]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no_history/);

  const badDate = await invoke(['export', '--from', '2026-13-01', '--data-dir', dataDir]);
  assert.equal(badDate.code, 2);
  assert.match(badDate.stderr, /--from is not a valid calendar date/);
});

test('a complete fetch auto-compacts old runs unless --no-compact', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);
  const oldId = daysAgo(40);
  await seedStandardRun(dataDir, oldId);

  const fetcher = router({
    [followersUrl(GITHUB_API_BASE, 'octocat', 1)]: () =>
      jsonResponse([{ login: 'a' }], { etag: 'W/"f"' }),
    [reposUrl(GITHUB_API_BASE, 'octocat', 1)]: () =>
      jsonResponse([repo('octocat/hello-world', 11, 2)], { etag: 'W/"r"' }),
  });

  const fetched = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: fetcher },
  );
  assert.equal(fetched.code, 0, fetched.stderr);
  const doc = JSON.parse(fetched.stdout) as {
    run: { id: string; status: string };
    compaction: { compactedDays: number; prunedRuns: number };
  };
  assert.equal(doc.run.status, 'complete');
  assert.deepEqual(doc.compaction, { compactedDays: 1, prunedRuns: 1 });
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), false);
  assert.equal(await exists(path.join(dataDir, 'runs', doc.run.id)), true);

  const json = await invoke(['export', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(json.code, 0, json.stderr);
  const rows = (JSON.parse(json.stdout) as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows, [
    { date: oldId.slice(0, 10), kind: 'repo', subject: 'octocat/hello-world', stars: 10, forks: 2 },
    { date: oldId.slice(0, 10), kind: 'repo', subject: 'torvalds/linux', stars: 3, forks: 1 },
    { date: oldId.slice(0, 10), kind: 'user', subject: 'octocat', followers: 2 },
  ]);
});

test('--no-compact and --keep-raw-days skip eligible pruning', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);
  const oldId = daysAgo(40);
  await seedStandardRun(dataDir, oldId);

  const fetcher = (): FetchLike =>
    router({
      [followersUrl(GITHUB_API_BASE, 'octocat', 1)]: () =>
        jsonResponse([{ login: 'a' }], { etag: 'W/"f"' }),
      [reposUrl(GITHUB_API_BASE, 'octocat', 1)]: () =>
        jsonResponse([repo('octocat/hello-world', 11, 2)], { etag: 'W/"r"' }),
    });

  const skipped = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--no-compact', '--format', 'json'],
    { fetchImpl: fetcher() },
  );
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.deepEqual(
    (JSON.parse(skipped.stdout) as { compaction: unknown }).compaction,
    { compactedDays: 0, prunedRuns: 0 },
  );
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), true);

  // Run ids are second-precision (D002); avoid a same-second collision.
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const fetched = await invoke(
    [
      'fetch', '--config', configPath, '--data-dir', dataDir,
      '--keep-raw-days', '60', '--format', 'json',
    ],
    { fetchImpl: fetcher() },
  );
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.deepEqual(
    (JSON.parse(fetched.stdout) as { compaction: unknown }).compaction,
    { compactedDays: 0, prunedRuns: 0 },
  );
  assert.equal(await exists(path.join(dataDir, 'runs', oldId)), true);
});
