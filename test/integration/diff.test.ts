import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { formatRunId } from '../../src/store/paths.js';
import type { DiffResult } from '../../src/types.js';
import { repoPayload, seedRun, type SeedRequest } from '../helpers/seed.js';

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

interface Workspace {
  dataDir: string;
}

const A = '2026-08-01T10-00-00Z';
const B = '2026-08-02T10-00-00Z';

const inertPrompts = {
  watchAdd: async () => null,
  selectSubject: async () => null,
  confirmRemoval: async () => null,
};

async function invoke(argv: readonly string[]): Promise<Capture> {
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
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

async function workspace(t: TestContext): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-diff-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { dataDir: path.join(dir, 'data') };
}

function requests(
  followers: readonly Record<string, unknown>[],
  repos: readonly unknown[],
  linuxStars = 3,
): SeedRequest[] {
  return [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: followers,
    },
    {
      subject: 'user:octocat',
      resource: 'repos',
      path: 'accounts/octocat/repos/page-0001.json',
      payload: repos,
    },
    {
      subject: 'repo:torvalds/linux',
      resource: 'repo',
      path: 'repos/torvalds__linux.json',
      payload: repoPayload(99, 'torvalds/linux', linuxStars, 1),
    },
  ];
}

async function seedOlder(dataDir: string): Promise<void> {
  await seedRun(
    dataDir,
    A,
    'complete',
    requests(
      [
        { login: 'a', id: 1 },
        { login: 'b', id: 2 },
        { login: 'Case', id: 3 },
      ],
      [
        repoPayload(1, 'octocat/hello-world', 120, 3, {
          archived: false,
          description: 'old',
        }),
        repoPayload(2, 'octocat/old-name', 5, 1),
        repoPayload(3, 'octocat/removed', 1, 0),
      ],
    ),
  );
}

async function seedNewer(dataDir: string, id = B): Promise<void> {
  await seedRun(
    dataDir,
    id,
    'complete',
    requests(
      [
        { login: 'a', id: 1 },
        { login: 'CASE', id: 3 },
        { login: 'd', id: 4 },
        { login: 'e', id: 5 },
      ],
      [
        repoPayload(1, 'octocat/hello-world', 132, 4, {
          archived: true,
          description: 'new',
        }),
        repoPayload(2, 'octocat/new-name', 5, 1),
        repoPayload(4, 'octocat/added', 7, 2),
      ],
      4,
    ),
  );
}

function parseDiff(result: Capture): DiffResult {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as DiffResult;
}

async function tree(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(`${relative}/`);
      files.push(...(await tree(root, relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

test('diff compares raw runs, names follower churn, and detects renames', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  await seedNewer(dataDir);

  const result = parseDiff(
    await invoke(['diff', '--format', 'json', '--data-dir', dataDir]),
  );

  assert.deepEqual(result.from, { id: A, finishedAt: '2026-08-01T10:00:00.000Z' });
  assert.deepEqual(result.to, { id: B, finishedAt: '2026-08-02T10:00:00.000Z' });
  assert.equal(result.source, 'raw');

  assert.deepEqual(result.repos, [
    { id: 4, repository: 'octocat/added', change: 'added', fields: {} },
    {
      id: 1,
      repository: 'octocat/hello-world',
      change: 'changed',
      fields: {
        archived: { from: false, to: true },
        description: { from: 'old', to: 'new' },
        forks_count: { from: 3, to: 4, delta: 1 },
        stargazers_count: { from: 120, to: 132, delta: 12 },
      },
    },
    {
      id: 2,
      repository: 'octocat/new-name',
      previousRepository: 'octocat/old-name',
      change: 'renamed',
      fields: {},
    },
    { id: 3, repository: 'octocat/removed', change: 'removed', fields: {} },
    {
      id: 99,
      repository: 'torvalds/linux',
      change: 'changed',
      fields: { stargazers_count: { from: 3, to: 4, delta: 1 } },
    },
  ]);

  assert.deepEqual(result.users, [
    {
      account: 'octocat',
      followers: {
        from: 3,
        to: 4,
        delta: 1,
        added: [
          { login: 'd', id: 4 },
          { login: 'e', id: 5 },
        ],
        removed: [{ login: 'b', id: 2 }],
      },
    },
  ]);
});

test('diff accepts date references and repeatable subject filters', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  await seedNewer(dataDir);

  const byDate = parseDiff(
    await invoke(['diff', '--from', '2026-08-01', '--to', '2026-08-02', '--format', 'json', '--data-dir', dataDir]),
  );
  assert.equal(byDate.from.id, A);
  assert.equal(byDate.to.id, B);

  const userFiltered = parseDiff(
    await invoke(['diff', '--subject', 'user:octocat', '--format', 'json', '--data-dir', dataDir]),
  );
  assert.deepEqual(
    userFiltered.repos.map((entry) => entry.repository),
    ['octocat/added', 'octocat/hello-world', 'octocat/new-name', 'octocat/removed'],
  );
  assert.deepEqual(userFiltered.users.map((entry) => entry.account), ['octocat']);

  const repoFiltered = parseDiff(
    await invoke(['diff', '--subject', 'repo:octocat/new-name', '--format', 'json', '--data-dir', dataDir]),
  );
  assert.deepEqual(repoFiltered.repos, [
    {
      id: 2,
      repository: 'octocat/new-name',
      previousRepository: 'octocat/old-name',
      change: 'renamed',
      fields: {},
    },
  ]);
  assert.deepEqual(repoFiltered.users, []);
});

test('table output reports before, after, and delta values', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  await seedNewer(dataDir);

  const result = await invoke(['diff', '--data-dir', dataDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /stargazers_count 120 -> 132 \(\+12\)/);
  assert.match(result.stdout, /forks_count 3 -> 4 \(\+1\)/);
  assert.match(result.stdout, /octocat\/new-name \(was octocat\/old-name\)/);
  assert.match(result.stdout, /d, e/);
  assert.match(result.stdout, /b/);
});

test('a diff with no changes reports empty lists', async (t) => {
  const { dataDir } = await workspace(t);
  const payloads = requests(
    [
      { login: 'a', id: 1 },
      { login: 'b', id: 2 },
      { login: 'Case', id: 3 },
    ],
    [
      repoPayload(1, 'octocat/hello-world', 120, 3, {
        archived: false,
        description: 'old',
      }),
      repoPayload(2, 'octocat/old-name', 5, 1),
      repoPayload(3, 'octocat/removed', 1, 0),
    ],
  );
  await seedRun(dataDir, A, 'complete', payloads);
  await seedRun(dataDir, B, 'complete', payloads);

  const result = parseDiff(
    await invoke(['diff', '--format', 'json', '--data-dir', dataDir]),
  );
  assert.equal(result.source, 'raw');
  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.users, []);

  const table = await invoke(['diff', '--data-dir', dataDir]);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /No changes\./);
});

