import assert from 'node:assert/strict';
import test from 'node:test';

import { filterDashboardRows } from '../../src/dashboard/filter.js';
import type { DashboardRow, SubjectType } from '../../src/types.js';

function row(kind: SubjectType, subject: string): DashboardRow {
  return {
    kind,
    subject,
    source: null,
    from: null,
    to: null,
    metrics:
      kind === 'user'
        ? { followers: { value: null, from: null, delta: null } }
        : { stars: { value: null, from: null, delta: null } },
  };
}

const ROWS = [
  row('repo', 'repo:octocat/hello-world'),
  row('repo', 'repo:octocat/spoon-knife'),
  row('repo', 'repo:other/hello-world'),
  row('user', 'user:octocat'),
  row('user', 'user:other'),
];

test('compact search keeps a tracked account header for a matching child', () => {
  assert.deepEqual(filterDashboardRows(ROWS, 'compact', 'spoon'), [ROWS[3], ROWS[1]]);
});

test('matching a compact account includes its full group', () => {
  assert.deepEqual(filterDashboardRows(ROWS, 'compact', 'OCTOCAT'), [ROWS[3], ROWS[0], ROWS[1]]);
});

test('compact search accepts a full owner/repository query', () => {
  assert.deepEqual(filterDashboardRows(ROWS, 'compact', 'octocat/hello'), [ROWS[3], ROWS[0]]);
});

test('columns search filters rows independently and case-insensitively', () => {
  assert.deepEqual(filterDashboardRows(ROWS, 'columns', 'HELLO'), [ROWS[0], ROWS[2]]);
});

test('empty query preserves compact display order', () => {
  assert.deepEqual(filterDashboardRows(ROWS, 'compact', ''), [
    ROWS[3],
    ROWS[0],
    ROWS[1],
    ROWS[4],
    ROWS[2],
  ]);
});
