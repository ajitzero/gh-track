import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { GITHUB_API_BASE, type FetchLike } from '../../src/github/client.js';
import { followersUrl } from '../../src/github/resources/followers.js';
import { reposUrl } from '../../src/github/resources/repos.js';
import { formatRunId } from '../../src/store/paths.js';
import type { PromptApi } from '../../src/types.js';
import { repoPayload, seedRun } from '../helpers/seed.js';

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

const FOLLOWERS_1 = followersUrl(GITHUB_API_BASE, 'octocat', 1);
const REPOS_1 = reposUrl(GITHUB_API_BASE, 'octocat', 1);

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function fakeGitHub(): FetchLike {
  return async (url) => {
    if (url === FOLLOWERS_1) {
      return jsonResponse([{ login: 'a', id: 1 }, { login: 'b', id: 2 }]);
    }
    if (url === REPOS_1) {
      return jsonResponse([
        repoPayload(10, 'octocat/hello-world', 120, 3, { archived: false }),
      ]);
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

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
    // JSON mode must stay non-interactive even when every stream is a TTY.
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-purity-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { configPath: path.join(dir, 'config.toml'), dataDir: path.join(dir, 'data') };
}

function daysAgo(days: number): string {
  const now = new Date();
  return formatRunId(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 10, 0, 0)),
  );
}

function assertJsonDocument(result: Capture, label: string): unknown {
  assert.equal(/\u001b\[[0-9;]*m/.test(result.stdout), false, `${label}: ANSI in stdout`);
  assert.equal(/\u001b\[[0-9;]*m/.test(result.stderr), false, `${label}: ANSI in stderr`);
  assert.equal(result.stderr, '', `${label}: unexpected stderr: ${result.stderr}`);
  assert.equal(result.stdout.endsWith('\n'), true, `${label}: missing trailing newline`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label}: stdout is not one JSON document:\n${result.stdout}`);
  }
}

function assertJsonError(result: Capture, label: string, code: string): void {
  assert.equal(result.code === 0, false, `${label}: expected a failure`);
  assert.equal(result.stdout, '', `${label}: stdout must be empty on error`);
  assert.equal(/\u001b\[[0-9;]*m/.test(result.stderr), false, `${label}: ANSI in stderr`);
  let doc: { error?: { code?: string } };
  try {
    doc = JSON.parse(result.stderr) as { error?: { code?: string } };
  } catch {
    assert.fail(`${label}: stderr is not one JSON document:\n${result.stderr}`);
  }
  assert.equal(doc.error?.code, code, `${label}: unexpected error code`);
}

test('every JSON command emits one clean document on a fake TTY', async (t) => {
  const { configPath, dataDir } = await workspace(t);

  const added = await invoke([
    'watch', 'add', 'user', 'octocat', '--config', configPath, '--format', 'json',
  ]);
  assertJsonDocument(added, 'watch add');

  const listed = await invoke([
    'watch', 'ls', '--config', configPath, '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(listed, 'watch ls');

  const dry = await invoke([
    'fetch', '--dry-run', '--config', configPath, '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(dry, 'fetch --dry-run');

  const fetched = await invoke(
    [
      'fetch', '--no-compact', '--config', configPath, '--data-dir', dataDir, '--format', 'json',
    ],
    { fetchImpl: fakeGitHub() },
  );
  const fetchedDoc = assertJsonDocument(fetched, 'fetch') as {
    run: { id: string; status: string };
  };
  assert.equal(fetchedDoc.run.status, 'complete');
  const runId = fetchedDoc.run.id;

  const runs = await invoke(['runs', 'ls', '--data-dir', dataDir, '--format', 'json']);
  assertJsonDocument(runs, 'runs ls');

  const shown = await invoke([
    'runs', 'show', runId, '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(shown, 'runs show');

  const paths = await invoke([
    'runs', 'paths', runId, '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(paths, 'runs paths');

  const older = daysAgo(2);
  const newer = daysAgo(1);
  const compactable = daysAgo(40);
  await seedRun(dataDir, older, 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a', id: 1 }],
    },
    {
      subject: 'user:octocat',
      resource: 'repos',
      path: 'accounts/octocat/repos/page-0001.json',
      payload: [repoPayload(10, 'octocat/hello-world', 100, 2)],
    },
  ]);
  await seedRun(dataDir, newer, 'complete', [
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: [{ login: 'a', id: 1 }, { login: 'c', id: 3 }],
    },
    {
      subject: 'user:octocat',
      resource: 'repos',
      path: 'accounts/octocat/repos/page-0001.json',
      payload: [repoPayload(10, 'octocat/hello-world', 110, 2)],
    },
  ]);
  await seedRun(dataDir, compactable, 'complete', [
    {
      subject: 'repo:torvalds/linux',
      resource: 'repo',
      path: 'repos/torvalds__linux.json',
      payload: repoPayload(99, 'torvalds/linux', 3, 1),
    },
  ]);

  const diff = await invoke([
    'diff', '--from', older, '--to', newer, '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(diff, 'diff');

  const compactDry = await invoke([
    'compact', '--dry-run', '--data-dir', dataDir, '--format', 'json',
  ]);
  assertJsonDocument(compactDry, 'compact --dry-run');

  const compact = await invoke(['compact', '--data-dir', dataDir, '--format', 'json']);
  const compactDoc = assertJsonDocument(compact, 'compact') as {
    compacted: Array<{ date: string }>;
  };
  assert.equal(
    compactDoc.compacted.some((entry) => entry.date === compactable.slice(0, 10)),
    true,
  );

  const exported = await invoke(['export', '--data-dir', dataDir, '--format', 'json']);
  assertJsonDocument(exported, 'export');

  const removed = await invoke([
    'watch', 'rm', 'user:octocat', '--yes', '--config', configPath, '--format', 'json',
  ]);
  assertJsonDocument(removed, 'watch rm');
});

test('JSON errors are one clean document on stderr with empty stdout', async (t) => {
  const { configPath, dataDir } = await workspace(t);

  assertJsonError(
    await invoke(['watch', 'ls', '--config', configPath, '--format', 'json']),
    'config_missing',
    'config_missing',
  );

  assertJsonError(
    await invoke(['fetch', '--dry-run', '--config', configPath, '--data-dir', dataDir, '--format', 'json']),
    'empty watchlist',
    'config_missing',
  );

  assertJsonError(
    await invoke(['diff', '--data-dir', dataDir, '--format', 'json']),
    'not enough runs',
    'not_enough_runs',
  );

  assertJsonError(
    await invoke(['runs', 'show', '2020-01-01T00-00-00Z', '--data-dir', dataDir, '--format', 'json']),
    'missing run',
    'run_not_found',
  );

  assertJsonError(
    await invoke(['export', '--data-dir', dataDir, '--format', 'json']),
    'missing history',
    'no_history',
  );

  assertJsonError(
    await invoke(['watch', 'ls', '--bogus', '--format', 'json']),
    'usage error',
    'usage',
  );
});
