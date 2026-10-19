import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import type { PromptApi } from '../../src/types.js';

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

const inertPrompts: PromptApi = {
  watchAdd: async () => null,
  selectSubject: async () => null,
  confirmRemoval: async () => null,
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

async function workspace(t: TestContext): Promise<{ configPath: string; dataDir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-fetch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { configPath: path.join(dir, 'config.toml'), dataDir: path.join(dir, 'data') };
}

async function seedState(
  dataDir: string,
  files: { etags?: unknown; limits?: unknown },
): Promise<void> {
  await mkdir(path.join(dataDir, 'state'), { recursive: true });
  if (files.etags !== undefined) {
    await writeFile(path.join(dataDir, 'state', 'etags.json'), JSON.stringify(files.etags), 'utf8');
  }
  if (files.limits !== undefined) {
    await writeFile(path.join(dataDir, 'state', 'limits.json'), JSON.stringify(files.limits), 'utf8');
  }
}

test('fetch --dry-run emits one JSON document and writes nothing', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);
  await invoke(['watch', 'add', 'repo', 'torvalds/linux', '--config', configPath]);

  const result = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--config', configPath, '--data-dir', dataDir,
  ]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');

  const doc = JSON.parse(result.stdout) as {
    dryRun: boolean;
    effectiveMaxRequests: number;
    estimatedRequests: number;
    plan: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(doc), [
    'dryRun',
    'effectiveMaxRequests',
    'estimatedRequests',
    'plan',
  ]);
  assert.equal(doc.dryRun, true);
  assert.equal(doc.effectiveMaxRequests, 58);
  assert.equal(doc.estimatedRequests, 3);
  assert.deepEqual(Object.keys(doc.plan[0] ?? {}), [
    'subject',
    'resource',
    'url',
    'page',
    'conditional',
  ]);
  assert.equal(doc.plan[0]?.conditional, false);

  await assert.rejects(readdir(dataDir), 'dry run must not create the data directory');
});

test('fetch --dry-run reads cached state for conditional flags and the quota cap', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  await seedState(dataDir, {
    limits: {
      limit: 60,
      remaining: 10,
      resetAt: '2999-01-01T00:00:00.000Z',
      observedAt: '2026-10-20T00:00:00.000Z',
    },
    etags: {
      'https://api.github.com/users/octocat/followers?per_page=100&page=1': {
        etag: 'W/"1"',
        checkedAt: '2026-10-20T00:00:00.000Z',
        lastStatus: 200,
      },
      'https://api.github.com/users/octocat/followers?per_page=100&page=2': {
        etag: 'W/"2"',
        checkedAt: '2026-10-20T00:00:00.000Z',
        lastStatus: 200,
      },
    },
  });

  const result = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(result.code, 0);

  const doc = JSON.parse(result.stdout) as {
    effectiveMaxRequests: number;
    estimatedRequests: number;
    plan: Array<{ resource: string; page: number; conditional: boolean }>;
  };
  assert.equal(doc.effectiveMaxRequests, 8);
  assert.equal(doc.estimatedRequests, 3);
  assert.deepEqual(
    doc.plan.map((request) => [request.resource, request.page, request.conditional]),
    [
      ['followers', 1, true],
      ['followers', 2, true],
      ['repos', 1, false],
    ],
  );
});

test('--max-requests lowers the cap and warns when it exceeds the quota cap', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const lowered = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--max-requests', '1',
    '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(lowered.code, 0);
  assert.equal((JSON.parse(lowered.stdout) as { effectiveMaxRequests: number }).effectiveMaxRequests, 1);

  const clamped = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--max-requests', '100',
    '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(clamped.code, 0);
  assert.equal((JSON.parse(clamped.stdout) as { effectiveMaxRequests: number }).effectiveMaxRequests, 58);
  assert.match(clamped.stderr, /exceeds the quota-derived cap 58/);
});

test('fetch --dry-run requires a non-empty watchlist when no subjects are given', async (t) => {
  const { configPath, dataDir } = await workspace(t);

  const missing = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.equal((JSON.parse(missing.stderr) as { error: { code: string } }).error.code, 'config_missing');

  await writeFile(configPath, 'schema_version = 1\n', 'utf8');
  const empty = await invoke([
    'fetch', '--dry-run', '--format', 'json', '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(empty.code, 2);
  assert.equal((JSON.parse(empty.stderr) as { error: { code: string } }).error.code, 'empty_watchlist');
});

test('fetch --dry-run rejects --resume', async (t) => {
  const { configPath, dataDir } = await workspace(t);
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const result = await invoke([
    'fetch', '--dry-run', '--resume', '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--dry-run cannot be combined with --resume/);
});

test('explicit subjects need no config and deduplicate with a warning', async (t) => {
  const { configPath, dataDir } = await workspace(t);

  const result = await invoke([
    'fetch', 'user:octocat', 'octocat', '--dry-run', '--format', 'json',
    '--config', configPath, '--data-dir', dataDir,
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stderr, /Duplicate subject user:octocat/);
  const doc = JSON.parse(result.stdout) as { estimatedRequests: number };
  assert.equal(doc.estimatedRequests, 2);
});
