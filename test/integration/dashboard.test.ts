import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
import { interrupted } from '../../src/errors.js';
import type {
  DashboardKeypress,
  DashboardResult,
  DashboardTerminal,
  PromptApi,
  TrackListResult,
} from '../../src/types.js';
import { repoPayload, seedRun, type SeedRequest } from '../helpers/seed.js';

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

interface Workspace {
  configPath: string;
  dataDir: string;
}

const A = '2026-10-01T10-00-00Z';
const B = '2026-10-05T10-00-00Z';
const PARTIAL = '2026-10-06T10-00-00Z';

const CONFIG = `schema_version = 1

[[subjects]]
type = "repo"
repo = "octocat/hello-world"

[[subjects]]
type = "repo"
repo = "history/only"

[[subjects]]
type = "repo"
repo = "never/fetched"

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers"]

[tracking."repo:octocat/hello-world"]
metrics = ["stars", "forks"]

[tracking."repo:history/only"]
metrics = ["stars"]

[tracking."repo:never/fetched"]
metrics = ["stars"]

[tracking."user:octocat"]
metrics = ["followers"]

[views."my-repos"]
layout = "columns"
from = "2026-09-01"
to = "latest"

[[views."my-repos".items]]
subject = "repo:octocat/hello-world"
metrics = ["stars"]

[[views."my-repos".items]]
subject = "user:octocat"
metrics = ["followers"]

[views."users-only"]

[[views."users-only".items]]
subject = "user:octocat"
metrics = ["followers"]
`;

const FIRST_RUN_CONFIG = `schema_version = 1

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers"]
`;

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

async function workspace(t: TestContext, config = CONFIG): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-dashboard-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = path.join(dir, 'config.toml');
  const dataDir = path.join(dir, 'data');
  await writeFile(configPath, config, 'utf8');
  return { configPath, dataDir };
}

function requests(stars: number, forks: number, followers: number): SeedRequest[] {
  return [
    {
      subject: 'repo:octocat/hello-world',
      resource: 'repo',
      path: 'repos/octocat__hello-world.json',
      payload: repoPayload(1, 'octocat/hello-world', stars, forks),
    },
    {
      subject: 'user:octocat',
      resource: 'followers',
      path: 'accounts/octocat/followers/page-0001.json',
      payload: Array.from({ length: followers }, (_, index) => ({
        login: `follower-${index}`,
        id: index + 1,
      })),
    },
  ];
}

async function seedWorkspace(dataDir: string): Promise<void> {
  await seedRun(dataDir, A, 'complete', requests(100, 3, 2));
  await seedRun(dataDir, B, 'complete', requests(120, 4, 3));
  await seedRun(dataDir, PARTIAL, 'partial', requests(130, 5, 4));

  await mkdir(path.join(dataDir, 'history/repos'), { recursive: true });
  await mkdir(path.join(dataDir, 'history/users'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'history/repos/octocat__hello-world.ndjson'),
    [
      JSON.stringify({ date: '2026-09-01', repository: 'octocat/hello-world', stars: 80, forks: 2 }),
      JSON.stringify({ date: '2026-10-05', repository: 'octocat/hello-world', stars: 999, forks: 999 }),
    ].join('\n') + '\n',
  );
  await writeFile(
    path.join(dataDir, 'history/repos/history__only.ndjson'),
    JSON.stringify({ date: '2026-09-10', repository: 'history/only', stars: 50, forks: 5 }) + '\n',
  );
  await writeFile(
    path.join(dataDir, 'history/users/octocat.ndjson'),
    [
      JSON.stringify({ date: '2026-09-01', account: 'octocat', followers: 1 }),
      JSON.stringify({ date: '2026-10-05', account: 'octocat', followers: 999 }),
    ].join('\n') + '\n',
  );
}

function args(workspace: Workspace, ...rest: string[]): string[] {
  return [...rest, '--config', workspace.configPath, '--data-dir', workspace.dataDir];
}

async function configOf(workspace: Workspace) {
  return parseConfig(await readFile(workspace.configPath, 'utf8')).config;
}

