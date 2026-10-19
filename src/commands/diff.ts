/** `gh-track diff`: compare two complete runs or compacted history days. */

import {
  diffFollowerCounts,
  diffRawFollowers,
  rawFollowerCounts,
  readRawFollowers,
  type FollowerCounts,
  type RawFollowerData,
} from '../diff/followers.js';
import { loadHistorySnapshot } from '../diff/compacted.js';
import {
  COMPACTED_REPO_FIELDS,
  diffRepoSnapshots,
  readRawRepos,
  restrictRepoFields,
  type RepoRecord,
} from '../diff/repos.js';
import {
  resolveDiffRange,
  type DiffPoint,
} from '../diff/resolve.js';
import { CliError, UsageError } from '../errors.js';
import { renderTable } from '../output/table.js';
import { parseSubject, type ParsedSubject } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  DiffField,
  DiffResult,
  DiffSource,
  RepoDiffEntry,
  UserDiffEntry,
} from '../types.js';

interface PointData {
  repos: RepoRecord[];
  /** Named sets for raw points; null when the point comes from history. */
  followers: RawFollowerData | null;
  /** Always present, including raw points, for mixed/compacted diffs. */
  counts: FollowerCounts;
}

async function loadPoint(dataDir: string, point: DiffPoint): Promise<PointData> {
  if (point.kind === 'raw') {
    const manifest = point.manifest;
    if (manifest === undefined) {
      throw new CliError('internal', `Raw diff point ${point.id} has no manifest.`);
    }
    const [repos, followers] = await Promise.all([
      readRawRepos(dataDir, manifest),
      readRawFollowers(dataDir, manifest),
    ]);
    return { repos, followers, counts: rawFollowerCounts(followers) };
  }

  const snapshot = await loadHistorySnapshot(dataDir, point.day);
  return { repos: snapshot.repos, followers: null, counts: snapshot.counts };
}

function diffSource(from: DiffPoint, to: DiffPoint): DiffSource {
  if (from.kind === 'raw' && to.kind === 'raw') {
    return 'raw';
  }
  if (from.kind === 'compacted' && to.kind === 'compacted') {
    return 'compacted';
  }
  return 'mixed';
}

function repoMatches(entry: RepoDiffEntry, filters: readonly ParsedSubject[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  const names = [entry.repository];
  if (entry.previousRepository !== undefined) {
    names.push(entry.previousRepository);
  }

  return names.some((name) => {
    const lower = name.toLowerCase();
    const owner = lower.split('/')[0] ?? '';
    return filters.some((filter) =>
      filter.type === 'repo'
        ? lower === filter.repo.toLowerCase()
        : owner === filter.account.toLowerCase(),
    );
  });
}

function userMatches(entry: UserDiffEntry, filters: readonly ParsedSubject[]): boolean {
  if (filters.length === 0) {
    return true;
  }
  const account = entry.account.toLowerCase();
  return filters.some(
    (filter) => filter.type === 'user' && filter.account.toLowerCase() === account,
  );
}

function formatValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function formatField(field: DiffField): string {
  const base = `${formatValue(field.from)} -> ${formatValue(field.to)}`;
  if (field.delta === undefined) {
    return base;
  }
  return `${base} (${field.delta >= 0 ? '+' : ''}${field.delta})`;
}

function formatFields(entry: RepoDiffEntry): string {
  const parts = Object.entries(entry.fields).map(
    ([name, field]) => `${name} ${formatField(field)}`,
  );
  return parts.length === 0 ? '-' : parts.join('; ');
}

function formatIdentities(
  identities: readonly { login: string; id?: number | undefined }[] | null,
): string {
  if (identities === null) {
    return '(unavailable)';
  }
  if (identities.length === 0) {
    return '-';
  }
  return identities.map((identity) => identity.login).join(', ');
}

function renderDiff(result: DiffResult): string {
  const lines = [`From ${result.from.id} to ${result.to.id} (source: ${result.source})`];
  if (result.source !== 'raw') {
    lines.push(
      'Compacted history has no repository ids or follower identities; fields are limited to stars, forks, and follower counts.',
    );
  }

  if (result.repos.length === 0 && result.users.length === 0) {
    lines.push('', 'No changes.');
    return `${lines.join('\n')}\n`;
  }

  if (result.repos.length > 0) {
    lines.push(
      '',
      'Repositories:',
      renderTable(
        ['REPOSITORY', 'CHANGE', 'FIELDS'],
        result.repos.map((entry) => [
          entry.previousRepository === undefined
            ? entry.repository
            : `${entry.repository} (was ${entry.previousRepository})`,
          entry.change,
          formatFields(entry),
        ]),
      ),
    );
  }

  if (result.users.length > 0) {
    lines.push(
      '',
      'Accounts:',
      renderTable(
        ['ACCOUNT', 'FOLLOWERS', 'ADDED', 'REMOVED'],
        result.users.map((entry) => [
          entry.account,
          formatField(entry.followers),
          formatIdentities(entry.followers.added),
          formatIdentities(entry.followers.removed),
        ]),
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function runDiff(context: CommandContext): Promise<CommandResult> {
  if (context.positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument ${JSON.stringify(context.positionals[0])}. Use: gh-track diff`,
    );
  }

  const filters = context.options.getAll('subject').map((value) => parseSubject(value));
  const range = await resolveDiffRange(context.paths.dataDir, {
    from: context.options.get('from'),
    to: context.options.get('to'),
  });
  const source = diffSource(range.from, range.to);

  const [fromData, toData] = await Promise.all([
    loadPoint(context.paths.dataDir, range.from),
    loadPoint(context.paths.dataDir, range.to),
  ]);

  let repos: RepoDiffEntry[];
  let users: UserDiffEntry[];

  if (source === 'raw') {
    const fromFollowers = fromData.followers;
    const toFollowers = toData.followers;
    if (fromFollowers === null || toFollowers === null) {
      throw new CliError('internal', 'Raw diff points are missing follower sets.');
    }
    repos = diffRepoSnapshots(fromData.repos, toData.repos);
    users = diffRawFollowers(fromFollowers, toFollowers);
  } else {
    repos = diffRepoSnapshots(
      restrictRepoFields(fromData.repos, COMPACTED_REPO_FIELDS),
      restrictRepoFields(toData.repos, COMPACTED_REPO_FIELDS),
    );
    users = diffFollowerCounts(fromData.counts, toData.counts);
  }

  const result: DiffResult = {
    from: { id: range.from.id, finishedAt: range.from.finishedAt },
    to: { id: range.to.id, finishedAt: range.to.finishedAt },
    source,
    repos: repos.filter((entry) => repoMatches(entry, filters)),
    users: users.filter((entry) => userMatches(entry, filters)),
  };

  return { json: result, text: renderDiff(result), warnings: [] };
}
