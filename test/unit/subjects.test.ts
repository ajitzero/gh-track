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

test('parses GitHub profile and repository URLs', () => {
  for (const value of [
    'https://github.com/octocat',
    'https://github.com/octocat/',
    'http://www.github.com/octocat?tab=repositories',
    'github.com/octocat',
  ]) {
    assert.deepEqual(parseSubject(value), {
      type: 'user',
      account: 'octocat',
      subject: 'user:octocat',
    }, value);
  }

  for (const [value, repo] of [
    ['https://github.com/torvalds/linux', 'torvalds/linux'],
    ['https://github.com/torvalds/linux/', 'torvalds/linux'],
    ['https://github.com/torvalds/linux.git', 'torvalds/linux'],
    ['https://github.com/torvalds/linux/tree/master', 'torvalds/linux'],
    ['https://github.com/torvalds/linux?tab=readme', 'torvalds/linux'],
    ['github.com/torvalds/linux', 'torvalds/linux'],
  ] as const) {
    assert.deepEqual(parseSubject(value), {
      type: 'repo',
      repo,
      subject: `repo:${repo}`,
    }, value);
  }

  assert.deepEqual(parseExplicitSubject('user', 'https://github.com/OctoCat'), {
    type: 'user',
    account: 'OctoCat',
    subject: 'user:OctoCat',
  });
  assert.deepEqual(parseExplicitSubject('repo', 'https://github.com/a/b.git'), {
    type: 'repo',
    repo: 'a/b',
    subject: 'repo:a/b',
  });
});

test('rejects malformed and mismatched GitHub URLs', () => {
  for (const value of [
    'https://github.com',
    'https://github.com/',
    'https://github.com/-bad',
    'https://gitlab.com/a/b',
  ]) {
    assert.throws(() => parseSubject(value), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_subject');
      return true;
    }, `expected ${JSON.stringify(value)} to be invalid`);
  }

  assert.throws(() => parseExplicitSubject('user', 'https://github.com/a/b'));
  assert.throws(() => parseExplicitSubject('repo', 'https://github.com/octocat'));
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
