/** Resolves `diff` references to complete runs or compacted history days. */

import { utcDay } from '../date.js';
import { invalidRange, notEnoughRuns, runNotFound, UsageError } from '../errors.js';
import { parseRef } from '../refs.js';
import { readCompactedDays } from '../store/compact.js';
import { readAllHistory } from '../store/history.js';
import { readManifest } from '../store/manifest.js';
import { listManifests } from '../store/runs.js';
import type { Manifest } from '../types.js';

export interface DiffPoint {
  /** Run id for raw runs; the UTC day for compacted history. */
  id: string;
  kind: 'raw' | 'compacted';
  /** UTC day used for ordering and date references. */
  day: string;
  /** Manifest time for raw runs; null when history has no exact time. */
  finishedAt: string | null;
  manifest?: Manifest | undefined;
}

function comparePoints(left: DiffPoint, right: DiffPoint): number {
  const byDay = left.day.localeCompare(right.day);
  if (byDay !== 0) {
    return byDay;
  }
  if (left.kind !== right.kind) {
    return left.kind === 'compacted' ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Every comparable point, oldest first: complete raw runs plus compacted days
 * that no longer have a complete raw run on disk. A day whose raw run survives
 * is always preferred, because raw data carries ids and identities.
 */
export async function loadDiffPoints(dataDir: string): Promise<DiffPoint[]> {
  const manifests = (await listManifests(dataDir)).filter(
    (manifest) => manifest.status === 'complete',
  );
  const rawDays = new Set(manifests.map((manifest) => utcDay(manifest.id)));

  const [markedDays, history] = await Promise.all([
    readCompactedDays(dataDir),
    readAllHistory(dataDir),
  ]);
  const historyDays = new Set<string>(markedDays);
  for (const row of history.repos) {
    historyDays.add(row.date);
  }
  for (const row of history.users) {
    historyDays.add(row.date);
  }

  const points: DiffPoint[] = manifests.map((manifest) => ({
    id: manifest.id,
    kind: 'raw' as const,
    day: utcDay(manifest.id),
    finishedAt: manifest.finishedAt ?? manifest.startedAt,
    manifest,
  }));

  for (const day of historyDays) {
    if (!rawDays.has(day)) {
      points.push({ id: day, kind: 'compacted', day, finishedAt: null });
    }
  }

  return points.sort(comparePoints);
}

function lastPointOnOrBefore(points: readonly DiffPoint[], day: string): DiffPoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point !== undefined && point.day <= day) {
      return point;
    }
  }
  return null;
}

function resolvePoint(points: readonly DiffPoint[], ref: string, now: Date): DiffPoint | null {
  const parsed = parseRef(ref, { label: 'diff', now });
  if (parsed.kind === 'latest') {
    return points[points.length - 1] ?? null;
  }
  if (parsed.kind === 'date' || parsed.kind === 'relative') {
    return lastPointOnOrBefore(points, parsed.day ?? parsed.ref);
  }
  if (parsed.kind === 'run') {
    return points.find((point) => point.kind === 'raw' && point.id === parsed.ref) ?? null;
  }
  // `previous` is relative to the resolved end point and handled by the caller.
  return null;
}

async function resolutionFailure(dataDir: string, ref: string, now: Date): Promise<never> {
  const parsed = parseRef(ref, { label: 'diff', now });
  if (parsed.kind === 'run') {
    const manifest = await readManifest(dataDir, parsed.ref);
    if (manifest !== null) {
      throw new UsageError(`Run ${parsed.ref} is ${manifest.status}; diff requires complete runs.`);
    }
    throw runNotFound(parsed.ref);
  }
  throw notEnoughRuns({ ref });
}

export interface DiffRange {
  from: DiffPoint;
  to: DiffPoint;
}

export interface ResolveDiffOptions {
  from?: string | undefined;
  to?: string | undefined;
  /** Instant relative references are measured from; defaults to now. */
  now?: Date | undefined;
}

/**
 * Resolves `--from`/`--to` with the documented defaults: the end point is the
 * latest complete run and the start point is the point immediately before it.
 * Relative offsets and calendar days snap to the newest point on or before the
 * day; a start bound older than the data snaps forward to the oldest point.
 */
export async function resolveDiffRange(
  dataDir: string,
  options: ResolveDiffOptions = {},
): Promise<DiffRange> {
  const now = options.now ?? new Date();
  const toRef = options.to ?? 'latest';
  if (toRef === 'previous') {
    throw new UsageError(
      '--to cannot be "previous"; use latest, a run id, YYYY-MM-DD, or a past offset like 1y.',
    );
  }
  parseRef(toRef, { label: 'diff', now });

  const fromRef = options.from ?? 'previous';
  if (fromRef !== 'previous') {
    parseRef(fromRef, { label: 'diff', now });
  }

  const points = await loadDiffPoints(dataDir);
  if (points.length < 2) {
    throw notEnoughRuns({ points: points.length });
  }

  const to = resolvePoint(points, toRef, now);
  if (to === null) {
    const parsed = parseRef(toRef, { label: 'diff', now });
    const oldest = points[0];
    if (oldest !== undefined && (parsed.kind === 'date' || parsed.kind === 'relative')) {
      throw new UsageError(
        `--to ${JSON.stringify(toRef)} resolves to ${parsed.day ?? parsed.ref}, before the oldest stored point (${oldest.day}).`,
      );
    }
    throw await resolutionFailure(dataDir, toRef, now);
  }
  const toIndex = points.indexOf(to);

  let from: DiffPoint | null;
  if (fromRef === 'previous') {
    from = toIndex > 0 ? (points[toIndex - 1] ?? null) : null;
    if (from === null) {
      throw notEnoughRuns({ to: to.id, reason: 'no previous complete run' });
    }
  } else {
    from = resolvePoint(points, fromRef, now);
    if (from === null) {
      const parsed = parseRef(fromRef, { label: 'diff', now });
      if (parsed.kind === 'date' || parsed.kind === 'relative') {
        // A start older than the data snaps forward to the oldest point.
        from = points[0] ?? null;
      }
    }
    if (from === null) {
      throw await resolutionFailure(dataDir, fromRef, now);
    }
  }

  if (points.indexOf(from) >= toIndex) {
    throw invalidRange({ from: from.id, to: to.id });
  }
  return { from, to };
}
