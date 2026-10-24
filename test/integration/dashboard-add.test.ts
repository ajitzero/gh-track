import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
import type { DashboardAddResult, PromptApi } from '../../src/types.js';

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

async function workspace(t: TestContext, config?: string): Promise<Workspace> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-dashboard-add-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = path.join(dir, 'config.toml');
  const dataDir = path.join(dir, 'data');
  if (config !== undefined) {
    await writeFile(configPath, config, 'utf8');
  }
  return { configPath, dataDir };
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

function tty(): Partial<CliIO> {
  return { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, env: { NO_COLOR: '1' } };
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const CONFIG_WITH_SELECTION = `schema_version = 1

[[subjects]]
type = "repo"
repo = "octocat/hello-world"

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers"]

[tracking."repo:octocat/hello-world"]
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
`;

test('explicit user add creates a default config', async (t) => {
  const w = await workspace(t);

  const result = await invoke(args(w, 'dashboard', 'add', 'user', 'octocat', '--format', 'json'));
  assert.equal(result.code, 0, result.stderr);
  const body = parseJson<DashboardAddResult>(result);
  assert.deepEqual(body.added, [
    { subject: 'user:octocat', metrics: ['followers'], watched: true },
  ]);
  assert.deepEqual(body.updated, []);

  const config = await configOf(w);
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.subjects, [
    {
      subject: 'user:octocat',
      type: 'user',
      account: 'octocat',
      resources: ['followers', 'repos'],
    },
  ]);
  assert.deepEqual(config.tracking, [{ subject: 'user:octocat', metrics: ['followers'] }]);
});

test('explicit repo add honors --metrics and --resources', async (t) => {
  const w = await workspace(t);

  const user = await invoke(
    args(w, 'dashboard', 'add', 'user', 'octocat', '--resources', 'followers'),
  );
  assert.equal(user.code, 0, user.stderr);

  const repo = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'torvalds/linux', '--metrics', 'stars'),
  );
  assert.equal(repo.code, 0, repo.stderr);
  assert.match(repo.stdout, /Added repo:torvalds\/linux \(stars\); now watching\./);

  const config = await configOf(w);
  const userEntry = config.subjects.find((subject) => subject.type === 'user');
  assert.deepEqual(userEntry?.resources, ['followers']);
  const repoEntry = config.subjects.find((subject) => subject.type === 'repo');
  assert.equal(repoEntry?.subject, 'repo:torvalds/linux');
  assert.deepEqual(config.tracking, [
    { subject: 'user:octocat', metrics: ['followers'] },
    { subject: 'repo:torvalds/linux', metrics: ['stars'] },
  ]);
});

test('bare subject forms add users and repositories', async (t) => {
  const w = await workspace(t);

  const user = await invoke(args(w, 'dashboard', 'add', 'octocat'));
  assert.equal(user.code, 0, user.stderr);
  const repo = await invoke(args(w, 'dashboard', 'add', 'octocat/hello-world'));
  assert.equal(repo.code, 0, repo.stderr);

  const config = await configOf(w);
  assert.deepEqual(
    config.subjects.map((subject) => subject.subject),
    ['user:octocat', 'repo:octocat/hello-world'],
  );
  assert.deepEqual(config.tracking, [
    { subject: 'user:octocat', metrics: ['followers'] },
    { subject: 'repo:octocat/hello-world', metrics: ['stars', 'forks'] },
  ]);
});

test('add accepts GitHub profile and repository URLs', async (t) => {
  const w = await workspace(t);

  const user = await invoke(args(w, 'dashboard', 'add', 'user', 'https://github.com/octocat'));
  assert.equal(user.code, 0, user.stderr);
  const repo = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'https://github.com/torvalds/linux', '--metrics', 'stars'),
  );
  assert.equal(repo.code, 0, repo.stderr);
  const bare = await invoke(
    args(w, 'dashboard', 'add', 'https://github.com/octocat/hello-world'),
  );
  assert.equal(bare.code, 0, bare.stderr);

  const config = await configOf(w);
  assert.deepEqual(config.subjects.map((subject) => subject.subject), [
    'user:octocat',
    'repo:torvalds/linux',
    'repo:octocat/hello-world',
  ]);
  assert.deepEqual(config.tracking, [
    { subject: 'user:octocat', metrics: ['followers'] },
    { subject: 'repo:torvalds/linux', metrics: ['stars'] },
    { subject: 'repo:octocat/hello-world', metrics: ['stars', 'forks'] },
  ]);
});

