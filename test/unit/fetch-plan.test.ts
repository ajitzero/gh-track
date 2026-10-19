import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFetchPlan, type PlanSubject } from '../../src/commands/fetch.js';
import { parseEtagCache } from '../../src/github/etag.js';

const USER: PlanSubject = {
  subject: 'user:octocat',
  type: 'user',
  account: 'octocat',
  resources: ['followers', 'repos'],
};

const REPO: PlanSubject = {
  subject: 'repo:torvalds/linux',
  type: 'repo',
  repo: 'torvalds/linux',
  resources: ['repo'],
};

test('plans one page per resource when nothing is cached', () => {
  const plan = buildFetchPlan([USER, REPO], parseEtagCache(null));
  assert.equal(plan.estimatedRequests, 3);
  assert.deepEqual(
    plan.requests.map((request) => [request.subject, request.resource, request.page, request.conditional]),
    [
      ['user:octocat', 'followers', 1, false],
      ['user:octocat', 'repos', 1, false],
      ['repo:torvalds/linux', 'repo', 1, false],
    ],
  );
  assert.equal(plan.requests[0]?.url, 'https://api.github.com/users/octocat/followers?per_page=100&page=1');
  assert.equal(
    plan.requests[1]?.url,
    'https://api.github.com/users/octocat/repos?per_page=100&page=1&sort=updated',
  );
  assert.equal(plan.requests[2]?.url, 'https://api.github.com/repos/torvalds/linux');
});

test('estimates pagination from the ETag cache and marks conditional pages', () => {
  const cache = parseEtagCache({
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
  });

  const plan = buildFetchPlan([USER], cache);
  assert.equal(plan.estimatedRequests, 3);
  assert.deepEqual(
    plan.requests.map((request) => [request.resource, request.page, request.conditional]),
    [
      ['followers', 1, true],
      ['followers', 2, true],
      ['repos', 1, false],
    ],
  );
});

test('honors a custom API base', () => {
  const plan = buildFetchPlan([REPO], parseEtagCache(null), 'https://github.example');
  assert.equal(plan.requests[0]?.url, 'https://github.example/repos/torvalds/linux');
});
