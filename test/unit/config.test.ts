import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  defaultConfig,
  defaultDefaults,
  loadConfig,
  parseConfig,
  saveConfig,
  serializeConfig,
} from '../../src/config.js';

const FULL_CONFIG = `schema_version = 1

[defaults]
raw_retention_days = 14
token_env = "MY_TOKEN"
request_timeout_ms = 5000
max_retries = 2

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers"]

[[subjects]]
type = "repo"
repo = "torvalds/linux"
`;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-config-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('defaultConfig has no subjects and documented defaults', () => {
  const config = defaultConfig();
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.defaults, {
    rawRetentionDays: 30,
    tokenEnv: 'GH_TOKEN',
    requestTimeoutMs: 30_000,
    maxRetries: 3,
  });
  assert.deepEqual(config.subjects, []);
  assert.deepEqual(defaultDefaults(), config.defaults);
});

test('parses a complete config', () => {
  const { config, warnings } = parseConfig(FULL_CONFIG);
  assert.deepEqual(warnings, []);
  assert.equal(config.defaults.rawRetentionDays, 14);
  assert.equal(config.defaults.tokenEnv, 'MY_TOKEN');
  assert.equal(config.defaults.requestTimeoutMs, 5000);
  assert.equal(config.defaults.maxRetries, 2);
  assert.equal(config.subjects.length, 2);

  const [user, repo] = config.subjects;
  assert.deepEqual(user, {
    subject: 'user:octocat',
    type: 'user',
    account: 'octocat',
    resources: ['followers'],
  });
  assert.deepEqual(repo, {
    subject: 'repo:torvalds/linux',
    type: 'repo',
    repo: 'torvalds/linux',
    resources: ['repo'],
  });
});

test('applies defaults when only schema_version is present', () => {
  const { config } = parseConfig('schema_version = 1\n');
  assert.deepEqual(config.defaults, defaultDefaults());
  assert.deepEqual(config.subjects, []);
});

test('user resources default to followers and repos', () => {
  const { config } = parseConfig(
    'schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "octocat"\n',
  );
  const user = config.subjects[0];
  assert.equal(user?.type, 'user');
  assert.deepEqual(user?.resources, ['followers', 'repos']);
});

test('canonicalizes resource order', () => {
  const { config } = parseConfig(
    'schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "octocat"\nresources = ["repos"]\n',
  );
  assert.deepEqual(config.subjects[0]?.resources, ['repos']);
});

test('deduplicates subjects and unions user resources with a warning', () => {
  const { config, warnings } = parseConfig(`schema_version = 1

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers"]

[[subjects]]
type = "user"
account = "Octocat"
resources = ["repos"]
`);
  assert.equal(config.subjects.length, 1);
  assert.deepEqual(config.subjects[0]?.resources, ['followers', 'repos']);
  assert.equal(warnings.length, 1);
});

test('rejects an unknown root key', () => {
  assert.throws(() => parseConfig('schema_version = 1\nfoo = "bar"\n'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'config_invalid');
    return true;
  });
});

test('rejects unknown nested keys', () => {
  assert.throws(() => parseConfig('schema_version = 1\n[defaults]\nnope = 1\n'));
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "a"\nwat = 1\n'),
  );
});

test('rejects an unsupported schema version', () => {
  assert.throws(() => parseConfig('schema_version = 2\n'));
  assert.throws(() => parseConfig(''));
});

test('rejects out-of-range defaults', () => {
  assert.throws(() => parseConfig('schema_version = 1\n[defaults]\nraw_retention_days = 0\n'));
  assert.throws(() => parseConfig('schema_version = 1\n[defaults]\nrequest_timeout_ms = 999\n'));
  assert.throws(() => parseConfig('schema_version = 1\n[defaults]\nmax_retries = 11\n'));
  assert.throws(() => parseConfig('schema_version = 1\n[defaults]\ntoken_env = 5\n'));
});

test('rejects malformed subjects', () => {
  assert.throws(() => parseConfig('schema_version = 1\n[[subjects]]\ntype = "user"\n'));
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "-bad"\n'),
  );
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "a"\nresources = []\n'),
  );
  assert.throws(() =>
    parseConfig(
      'schema_version = 1\n[[subjects]]\ntype = "user"\naccount = "a"\nresources = ["wat"]\n',
    ),
  );
  assert.throws(() => parseConfig('schema_version = 1\n[[subjects]]\ntype = "repo"\n'));
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "repo"\nrepo = "a/b/c"\n'),
  );
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "repo"\nrepo = "a/b"\nresources = ["repo"]\n'),
  );
  assert.throws(() =>
    parseConfig('schema_version = 1\n[[subjects]]\ntype = "repo"\nrepo = "a/b"\naccount = "a"\n'),
  );
  assert.throws(() => parseConfig('schema_version = 1\n[[subjects]]\ntype = "org"\n'));
});

test('serializeConfig round-trips through parseConfig', () => {
  const original = parseConfig(FULL_CONFIG).config;
  const reparsed = parseConfig(serializeConfig(original)).config;
  assert.deepEqual(reparsed, original);
});

test('serializeConfig emits canonical sections', () => {
  const text = serializeConfig(defaultConfig());
  assert.match(text, /^schema_version = 1\n/);
  assert.match(text, /\[defaults\]\nraw_retention_days = 30\n/);
  assert.match(text, /token_env = "GH_TOKEN"/);
  assert.doesNotMatch(text, /\[\[subjects\]\]/);
});

test('saveConfig writes atomically and loadConfig reads it back', async (t) => {
  const dir = await tempDir(t);
  const configPath = path.join(dir, 'nested', 'config.toml');
  const config = parseConfig(FULL_CONFIG).config;

  await saveConfig(configPath, config);
  const loaded = await loadConfig(configPath);
  assert.deepEqual(loaded?.config, config);

  const entries = await readdir(path.dirname(configPath));
  assert.deepEqual(entries, ['config.toml']);
});

test('loadConfig returns null for a missing file when optional', async (t) => {
  const dir = await tempDir(t);
  const missing = path.join(dir, 'config.toml');
  assert.equal(await loadConfig(missing, { required: false }), null);

  await assert.rejects(() => loadConfig(missing), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'config_missing');
    return true;
  });
});