function parseJson<T>(capture: Capture): T {
  assert.equal(capture.stderr, '');
  return JSON.parse(capture.stdout) as T;
}

test('compact dashboard resolves each subject independently', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const result = await invoke(args(w, 'dashboard'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');

  assert.match(result.stdout, /\n  hello-world\s+stars\s+120\s+\(\+20\)\s+forks\s+4\s+\(\+1\)/);
  assert.match(result.stdout, /history\/only\s+stars\s+50~/);
  assert.match(result.stdout, /never\/fetched\s+—\s+—/);
  assert.match(result.stdout, /\noctocat\s+followers\s+3\s+\(\+1\)/);
  assert.doesNotMatch(result.stdout, /octocat\/hello-world/);
  assert.doesNotMatch(result.stdout, /@octocat/);
  assert.ok(result.stdout.indexOf('\noctocat') < result.stdout.indexOf('hello-world'));
  assert.match(result.stdout, /~ compacted history/);
  assert.doesNotMatch(result.stdout, /999/);
});

test('bare invocation renders the dashboard with dashboard options', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const bare = await invoke(args(w));
  const explicit = await invoke(args(w, 'dashboard'));
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(bare.stdout, explicit.stdout);

  const withOptions = await invoke(args(w, '--view', 'my-repos'));
  assert.equal(withOptions.code, 0, withOptions.stderr);
  assert.match(withOptions.stdout, /gh-track dashboard — my-repos/);
});