test('add repo accepts a profile URL and browses its repositories', async (t) => {
  const w = await workspace(t);
  const requested: string[] = [];

  const result = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'https://github.com/octocat'),
    {
      ...tty(),
      fetchImpl: async (input) => {
        requested.push(input);
        return jsonResponse([
          { full_name: 'octocat/hello-world', fork: false, archived: false, stargazers_count: 10 },
        ]);
      },
      prompts: {
        ...inertPrompts,
        selectRepos: async (login) => {
          assert.equal(login, 'octocat');
          return ['octocat/hello-world'];
        },
        selectMetrics: async (_subject, _available, initial) => [...initial],
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(requested[0] ?? '', /\/users\/octocat\/repos/);
  assert.deepEqual(
    (await configOf(w)).subjects.map((subject) => subject.subject),
    ['repo:octocat/hello-world'],
  );
});

test('re-adding a tracked subject preserves metrics unless --metrics is given', async (t) => {
  const w = await workspace(t, CONFIG_WITH_SELECTION);

  const again = await invoke(args(w, 'dashboard', 'add', 'repo', 'octocat/hello-world'));
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /Already tracked repo:octocat\/hello-world \(stars\)\./);
  let config = await configOf(w);
  assert.deepEqual(config.tracking[0], {
    subject: 'repo:octocat/hello-world',
    metrics: ['stars'],
  });

  const changed = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'octocat/hello-world', '--metrics', 'stars,forks'),
  );
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stdout, /Updated repo:octocat\/hello-world \(stars, forks\)\./);
  config = await configOf(w);
  assert.deepEqual(config.tracking[0], {
    subject: 'repo:octocat/hello-world',
    metrics: ['stars', 'forks'],
  });
});

test('add leaves saved views untouched', async (t) => {
  const w = await workspace(t, CONFIG_WITH_SELECTION);
  const before = await configOf(w);

  const result = await invoke(args(w, 'dashboard', 'add', 'repo', 'torvalds/linux'));
  assert.equal(result.code, 0, result.stderr);

  const after = await configOf(w);
  assert.deepEqual(after.views, before.views);
});

