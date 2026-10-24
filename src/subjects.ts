/** Parsing and normalizing subject syntax from the CLI and config. */

import { invalidSubject } from './errors.js';
import type { SubjectType } from './types.js';

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_PART_PATTERN = /^[A-Za-z0-9._-]+$/;
const WHITESPACE_PATTERN = /\s/;

export type ParsedSubject =
  | { type: 'user'; account: string; subject: string }
  | { type: 'repo'; repo: string; subject: string };

export function isValidLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

export function isValidRepoFullName(repo: string): boolean {
  const parts = repo.split('/');
  if (parts.length !== 2) {
    return false;
  }
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined) {
    return false;
  }
  return REPO_PART_PATTERN.test(owner) && REPO_PART_PATTERN.test(name);
}

export function canonicalUserSubject(account: string): string {
  return `user:${account}`;
}

export function canonicalRepoSubject(repo: string): string {
  return `repo:${repo}`;
}

const GITHUB_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com(?=\/|$)/i;

/**
 * Recognizes a GitHub profile or repository URL and returns its canonical
 * subject. A profile has one path segment; a repository uses the first two, so
 * subpages, trailing slashes, query strings, and `.git` suffixes also resolve.
 * Returns null when the input is not a GitHub URL, letting callers fall back to
 * the bare and canonical forms.
 */
export function parseGitHubUrl(input: string): ParsedSubject | null {
  const match = GITHUB_URL_PREFIX.exec(input);
  if (match === null) {
    return null;
  }

  let path = input.slice(match[0].length);
  const suffix = path.search(/[?#]/);
  if (suffix >= 0) {
    path = path.slice(0, suffix);
  }
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const first = segments[0];
  if (first === undefined) {
    return null;
  }

  const second = segments[1];
  if (second === undefined) {
    return isValidLogin(first)
      ? { type: 'user', account: first, subject: canonicalUserSubject(first) }
      : null;
  }

  const repo = `${first}/${second.replace(/\.git$/i, '')}`;
  return isValidRepoFullName(repo)
    ? { type: 'repo', repo, subject: canonicalRepoSubject(repo) }
    : null;
}

/**
 * Accepts a GitHub URL, `user:<login>`, `repo:<owner>/<name>`, or a bare value.
 * A bare value containing a slash is a repository; otherwise it is a user.
 */
export function parseSubject(input: string): ParsedSubject {
  if (input.length === 0 || input.trim() !== input || WHITESPACE_PATTERN.test(input)) {
    throw invalidSubject(input);
  }

  const url = parseGitHubUrl(input);
  if (url !== null) {
    return url;
  }

  if (input.startsWith('user:')) {
    const account = input.slice('user:'.length);
    if (!isValidLogin(account)) {
      throw invalidSubject(input);
    }
    return { type: 'user', account, subject: canonicalUserSubject(account) };
  }

  if (input.startsWith('repo:')) {
    const repo = input.slice('repo:'.length);
    if (!isValidRepoFullName(repo)) {
      throw invalidSubject(input);
    }
    return { type: 'repo', repo, subject: canonicalRepoSubject(repo) };
  }

  if (input.includes('/')) {
    if (!isValidRepoFullName(input)) {
      throw invalidSubject(input);
    }
    return { type: 'repo', repo: input, subject: canonicalRepoSubject(input) };
  }

  if (!isValidLogin(input)) {
    throw invalidSubject(input);
  }
  return { type: 'user', account: input, subject: canonicalUserSubject(input) };
}

/** Parses the value supplied to `watch add user|repo`. */
export function parseExplicitSubject(type: SubjectType, value: string): ParsedSubject {
  const url = parseGitHubUrl(value);
  if (url !== null) {
    if (url.type !== type) {
      throw invalidSubject(value);
    }
    return url;
  }

  if (type === 'user') {
    if (value.includes(':') || !isValidLogin(value)) {
      throw invalidSubject(value);
    }
    return { type: 'user', account: value, subject: canonicalUserSubject(value) };
  }

  if (value.includes(':') || !isValidRepoFullName(value)) {
    throw invalidSubject(value);
  }
  return { type: 'repo', repo: value, subject: canonicalRepoSubject(value) };
}

/** Case-insensitive identity used for deduplication and lookups. */
export function subjectKey(subject: {
  type: SubjectType;
  account?: string;
  repo?: string;
}): string {
  if (subject.type === 'user') {
    return `user:${(subject.account ?? '').toLowerCase()}`;
  }
  return `repo:${(subject.repo ?? '').toLowerCase()}`;
}

/** Parses a canonical subject string and returns its case-insensitive key. */
export function subjectKeyOf(subject: string): string {
  return subjectKey(parseSubject(subject));
}

/** Best-effort key for persisted subjects that may predate validation. */
export function tolerantSubjectKey(subject: string): string {
  try {
    return subjectKeyOf(subject);
  } catch {
    return subject.toLowerCase();
  }
}

/** The login encoded in a canonical `user:` subject. */
export function accountOf(subject: string): string {
  return subject.startsWith('user:') ? subject.slice('user:'.length) : subject;
}

/** The `owner/name` encoded in a canonical `repo:` subject. */
export function repoOf(subject: string): string {
  return subject.startsWith('repo:') ? subject.slice('repo:'.length) : subject;
}