test('--no-interactive keeps the static table on a TTY', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  let entered = false;
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => { entered = true; },
    leave: () => undefined,
    write: () => undefined,
    onKeypress: () => () => undefined,
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const result = await invoke(args(w, 'dashboard', '--no-interactive'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(entered, false);
  assert.match(result.stdout, /gh-track dashboard/);
});

test('--no-interactive skips first-run setup without changing tracking', async (t) => {
  const w = await workspace(t, FIRST_RUN_CONFIG);
  let promptCalled = false;
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => assert.fail('static mode must not enter the terminal'),
    leave: () => undefined,
    write: () => undefined,
    onKeypress: () => () => undefined,
    onResize: () => () => undefined,
    copy: async () => true,
  };
  const prompts: PromptApi = {
    ...inertPrompts,
    selectSubjects: async () => {
      promptCalled = true;
      return null;
    },
  };

  const result = await invoke(args(w, 'dashboard', '--no-interactive'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
    prompts,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(promptCalled, false);
  assert.match(result.stdout, /octocat/);
  assert.equal((await configOf(w)).tracking.length, 0);
});

test('interactive dashboard restores the terminal and emits no table after quit', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  let entered = 0;
  let left = 0;
  let output = '';
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => { entered += 1; },
    leave: () => { left += 1; },
    write: (text) => { output += text; },
    onKeypress: (listener: (key: DashboardKeypress) => void) => {
      listener({ name: 'q', sequence: 'q', ctrl: false });
      return () => undefined;
    },
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const result = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(entered, 1);
  assert.equal(left, 1);
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(plain, /r refresh · ↑↓\/j k move · \/ search · c copy · a add · q quit/);
  assert.match(output, /\u001b\[97mr\u001b\[0m\u001b\[2m refresh\u001b\[0m/);
  assert.match(plain, /hello-world/);
});

test('r runs a full fetch from the interactive dashboard', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  let left = 0;
  const requested: string[] = [];
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => undefined,
    leave: () => { left += 1; },
    write: () => undefined,
    onKeypress: (listener) => {
      listener({ name: 'r', sequence: 'r', ctrl: false });
      listener({ name: 'q', sequence: 'q', ctrl: false });
      return () => undefined;
    },
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const result = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
    fetchImpl: async (input) => {
      requested.push(input);
      const url = new URL(input);
      let payload: unknown = [];
      if (url.pathname.startsWith('/repos/')) {
        const fullName = url.pathname.slice('/repos/'.length);
        payload = repoPayload(1, fullName, 150, 8);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(left, 1);
  assert.ok(requested.some((url) => new URL(url).pathname === '/users/octocat/followers'));
  assert.ok(requested.some((url) => new URL(url).pathname === '/repos/octocat/hello-world'));
});

test('a adds a subject, fetches only it, and refreshes the dashboard', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  const requested: string[] = [];
  let output = '';
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => undefined,
    leave: () => undefined,
    write: (text) => { output += text; },
    onKeypress: (listener) => {
      listener({ name: 'a', sequence: 'a', ctrl: false });
      for (const character of 'testing-user') {
        listener({ name: character, sequence: character, ctrl: false });
      }
      listener({ name: 'return', sequence: '\r', ctrl: false });
      listener({ name: 'q', sequence: 'q', ctrl: false });
      return () => undefined;
    },
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const result = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
    fetchImpl: async (input) => {
      requested.push(input);
      const url = new URL(input);
      const payload = url.pathname.endsWith('/followers')
        ? [{ login: 'one', id: 1 }, { login: 'two', id: 2 }]
        : [repoPayload(9, 'testing-user/demo', 5, 1)];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(requested.length > 0);
  assert.ok(
    requested.every((url) => new URL(url).pathname.startsWith('/users/testing-user/')),
  );
  assert.ok(plain.includes('add: testing-user'));
  assert.ok(plain.includes('Added user:testing-user'));
  assert.ok(plain.includes('testing-user'));

  const saved = await configOf(w);
  assert.ok(saved.subjects.some((subject) => subject.subject === 'user:testing-user'));
  assert.ok(saved.tracking.some((entry) => entry.subject === 'user:testing-user'));
});

test('a accepts a repository URL in the interactive add prompt', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  const requested: string[] = [];
  let output = '';
  const terminal: DashboardTerminal = {
    rows: 24,
    enter: () => undefined,
    leave: () => undefined,
    write: (text) => { output += text; },
    onKeypress: (listener) => {
      listener({ name: 'a', sequence: 'a', ctrl: false });
      for (const character of 'https://github.com/testing-user/demo') {
        listener({ name: character, sequence: character, ctrl: false });
      }
      listener({ name: 'return', sequence: '\r', ctrl: false });
      listener({ name: 'q', sequence: 'q', ctrl: false });
      return () => undefined;
    },
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const result = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    dashboardTerminal: terminal,
    fetchImpl: async (input) => {
      requested.push(input);
      return new Response(
        JSON.stringify(repoPayload(9, 'testing-user/demo', 7, 2)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    requested.map((url) => new URL(url).pathname),
    ['/repos/testing-user/demo'],
  );
  assert.ok(plain.includes('Added repo:testing-user/demo'));

  const saved = await configOf(w);
  assert.ok(saved.subjects.some((subject) => subject.subject === 'repo:testing-user/demo'));
  assert.ok(saved.tracking.some((entry) => entry.subject === 'repo:testing-user/demo'));
});

test('--from and --to bound each subject and mark compacted baselines', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const fromHistory = await invoke(args(w, 'dashboard', '--from', '2026-09-01'));
  assert.equal(fromHistory.code, 0, fromHistory.stderr);
  assert.match(fromHistory.stdout, /stars\s+120\s+\(\+40\)\s+forks\s+4\s+\(\+2\)\s+2026-09-01~/);
  assert.match(fromHistory.stdout, /\noctocat\s+followers\s+3\s+\(\+2\)\s+2026-09-01~/);
  assert.match(fromHistory.stdout, /history\/only\s+stars\s+50~/);

  const early = await invoke(args(w, 'dashboard', '--to', '2026-09-15'));
  assert.equal(early.code, 0, early.stderr);
  assert.match(early.stdout, /\n  hello-world\s+stars\s+80~\s+forks\s+2~/);
  assert.match(early.stdout, /history\/only\s+stars\s+50~/);
  assert.match(early.stdout, /\noctocat\s+followers\s+1~/);

  const runBound = await invoke(args(w, 'dashboard', '--to', A));
  assert.equal(runBound.code, 0, runBound.stderr);
  assert.match(runBound.stdout, /stars\s+100\s+\(\+20\)\s+forks\s+3\s+\(\+1\)\s+2026-09-01~/);
});

test('a relative --from clamps to each subject’s oldest observation', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const result = await invoke(args(w, 'dashboard', '--from', '-100y'));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /stars\s+120\s+\(\+40\)\s+forks\s+4\s+\(\+2\)\s+2026-09-01~/);
  assert.match(result.stdout, /\noctocat\s+followers\s+3\s+\(\+2\)\s+2026-09-01~/);
  assert.match(result.stdout, /history\/only\s+stars\s+50~/);
});

test('--from latest produces zero deltas', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const result = await invoke(args(w, 'dashboard', '--from', 'latest'));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /stars\s+120\s+\(0\)\s+forks\s+4\s+\(0\)/);
  assert.match(result.stdout, /\noctocat\s+followers\s+3\s+\(0\)/);

  const bounded = await invoke(
    args(w, 'dashboard', '--from', 'latest', '--to', '2026-09-15'),
  );
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.match(bounded.stdout, /stars\s+80~\s+\(0\)\s+forks\s+2~\s+\(0\)/);
  assert.match(bounded.stdout, /\noctocat\s+followers\s+1~\s+\(0\)/);
});

test('--view renders a saved columns snapshot and overrides flags', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const result = await invoke(args(w, 'dashboard', '--view', 'my-repos'));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /gh-track dashboard — my-repos \(from 2026-09-01 to latest\)/);
  assert.match(result.stdout, /Repositories\nNAME\s+STARS\s+SINCE/);
  assert.match(result.stdout, /octocat\/hello-world\s+120 \(\+40\)\s+2026-09-01~/);
  assert.doesNotMatch(result.stdout, /FORKS/);
  assert.match(result.stdout, /Accounts\nNAME\s+FOLLOWERS\s+SINCE/);

  const overridden = await invoke(
    args(w, 'dashboard', '--view', 'my-repos', '--layout', 'compact', '--from', 'latest'),
  );
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.match(overridden.stdout, /stars\s+120\s+\(0\)/);
});

test('--subject replaces the selection and keeps configured metrics', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const onlyUser = await invoke(args(w, 'dashboard', '--subject', 'user:octocat'));
  assert.equal(onlyUser.code, 0, onlyUser.stderr);
  assert.match(onlyUser.stdout, /\noctocat\s+followers/);
  assert.doesNotMatch(onlyUser.stdout, /@octocat/);
  assert.doesNotMatch(onlyUser.stdout, /octocat\/hello-world/);

  const never = await invoke(args(w, 'dashboard', '--subject', 'repo:never/fetched'));
  assert.equal(never.code, 0, never.stderr);
  assert.match(never.stdout, /never\/fetched\s+—\s+—/);

  const unknown = await invoke(args(w, 'dashboard', '--subject', 'repo:nope/nope'));
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown_subject/);
});

