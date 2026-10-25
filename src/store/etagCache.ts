/** Removes one subject's advisory validators from `state/etags.json`. */

import { isRecord } from '../guards.js';
import { parseSubject } from '../subjects.js';
import { readStateJson, STATE_ETAGS_FILE, writeStateJson } from './state.js';

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment).toLowerCase());
  } catch {
    return null;
  }
}

/**
 * True only for URLs that belong to exactly this subject. Repository matching
 * uses the full owner and name path segments, so `other/repo` and
 * `owner/repo-extra` are never treated as the same repository. Account
 * matching covers only the account's own followers and repositories
 * resources, never its repositories' `/repos/...` entries.
 */
export function etagBelongsToSubject(url: string, subject: string): boolean {
  const segments = pathSegments(url);
  if (segments === null) {
    return false;
  }

  let parsed: ReturnType<typeof parseSubject>;
  try {
    parsed = parseSubject(subject);
  } catch {
    return false;
  }

  if (parsed.type === 'repo') {
    const [owner, name] = parsed.repo.split('/');
    if (owner === undefined || name === undefined) {
      return false;
    }
    return (
      segments.length >= 3 &&
      segments[0] === 'repos' &&
      segments[1] === owner.toLowerCase() &&
      segments[2] === name.toLowerCase()
    );
  }

  return (
    segments.length >= 3 &&
    segments[0] === 'users' &&
    segments[1] === parsed.account.toLowerCase() &&
    (segments[2] === 'followers' || segments[2] === 'repos')
  );
}

/**
 * Deletes the ETag cache entries for one subject and leaves every other entry
 * untouched. Returns the removed URLs. Missing or malformed state is ignored,
 * matching the advisory nature of the cache.
 */
export async function forgetSubjectEtags(dataDir: string, subject: string): Promise<string[]> {
  const raw = await readStateJson(dataDir, STATE_ETAGS_FILE);
  if (!isRecord(raw)) {
    return [];
  }

  const removed: string[] = [];
  for (const url of Object.keys(raw)) {
    if (etagBelongsToSubject(url, subject)) {
      delete raw[url];
      removed.push(url);
    }
  }

  if (removed.length > 0) {
    await writeStateJson(dataDir, STATE_ETAGS_FILE, raw);
  }
  return removed;
}
