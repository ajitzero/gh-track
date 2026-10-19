/** Resolves `diff` references to complete runs or compacted history days. */

import { invalidRange, notEnoughRuns, runNotFound, UsageError } from '../errors.js';
import { readCompactedDays } from '../store/compact.js';
import { readAllHistory } from '../store/history.js';
import { readManifest } from '../store/manifest.js';
import { isValidRunId } from '../store/paths.js';
import { listManifests } from '../store/runs.js';
import type { Manifest } from '../types.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

export type RefKind = 'latest' | 'previous' | 'date' | 'run';

export function isCalendarDay(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Classifies a reference, rejecting anything outside the documented forms. */
export function classifyRef(ref: string): RefKind {
  if (ref === 'latest' || ref === 'previous') {
    return ref;
  }
  if (isCalendarDay(ref)) {
    return 'date';
  }
  if (isValidRunId(ref)) {
    return 'run';
  }
  throw new UsageError(
    `Invalid diff reference: ${JSON.stringify(ref)}. Use latest, previous, a run id, or YYYY-MM-DD.`,
  );
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

function runDay(runId: string): string {
  return runId.slice(0, 10);
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
  const rawDays = new Set(manifests.map((manifest) => runDay(manifest.id)));

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
    day: runDay(manifest.id),
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
  const kind = classifyRef(ref);
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
  const kind = classifyRef(ref);
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
  classifyRef(toRef);

  const fromRef = options.from ?? 'previous';
  if (fromRef !== 'previous') {
    classifyRef(fromRef);
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