test('dashboard JSON is one document with per-row sources', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const capture = await invoke(args(w, 'dashboard', '--format', 'json'));
  assert.equal(capture.code, 0, capture.stderr);
  assert.equal(/\u001b\[[0-9;]*m/.test(capture.stdout), false);
  const result = parseJson<DashboardResult>(capture);
  assert.equal(result.layout, 'compact');
  assert.equal(result.view, undefined);
  assert.deepEqual(result.range, { from: 'previous', to: 'latest' });
  assert.equal(result.rows.length, 4);
  assert.deepEqual(
    result.rows.map((row) => row.subject),
    [
      'repo:octocat/hello-world',
      'repo:history/only',
      'repo:never/fetched',
      'user:octocat',
    ],
  );

  const bySubject = new Map(result.rows.map((row) => [row.subject, row]));
  assert.equal(bySubject.get('repo:octocat/hello-world')?.source, 'raw');
  assert.deepEqual(bySubject.get('repo:octocat/hello-world')?.metrics.stars, {
    value: 120,
    from: 100,
    delta: 20,
  });
  assert.equal(bySubject.get('repo:history/only')?.source, 'compacted');
  assert.equal(bySubject.get('repo:never/fetched')?.source, null);
  assert.deepEqual(bySubject.get('repo:never/fetched')?.metrics.stars, {
    value: null,
    from: null,
    delta: null,
  });
  assert.equal(bySubject.get('repo:never/fetched')?.to, null);
  assert.equal(bySubject.get('repo:never/fetched')?.from, null);

  const viewCapture = await invoke(args(w, 'dashboard', '--view', 'my-repos', '--format', 'json'));
  const viewResult = parseJson<DashboardResult>(viewCapture);
  assert.equal(viewResult.view, 'my-repos');
  assert.equal(viewResult.layout, 'columns');
  assert.equal(viewResult.rows[0]?.source, 'mixed');
});

