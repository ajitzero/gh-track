import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { run, type CliIO } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
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

async function invoke(
  argv: readonly string[],
  overrides: Partial<CliIO> = {},
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

  const code = await run(argv, io);
  return { code, stdout, stderr };
}

async function tempDir(t: TestContext, prefix = 'gh-track-cli-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('root, command, and leaf help exit 0 on stdout', async () => {
  for (const argv of [
    ['--help'],
    ['fetch', '--help'],
    ['watch', '--help'],
    ['watch', 'add', '--help'],
    ['help', 'watch', 'add'],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.code, 0, `expected exit 0 for ${argv.join(' ')}`);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
});

test('--help wins over unknown options', async () => {
  const result = await invoke(['fetch', '--bogus', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /gh-track fetch/);
});

test('--version prints the version and exits 0', async () => {
  const result = await invoke(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'gh-track 0.1.0\n');
});

test('unknown command exits 2 with usage on stderr', async () => {
  const result = await invoke(['bogus']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stderr, /Usage:/);
});

test('unknown option exits 2', async () => {
  const result = await invoke(['watch', 'ls', '--bogus']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test('command-invalid option exits 2', async () => {
  const result = await invoke(['watch', 'ls', '--dry-run']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--dry-run is not valid/);
});

test('watch add writes a valid config atomically', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'nested', 'config.toml');

  const result = await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Added user:octocat/);

  const text = await readFile(configPath, 'utf8');
  const { config } = parseConfig(text);
  assert.equal(config.subjects.length, 1);
  assert.deepEqual(config.subjects[0], {
    subject: 'user:octocat',
    type: 'user',
    account: 'octocat',
    resources: ['followers', 'repos'],
  });

  const entries = await readdir(path.dirname(configPath));
  assert.deepEqual(entries, ['config.toml']);
});

test('watch add with --resources restricts and updates', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');

  const first = await invoke([
    'watch', 'add', 'user', 'octocat', '--resources', 'followers', '--config', configPath, '--format', 'json',
  ]);
  assert.equal(first.code, 0);
  const firstDoc = JSON.parse(first.stdout) as { updated: boolean; resources: string[] };
  assert.equal(firstDoc.updated, false);
  assert.deepEqual(firstDoc.resources, ['followers']);

  const second = await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath, '--format', 'json']);
  assert.equal(second.code, 0);
  const secondDoc = JSON.parse(second.stdout) as { updated: boolean; resources: string[] };
  assert.equal(secondDoc.updated, true);
  assert.deepEqual(secondDoc.resources, ['followers', 'repos']);

  const text = await readFile(configPath, 'utf8');
  assert.equal(parseConfig(text).config.subjects.length, 1);
});

test('watch add repo rejects --resources', async (t) => {
  const dir = await tempDir(t);
  const result = await invoke([
    'watch', 'add', 'repo', 'torvalds/linux', '--resources', 'followers', '--config', path.join(dir, 'config.toml'),
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--resources is only valid for user/);
});

test('watch add rejects invalid subjects', async (t) => {
  const dir = await tempDir(t);
  const result = await invoke([
    'watch', 'add', 'user', 'not a login', '--config', path.join(dir, 'config.toml'),
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid_subject/);
});

test('watch add without arguments exits 2 and shows the exact invocation', async () => {
  const result = await invoke(['watch', 'add']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /gh-track watch add user <login>/);
  assert.match(result.stderr, /gh-track watch add repo <owner\/name>/);
});

test('watch ls --format json is one clean document', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  const dataDir = path.join(dir, 'data');

  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);
  await invoke(['watch', 'add', 'repo', 'torvalds/linux', '--config', configPath]);

  const result = await invoke([
    'watch', 'ls', '--format', 'json', '--config', configPath, '--data-dir', dataDir,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');

  const doc = JSON.parse(result.stdout) as {
    configPath: string;
    dataDir: string;
    defaults: Record<string, unknown>;
    subjects: Array<Record<string, unknown>>;
  };
  assert.equal(doc.configPath, configPath);
  assert.equal(doc.dataDir, dataDir);
  assert.deepEqual(Object.keys(doc.defaults), [
    'rawRetentionDays',
    'tokenEnv',
    'requestTimeoutMs',
    'maxRetries',
  ]);
  assert.equal(doc.subjects.length, 2);
  assert.equal(doc.subjects[0]?.lastRun, null);
  assert.equal(doc.subjects[1]?.repo, 'torvalds/linux');
});

test('watch ls table shows never for last run', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const result = await invoke(['watch', 'ls', '--config', configPath]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /SUBJECT/);
  assert.match(result.stdout, /STATUS/);
  assert.match(result.stdout, /FINISHED/);
  assert.match(result.stdout, /REPOS/);
  assert.match(result.stdout, /FOLLOWERS/);
  assert.match(result.stdout, /never/);
});

test('watch ls without a config exits 2 with config_missing', async (t) => {
  const dir = await tempDir(t);
  const result = await invoke([
    'watch', 'ls', '--format', 'json', '--config', path.join(dir, 'missing.toml'),
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  const doc = JSON.parse(result.stderr) as { error: { code: string } };
  assert.equal(doc.error.code, 'config_missing');
});

test('invalid config exits 2 and reports config_invalid on stderr only', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await writeFile(configPath, 'schema_version = 2\n', 'utf8');

  const result = await invoke(['watch', 'ls', '--format', 'json', '--config', configPath]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  const doc = JSON.parse(result.stderr) as { error: { code: string } };
  assert.equal(doc.error.code, 'config_invalid');
});

test('duplicate subjects warn on stderr but keep stdout pure JSON', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await writeFile(
    configPath,
    'schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "octocat"\n[[subjects]]\ntype = "user"\naccount = "Octocat"\n',
    'utf8',
  );

  const result = await invoke(['watch', 'ls', '--format', 'json', '--config', configPath]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Duplicate subject/);
  const doc = JSON.parse(result.stdout) as { subjects: unknown[] };
  assert.equal(doc.subjects.length, 1);
});

test('watch rm requires --yes when non-interactive', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const refused = await invoke(['watch', 'rm', 'user:octocat', '--config', configPath]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--yes/);

  const removed = await invoke(['watch', 'rm', 'user:octocat', '--config', configPath, '--yes']);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /Removed user:octocat/);

  const text = await readFile(configPath, 'utf8');
  assert.equal(parseConfig(text).config.subjects.length, 0);
});

test('watch rm of an unknown subject exits 2', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const result = await invoke(['watch', 'rm', 'hubot', '--config', configPath, '--yes']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown_subject/);
});

test('interactive watch add uses the injected prompt', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  const prompts: PromptApi = {
    ...inertPrompts,
    watchAdd: async () => ({ type: 'user', value: 'hubot' }),
  };

  const result = await invoke(['watch', 'add', '--config', configPath], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    prompts,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Added user:hubot/);
  assert.equal(parseConfig(await readFile(configPath, 'utf8')).config.subjects[0]?.subject, 'user:hubot');
});

test('interactive watch rm can be declined without changing the config', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  await invoke(['watch', 'add', 'user', 'octocat', '--config', configPath]);

  const prompts: PromptApi = { ...inertPrompts, confirmRemoval: async () => false };
  const result = await invoke(['watch', 'rm', 'user:octocat', '--config', configPath], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    prompts,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Cancelled/);
  assert.equal(parseConfig(await readFile(configPath, 'utf8')).config.subjects.length, 1);
});

test('diff requires stored runs', async (t) => {
  const dir = await tempDir(t);
  const result = await invoke(['diff', '--data-dir', path.join(dir, 'data')]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not_enough_runs/);
});
