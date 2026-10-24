/** Repository snapshots and the id-based repository diff. */

import { isRecord } from '../guards.js';
import { readRunPayload } from '../store/runs.js';
import type { DiffField, Manifest, RepoDiffEntry, RepoHistoryRow } from '../types.js';

/** Scalar payload fields for one repository; identity is kept separately. */
export interface RepoRecord {
  id: number | null;
  fullName: string;
  fields: Record<string, unknown>;
}

/** The fields retained when one side comes from compacted history. */
export const COMPACTED_REPO_FIELDS: ReadonlySet<string> = new Set([
  'stargazers_count',
  'forks_count',
]);

const IDENTITY_FIELDS = new Set(['id', 'full_name']);

export function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function scalarFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (IDENTITY_FIELDS.has(key) || !isScalar(value)) {
      continue;
    }
    fields[key] = value;
  }
  return fields;
}

/** Converts one repository payload into a comparable record, or null if unusable. */
export function repoRecordFromPayload(value: unknown): RepoRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const fullName = value.full_name;
  if (typeof fullName !== 'string' || fullName.length === 0) {
    return null;
  }
  const rawId = value.id;
  const id = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null;
  return { id, fullName, fields: scalarFields(value) };
}

function addRepo(map: Map<string, RepoRecord>, record: RepoRecord): void {
  if (record.id !== null) {
    const key = `id:${record.id}`;
    if (!map.has(key)) {
      map.set(key, record);
    }
    return;
  }

  const name = record.fullName.toLowerCase();
  for (const existing of map.values()) {
    if (existing.fullName.toLowerCase() === name) {
      return;
    }
  }
  map.set(`name:${name}`, record);
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

/** Reads every repository a run stored, from user repo pages and standalone repos. */
export async function readRawRepos(
  dataDir: string,
  manifest: Manifest,
): Promise<RepoRecord[]> {
  const records = new Map<string, RepoRecord>();

  for (const entry of manifest.requests) {
    if (entry.path === undefined) {
      continue;
    }
    if (entry.resource === 'repos') {
      const payload = await readPayload(dataDir, manifest, entry.path);
      if (!Array.isArray(payload)) {
        continue;
      }
      for (const value of payload) {
        const record = repoRecordFromPayload(value);
        if (record !== null) {
          addRepo(records, record);
        }
      }
      continue;
    }
    if (entry.resource === 'repo') {
      const record = repoRecordFromPayload(await readPayload(dataDir, manifest, entry.path));
      if (record !== null) {
        addRepo(records, record);
      }
    }
  }

  return [...records.values()];
}

/** Compacted repository rows as id-less snapshots with only stars and forks. */
export function historyRepoRecords(rows: readonly RepoHistoryRow[]): RepoRecord[] {
  return rows.map((row) => ({
    id: null,
    fullName: row.repository,
    fields: {
      stargazers_count: row.stars,
      forks_count: row.forks,
    },
  }));
}

/** Copies records while dropping every field outside `allowed`. */
export function restrictRepoFields(
  records: readonly RepoRecord[],
  allowed: ReadonlySet<string>,
): RepoRecord[] {
  return records.map((record) => ({
    id: record.id,
    fullName: record.fullName,
    fields: Object.fromEntries(
      Object.entries(record.fields).filter(([key]) => allowed.has(key)),
    ),
  }));
}

/**
 * Compares scalar fields present in either side, adding deltas for numbers.
 * A key missing from one side is compared as null; explicit nulls remain
 * values rather than being treated as absent.
 */
export function compareRepoFields(
  from: Readonly<Record<string, unknown>>,
  to: Readonly<Record<string, unknown>>,
): Record<string, DiffField> {
  const fields: Record<string, DiffField> = {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const key of [...keys].sort()) {
    const before = Object.hasOwn(from, key) ? from[key] : null;
    const after = Object.hasOwn(to, key) ? to[key] : null;
    if (!isScalar(before) || !isScalar(after) || Object.is(before, after)) {
      continue;
    }
    const field: DiffField = { from: before, to: after };
    if (typeof before === 'number' && typeof after === 'number') {
      field.delta = after - before;
    }
    fields[key] = field;
  }
  return fields;
}

function nameKey(name: string): string {
  return name.toLowerCase();
}

function compareEntries(left: RepoDiffEntry, right: RepoDiffEntry): number {
  const byName = left.repository
    .toLowerCase()
    .localeCompare(right.repository.toLowerCase());
  if (byName !== 0) {
    return byName;
  }
  return (left.id ?? 0) - (right.id ?? 0);
}

/**
 * Diffs repository snapshots. Numeric ids are authoritative; full_name is only
 * consulted when an id is missing on one side, which is the history fallback.
 * A matched id with a different name is one `renamed` entry.
 */
export function diffRepoSnapshots(
  from: readonly RepoRecord[],
  to: readonly RepoRecord[],
): RepoDiffEntry[] {
  const toById = new Map<number, RepoRecord>();
  const toByName = new Map<string, RepoRecord>();

  for (const record of to) {
    if (record.id !== null && !toById.has(record.id)) {
      toById.set(record.id, record);
    }
    if (!toByName.has(nameKey(record.fullName))) {
      toByName.set(nameKey(record.fullName), record);
    }
  }

  const usedTo = new Set<RepoRecord>();
  const entries: RepoDiffEntry[] = [];

  for (const left of from) {
    let right = left.id !== null ? toById.get(left.id) : undefined;
    if (right === undefined) {
      const candidate = toByName.get(nameKey(left.fullName));
      if (candidate !== undefined && (left.id === null || candidate.id === null)) {
        right = candidate;
      }
    }

    if (right === undefined) {
      entries.push({
        id: left.id,
        repository: left.fullName,
        change: 'removed',
        fields: {},
      });
      continue;
    }

    usedTo.add(right);
    const renamed = left.fullName !== right.fullName;
    const fields = compareRepoFields(left.fields, right.fields);
    if (!renamed && Object.keys(fields).length === 0) {
      continue;
    }

    const entry: RepoDiffEntry = {
      id: right.id ?? left.id,
      repository: right.fullName,
      change: renamed ? 'renamed' : 'changed',
      fields,
    };
    if (renamed) {
      entry.previousRepository = left.fullName;
    }
    entries.push(entry);
  }

  for (const right of to) {
    if (usedTo.has(right)) {
      continue;
    }
    entries.push({
      id: right.id,
      repository: right.fullName,
      change: 'added',
      fields: {},
    });
  }

  return entries.sort(compareEntries);
}