test('dashboard rejects invalid references and incomplete runs', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const previousTo = await invoke(args(w, 'dashboard', '--to', 'previous'));
  assert.equal(previousTo.code, 2);
  assert.match(previousTo.stderr, /--to cannot be "previous"/);

  const backwards = await invoke(args(w, 'dashboard', '--from', '2026-10-06', '--to', '2026-10-05'));
  assert.equal(backwards.code, 2);
  assert.match(backwards.stderr, /invalid_range/);

  const badRef = await invoke(args(w, 'dashboard', '--from', 'yesterday'));
  assert.equal(badRef.code, 2);
  assert.match(badRef.stderr, /Invalid --from reference/);

  const partial = await invoke(args(w, 'dashboard', '--to', PARTIAL));
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /partial/);

  const missing = await invoke(args(w, 'dashboard', '--from', '2020-01-01T00-00-00Z'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /run_not_found/);

  const unknownView = await invoke(args(w, 'dashboard', '--view', 'nope'));
  assert.equal(unknownView.code, 2);
  assert.match(unknownView.stderr, /unknown_view/);
});

test('first-run dashboard picker saves tracking', async (t) => {
  const w = await workspace(t, CONFIG.replace(/\[tracking\.[\s\S]*?\n\n/g, ''));
  await seedWorkspace(w.dataDir);

  const prompts: PromptApi = {
    ...inertPrompts,
    selectSubjects: async () => ['repo:octocat/hello-world', 'user:octocat'],
    selectMetrics: async (_subject, _available, initial) => [...initial].slice(0, 1),
    confirmSelection: async () => true,
  };
  const result = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    env: { NO_COLOR: '1' },
    prompts,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /stars\s+120\s+\(\+20\)/);
  assert.doesNotMatch(result.stdout, /forks\s+4/);

  const config = await configOf(w);
  assert.deepEqual(config.tracking, [
    { subject: 'repo:octocat/hello-world', metrics: ['stars'] },
    { subject: 'user:octocat', metrics: ['followers'] },
  ]);
});

test('invalid overrides fail before first-run setup writes', async (t) => {
  const w = await workspace(t, CONFIG.replace(/\[tracking\.[\s\S]*?\n\n/g, ''));
  const before = await readFile(w.configPath, 'utf8');

  const layout = await invoke(args(w, 'dashboard', '--layout', 'wide'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => {
        throw new Error('must not prompt');
      },
    },
  });
  assert.equal(layout.code, 2);
  assert.match(layout.stderr, /Unsupported --layout value/);
  assert.equal(await readFile(w.configPath, 'utf8'), before);

  const range = await invoke(args(w, 'dashboard', '--to', 'previous'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => {
        throw new Error('must not prompt');
      },
    },
  });
  assert.equal(range.code, 2);
  assert.match(range.stderr, /--to cannot be/);
  assert.equal(await readFile(w.configPath, 'utf8'), before);
});

