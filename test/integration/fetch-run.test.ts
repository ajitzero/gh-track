import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO, type RunOptions } from '../../src/cli.js';
import { GITHUB_API_BASE, type FetchLike } from '../../src/github/client.js';
import { followersUrl } from '../../src/github/resources/followers.js';
import { repoUrl } from '../../src/github/resources/repo.js';
import { reposUrl } from '../../src/github/resources/repos.js';
import { parseManifest } from '../../src/store/manifest.js';
import { runsDir } from '../../src/store/paths.js';
import type { PromptApi } from '../../src/types.js';

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
};

async function invoke(
  argv: readonly string[],
  overrides: Partial<CliIO> = {},
  runOptions: RunOptions = {},
): Promise<Capture> {
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
  const code = await run(argv, io, runOptions);
  return { code, stdout, stderr };
}

async function workspace(t: TestContext): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-run-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { configPath: path.join(dir, 'config.toml'), dataDir: path.join(dir, 'data') };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function notModified(): Response {
  return new Response(null, { status: 304 });
}

function notFound(): Response {
  return new Response('{"message":"Not Found"}', { status: 404 });
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

async function addUser(configPath: string, login = 'octocat'): Promise<void> {
  const result = await invoke(['watch', 'add', 'user', login, '--config', configPath]);
  assert.equal(result.code, 0);
}

async function readManifestFile(dataDir: string, id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(runsDir(dataDir), id, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function listRunsDir(dataDir: string): Promise<string[]> {
  return readdir(runsDir(dataDir)).catch(() => []);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

const FOLLOWERS_1 = followersUrl(GITHUB_API_BASE, 'octocat', 1);
const REPOS_1 = reposUrl(GITHUB_API_BASE, 'octocat', 1);

function happyRoutes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    [FOLLOWERS_1]: () =>
      jsonResponse([{ login: 'a' }, { login: 'b' }], { etag: 'W/"f1"' }),
    [REPOS_1]: () =>
      jsonResponse([{ id: 1, full_name: 'octocat/hello-world' }], { etag: 'W/"r1"' }),
    ...overrides,
  };
}

test('a fresh fetch writes a complete run atomically', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const result = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const doc = JSON.parse(result.stdout) as {
    run: { id: string; status: string; stats: Record<string, number> };
    compaction: unknown;
    pending: unknown[];
    resumeAfter: unknown;
  };
  assert.equal(doc.run.status, 'complete');
  assert.deepEqual(doc.run.stats, { repos: 1, followers: 2, requests: 2, notModified: 0 });
  assert.deepEqual(doc.compaction, { compactedDays: 0, prunedRuns: 0 });
  assert.deepEqual(doc.pending, []);
  assert.equal(doc.resumeAfter, null);

  const manifest = await readManifestFile(dataDir, doc.run.id);
  assert.equal(manifest.status, 'complete');
  assert.equal((manifest.subjects as unknown[]).length, 1);

  const runPath = path.join(runsDir(dataDir), doc.run.id);
  assert.equal(
    await exists(path.join(runPath, 'accounts/octocat/followers/page-0001.json')),
    true,
  );
  assert.equal(
    await exists(path.join(runPath, 'accounts/octocat/repos/page-0001.json')),
    true,
  );
  assert.equal(
    await exists(path.join(runPath, 'accounts/octocat/repos/octocat__hello-world.json')),
    true,
  );
  assert.equal((await listRunsDir(dataDir)).some((entry) => entry.startsWith('.tmp-')), false);
});

test('pagination follows Link and extends the plan dynamically', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const page2 = followersUrl(GITHUB_API_BASE, 'octocat', 2);
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ login: `u${index}` }));
  const secondPage = Array.from({ length: 5 }, (_, index) => ({ login: `v${index}` }));

  const routes = happyRoutes({
    [FOLLOWERS_1]: () =>
      jsonResponse(firstPage, {
        etag: 'W/"f1"',
        link: `<${page2}>; rel="next"`,
      }),
    [page2]: () => jsonResponse(secondPage, { etag: 'W/"f2"' }),
  });

  const result = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(routes) },
  );

  assert.equal(result.code, 0);
  const doc = JSON.parse(result.stdout) as { run: { id: string; stats: Record<string, number> } };
  assert.equal(doc.run.stats.requests, 3);
  assert.equal(doc.run.stats.followers, 105);
  assert.equal(await exists(path.join(runsDir(dataDir), doc.run.id, 'accounts/octocat/followers/page-0002.json')), true);
});

