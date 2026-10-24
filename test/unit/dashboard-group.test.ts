import assert from 'node:assert/strict';
import test from 'node:test';

import { groupDashboardRows } from '../../src/dashboard/group.js';
import type { DashboardMetricValue, DashboardRow, SubjectType } from '../../src/types.js';

const VALUE: DashboardMetricValue = { value: 1, from: null, delta: null };

function row(kind: SubjectType, subject: string): DashboardRow {
  return {
    kind,
    subject,
    source: null,
    from: null,
    to: null,
    metrics: kind === 'user' ? { followers: VALUE } : { stars: VALUE, forks: VALUE },
  };
}

function labels(rows: readonly DashboardRow[]): string[] {
  return groupDashboardRows(rows).map((display) => display.label);
}

function nested(rows: readonly DashboardRow[]): boolean[] {
  return groupDashboardRows(rows).map((display) => display.nested);
}

test('moves a repository under its tracked account even when the account is selected later', () => {
  const rows = [
    row('repo', 'repo:octocat/hello-world'),
    row('repo', 'repo:never/fetched'),
    row('user', 'user:octocat'),
  ];
  assert.deepEqual(labels(rows), ['octocat', 'hello-world', 'never/fetched']);
  assert.deepEqual(nested(rows), [false, true, false]);
});

test('keeps unrelated repositories in their selection position', () => {
  const rows = [
    row('repo', 'repo:never/one'),
    row('repo', 'repo:octocat/hello-world'),
    row('user', 'user:octocat'),
    row('repo', 'repo:other/two'),
  ];
  assert.deepEqual(labels(rows), ['never/one', 'octocat', 'hello-world', 'other/two']);
  assert.deepEqual(nested(rows), [false, false, true, false]);
});

test('preserves repository order inside a group', () => {
  const rows = [
    row('user', 'user:octocat'),
    row('repo', 'repo:octocat/zeta'),
    row('repo', 'repo:octocat/alpha'),
  ];
  assert.deepEqual(labels(rows), ['octocat', 'zeta', 'alpha']);
  assert.deepEqual(nested(rows), [false, true, true]);
});

test('matches repository owners case-insensitively', () => {
  const rows = [row('repo', 'repo:OctoCat/Hello-World'), row('user', 'user:octocat')];
  assert.deepEqual(labels(rows), ['octocat', 'Hello-World']);
  assert.deepEqual(nested(rows), [false, true]);
});

test('leaves repositories untouched when their owner is not selected', () => {
  const rows = [row('repo', 'repo:octocat/hello-world'), row('user', 'user:someone-else')];
  assert.deepEqual(labels(rows), ['octocat/hello-world', 'someone-else']);
  assert.deepEqual(nested(rows), [false, false]);
});

test('renders an account without repositories on its own', () => {
  const rows = [row('user', 'user:octocat'), row('repo', 'repo:other/two')];
  assert.deepEqual(labels(rows), ['octocat', 'other/two']);
  assert.deepEqual(nested(rows), [false, false]);
});
