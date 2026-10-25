import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliError } from '../../src/errors.js';
import {
  GitHubClient,
  hasNextPage,
  nextPageUrl,
  parseLinkHeader,
  type FetchLike,
} from '../../src/github/client.js';

const URL = 'https://api.github.com/users/octocat/followers?per_page=100&page=1';
const RESET_SECONDS = 1_790_000_000;

function response(
  status: number,
  body: string | null = null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

function expectCliError(code: string): (error: unknown) => boolean {
  return (error) => (error as CliError).code === code;
}

test('a 200 parses JSON and surfaces the validators', async () => {
  const client = new GitHubClient({
    fetchImpl: async () =>
      response(200, JSON.stringify([{ id: 1 }]), {
        etag: 'W/"a"',
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
        'x-ratelimit-reset': String(RESET_SECONDS),
      }),
  });

  const result = await client.get(URL);
  assert.equal(result.status, 200);
  assert.equal(result.notModified, false);
  assert.deepEqual(result.payload, [{ id: 1 }]);
  assert.equal(result.etag, 'W/"a"');
  assert.equal(result.rateLimit.remaining, 59);
});

test('a 304 reports not modified with no payload', async () => {
  const client = new GitHubClient({
    fetchImpl: async () => response(304, null, { etag: 'W/"a"' }),
  });
  const result = await client.get(URL, { ifNoneMatch: 'W/"a"' });
  assert.equal(result.status, 304);
  assert.equal(result.notModified, true);
  assert.equal(result.payload, undefined);
});

test('a 404 is returned so the caller can record a subject error', async () => {
  const client = new GitHubClient({
    fetchImpl: async () => response(404, '{"message":"Not Found"}'),
  });
  const result = await client.get(URL);
  assert.equal(result.status, 404);
  assert.equal(result.notModified, false);
});

test('a 5xx is retried with exponential backoff before succeeding', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new GitHubClient({
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2 ? response(500) : response(200, '[]');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    maxRetries: 3,
  });

  const result = await client.get(URL);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.deepEqual(result.payload, []);
});

test('an exhausting 5xx throws http_error', async () => {
  const client = new GitHubClient({
    fetchImpl: async () => response(503),
    sleep: async () => undefined,
    maxRetries: 2,
  });
  await assert.rejects(client.get(URL), expectCliError('http_error'));
});

test('primary rate-limit exhaustion throws rate_limited with the reset time', async () => {
  let calls = 0;
  const client = new GitHubClient({
    fetchImpl: async () => {
      calls += 1;
      return response(403, '{"message":"API rate limit exceeded"}', {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(RESET_SECONDS),
      });
    },
    sleep: async () => undefined,
  });

  const error = await client.get(URL).then(
    () => null,
    (caught: unknown) => caught as CliError,
  );
  assert.equal(error?.code, 'rate_limited');
  assert.equal(error?.exitCode, 3);
  assert.deepEqual(error?.details, { resumeAfter: new Date(RESET_SECONDS * 1000).toISOString() });
  assert.equal(client.lastRateLimit?.remaining, 0);
  assert.equal(client.lastRateLimit?.resetAt, new Date(RESET_SECONDS * 1000).toISOString());
  assert.equal(calls, 1, 'primary exhaustion must not be retried in the same run');
});

test('a 429 honors Retry-After and retries', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new GitHubClient({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(429, null, { 'retry-after': '2' }) : response(200, '[]');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await client.get(URL);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(result.payload, []);
});

test('a persistent 429 throws rate_limited', async () => {
  const client = new GitHubClient({
    fetchImpl: async () => response(429, null, { 'retry-after': '1' }),
    sleep: async () => undefined,
    maxRetries: 0,
  });
  await assert.rejects(client.get(URL), expectCliError('rate_limited'));
});

test('malformed JSON throws http_error', async () => {
  const client = new GitHubClient({ fetchImpl: async () => response(200, 'this is not json') });
  await assert.rejects(client.get(URL), expectCliError('http_error'));
});

test('network errors retry then throw network', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new GitHubClient({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    maxRetries: 1,
  });

  await assert.rejects(client.get(URL), expectCliError('network'));
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test('a request that exceeds the timeout is aborted and reported', async () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  const client = new GitHubClient({ fetchImpl: hanging, timeoutMs: 5, maxRetries: 0 });

  await assert.rejects(client.get(URL), /timed out/);
});

test('the timeout also covers reading the response body', async () => {
  const client = new GitHubClient({
    fetchImpl: async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('['));
          // Headers arrived, the body never closes. A real fetch aborts the
          // body when the request signal fires; mirror that here.
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    },
    timeoutMs: 10,
    maxRetries: 0,
  });

  await assert.rejects(client.get(URL), /timed out/);
});

test('refuses requests outside the configured API origin', async () => {
  let calls = 0;
  const client = new GitHubClient({
    token: 'secret-token',
    fetchImpl: async () => {
      calls += 1;
      return response(200, '[]');
    },
  });

  await assert.rejects(client.get('https://evil.example/steal'), expectCliError('refused_url'));
  assert.equal(calls, 0, 'the foreign URL must not reach fetch');
});

test('refuses a redirect that lands outside the configured API origin', async () => {
  const seen: string[] = [];
  const client = new GitHubClient({
    token: 'secret-token',
    fetchImpl: async (url, init) => {
      seen.push(url);
      assert.equal(init?.redirect, 'manual');
      assert.equal(
        (init?.headers as Record<string, string> | undefined)?.authorization,
        'Bearer secret-token',
      );
      return response(302, null, { location: 'https://evil.example/steal' });
    },
  });

  await assert.rejects(client.get(URL), expectCliError('refused_url'));
  assert.deepEqual(seen, [URL]);
});

test('follows a same-origin redirect before reading the body', async () => {
  const seen: string[] = [];
  const next = 'https://api.github.com/repositories/1';
  const client = new GitHubClient({
    token: 'secret-token',
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === URL) {
        return response(301, null, { location: '/repositories/1' });
      }
      return response(200, JSON.stringify({ id: 1 }));
    },
  });

  const result = await client.get(URL);
  assert.equal(result.status, 200);
  assert.equal(result.url, URL);
  assert.deepEqual(result.payload, { id: 1 });
  assert.deepEqual(seen, [URL, next]);
});

test('sends the required headers, token, and conditional validator', async () => {
  let seen: Record<string, string> = {};
  const client = new GitHubClient({
    token: 'secret-token',
    userAgent: 'gh-track/0.1.0',
    fetchImpl: async (_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return response(200, '{}');
    },
  });

  await client.get(URL, { ifNoneMatch: 'W/"a"' });
  assert.equal(seen.authorization, 'Bearer secret-token');
  assert.equal(seen['user-agent'], 'gh-track/0.1.0');
  assert.equal(seen.accept, 'application/vnd.github+json');
  assert.equal(seen['x-github-api-version'], '2022-11-28');
  assert.equal(seen['if-none-match'], 'W/"a"');
});

test('parses Link headers and falls back to short-page detection', () => {
  const header = `<${URL.replace('page=1', 'page=2')}>; rel="next", <${URL.replace('page=1', 'page=5')}>; rel="last"`;
  assert.equal(nextPageUrl(header), URL.replace('page=1', 'page=2'));
  assert.deepEqual([...parseLinkHeader(header).keys()], ['next', 'last']);
  assert.equal(nextPageUrl(null), null);
  assert.equal(hasNextPage(null, 100, 100), true);
  assert.equal(hasNextPage(null, 3, 100), false);
  assert.equal(hasNextPage(header, 0, 100), true);
});
