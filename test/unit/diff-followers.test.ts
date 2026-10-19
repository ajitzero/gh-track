import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffFollowerCounts,
  diffRawFollowers,
  historyFollowerCounts,
  rawFollowerCounts,
  type AccountFollowers,
  type FollowerCounts,
  type RawFollowerData,
} from '../../src/diff/followers.js';

function account(name: string, followers: readonly (readonly [string, number | null])[]): AccountFollowers {
  return {
    account: name,
    followers: new Map(
      followers.map(([login, id]) => [
        login.toLowerCase(),
        { login, id },
      ]),
    ),
  };
}

function raw(...accounts: AccountFollowers[]): RawFollowerData {
  return new Map(accounts.map((entry) => [entry.account.toLowerCase(), entry]));
}

function counts(...entries: readonly (readonly [string, number])[]): FollowerCounts {
  return new Map(
    entries.map(([name, count]) => [name.toLowerCase(), { account: name, count }]),
  );
}

test('named follower diff is case-insensitive and reports stable identities', () => {
  const entries = diffRawFollowers(
    raw(account('Octocat', [['Alice', 1], ['bob', 2], ['Carol', 3]])),
    raw(account('octocat', [['alice', 1], ['Bob', 2], ['dave', 4]])),
  );

  assert.deepEqual(entries, [
    {
      account: 'octocat',
      followers: {
        from: 3,
        to: 3,
        delta: 0,
        added: [{ login: 'dave', id: 4 }],
        removed: [{ login: 'Carol', id: 3 }],
      },
    },
  ]);
});

test('additions and removals are sorted by lowercased login', () => {
  const entries = diffRawFollowers(
    raw(account('octocat', [['b', 2]])),
    raw(account('octocat', [['Zed', 9], ['alpha', 1], ['Beta', 2]])),
  );

  assert.deepEqual(entries[0]?.followers.added?.map((entry) => entry.login), [
    'alpha',
    'Beta',
    'Zed',
  ]);
  assert.deepEqual(entries[0]?.followers.removed?.map((entry) => entry.login), ['b']);
});

test('an account with no follower change is omitted', () => {
  const entries = diffRawFollowers(
    raw(account('octocat', [['a', 1]])),
    raw(account('octocat', [['a', 1]])),
  );
  assert.deepEqual(entries, []);
});

test('count-only diffs suppress identities and flag the limit', () => {
  const entries = diffFollowerCounts(counts(['octocat', 340]), counts(['octocat', 341]));
  assert.deepEqual(entries, [
    {
      account: 'octocat',
      followers: {
        from: 340,
        to: 341,
        delta: 1,
        added: null,
        removed: null,
        identitiesAvailable: false,
      },
    },
  ]);
});

test('equal counts produce no entry when identities are unavailable', () => {
  assert.deepEqual(diffFollowerCounts(counts(['octocat', 3]), counts(['octocat', 3])), []);
});

test('an account present on one side is compared against zero', () => {
  const entries = diffFollowerCounts(new Map(), counts(['octocat', 2]));
  assert.equal(entries[0]?.followers.from, 0);
  assert.equal(entries[0]?.followers.to, 2);
  assert.equal(entries[0]?.followers.delta, 2);
});

test('history rows and raw sets collapse to the same count shape', () => {
  assert.deepEqual(
    historyFollowerCounts([
      { date: '2026-08-01', account: 'Octocat', followers: 3 },
    ]),
    counts(['Octocat', 3]),
  );
  assert.deepEqual(
    rawFollowerCounts(raw(account('Octocat', [['a', 1], ['b', 2]]))),
    counts(['Octocat', 2]),
  );
});
