/** NDJSON history: tolerant reads, sorted writes, and per-day replacement. */

import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RepoHistoryRow, UserHistoryRow } from '../types.js';
import { writeFileAtomic } from './atomic.js';
import { historyReposDir, historyUsersDir } from './paths.js';
import { repoFileStem, safeSegment } from './runWriter.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

/** Parses one repository history line, rejecting anything malformed. */
export function parseRepoHistoryRow(value: unknown): RepoHistoryRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isDate(value.date) ||
    typeof value.repository !== 'string' ||
    value.repository.length === 0 ||
    typeof value.stars !== 'number' ||
    !Number.isInteger(value.stars) ||
    typeof value.forks !== 'number' ||
    !Number.isInteger(value.forks)
  ) {
    return null;
  }
  return {
    date: value.date,
    repository: value.repository,
    stars: value.stars,
    forks: value.forks,
  };
}

/** Parses one account history line, rejecting anything malformed. */
export function parseUserHistoryRow(value: unknown): UserHistoryRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isDate(value.date) ||
    typeof value.account !== 'string' ||
    value.account.length === 0 ||
    typeof value.followers !== 'number' ||
    !Number.isInteger(value.followers)
  ) {
    return null;
  }
  return { date: value.date, account: value.account, followers: value.followers };
}

export function serializeRepoHistoryRow(row: RepoHistoryRow): string {
  return JSON.stringify({
    date: row.date,
    repository: row.repository,
    stars: row.stars,
    forks: row.forks,
  });
}

export function serializeUserHistoryRow(row: UserHistoryRow): string {
  return JSON.stringify({ date: row.date, account: row.account, followers: row.followers });
}

export function repoHistoryFile(dataDir: string, repository: string): string {
  return path.join(historyReposDir(dataDir), `${repoFileStem(repository)}.ndjson`);
}

export function userHistoryFile(dataDir: string, account: string): string {
  return path.join(historyUsersDir(dataDir), `${safeSegment(account)}.ndjson`);
}

interface HistoryFile<T> {
  name: string;
  rows: T[];
}

/**
 * Reads every history file in a family. Malformed lines and unreadable files
 * are skipped: history is derived state and a single bad line must not make
 * `export` or the next compaction fail.
 */
async function readHistoryFiles<T>(
  dir: string,
  parse: (value: unknown) => T | null,
  identity: (row: T) => string,
): Promise<Map<string, HistoryFile<T>>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return new Map();
  }

  const files = new Map<string, HistoryFile<T>>();
  for (const name of entries.sort()) {
    if (!name.endsWith('.ndjson')) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }

    const rows: T[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const row = parse(parsed);
      if (row !== null) {
        rows.push(row);
      }
    }
    if (rows.length === 0) {
      continue;
    }

    // History files hold one identity per file; group by that identity so a
    // renamed file cannot produce duplicate rows on a rewrite.
    const first = rows[0];
    if (first === undefined) {
      continue;
    }
    const key = identity(first).toLowerCase();
    const existing = files.get(key);
    if (existing === undefined) {
      files.set(key, { name, rows });
    } else {
      existing.rows.push(...rows);
    }
  }
  return files;
}

async function writeHistoryFile<T>(
  filePath: string,
  rows: T[],
  serialize: (row: T) => string,
  dateOf: (row: T) => string,
): Promise<void> {
  rows.sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
  if (rows.length === 0) {
    await unlink(filePath).catch(() => undefined);
    return;
  }
  await writeFileAtomic(filePath, `${rows.map(serialize).join('\n')}\n`);
}

/**
 * Replaces one UTC day across a history family: the date is removed from every
 * file and the supplied rows are written. This makes compaction idempotent and
 * makes the chosen complete run authoritative for the day.
 */
async function replaceFamily<T>(
  dir: string,
  day: string,
  additions: readonly T[],
  parse: (value: unknown) => T | null,
  identity: (row: T) => string,
  stem: (row: T) => string,
  serialize: (row: T) => string,
  dateOf: (row: T) => string,
): Promise<void> {
  const files = await readHistoryFiles(dir, parse, identity);
  const updates = new Map<string, HistoryFile<T>>();
  for (const [key, file] of files) {
    updates.set(key, {
      name: file.name,
      rows: file.rows.filter((row) => dateOf(row) !== day),
    });
  }

  for (const row of additions) {
    const key = identity(row).toLowerCase();
    const existing = updates.get(key);
    if (existing !== undefined) {
      existing.rows.push(row);
    } else {
      updates.set(key, { name: `${stem(row)}.ndjson`, rows: [row] });
    }
  }

  for (const file of updates.values()) {
    await writeHistoryFile(path.join(dir, file.name), file.rows, serialize, dateOf);
  }
}

/**
 * Replaces repository and account history for one day. The maps passed in are
 * the metrics of the day's chosen complete run.
 */
export async function replaceHistoryDay(
  dataDir: string,
  day: string,
  repos: ReadonlyMap<string, { stars: number; forks: number }>,
  users: ReadonlyMap<string, number>,
): Promise<void> {
  const repoRows: RepoHistoryRow[] = [...repos].map(([repository, metrics]) => ({
    date: day,
    repository,
    stars: metrics.stars,
    forks: metrics.forks,
  }));
  const userRows: UserHistoryRow[] = [...users].map(([account, followers]) => ({
    date: day,
    account,
    followers,
  }));

  await replaceFamily<RepoHistoryRow>(
    historyReposDir(dataDir),
    day,
    repoRows,
    parseRepoHistoryRow,
    (row) => row.repository,
    (row) => repoFileStem(row.repository),
    serializeRepoHistoryRow,
    (row) => row.date,
  );
  await replaceFamily<UserHistoryRow>(
    historyUsersDir(dataDir),
    day,
    userRows,
    parseUserHistoryRow,
    (row) => row.account,
    (row) => safeSegment(row.account),
    serializeUserHistoryRow,
    (row) => row.date,
  );
}

export interface StoredHistory {
  repos: RepoHistoryRow[];
  users: UserHistoryRow[];
}

/** Reads every compacted history row for `export`. */
export async function readAllHistory(dataDir: string): Promise<StoredHistory> {
  const repoFiles = await readHistoryFiles(
    historyReposDir(dataDir),
    parseRepoHistoryRow,
    (row) => row.repository,
  );
  const userFiles = await readHistoryFiles(
    historyUsersDir(dataDir),
    parseUserHistoryRow,
    (row) => row.account,
  );

  return {
    repos: [...repoFiles.values()]
      .flatMap((file) => file.rows)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.repository.toLowerCase().localeCompare(right.repository.toLowerCase()),
      ),
    users: [...userFiles.values()]
      .flatMap((file) => file.rows)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.account.toLowerCase().localeCompare(right.account.toLowerCase()),
      ),
  };
}
