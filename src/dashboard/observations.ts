/** Per-subject observation series built from complete runs and compacted history. */

import { endOfDay } from '../date.js';
import { UsageError, invalidRange, runNotFound } from '../errors.js';
import { rawFollowerCounts, readRawFollowers } from '../diff/followers.js';
import { readRawRepos, type RepoRecord } from '../diff/repos.js';
import { classifyRangeRef, type RefKind } from '../refs.js';
import { readAllHistory } from '../store/history.js';
import { listManifests } from '../store/runs.js';
import { accountOf, parseSubject, repoOf, subjectKeyOf } from '../subjects.js';
import type {
  DashboardObservation,
  DashboardRow,
  Manifest,
  Metric,
  SubjectType,
} from '../types.js';

function observationTime(observation: DashboardObservation): string {
  return observation.finishedAt ?? endOfDay(observation.day);
}

function compareObservations(
  left: DashboardObservation,
  right: DashboardObservation,
): number {
  const byTime = observationTime(left).localeCompare(observationTime(right));
  if (byTime !== 0) {
    return byTime;
  }
  return left.id.localeCompare(right.id);
}

export interface ObservationSubject {
  subject: string;
  kind: SubjectType;
}

export interface ObservationData {
  /** Keyed by lowercased subject identity. */
  series: Map<string, DashboardObservation[]>;
  /** Every manifest on disk, keyed by run id. */
  manifests: Map<string, Manifest>;
}

interface RawCaches {
  repos: Map<string, RepoRecord[]>;
  followers: Map<string, Map<string, { account: string; count: number }>>;
}

async function rawRepos(dataDir: string, manifest: Manifest, cache: RawCaches): Promise<RepoRecord[]> {
  const cached = cache.repos.get(manifest.id);
  if (cached !== undefined) {
    return cached;
  }
  const records = await readRawRepos(dataDir, manifest);
  cache.repos.set(manifest.id, records);
  return records;
}

async function rawFollowers(
  dataDir: string,
  manifest: Manifest,
  cache: RawCaches,
): Promise<Map<string, { account: string; count: number }>> {
  const cached = cache.followers.get(manifest.id);
  if (cached !== undefined) {
    return cached;
  }
  const counts = rawFollowerCounts(await readRawFollowers(dataDir, manifest));
  cache.followers.set(manifest.id, counts);
  return counts;
}

function repoName(subject: string): string {
  return repoOf(subject).toLowerCase();
}

function accountName(subject: string): string {
  return accountOf(subject).toLowerCase();
}

function repoObservation(
  manifest: Manifest,
  record: RepoRecord,
): DashboardObservation | null {
  const stars = record.fields.stargazers_count;
  const forks = record.fields.forks_count;
  if (
    typeof stars !== 'number' ||
    !Number.isInteger(stars) ||
    typeof forks !== 'number' ||
    !Number.isInteger(forks)
  ) {
    return null;
  }
  return {
    id: manifest.id,
    day: manifest.id.slice(0, 10),
    finishedAt: manifest.finishedAt ?? manifest.startedAt,
    kind: 'raw',
    metrics: { stars, forks },
  };
}

function userObservation(
  manifest: Manifest,
  count: number,
): DashboardObservation {
  return {
    id: manifest.id,
    day: manifest.id.slice(0, 10),
    finishedAt: manifest.finishedAt ?? manifest.startedAt,
    kind: 'raw',
    metrics: { followers: count },
  };
}

interface SubjectSpec extends ObservationSubject {
  key: string;
  name: string;
}