test('a 304 resolves to the previous run payload and copies it forward', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const first = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );
  assert.equal(first.code, 0, first.stderr);
  const firstId = (JSON.parse(first.stdout) as { run: { id: string } }).run.id;

  // Run ids are second-precision (D002); a same-second run is refused by design.
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const second = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router({ [FOLLOWERS_1]: notModified, [REPOS_1]: notModified }) },
  );

  assert.equal(second.code, 0);
  const doc = JSON.parse(second.stdout) as {
    run: { id: string; status: string; stats: Record<string, number> };
  };
  assert.notEqual(doc.run.id, firstId);
  assert.equal(doc.run.status, 'complete');
  assert.equal(doc.run.stats.notModified, 2);
  assert.equal(doc.run.stats.followers, 2);
  assert.equal(doc.run.stats.repos, 1);

  const manifest = await readManifestFile(dataDir, doc.run.id);
  const requests = manifest.requests as Array<{ status: number; sourceRun: string }>;
  assert.deepEqual(requests.map((entry) => entry.status), [304, 304]);
  assert.deepEqual(requests.map((entry) => entry.sourceRun), [firstId, firstId]);

  assert.equal(
    await exists(path.join(runsDir(dataDir), doc.run.id, 'accounts/octocat/followers/page-0001.json')),
    true,
  );
});

test('the request cap promotes a partial run and --resume completes it', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const capped = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--max-requests', '1', '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );

  assert.equal(capped.code, 3);
  const partial = JSON.parse(capped.stdout) as {
    run: { id: string; status: string };
    pending: Array<{ resource: string; subject: string }>;
  };
  assert.equal(partial.run.status, 'partial');
  assert.deepEqual(partial.pending.map((request) => request.resource), ['repos']);

  const resumed = await invoke(
    ['fetch', '--resume', partial.run.id, '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );

  assert.equal(resumed.code, 0);
  const complete = JSON.parse(resumed.stdout) as {
    run: { id: string; status: string; stats: Record<string, number> };
    pending: unknown[];
  };
  assert.equal(complete.run.id, partial.run.id);
  assert.equal(complete.run.status, 'complete');
  assert.equal(complete.run.stats.requests, 2);
  assert.equal(complete.run.stats.repos, 1);
  assert.equal(complete.run.stats.followers, 2);
  assert.deepEqual(complete.pending, []);
  assert.equal((await listRunsDir(dataDir)).some((entry) => entry.startsWith('.tmp-')), false);
});

test('a live lock refuses a second fetch', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);
  await mkdir(path.join(dataDir, 'locks'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'locks', 'fetch.lock'),
    JSON.stringify({ pid: process.pid, startedAt: '2026-10-20T00:00:00.000Z' }),
    'utf8',
  );

  const result = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir],
    { fetchImpl: router(happyRoutes()) },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /locked/);
  assert.deepEqual(await listRunsDir(dataDir), []);
});

test('an interrupt promotes a partial run and exits 130', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);
  const controller = new AbortController();

  const fetchImpl: FetchLike = async (url) => {
    if (url === FOLLOWERS_1) {
      controller.abort();
      return jsonResponse([{ login: 'a' }], { etag: 'W/"f1"' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl },
    { signal: controller.signal },
  );

  assert.equal(result.code, 130);
  const doc = JSON.parse(result.stdout) as {
    run: { id: string; status: string };
    pending: Array<{ resource: string }>;
  };
  assert.equal(doc.run.status, 'partial');
  assert.deepEqual(doc.pending.map((request) => request.resource), ['repos']);
  assert.equal(await exists(path.join(runsDir(dataDir), doc.run.id, 'manifest.json')), true);
  assert.equal((await listRunsDir(dataDir)).some((entry) => entry.startsWith('.tmp-')), false);
});