test('--subject skips first-run setup and does not write config', async (t) => {
  const w = await workspace(t, CONFIG.replace(/\[tracking\.[\s\S]*?\n\n/g, ''));
  await seedWorkspace(w.dataDir);
  const before = await readFile(w.configPath, 'utf8');

  const result = await invoke(args(w, 'dashboard', '--subject', 'user:octocat'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    env: { NO_COLOR: '1' },
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => {
        throw new Error('must not prompt');
      },
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\noctocat\s+followers/);
  assert.doesNotMatch(result.stdout, /@octocat/);
  assert.equal(await readFile(w.configPath, 'utf8'), before);
});

test('track edit picker reuses existing metrics', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);
  let initialSeen: string[] = [];

  const result = await invoke(args(w, 'track', 'edit'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    env: { NO_COLOR: '1' },
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => ['repo:octocat/hello-world'],
      selectMetrics: async (_subject, _available, initial) => {
        initialSeen = [...initial];
        return ['stars'];
      },
      confirmSelection: async () => true,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(initialSeen, ['stars', 'forks']);
  const config = await configOf(w);
  assert.deepEqual(config.tracking, [
    { subject: 'repo:octocat/hello-world', metrics: ['stars'] },
  ]);
});

test('declining or cancelling the picker writes nothing', async (t) => {
  const w = await workspace(t, CONFIG.replace(/\[tracking\.[\s\S]*?\n\n/g, ''));
  await seedWorkspace(w.dataDir);
  const before = await readFile(w.configPath, 'utf8');

  const declined = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => ['repo:octocat/hello-world'],
      selectMetrics: async () => ['stars'],
      confirmSelection: async () => false,
    },
  });
  assert.equal(declined.code, 0);
  assert.equal(declined.stdout, 'Cancelled.\n');
  assert.equal(await readFile(w.configPath, 'utf8'), before);

  const cancelled = await invoke(args(w, 'dashboard'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => {
        throw interrupted();
      },
    },
  });
  assert.equal(cancelled.code, 130);
  assert.equal(await readFile(w.configPath, 'utf8'), before);
});

test('--setup is removed with a targeted message', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const setup = await invoke(args(w, 'dashboard', '--setup'));
  assert.equal(setup.code, 2);
  assert.match(setup.stderr, /--setup flag has been removed/);
  assert.match(setup.stderr, /dashboard add/);
});

test('JSON never prompts on the first run', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const json = await invoke(args(w, 'dashboard', '--format', 'json'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => {
        throw new Error('must not prompt');
      },
    },
  });
  assert.equal(json.code, 0, json.stderr);
  const result = parseJson<DashboardResult>(json);
  assert.equal(result.rows.length, 4);
});

test('track set, ls, rm, and view commands round-trip through config', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const set = await invoke(
    args(w, 'track', 'set', '--item', 'repo:octocat/hello-world=forks', '--item', 'user:octocat=followers'),
  );
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /repo:octocat\/hello-world\s+forks/);

  let config = await configOf(w);
  assert.deepEqual(config.tracking, [
    { subject: 'repo:octocat/hello-world', metrics: ['forks'] },
    { subject: 'repo:history/only', metrics: ['stars'] },
    { subject: 'repo:never/fetched', metrics: ['stars'] },
    { subject: 'user:octocat', metrics: ['followers'] },
  ]);

  const listed = await invoke(args(w, 'track', 'ls'));
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /repo:octocat\/hello-world\s+forks/);
  assert.match(listed.stdout, /my-repos/);

  const listedJson = await invoke(args(w, 'track', 'ls', '--format', 'json'));
  const list = parseJson<TrackListResult>(listedJson);
  assert.equal(list.tracking.length, 4);
  assert.equal(list.views.length, 2);

  const saved = await invoke(
    args(
      w,
      'track',
      'view',
      'save',
      'compact-repo',
      '--item',
      'repo:octocat/hello-world=stars,forks',
      '--layout',
      'compact',
      '--from',
      '2026-10-01',
    ),
  );
  assert.equal(saved.code, 0, saved.stderr);
  config = await configOf(w);
  const view = config.views.find((candidate) => candidate.name === 'compact-repo');
  assert.deepEqual(view, {
    name: 'compact-repo',
    items: [{ subject: 'repo:octocat/hello-world', metrics: ['stars', 'forks'] }],
    layout: 'compact',
    from: '2026-10-01',
    to: 'latest',
  });

  const rendered = await invoke(args(w, 'dashboard', '--view', 'compact-repo'));
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(rendered.stdout, /gh-track dashboard — compact-repo/);

  const removedView = await invoke(args(w, 'track', 'view', 'rm', 'compact-repo'));
  assert.equal(removedView.code, 0, removedView.stderr);
  config = await configOf(w);
  assert.equal(config.views.some((candidate) => candidate.name === 'compact-repo'), false);

  const removed = await invoke(args(w, 'track', 'rm', 'user:octocat'));
  assert.equal(removed.code, 0, removed.stderr);
  config = await configOf(w);
  assert.equal(config.tracking.some((entry) => entry.subject === 'user:octocat'), false);
  const stillSaved = config.views.find((view) => view.name === 'my-repos');
  assert.deepEqual(stillSaved?.items.map((item) => item.subject), [
    'repo:octocat/hello-world',
    'user:octocat',
  ]);

  const missing = await invoke(args(w, 'track', 'rm', 'user:octocat'));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /not in the dashboard selection/);
});

