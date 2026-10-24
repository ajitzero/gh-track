import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTED_REPO_FIELDS,
  compareRepoFields,
  diffRepoSnapshots,
  repoRecordFromPayload,
  restrictRepoFields,
  type RepoRecord,
} from '../../src/diff/repos.js';

function record(id: number | null, fullName: string, fields: Record<string, unknown>): RepoRecord {
  return { id, fullName, fields };
}

test('changed repositories report exact before, after, and numeric deltas', () => {
  const entries = diffRepoSnapshots(
    [
      record(1, 'octocat/hello-world', {
        archived: false,
        forks_count: 3,
        stargazers_count: 120,
      }),
    ],
    [
      record(1, 'octocat/hello-world', {
        archived: true,
        forks_count: 4,
        stargazers_count: 132,
      }),
    ],
  );

  assert.deepEqual(entries, [
    {
      id: 1,
      repository: 'octocat/hello-world',
      change: 'changed',
      fields: {
        archived: { from: false, to: true },
        forks_count: { from: 3, to: 4, delta: 1 },
        stargazers_count: { from: 120, to: 132, delta: 12 },
      },
    },
  ]);
});

test('a repository with the same id and a new name is one renamed entry', () => {
  const entries = diffRepoSnapshots(
    [record(7, 'octocat/old-name', { stargazers_count: 5 })],
    [record(7, 'octocat/new-name', { stargazers_count: 5 })],
  );

  assert.deepEqual(entries, [
    {
      id: 7,
      repository: 'octocat/new-name',
      previousRepository: 'octocat/old-name',
      change: 'renamed',
      fields: {},
    },
  ]);
});

test('added and removed repositories are presence changes', () => {
  const entries = diffRepoSnapshots(
    [record(1, 'octocat/gone', {})],
    [record(2, 'octocat/new', {})],
  );

  assert.deepEqual(entries, [
    { id: 1, repository: 'octocat/gone', change: 'removed', fields: {} },
    { id: 2, repository: 'octocat/new', change: 'added', fields: {} },
  ]);
});

test('full_name fallback is case-insensitive when ids are unavailable', () => {
  const entries = diffRepoSnapshots(
    [record(null, 'Octocat/Hello-World', { stargazers_count: 1 })],
    [record(null, 'Octocat/Hello-World', { stargazers_count: 2 })],
  );

  assert.deepEqual(entries, [
    {
      id: null,
      repository: 'Octocat/Hello-World',
      change: 'changed',
      fields: { stargazers_count: { from: 1, to: 2, delta: 1 } },
    },
  ]);
});

test('a matched id wins over a name that happens to collide', () => {
  const entries = diffRepoSnapshots(
    [record(1, 'octocat/one', { stargazers_count: 1 })],
    [
      record(2, 'octocat/one', { stargazers_count: 2 }),
      record(1, 'octocat/one-moved', { stargazers_count: 1 }),
    ],
  );

  assert.deepEqual(entries, [
    { id: 2, repository: 'octocat/one', change: 'added', fields: {} },
    {
      id: 1,
      repository: 'octocat/one-moved',
      previousRepository: 'octocat/one',
      change: 'renamed',
      fields: {},
    },
  ]);
});

test('null is a value and a missing key compares as null', () => {
  const fields = compareRepoFields(
    { description: null, stars: 1 },
    { description: 'set', stars: 1, archived: true },
  );
  assert.deepEqual(fields, {
    archived: { from: null, to: true },
    description: { from: null, to: 'set' },
  });
});

test('payload extraction keeps scalars and drops identity and nested values', () => {
  const parsed = repoRecordFromPayload({
    id: 42,
    full_name: 'octocat/hello-world',
    description: null,
    archived: false,
    owner: { login: 'octocat' },
    topics: ['a'],
    stargazers_count: 2,
  });
  assert.deepEqual(parsed, {
    id: 42,
    fullName: 'octocat/hello-world',
    fields: { description: null, archived: false, stargazers_count: 2 },
  });
});

test('compacted field restriction keeps only stars and forks', () => {
  const restricted = restrictRepoFields(
    [
      record(1, 'octocat/hello-world', {
        archived: true,
        forks_count: 4,
        stargazers_count: 132,
        description: 'x',
      }),
    ],
    COMPACTED_REPO_FIELDS,
  );
  assert.deepEqual(restricted, [
    {
      id: 1,
      fullName: 'octocat/hello-world',
      fields: { forks_count: 4, stargazers_count: 132 },
    },
  ]);
});