test('runs ls|show|paths read stored manifests', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const fetched = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );
  const id = (JSON.parse(fetched.stdout) as { run: { id: string } }).run.id;

  const listed = await invoke(['runs', 'ls', '--format', 'json', '--data-dir', dataDir]);
  assert.equal(listed.code, 0);
  const listedDoc = JSON.parse(listed.stdout) as {
    runs: Array<Record<string, unknown>>;
  };
  assert.equal(listedDoc.runs.length, 1);
  assert.equal(listedDoc.runs[0]?.id, id);
  assert.equal(listedDoc.runs[0]?.status, 'complete');
  assert.equal(listedDoc.runs[0]?.subjects, 1);
  assert.equal(listedDoc.runs[0]?.repos, 1);
  assert.equal(listedDoc.runs[0]?.followers, 2);

  const shown = await invoke(['runs', 'show', id, '--format', 'json', '--data-dir', dataDir]);
  assert.equal(shown.code, 0);
  assert.equal((JSON.parse(shown.stdout) as { id: string }).id, id);

  const paths = await invoke(['runs', 'paths', id, '--data-dir', dataDir]);
  assert.equal(paths.code, 0);
  assert.equal(paths.stdout.trim(), path.join(dataDir, 'runs', id));

  const missing = await invoke(['runs', 'show', '2020-01-01T00-00-00Z', '--data-dir', dataDir]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /run_not_found/);
});

test('watch ls reports the last run for each subject', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const fetched = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );
  const id = (JSON.parse(fetched.stdout) as { run: { id: string } }).run.id;

  const listed = await invoke(['watch', 'ls', '--format', 'json', '--config', configPath, '--data-dir', dataDir]);
  assert.equal(listed.code, 0);
  const doc = JSON.parse(listed.stdout) as {
    subjects: Array<{ lastRun: { id: string; status: string; repos: number; followers: number } | null }>;
  };
  assert.deepEqual(doc.subjects[0]?.lastRun, {
    id,
    status: 'complete',
    finishedAt: (JSON.parse(fetched.stdout) as { run: { finishedAt: string } }).run.finishedAt,
    repos: 1,
    followers: 2,
  });
});

test('a 404 is recorded while the run stays complete', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  const added = await invoke([
    'watch', 'add', 'repo', 'torvalds/linux', '--config', configPath,
  ]);
  assert.equal(added.code, 0);

  const result = await invoke(
    ['fetch', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router({ [repoUrl(GITHUB_API_BASE, 'torvalds/linux')]: notFound }) },
  );

  assert.equal(result.code, 0);
  const doc = JSON.parse(result.stdout) as {
    run: { id: string; status: string; stats: Record<string, number> };
  };
  assert.equal(doc.run.status, 'complete');
  assert.equal(doc.run.stats.repos, 0);

  const manifest = parseManifest(await readManifestFile(dataDir, doc.run.id));
  assert.equal(manifest?.errors.length, 1);
  assert.equal(manifest?.errors[0]?.status, 404);
});

test('watch ls matches a manifest subject case-insensitively', async (t) => {
  const { configPath, dataDir } = await workspace(t);

  // Fetch explicitly first so the manifest stores `user:octocat`; the config is
  // added afterwards with different casing.
  const fetched = await invoke(
    ['fetch', 'octocat', '--config', configPath, '--data-dir', dataDir, '--format', 'json'],
    { fetchImpl: router(happyRoutes()) },
  );
  assert.equal(fetched.code, 0, fetched.stderr);
  const id = (JSON.parse(fetched.stdout) as { run: { id: string } }).run.id;

  const added = await invoke(['watch', 'add', 'user', 'OctoCat', '--config', configPath]);
  assert.equal(added.code, 0);

  const listed = await invoke([
    'watch', 'ls', '--config', configPath, '--data-dir', dataDir, '--format', 'json',
  ]);
  const doc = JSON.parse(listed.stdout) as {
    subjects: Array<{ lastRun: { id: string; repos: number; followers: number } | null }>;
  };
  assert.equal(doc.subjects[0]?.lastRun?.id, id);
  assert.equal(doc.subjects[0]?.lastRun?.followers, 2);
  assert.equal(doc.subjects[0]?.lastRun?.repos, 1);
});

test('watch ls ignores failed runs when reporting lastRun', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await addUser(configPath);

  const failedId = '2026-01-01T00-00-00Z';
  const failedDir = path.join(runsDir(dataDir), failedId);
  await mkdir(failedDir, { recursive: true });
  await writeFile(
    path.join(failedDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: failedId,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      status: 'failed',
      subjects: [{ subject: 'user:octocat', resources: ['followers', 'repos'] }],
      stats: { repos: 0, followers: 0, requests: 0, notModified: 0 },
      requests: [],
      pending: [],
      errors: [],
    }),
    'utf8',
  );

  const listed = await invoke([
    'watch', 'ls', '--config', configPath, '--data-dir', dataDir, '--format', 'json',
  ]);
  assert.equal(listed.code, 0);
  const doc = JSON.parse(listed.stdout) as { subjects: Array<{ lastRun: unknown }> };
  assert.equal(doc.subjects[0]?.lastRun, null);
});