test('track rejects invalid items and non-interactive edit', async (t) => {
  const w = await workspace(t);

  const unknown = await invoke(args(w, 'track', 'set', '--item', 'repo:nope/nope=stars'));
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown_subject/);

  const metric = await invoke(args(w, 'track', 'set', '--item', 'repo:octocat/hello-world=followers'));
  assert.equal(metric.code, 2);
  assert.match(metric.stderr, /Invalid metric/);

  const duplicate = await invoke(
    args(
      w,
      'track',
      'set',
      '--item',
      'repo:octocat/hello-world=stars',
      '--item',
      'repo:octocat/hello-world=forks',
    ),
  );
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /Duplicate --item/);

  const edit = await invoke(args(w, 'track', 'edit'));
  assert.equal(edit.code, 2);
  assert.match(edit.stderr, /track edit requires an interactive terminal/);

  const save = await invoke(args(w, 'track', 'view', 'save', 'my-view'));
  assert.equal(save.code, 2);
  assert.match(save.stderr, /needs --item in non-interactive mode/);
});

test('track view save picker asks for layout and range', async (t) => {
  const w = await workspace(t, CONFIG.replace(/\[tracking\.[\s\S]*?\n\n/g, ''));
  await seedWorkspace(w.dataDir);

  const result = await invoke(args(w, 'track', 'view', 'save', 'picked'), {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    prompts: {
      ...inertPrompts,
      selectSubjects: async () => ['repo:octocat/hello-world'],
      selectMetrics: async () => ['stars'],
      selectLayout: async () => 'columns',
      selectFrom: async () => '2026-09-01',
      confirmSelection: async () => true,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const config = await configOf(w);
  assert.deepEqual(config.views.find((view) => view.name === 'picked'), {
    name: 'picked',
    items: [{ subject: 'repo:octocat/hello-world', metrics: ['stars'] }],
    layout: 'columns',
    from: '2026-09-01',
    to: 'latest',
  });
});

test('watch rm cleans tracking and view references', async (t) => {
  const w = await workspace(t);
  await seedWorkspace(w.dataDir);

  const removed = await invoke(args(w, 'watch', 'rm', 'user:octocat', '--yes'));
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stderr, /dashboard selection/);
  assert.match(removed.stderr, /empty dashboard view users-only/);

  const config = await configOf(w);
  assert.equal(config.tracking.some((entry) => entry.subject === 'user:octocat'), false);
  assert.equal(config.views.some((view) => view.name === 'users-only'), false);
  const myRepos = config.views.find((view) => view.name === 'my-repos');
  assert.deepEqual(myRepos?.items.map((item) => item.subject), ['repo:octocat/hello-world']);
});

test('dashboard requires a selection and a non-empty watchlist', async (t) => {
  const w = await workspace(t, 'schema_version = 1\n');
  const empty = await invoke(args(w, 'dashboard'));
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /empty_watchlist/);

  const configPath = path.join(path.dirname(w.configPath), 'missing.toml');
  const missing = await invoke(['dashboard', '--config', configPath, '--data-dir', w.dataDir]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /config_missing/);
});
