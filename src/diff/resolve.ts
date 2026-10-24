/** Resolves `diff` references to complete runs or compacted history days. */

import { utcDay } from '../date.js';
import { invalidRange, notEnoughRuns, runNotFound, UsageError } from '../errors.js';
import { classifyRef } from '../refs.js';

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

function resolvePoint(points: readonly DiffPoint[], ref: string): DiffPoint | null {
  const kind = classifyRef(ref, { label: 'diff' });
  if (kind === 'latest') {
    return points[points.length - 1] ?? null;
  }
  if (kind === 'date') {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index];
      if (point !== undefined && point.day <= ref) {
        return point;
      }
    }
    return null;
  }
  if (kind === 'run') {
    return points.find((point) => point.kind === 'raw' && point.id === ref) ?? null;
  }
  // `previous` is relative to the resolved end point and handled by the caller.
  return null;
}

async function resolutionFailure(dataDir: string, ref: string): Promise<never> {
  const kind = classifyRef(ref, { label: 'diff' });
  if (kind === 'run') {
    const manifest = await readManifest(dataDir, ref);
    if (manifest !== null) {
      throw new UsageError(`Run ${ref} is ${manifest.status}; diff requires complete runs.`);
    }
    throw runNotFound(ref);
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
}

/**
 * Resolves `--from`/`--to` with the documented defaults: the end point is the
 * latest complete run and the start point is the point immediately before it.
 */
export async function resolveDiffRange(
  dataDir: string,
  options: ResolveDiffOptions = {},
): Promise<DiffRange> {
  const toRef = options.to ?? 'latest';
  if (toRef === 'previous') {
    throw new UsageError('--to cannot be "previous"; use latest, a run id, or YYYY-MM-DD.');
  }
  classifyRef(toRef, { label: 'diff' });

  const fromRef = options.from ?? 'previous';
  if (fromRef !== 'previous') {
    classifyRef(fromRef, { label: 'diff' });
  }

  const points = await loadDiffPoints(dataDir);
  if (points.length < 2) {
    throw notEnoughRuns({ points: points.length });
  }

  const to = resolvePoint(points, toRef);
  if (to === null) {
    throw await resolutionFailure(dataDir, toRef);
  }
  const toIndex = points.indexOf(to);

  let from: DiffPoint | null;
  if (fromRef === 'previous') {
    from = toIndex > 0 ? (points[toIndex - 1] ?? null) : null;
    if (from === null) {
      throw notEnoughRuns({ to: to.id, reason: 'no previous complete run' });
    }
  } else {
    from = resolvePoint(points, fromRef);
    if (from === null) {
      throw await resolutionFailure(dataDir, fromRef);
    }
  }

  if (points.indexOf(from) >= toIndex) {
    throw invalidRange({ from: from.id, to: to.id });
  }
  return { from, to };
}
