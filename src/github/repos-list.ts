/** Public repository listing used by the `dashboard add` picker. */

import { githubUserNotFound } from '../errors.js';
import { isValidRepoFullName } from '../subjects.js';
import {
  GitHubClient,
  MAX_PAGES,
  hasNextPage,
  nextPageUrl,
} from './client.js';
import { REPOS_PER_PAGE, reposUrl } from './resources/repos.js';

export interface RepoListing {
  fullName: string;
  fork: boolean;
  archived: boolean;
  stars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts the fields the picker needs from one `/users/{login}/repos` entry. */
export function parseRepoListing(payload: unknown): RepoListing | null {
  if (!isRecord(payload)) {
    return null;
  }
  const fullName = payload.full_name;
  if (typeof fullName !== 'string' || !isValidRepoFullName(fullName)) {
    return null;
  }
  return {
    fullName,
    fork: payload.fork === true,
    archived: payload.archived === true,
    stars:
      typeof payload.stargazers_count === 'number' && Number.isFinite(payload.stargazers_count)
        ? payload.stargazers_count
        : 0,
  };
}

/**
 * Lists every public repository owned by `login`, following pagination up to
 * `MAX_PAGES`. A 404 means the login does not exist.
 */
export async function listUserRepos(
  client: GitHubClient,
  login: string,
  signal?: AbortSignal,
): Promise<RepoListing[]> {
  const repos: RepoListing[] = [];
  const seen = new Set<string>();
  let page = 1;
  let url: string | null = reposUrl(client.apiBase, login, page);

  while (url !== null && page <= MAX_PAGES) {
    const response = await client.get(url, { signal });
    if (response.status === 404) {
      throw githubUserNotFound(login);
    }
    if (!Array.isArray(response.payload)) {
      break;
    }

    for (const entry of response.payload) {
      const repo = parseRepoListing(entry);
      if (repo === null || seen.has(repo.fullName.toLowerCase())) {
        continue;
      }
      seen.add(repo.fullName.toLowerCase());
      repos.push(repo);
    }

    if (!hasNextPage(response.link, response.payload.length, REPOS_PER_PAGE)) {
      break;
    }
    url = nextPageUrl(response.link) ?? reposUrl(client.apiBase, login, page + 1);
    page += 1;
  }

  return repos;
}
