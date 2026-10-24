/** Rate-limit header parsing, budgets, and persisted state. */

import { isRecord } from '../guards.js';

/** Requests held back so a run never drains the quota to exactly zero. */
export const HEADROOM = 2;

/** Unauthenticated ceiling per hour. */
export const DEFAULT_UNAUTHENTICATED_LIMIT = 60;

/** Authenticated ceiling per hour. */
export const DEFAULT_AUTHENTICATED_LIMIT = 5000;

export interface RateLimitHeaders {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
}

/** The subset persisted to `state/limits.json`. */
export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: string;
  observedAt: string;
}

export interface HeaderReader {
  get(name: string): string | null;
}

function parseInteger(value: string | null): number | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function parseRateLimitHeaders(headers: HeaderReader): RateLimitHeaders {
  const limit = parseInteger(headers.get('x-ratelimit-limit'));
  const remaining = parseInteger(headers.get('x-ratelimit-remaining'));
  const resetSeconds = parseInteger(headers.get('x-ratelimit-reset'));
  const retryAfterSeconds = parseInteger(headers.get('retry-after'));

  return {
    limit,
    remaining,
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
    retryAfterSeconds,
  };
}

/** Builds a cache entry from parsed headers, or null when a field is missing. */
export function stateFromInfo(
  info: RateLimitHeaders,
  observedAt: string,
): RateLimitState | null {
  if (info.limit === null || info.remaining === null || info.resetAt === null) {
    return null;
  }
  return { limit: info.limit, remaining: info.remaining, resetAt: info.resetAt, observedAt };
}

/** Builds a cache entry from response headers, or null when a header is missing. */
export function stateFromHeaders(
  headers: HeaderReader,
  observedAt: string,
): RateLimitState | null {
  return stateFromInfo(parseRateLimitHeaders(headers), observedAt);
}

/** Reads `state/limits.json`, returning null for anything unusable. */
export function parseRateLimitState(raw: unknown): RateLimitState | null {
  if (!isRecord(raw)) {
    return null;
  }
  const limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit) ? raw.limit : null;
  const remaining =
    typeof raw.remaining === 'number' && Number.isInteger(raw.remaining) ? raw.remaining : null;
  const resetAt = isIsoTimestamp(raw.resetAt) ? raw.resetAt : null;
  const observedAt = isIsoTimestamp(raw.observedAt) ? raw.observedAt : null;
  if (limit === null || remaining === null || resetAt === null || observedAt === null) {
    return null;
  }
  return { limit, remaining, resetAt, observedAt };
}

export function serializeRateLimitState(state: RateLimitState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function defaultLimit(hasToken: boolean): number {
  return hasToken ? DEFAULT_AUTHENTICATED_LIMIT : DEFAULT_UNAUTHENTICATED_LIMIT;
}

export interface CapInput {
  hasToken: boolean;
  nowMs: number;
  /** `--max-requests`. May only lower the quota-derived cap. */
  override?: number | undefined;
}

/**
 * The quota-derived cap: `remaining - HEADROOM`, never negative. A cache entry
 * whose reset time has passed is treated as a fresh window.
 */
export function quotaDerivedCap(
  state: RateLimitState | null,
  hasToken: boolean,
  nowMs: number,
): number {
  let remaining: number;
  if (state === null) {
    remaining = defaultLimit(hasToken);
  } else if (Date.parse(state.resetAt) > nowMs) {
    remaining = state.remaining;
  } else {
    remaining = state.limit;
  }
  return Math.max(0, remaining - HEADROOM);
}

/** The effective request cap for a run. `--max-requests` may only lower it. */
export function effectiveMaxRequests(state: RateLimitState | null, input: CapInput): number {
  const quota = quotaDerivedCap(state, input.hasToken, input.nowMs);
  if (input.override === undefined) {
    return quota;
  }
  return Math.min(quota, input.override);
}
