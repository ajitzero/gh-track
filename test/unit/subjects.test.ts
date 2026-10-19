import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalRepoSubject,
  canonicalUserSubject,
  isValidLogin,
  isValidRepoFullName,
  parseExplicitSubject,
  parseSubject,
  subjectKey,
} from '../../src/subjects.js';

test('parses canonical and bare subjects', () => {
  assert.deepEqual(parseSubject('user:octocat'), {
    type: 'user',
    account: 'octocat',
    subject: 'user:octocat',
  });
  assert.deepEqual(parseSubject('octocat'), {
    type: 'user',
    account: 'octocat',
    subject: 'user:octocat',
  });
  assert.deepEqual(parseSubject('repo:torvalds/linux'), {
    type: 'repo',
    repo: 'torvalds/linux',
    subject: 'repo:torvalds/linux',
  });
  assert.deepEqual(parseSubject('torvalds/linux'), {
    type: 'repo',
    repo: 'torvalds/linux',
    subject: 'repo:torvalds/linux',
  });
});

test('preserves casing in canonical subjects', () => {
  assert.deepEqual(parseSubject('user:OctoCat'), {
    type: 'user',
    account: 'OctoCat',
    subject: 'user:OctoCat',
  });
  assert.equal(canonicalUserSubject('OctoCat'), 'user:OctoCat');
  assert.equal(canonicalRepoSubject('OctoCat/Hello-World'), 'repo:OctoCat/Hello-World');
});

test('rejects invalid subject values', () => {
  for (const value of ['', ' ', ' a', 'a ', 'a b', 'user:', 'repo:', 'a/b/c', 'user:a/b', 'repo:a', 'repo:/b', 'repo:a/', ':x']) {
    assert.throws(() => parseSubject(value), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_subject');
      return true;
    }, `expected ${JSON.stringify(value)} to be invalid`);
  }
});

test('parseExplicitSubject enforces the requested subtype', () => {
  assert.deepEqual(parseExplicitSubject('user', 'octocat'), {
    type: 'user',
    account: 'octocat',
    subject: 'user:octocat',
  });
  assert.deepEqual(parseExplicitSubject('repo', 'torvalds/linux'), {
    type: 'repo',
    repo: 'torvalds/linux',
    subject: 'repo:torvalds/linux',
  });
  assert.throws(() => parseExplicitSubject('user', 'user:octocat'));
  assert.throws(() => parseExplicitSubject('user', 'a/b'));
  assert.throws(() => parseExplicitSubject('repo', 'octocat'));
});

test('subjectKey is case-insensitive', () => {
  assert.equal(
    subjectKey({ type: 'user', account: 'OctoCat' }),
    subjectKey({ type: 'user', account: 'octocat' }),
  );
  assert.equal(
    subjectKey({ type: 'repo', repo: 'Torvalds/Linux' }),
    subjectKey({ type: 'repo', repo: 'torvalds/linux' }),
  );
  assert.notEqual(
    subjectKey({ type: 'user', account: 'octocat' }),
    subjectKey({ type: 'repo', repo: 'torvalds/linux' }),
  );
});

test('validates logins and repo names', () => {
  assert.equal(isValidLogin('octocat'), true);
  assert.equal(isValidLogin('a'), true);
  assert.equal(isValidLogin('a-b-c'), true);
  assert.equal(isValidLogin('-a'), false);
  assert.equal(isValidLogin('a-'), false);
  assert.equal(isValidLogin(''), false);
  assert.equal(isValidLogin('a/b'), false);

  assert.equal(isValidRepoFullName('torvalds/linux'), true);
  assert.equal(isValidRepoFullName('a/b.c_d-e'), true);
  assert.equal(isValidRepoFullName('a'), false);
  assert.equal(isValidRepoFullName('a/b/c'), false);
  assert.equal(isValidRepoFullName('/b'), false);
});