test('diff writes nothing', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  await seedNewer(dataDir);

  await mkdir(dataDir, { recursive: true });
  const before = await tree(dataDir);
  const result = await invoke(['diff', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await tree(dataDir), before);
});

test('mixed raw/compacted diffs use counts and suppress identities', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  const today = formatRunId(new Date());
  await seedNewer(dataDir, today);

  const compacted = await invoke(['compact', '--keep-days', '30', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(compacted.code, 0, compacted.stderr);

  const before = await tree(dataDir);
  const result = parseDiff(
    await invoke(['diff', '--from', '2026-08-01', '--to', 'latest', '--format', 'json', '--data-dir', dataDir]),
  );

  assert.equal(result.source, 'mixed');
  assert.deepEqual(result.from, { id: '2026-08-01', finishedAt: null });
  assert.equal(result.to.id, today);
  assert.deepEqual(await tree(dataDir), before);

  const hello = result.repos.find((entry) => entry.repository === 'octocat/hello-world');
  assert.deepEqual(hello?.fields, {
    forks_count: { from: 3, to: 4, delta: 1 },
    stargazers_count: { from: 120, to: 132, delta: 12 },
  });
  assert.deepEqual(result.users, [
    {
      account: 'octocat',
      followers: {
        from: 3,
        to: 4,
        delta: 1,
        added: null,
        removed: null,
        identitiesAvailable: false,
      },
    },
  ]);
});

test('fully compacted diffs report source compacted and only stars/forks', async (t) => {
  const { dataDir } = await workspace(t);
  await seedOlder(dataDir);
  await seedNewer(dataDir);

  const compacted = await invoke(['compact', '--keep-days', '1', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(compacted.code, 0, compacted.stderr);

  const result = parseDiff(
    await invoke(['diff', '--from', '2026-08-01', '--to', '2026-08-02', '--format', 'json', '--data-dir', dataDir]),
  );
  assert.equal(result.source, 'compacted');
  assert.deepEqual(result.from, { id: '2026-08-01', finishedAt: null });

  const hello = result.repos.find((entry) => entry.repository === 'octocat/hello-world');
  assert.deepEqual(hello?.fields, {
    forks_count: { from: 3, to: 4, delta: 1 },
    stargazers_count: { from: 120, to: 132, delta: 12 },
  });
  assert.equal(hello?.change, 'changed');
  assert.deepEqual(result.users[0]?.followers, {
    from: 3,
    to: 4,
    delta: 1,
    added: null,
    removed: null,
    identitiesAvailable: false,
  });
});

test('diff maps insufficient runs, invalid ranges, and bad refs to stable exits', async (t) => {
  const { dataDir } = await workspace(t);
  await seedRun(dataDir, A, 'complete', []);
  await seedRun(dataDir, B, 'complete', []);

  const invalidRange = await invoke([
    'diff',
    '--from',
    B,
    '--to',
    A,
    '--format',
    'json',
    '--data-dir',
    dataDir,
  ]);
  assert.equal(invalidRange.code, 2);
  assert.equal(invalidRange.stdout, '');
  assert.equal(
    (JSON.parse(invalidRange.stderr) as { error: { code: string } }).error.code,
    'invalid_range',
  );

  const badRef = await invoke(['diff', '--from', 'yesterday', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(badRef.code, 2);
  assert.equal(
    (JSON.parse(badRef.stderr) as { error: { code: string } }).error.code,
    'usage',
  );

  const other = await workspace(t);
  await seedRun(other.dataDir, A, 'complete', []);
  const sparse = await invoke(['diff', '--format', 'json', '--data-dir', other.dataDir]);
  assert.equal(sparse.code, 1);
  assert.equal(sparse.stdout, '');
  assert.equal(
    (JSON.parse(sparse.stderr) as { error: { code: string } }).error.code,
    'not_enough_runs',
  );
});
