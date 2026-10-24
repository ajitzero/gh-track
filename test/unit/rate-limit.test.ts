import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AUTHENTICATED_LIMIT,
  DEFAULT_UNAUTHENTICATED_LIMIT,
  HEADROOM,
  effectiveMaxRequests,
  parseRateLimitHeaders,
  parseRateLimitState,
  quotaDerivedCap,
  stateFromHeaders,
} from '../../src/github/rateLimit.js';

const RESET_SECONDS = 1_790_000_000;
const RESET_ISO = new Date(RESET_SECONDS * 1000).toISOString();

test('parses rate-limit headers, including Retry-After', () => {
  const parsed = parseRateLimitHeaders(
    new Headers({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '41',
      'x-ratelimit-reset': String(RESET_SECONDS),
      'retry-after': '30',
    }),
  );
  assert.equal(parsed.limit, 60);
  assert.equal(parsed.remaining, 41);
  assert.equal(parsed.resetAt, RESET_ISO);
  assert.equal(parsed.retryAfterSeconds, 30);
});

test('missing rate-limit headers become null', () => {
  assert.deepEqual(parseRateLimitHeaders(new Headers()), {
    limit: null,
    remaining: null,
    resetAt: null,
    retryAfterSeconds: null,
  });
});

test('stateFromHeaders needs limit, remaining, and reset together', () => {
  const observedAt = '2026-10-20T00:00:00.000Z';
  assert.deepEqual(
    stateFromHeaders(
      new Headers({
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '10',
        'x-ratelimit-reset': String(RESET_SECONDS),
      }),
      observedAt,
    ),
    { limit: 60, remaining: 10, resetAt: RESET_ISO, observedAt },
  );
  assert.equal(stateFromHeaders(new Headers({ 'x-ratelimit-limit': '60' }), observedAt), null);
});

test('parseRateLimitState drops anything unusable', () => {
  assert.equal(parseRateLimitState(null), null);
  assert.equal(parseRateLimitState('nope'), null);
  assert.equal(parseRateLimitState({ limit: 60 }), null);
  assert.equal(
    parseRateLimitState({
      limit: 60,
      remaining: 10,
      resetAt: 'not-a-date',
      observedAt: '2026-10-20T00:00:00.000Z',
    }),
    null,
  );
});

test('quota cap keeps a headroom of two and floors at zero', () => {
  assert.equal(quotaDerivedCap(null, false, 0), DEFAULT_UNAUTHENTICATED_LIMIT - HEADROOM);
  assert.equal(quotaDerivedCap(null, true, 0), DEFAULT_AUTHENTICATED_LIMIT - HEADROOM);
  assert.equal(
    quotaDerivedCap(
      {
        limit: 60,
        remaining: 1,
        resetAt: '2999-01-01T00:00:00.000Z',
        observedAt: '2026-10-20T00:00:00.000Z',
      },
      false,
      Date.parse('2026-10-20T00:00:00.000Z'),
    ),
    0,
  );
});

test('a stale window falls back to the full limit', () => {
  assert.equal(
    quotaDerivedCap(
      {
        limit: 60,
        remaining: 3,
        resetAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2025-12-31T23:00:00.000Z',
      },
      false,
      Date.parse('2026-10-20T00:00:00.000Z'),
    ),
    DEFAULT_UNAUTHENTICATED_LIMIT - HEADROOM,
  );
});

test('--max-requests can only lower the cap', () => {
  assert.equal(effectiveMaxRequests(null, { hasToken: false, nowMs: 0, override: 10 }), 10);
  assert.equal(effectiveMaxRequests(null, { hasToken: false, nowMs: 0, override: 100 }), 58);
  assert.equal(effectiveMaxRequests(null, { hasToken: false, nowMs: 0 }), 58);
});
