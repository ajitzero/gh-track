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

/**
 * Accepts `user:<login>`, `repo:<owner>/<name>`, or a bare value.
 * A bare value containing a slash is a repository; otherwise it is a user.
 */
export function parseSubject(input: string): ParsedSubject {
  if (
    input.length === 0 ||
    input.trim() !== input ||
    WHITESPACE_PATTERN.test(input)
  ) {
    throw invalidSubject(input);
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
