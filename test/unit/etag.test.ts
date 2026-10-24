import assert from 'node:assert/strict';
import test from 'node:test';

import {
  etagFor,
  parseEtagCache,
  recordEtag,
  resolveNotModified,
  serializeEtagCache,
} from '../../src/github/etag.js';

const URL = 'https://api.github.com/users/octocat/followers?per_page=100&page=1';

test('parses and serializes an ETag cache', () => {
  const raw = {
    [URL]: {
      etag: 'W/"abc"',
      lastModified: 'Mon, 19 Oct 2026 21:00:00 GMT',
      checkedAt: '2026-10-19T21:30:05.900Z',
      lastStatus: 200,
      sourceRun: '2026-10-18T09-00-00Z',
      sourcePath: 'accounts/octocat/followers/page-0001.json',
    },
  };
  const cache = parseEtagCache(raw);
  assert.deepEqual(cache, raw);
  assert.equal(etagFor(cache, URL)?.etag, 'W/"abc"');
  assert.deepEqual(JSON.parse(serializeEtagCache(cache)), raw);
});

test('parseEtagCache tolerates junk', () => {
  assert.deepEqual(parseEtagCache(null), {});
  assert.deepEqual(parseEtagCache([1, 2]), {});
  assert.deepEqual(parseEtagCache({ [URL]: { etag: 5 } }), {});
  assert.deepEqual(parseEtagCache({ [URL]: { etag: 'W/"a"', checkedAt: 'now' } }), {});
});

test('recordEtag writes and clears entries', () => {
  const cache = parseEtagCache({});
  const entry = recordEtag(cache, URL, {
    etag: 'W/"a"',
    status: 200,
    checkedAt: '2026-10-20T00:00:00.000Z',
    sourceRun: '2026-10-19T00-00-00Z',
    sourcePath: 'accounts/octocat/followers/page-0001.json',
  });
  assert.equal(entry?.sourceRun, '2026-10-19T00-00-00Z');
  assert.equal(etagFor(cache, URL)?.etag, 'W/"a"');

  recordEtag(cache, URL, { etag: null, status: 200, checkedAt: 'later' });
  assert.equal(etagFor(cache, URL), undefined);
});

test('resolveNotModified reads the previous stored payload', async () => {
  const calls: Array<[string, string]> = [];
  const resolved = await resolveNotModified(
    {
      etag: 'W/"a"',
      checkedAt: '2026-10-20T00:00:00.000Z',
      lastStatus: 200,
      sourceRun: '2026-10-19T00-00-00Z',
      sourcePath: 'accounts/octocat/followers/page-0001.json',
    },
    async (runId, relativePath) => {
      calls.push([runId, relativePath]);
      return [{ login: 'a' }];
    },
  );

  assert.deepEqual(calls, [['2026-10-19T00-00-00Z', 'accounts/octocat/followers/page-0001.json']]);
  assert.deepEqual(resolved.payload, [{ login: 'a' }]);
  assert.equal(resolved.sourceRun, '2026-10-19T00-00-00Z');
});

test('resolveNotModified fails without a stored source', async () => {
  await assert.rejects(
    resolveNotModified(
      { etag: 'W/"a"', checkedAt: '2026-10-20T00:00:00.000Z', lastStatus: 200 },
      async () => null,
    ),
    /Cannot resolve a 304/,
  );
});
