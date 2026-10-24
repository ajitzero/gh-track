/** Follower set extraction and the named/count follower diffs. */

import { isRecord } from '../guards.js';
import { readRunPayload } from '../store/runs.js';
import type { FollowerIdentity, Manifest, UserDiffEntry, UserHistoryRow } from '../types.js';

export interface FollowerRecord {
  login: string;
  id: number | null;
}

export interface AccountFollowers {
  account: string;
  followers: Map<string, FollowerRecord>;
}

/** Account key (lowercase) to its named follower set. */
export type RawFollowerData = Map<string, AccountFollowers>;

export interface FollowerCount {
  account: string;
  count: number;
}

/** Account key (lowercase) to an aggregate follower count. */
export type FollowerCounts = Map<string, FollowerCount>;

function accountKey(account: string): string {
  return account.toLowerCase();
}

async function readPayload(
  dataDir: string,
  manifest: Manifest,
  relativePath: string,
): Promise<unknown | null> {
  try {
    return await readRunPayload(dataDir, manifest.id, relativePath);
  } catch {
    return null;
  }
}

/** Reads every follower page a run stored, keyed by account and login. */
export async function readRawFollowers(
  dataDir: string,
  manifest: Manifest,
): Promise<RawFollowerData> {
  const accounts: RawFollowerData = new Map();

  for (const entry of manifest.requests) {
    if (entry.resource !== 'followers' || entry.path === undefined) {
      continue;
    }
    if (!entry.subject.startsWith('user:')) {
      continue;
    }
    const account = entry.subject.slice('user:'.length);
    if (account.length === 0) {
      continue;
    }

    const key = accountKey(account);
    let bucket = accounts.get(key);
    if (bucket === undefined) {
      bucket = { account, followers: new Map() };
      accounts.set(key, bucket);
    }

    const payload = await readPayload(dataDir, manifest, entry.path);
    if (!Array.isArray(payload)) {
      continue;
    }
    for (const value of payload) {
      if (!isRecord(value) || typeof value.login !== 'string' || value.login.length === 0) {
        continue;
      }
      const loginKey = value.login.toLowerCase();
      if (bucket.followers.has(loginKey)) {
        continue;
      }
      const id = typeof value.id === 'number' && Number.isInteger(value.id) ? value.id : null;
      bucket.followers.set(loginKey, { login: value.login, id });
    }
  }

  return accounts;
}

/** Collapses a raw follower set to counts for mixed/compacted diffs. */
export function rawFollowerCounts(data: RawFollowerData): FollowerCounts {
  const counts: FollowerCounts = new Map();
  for (const [key, bucket] of data) {
    counts.set(key, { account: bucket.account, count: bucket.followers.size });
  }
  return counts;
}

/** Compacted account rows as counts; identities do not survive compaction. */
export function historyFollowerCounts(rows: readonly UserHistoryRow[]): FollowerCounts {
  const counts: FollowerCounts = new Map();
  for (const row of rows) {
    counts.set(accountKey(row.account), { account: row.account, count: row.followers });
  }
  return counts;
}

function identity(record: FollowerRecord): FollowerIdentity {
  return record.id === null ? { login: record.login } : { login: record.login, id: record.id };
}

function compareIdentities(left: FollowerIdentity, right: FollowerIdentity): number {
  return left.login.toLowerCase().localeCompare(right.login.toLowerCase());
}

function compareUserEntries(left: UserDiffEntry, right: UserDiffEntry): number {
  return left.account.toLowerCase().localeCompare(right.account.toLowerCase());
}

/** Diffs named follower sets, case-insensitively, preserving display casing. */
export function diffRawFollowers(from: RawFollowerData, to: RawFollowerData): UserDiffEntry[] {
  const keys = new Set([...from.keys(), ...to.keys()]);
  const entries: UserDiffEntry[] = [];

  for (const key of keys) {
    const left = from.get(key);
    const right = to.get(key);
    const leftFollowers = left?.followers ?? new Map<string, FollowerRecord>();
    const rightFollowers = right?.followers ?? new Map<string, FollowerRecord>();

    const added = [...rightFollowers]
      .filter(([loginKey]) => !leftFollowers.has(loginKey))
      .map(([, record]) => identity(record))
      .sort(compareIdentities);
    const removed = [...leftFollowers]
      .filter(([loginKey]) => !rightFollowers.has(loginKey))
      .map(([, record]) => identity(record))
      .sort(compareIdentities);

    if (added.length === 0 && removed.length === 0) {
      continue;
    }

    entries.push({
      account: right?.account ?? left?.account ?? key,
      followers: {
        from: leftFollowers.size,
        to: rightFollowers.size,
        delta: rightFollowers.size - leftFollowers.size,
        added,
        removed,
      },
    });
  }

  return entries.sort(compareUserEntries);
}

/**
 * Diffs aggregate follower counts. Used whenever a side comes from compacted
 * history: additions/removals cannot be named, so both lists are null.
 */
export function diffFollowerCounts(from: FollowerCounts, to: FollowerCounts): UserDiffEntry[] {
  const keys = new Set([...from.keys(), ...to.keys()]);
  const entries: UserDiffEntry[] = [];

  for (const key of keys) {
    const left = from.get(key);
    const right = to.get(key);
    const before = left?.count ?? 0;
    const after = right?.count ?? 0;
    if (before === after) {
      continue;
    }
    entries.push({
      account: right?.account ?? left?.account ?? key,
      followers: {
        from: before,
        to: after,
        delta: after - before,
        added: null,
        removed: null,
        identitiesAvailable: false,
      },
    });
  }

  return entries.sort(compareUserEntries);
}