/** Builds one observation series per requested subject, oldest first. */
export async function buildObservationData(
  dataDir: string,
  subjects: readonly ObservationSubject[],
): Promise<ObservationData> {
  const manifests = await listManifests(dataDir);
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const complete = manifests.filter((manifest) => manifest.status === 'complete');

  const specs: SubjectSpec[] = subjects.map((subject) => ({
    ...subject,
    key: subjectKeyOf(subject.subject),
    name: subject.kind === 'repo' ? repoName(subject.subject) : accountName(subject.subject),
  }));
  const repoSpecs = specs.filter((spec) => spec.kind === 'repo');
  const userSpecs = specs.filter((spec) => spec.kind === 'user');

  const cache: RawCaches = { repos: new Map(), followers: new Map() };
  const series = new Map<string, DashboardObservation[]>();
  for (const spec of specs) {
    series.set(spec.key, []);
  }

  const rawDays = new Map<string, Set<string>>();
  const noteRawDay = (key: string, day: string): void => {
    const days = rawDays.get(key) ?? new Set<string>();
    days.add(day);
    rawDays.set(key, days);
  };

  // Oldest first so each series ends up chronologically sorted.
  for (const manifest of [...complete].reverse()) {
    if (repoSpecs.length > 0) {
      const records = await rawRepos(dataDir, manifest, cache);
      const byName = new Map(
        records.map((record) => [record.fullName.toLowerCase(), record]),
      );
      for (const spec of repoSpecs) {
        const record = byName.get(spec.name);
        if (record === undefined) {
          continue;
        }
        const observation = repoObservation(manifest, record);
        if (observation === null) {
          continue;
        }
        series.get(spec.key)?.push(observation);
        noteRawDay(spec.key, observation.day);
      }
    }

    if (userSpecs.length > 0) {
      const counts = await rawFollowers(dataDir, manifest, cache);
      for (const spec of userSpecs) {
        const count = counts.get(spec.name);
        if (count === undefined) {
          continue;
        }
        const observation = userObservation(manifest, count.count);
        series.get(spec.key)?.push(observation);
        noteRawDay(spec.key, observation.day);
      }
    }
  }

  const history = await readAllHistory(dataDir);
  const repoRows = new Map<string, Map<string, { stars: number; forks: number }>>();
  for (const row of history.repos) {
    const key = `repo:${row.repository.toLowerCase()}`;
    const days = repoRows.get(key) ?? new Map();
    days.set(row.date, { stars: row.stars, forks: row.forks });
    repoRows.set(key, days);
  }
  const userRows = new Map<string, Map<string, number>>();
  for (const row of history.users) {
    const key = `user:${row.account.toLowerCase()}`;
    const days = userRows.get(key) ?? new Map();
    days.set(row.date, row.followers);
    userRows.set(key, days);
  }

  for (const spec of specs) {
    const list = series.get(spec.key) ?? [];
    const days = rawDays.get(spec.key) ?? new Set<string>();

    if (spec.kind === 'repo') {
      for (const [day, metrics] of repoRows.get(spec.key) ?? []) {
        if (days.has(day)) {
          continue;
        }
        list.push({
          id: day,
          day,
          finishedAt: null,
          kind: 'compacted',
          metrics: { stars: metrics.stars, forks: metrics.forks },
        });
      }
    } else {
      for (const [day, count] of userRows.get(spec.key) ?? []) {
        if (days.has(day)) {
          continue;
        }
        list.push({
          id: day,
          day,
          finishedAt: null,
          kind: 'compacted',
          metrics: { followers: count },
        });
      }
    }

    list.sort(compareObservations);
    series.set(spec.key, list);
  }

  return { series, manifests: byId };
}

export interface ResolvedRefs {
  from: string;
  to: string;
  /** Null means unbounded (`latest`). */
  fromTime: string | null;
  toTime: string | null;
  fromPrevious: boolean;
}

function runBound(id: string, manifests: ReadonlyMap<string, Manifest>): string {
  const manifest = manifests.get(id);
  if (manifest === undefined) {
    throw runNotFound(id);
  }
  if (manifest.status !== 'complete') {
    throw new UsageError(`Run ${id} is ${manifest.status}; dashboard requires complete runs.`);
  }
  return manifest.finishedAt ?? manifest.startedAt;
}

