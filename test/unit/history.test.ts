import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  parseRepoHistoryRow,
  parseUserHistoryRow,
  readAllHistory,
  replaceHistoryDays,
  repoHistoryFile,
} from '../../src/store/history.js';

async function replaceDays(
  dataDir: string,
  date: string,
  repos: ReadonlyMap<string, { stars: number; forks: number }>,
  users: ReadonlyMap<string, number>,
): Promise<void> {
  await replaceHistoryDays(dataDir, [{ date, repos, users }]);
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-history-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('history parsers reject malformed rows', () => {
  assert.equal(parseRepoHistoryRow(null), null);
  assert.equal(parseRepoHistoryRow({ date: '2026-01-01', repository: 'a/b', stars: 1 }), null);
  assert.equal(
    parseRepoHistoryRow({ date: 'nope', repository: 'a/b', stars: 1, forks: 2 }),
    null,
  );
  assert.deepEqual(
    parseRepoHistoryRow({ date: '2026-01-01', repository: 'a/b', stars: 1, forks: 2 }),
    { date: '2026-01-01', repository: 'a/b', stars: 1, forks: 2 },
  );
  assert.equal(parseUserHistoryRow({ date: '2026-01-01', account: 'a', followers: '1' }), null);
  assert.deepEqual(
    parseUserHistoryRow({ date: '2026-01-01', account: 'a', followers: 1 }),
    { date: '2026-01-01', account: 'a', followers: 1 },
  );
});

test('replaceHistoryDays writes sorted rows and replaces one day in place', async (t) => {
  const dataDir = await tempDir(t);

  await replaceDays(
    dataDir,
    '2026-01-02',
    new Map([['octocat/a', { stars: 1, forks: 2 }]]),
    new Map([['octocat', 3]]),
  );
  await replaceDays(
    dataDir,
    '2026-01-01',
    new Map([
      ['octocat/a', { stars: 0, forks: 0 }],
      ['octocat/b', { stars: 5, forks: 1 }],
    ]),
    new Map([['octocat', 2]]),
  );

  let history = await readAllHistory(dataDir);
  assert.deepEqual(
    history.repos.map((row) => [row.date, row.repository, row.stars]),
    [
      ['2026-01-01', 'octocat/a', 0],
      ['2026-01-01', 'octocat/b', 5],
      ['2026-01-02', 'octocat/a', 1],
    ],
  );
  assert.deepEqual(
    history.users.map((row) => [row.date, row.account, row.followers]),
    [
      ['2026-01-01', 'octocat', 2],
      ['2026-01-02', 'octocat', 3],
    ],
  );

  // Replacing 2026-01-02 updates the repo row, drops the now-absent account
  // row for that date, and leaves the other day untouched.
  await replaceDays(
    dataDir,
    '2026-01-02',
    new Map([['octocat/a', { stars: 9, forks: 4 }]]),
    new Map(),
  );
  history = await readAllHistory(dataDir);
  assert.deepEqual(
    history.repos.map((row) => [row.date, row.repository, row.stars, row.forks]),
    [
      ['2026-01-01', 'octocat/a', 0, 0],
      ['2026-01-01', 'octocat/b', 5, 1],
      ['2026-01-02', 'octocat/a', 9, 4],
    ],
  );
  assert.deepEqual(
    history.users.map((row) => [row.date, row.account, row.followers]),
    [['2026-01-01', 'octocat', 2]],
  );

  // Idempotent: replacing the same day with the same metrics changes nothing.
  await replaceDays(
    dataDir,
    '2026-01-02',
    new Map([['octocat/a', { stars: 9, forks: 4 }]]),
    new Map(),
  );
  assert.deepEqual(await readAllHistory(dataDir), history);
});

test('replaceHistoryDays replaces several days in one pass', async (t) => {
  const dataDir = await tempDir(t);
  await replaceHistoryDays(dataDir, [
    {
      date: '2026-01-01',
      repos: new Map([['octocat/a', { stars: 1, forks: 2 }]]),
      users: new Map([['octocat', 3]]),
    },
    {
      date: '2026-01-02',
      repos: new Map([['octocat/b', { stars: 3, forks: 4 }]]),
      users: new Map(),
    },
  ]);

  const history = await readAllHistory(dataDir);
  assert.deepEqual(
    history.repos.map((row) => [row.date, row.repository]),
    [
      ['2026-01-01', 'octocat/a'],
      ['2026-01-02', 'octocat/b'],
    ],
  );
  assert.deepEqual(
    history.users.map((row) => [row.date, row.account]),
    [['2026-01-01', 'octocat']],
  );
});

test('readAllHistory tolerates malformed lines', async (t) => {
  const dataDir = await tempDir(t);
  await replaceDays(
    dataDir,
    '2026-01-01',
    new Map([['octocat/a', { stars: 1, forks: 2 }]]),
    new Map([['octocat', 3]]),
  );

  const file = repoHistoryFile(dataDir, 'octocat/a');
  const text = await readFile(file, 'utf8');
  await writeFile(file, `${text}not json\n{"date":"bad"}\n`, 'utf8');

  const history = await readAllHistory(dataDir);
  assert.equal(history.repos.length, 1);
  assert.equal(history.repos[0]?.repository, 'octocat/a');
});

test('history file names use the documented safe stems', async (t) => {
  const dataDir = await tempDir(t);
  assert.equal(
    path.basename(repoHistoryFile(dataDir, 'Octo Cat/repo name')),
    'Octo-Cat__repo-name.ndjson',
  );
});
