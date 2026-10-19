/** Shared run seeding used by integration and diff unit tests. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Manifest, Resource, RunStatus } from '../../src/types.js';

export interface SeedRequest {
  subject: string;
  resource: Resource;
  path: string;
  payload: unknown;
}

/** Converts a run id such as 2026-08-01T10-00-00Z to its ISO timestamp. */
export function runTimestamp(id: string): string {
  return `${id.slice(0, 10)}T${id.slice(11, 19).replaceAll('-', ':')}.000Z`;
}

export function repoPayload(
  id: number,
  fullName: string,
  stars: number,
  forks: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    full_name: fullName,
    stargazers_count: stars,
    forks_count: forks,
    ...extra,
  };
}

/** Writes a run directory with a valid manifest and the supplied payloads. */
export async function seedRun(
  dataDir: string,
  id: string,
  status: RunStatus,
  requests: readonly SeedRequest[],
): Promise<void> {
  const directory = path.join(dataDir, 'runs', id);
  await mkdir(directory, { recursive: true });

  const subjects = new Map<string, Set<Resource>>();
  for (const request of requests) {
    const resources = subjects.get(request.subject) ?? new Set<Resource>();
    resources.add(request.resource);
    subjects.set(request.subject, resources);

    const target = path.join(directory, request.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(request.payload, null, 2)}\n`, 'utf8');
  }

  const timestamp = runTimestamp(id);
  const manifest: Manifest = {
    schemaVersion: 1,
    id,
    startedAt: timestamp,
    finishedAt: timestamp,
    status,
    subjects: [...subjects].map(([subject, resources]) => ({
      subject,
      resources: [...resources],
    })),
    stats: { repos: 0, followers: 0, requests: requests.length, notModified: 0 },
    requests: requests.map((request, index) => ({
      ...request,
      url: `https://example.test/${id}/${index}`,
      page: 1,
      status: 200,
    })),
    pending: [],
    errors: [],
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}
