import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRepoListing } from '../../src/github/repos-list.js';

test('parses the fields the repository picker needs', () => {
  assert.deepEqual(
    parseRepoListing({
      full_name: 'octocat/hello-world',
      fork: true,
      archived: true,
      stargazers_count: 42,
    }),
    {
      fullName: 'octocat/hello-world',
      fork: true,
      archived: true,
      stars: 42,
    },
  );
});

test('defaults missing flags and counts', () => {
  assert.deepEqual(parseRepoListing({ full_name: 'octocat/spoon-knife' }), {
    fullName: 'octocat/spoon-knife',
    fork: false,
    archived: false,
    stars: 0,
  });
});

test('rejects entries without a usable full_name', () => {
  assert.equal(parseRepoListing(null), null);
  assert.equal(parseRepoListing('repo'), null);
  assert.equal(parseRepoListing([]), null);
  assert.equal(parseRepoListing({}), null);
  assert.equal(parseRepoListing({ full_name: '' }), null);
  assert.equal(parseRepoListing({ full_name: 'no-slash' }), null);
  assert.equal(parseRepoListing({ full_name: 7 }), null);
});