function refTime(
  ref: string,
  kind: RefKind,
  manifests: ReadonlyMap<string, Manifest>,
): string | null {
  if (kind === 'latest') {
    return null;
  }
  if (kind === 'date') {
    return endOfDay(ref);
  }
  if (kind === 'run') {
    return runBound(ref, manifests);
  }
  throw new UsageError('A range reference cannot be "previous" here.');
}

/** Validates the reference pair once and converts it to per-subject bounds. */
export function resolveRefs(
  manifests: ReadonlyMap<string, Manifest>,
  fromRef: string,
  toRef: string,
): ResolvedRefs {
  const fromKind = classifyRangeRef(fromRef, '--from');
  const toKind = classifyRangeRef(toRef, '--to');
  if (toKind === 'previous') {
    throw new UsageError('--to cannot be "previous"; use latest, a run id, or YYYY-MM-DD.');
  }

  const toTime = refTime(toRef, toKind, manifests);
  // `latest` as a baseline means "the same observation as `to`": values with no delta.
  const fromTime =
    fromKind === 'previous'
      ? null
      : fromKind === 'latest'
        ? toTime
        : refTime(fromRef, fromKind, manifests);

  if (fromTime !== null && toTime !== null && fromTime > toTime) {
    throw invalidRange({ from: fromRef, to: toRef });
  }

  return {
    from: fromRef,
    to: toRef,
    fromTime,
    toTime,
    fromPrevious: fromKind === 'previous',
  };
}

function lastAtOrBefore(
  observations: readonly DashboardObservation[],
  time: string | null,
): DashboardObservation | null {
  if (observations.length === 0) {
    return null;
  }
  if (time === null) {
    return observations[observations.length - 1] ?? null;
  }
  let found: DashboardObservation | null = null;
  for (const observation of observations) {
    if (observationTime(observation) <= time) {
      found = observation;
    } else {
      break;
    }
  }
  return found;
}

export interface ResolvedObservations {
  from: DashboardObservation | null;
  to: DashboardObservation | null;
}

export function resolveObservations(
  observations: readonly DashboardObservation[],
  refs: ResolvedRefs,
): ResolvedObservations {
  const to = lastAtOrBefore(observations, refs.toTime);
  if (refs.fromPrevious) {
    if (to === null) {
      return { from: null, to: null };
    }
    const index = observations.indexOf(to);
    return { from: index > 0 ? (observations[index - 1] ?? null) : null, to };
  }
  return { from: lastAtOrBefore(observations, refs.fromTime), to };
}

function refInfo(observation: DashboardObservation): { id: string; finishedAt: string | null } {
  return { id: observation.id, finishedAt: observation.finishedAt };
}

function rowSource(
  from: DashboardObservation | null,
  to: DashboardObservation | null,
): DashboardRow['source'] {
  if (to === null) {
    return null;
  }
  if (from === null || from === to) {
    return to.kind;
  }
  if (from.kind === to.kind) {
    return to.kind;
  }
  return 'mixed';
}

export interface DashboardItem {
  subject: string;
  metrics: readonly Metric[];
}

/** Builds one row per selected subject using that subject's own observations. */
export function buildDashboardRows(
  data: ObservationData,
  items: readonly DashboardItem[],
  refs: ResolvedRefs,
): DashboardRow[] {
  return items.map((item) => {
    const parsed = parseSubject(item.subject);
    const observations = data.series.get(subjectKeyOf(item.subject)) ?? [];
    const resolved = resolveObservations(observations, refs);
    const metrics: DashboardRow['metrics'] = {};

    for (const metric of item.metrics) {
      const value = resolved.to?.metrics[metric] ?? null;
      const from = resolved.from?.metrics[metric] ?? null;
      metrics[metric] = {
        value,
        from,
        delta: value !== null && from !== null ? value - from : null,
      };
    }

    return {
      kind: parsed.type,
      subject: item.subject,
      source: rowSource(resolved.from, resolved.to),
      from: resolved.from === null ? null : refInfo(resolved.from),
      to: resolved.to === null ? null : refInfo(resolved.to),
      metrics,
    };
  });
}