test('interactive user flow prompts for the login', async (t) => {
  const w = await workspace(t);

  const result = await invoke(args(w, 'dashboard', 'add'), {
    ...tty(),
    prompts: {
      ...inertPrompts,
      selectAddType: async () => 'user',
      askUserLogin: async () => 'octocat',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Added user:octocat \(followers\); now watching\./);
  const config = await configOf(w);
  assert.deepEqual(config.tracking, [{ subject: 'user:octocat', metrics: ['followers'] }]);
});

test('interactive repo flow lists pages, multi-selects, and prompts per repo', async (t) => {
  const w = await workspace(t, CONFIG_WITH_SELECTION);
  const requested: string[] = [];
  const metricPrompts: { subject: string; initial: string[] }[] = [];

  const pageTwo = 'https://api.github.com/users/octocat/repos?per_page=100&page=2&sort=updated';
  const fetchImpl = async (input: string): Promise<Response> => {
    requested.push(input);
    if (input.includes('page=2')) {
      return jsonResponse([
        {
          full_name: 'octocat/spoon-knife',
          fork: false,
          archived: false,
          stargazers_count: 2,
        },
      ]);
    }
    return jsonResponse(
      [
        {
          full_name: 'octocat/hello-world',
          fork: false,
          archived: false,
          stargazers_count: 10,
        },
        {
          full_name: 'octocat/forked-repo',
          fork: true,
          archived: false,
          stargazers_count: 1,
        },
      ],
      { link: `<${pageTwo}>; rel="next"` },
    );
  };

  let capturedChoices: string[] = [];
  const result = await invoke(args(w, 'dashboard', 'add'), {
    ...tty(),
    fetchImpl,
    prompts: {
      ...inertPrompts,
      selectAddType: async () => 'repo',
      askRepoInput: async () => 'octocat',
      selectRepos: async (login, choices) => {
        assert.equal(login, 'octocat');
        capturedChoices = choices.map((choice) => `${choice.label} ${choice.hint ?? ''}`.trim());
        return ['octocat/hello-world', 'octocat/forked-repo'];
      },
      selectMetrics: async (subject, _available, initial) => {
        metricPrompts.push({ subject, initial: [...initial] });
        return subject.endsWith('hello-world') ? ['stars'] : [...initial];
      },
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requested.length, 2);
  assert.match(requested[0] ?? '', /\/users\/octocat\/repos\?per_page=100&page=1/);
  assert.match(requested[1] ?? '', /page=2/);

  assert.deepEqual(capturedChoices, [
    'octocat/hello-world tracked: stars',
    'octocat/forked-repo ★ 1 · fork',
    'octocat/spoon-knife ★ 2',
  ]);
  assert.deepEqual(metricPrompts, [
    { subject: 'repo:octocat/hello-world', initial: ['stars'] },
    { subject: 'repo:octocat/forked-repo', initial: ['stars', 'forks'] },
  ]);

  const config = await configOf(w);
  assert.deepEqual(
    config.subjects.map((subject) => subject.subject),
    ['repo:octocat/hello-world', 'user:octocat', 'repo:octocat/forked-repo'],
  );
  assert.deepEqual(config.tracking, [
    { subject: 'repo:octocat/hello-world', metrics: ['stars'] },
    { subject: 'user:octocat', metrics: ['followers'] },
    { subject: 'repo:octocat/forked-repo', metrics: ['stars', 'forks'] },
  ]);
});

test('listing failure falls back to a manual repository name', async (t) => {
  const w = await workspace(t);
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ message: 'rate limited' }), {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '0',
      },
    });

  const result = await invoke(args(w, 'dashboard', 'add', 'repo', 'octocat'), {
    ...tty(),
    fetchImpl,
    prompts: {
      ...inertPrompts,
      askRepoName: async () => 'manual/repo',
      selectMetrics: async (_subject, _available, initial) => [...initial],
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Could not list repositories for octocat/);
  const config = await configOf(w);
  assert.deepEqual(config.tracking, [
    { subject: 'repo:manual/repo', metrics: ['stars', 'forks'] },
  ]);
});

test('interactive forms require a TTY and honor --yes', async (t) => {
  const w = await workspace(t);

  const noArgs = await invoke(args(w, 'dashboard', 'add'));
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stderr, /requires an interactive terminal/);

  const owner = await invoke(args(w, 'dashboard', 'add', 'repo', 'octocat'));
  assert.equal(owner.code, 2);
  assert.match(owner.stderr, /requires an interactive terminal/);

  const json = await invoke(args(w, 'dashboard', 'add', '--format', 'json'), tty());
  assert.equal(json.code, 2);
  assert.match(json.stderr, /requires an interactive terminal/);

  const yes = await invoke(args(w, 'dashboard', 'add', '--yes'), tty());
  assert.equal(yes.code, 2);
  assert.match(yes.stderr, /requires an interactive terminal/);
});

test('cancelling the picker writes nothing', async (t) => {
  const w = await workspace(t);

  const result = await invoke(args(w, 'dashboard', 'add'), {
    ...tty(),
    prompts: {
      ...inertPrompts,
      selectAddType: async () => null,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Cancelled.\n');
  await assert.rejects(readFile(w.configPath, 'utf8'));
});

test('dashboard renders the subjects added by dashboard add', async (t) => {
  const w = await workspace(t);

  assert.equal((await invoke(args(w, 'dashboard', 'add', 'user', 'octocat'))).code, 0);
  assert.equal(
    (await invoke(args(w, 'dashboard', 'add', 'repo', 'octocat/hello-world'))).code,
    0,
  );

  const result = await invoke(args(w, 'dashboard', '--format', 'json'));
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { rows: { subject: string }[] };
  assert.deepEqual(
    body.rows.map((row) => row.subject),
    ['user:octocat', 'repo:octocat/hello-world'],
  );
});

test('invalid flag combinations fail before writing', async (t) => {
  const w = await workspace(t);

  const resources = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'octocat/hello-world', '--resources', 'followers'),
  );
  assert.equal(resources.code, 2);
  assert.match(resources.stderr, /--resources is only valid for user subjects/);

  const metrics = await invoke(
    args(w, 'dashboard', 'add', 'user', 'octocat', '--metrics', 'stars'),
  );
  assert.equal(metrics.code, 2);
  assert.match(metrics.stderr, /--metrics is only valid for repositories/);

  const badMetrics = await invoke(
    args(w, 'dashboard', 'add', 'repo', 'octocat/hello-world', '--metrics', 'followers'),
  );
  assert.equal(badMetrics.code, 2);
  assert.match(badMetrics.stderr, /Expected a comma-separated subset of stars,forks/);

  const renderFlag = await invoke(
    args(w, 'dashboard', 'add', 'user', 'octocat', '--view', 'mine'),
  );
  assert.equal(renderFlag.code, 2);
  assert.match(renderFlag.stderr, /--view is only valid when rendering the dashboard/);

  const renderWithAddFlag = await invoke(
    args(w, 'dashboard', '--metrics', 'stars'),
  );
  assert.equal(renderWithAddFlag.code, 2);
  assert.match(renderWithAddFlag.stderr, /--metrics is only valid with 'gh-track dashboard add'/);

  await assert.rejects(readFile(w.configPath, 'utf8'));
});
