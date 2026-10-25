/** HTTP client for the GitHub REST API: headers, auth, timeout, retries, pagination. */

import { httpError, interrupted, networkError, rateLimited, refusedUrl } from '../errors.js';
import { errorMessage } from '../guards.js';
import { parseRateLimitHeaders, type RateLimitHeaders } from './rateLimit.js';

export const GITHUB_API_BASE = 'https://api.github.com';

/** Runaway-page guard from spec §9. */
export const MAX_PAGES = 1000;

/** Same-origin redirect hops followed before a request is treated as failed. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const API_VERSION = '2022-11-28';
const ACCEPT = 'application/vnd.github+json';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubResponse {
  url: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  link: string | null;
  rateLimit: RateLimitHeaders;
  notModified: boolean;
  payload?: unknown;
}

export interface GitHubClientOptions {
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  userAgent?: string | undefined;
  apiBase?: string | undefined;
  /** Verbose diagnostics; never receives credentials. */
  onDiagnostic?: ((message: string) => void) | undefined;
}

export interface RequestOptions {
  /** Sent as `If-None-Match` for conditional requests. */
  ifNoneMatch?: string | null | undefined;
  /** Aborting this signal stops the request and throws `interrupted`. */
  signal?: AbortSignal | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Resolves a redirect target against the URL that returned it. */
function resolveRedirect(current: string, location: string | null): string | null {
  if (location === null || location.trim().length === 0) {
    return null;
  }
  try {
    return new URL(location, current).href;
  } catch {
    return null;
  }
}

export class GitHubClient {
  readonly apiBase: string;

  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private lastRateLimitHeaders: RateLimitHeaders | null = null;

  constructor(options: GitHubClientOptions = {}) {
    this.apiBase = options.apiBase ?? GITHUB_API_BASE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.userAgent = options.userAgent ?? 'gh-track';
    this.onDiagnostic = options.onDiagnostic;
  }

  nowMs(): number {
    return this.now();
  }

  /** Headers from the most recent response, including failed responses. */
  get lastRateLimit(): RateLimitHeaders | null {
    return this.lastRateLimitHeaders;
  }

  /** True when `url` has the configured API origin. */
  isApiUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.apiBase).origin;
    } catch {
      return false;
    }
  }

  private buildHeaders(
    url: string,
    ifNoneMatch: string | null | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      accept: ACCEPT,
      'user-agent': this.userAgent,
      'x-github-api-version': API_VERSION,
    };
    // Never attach credentials to a URL supplied by a Link header on another
    // origin. `get` also refuses such requests before they reach fetch.
    if (this.token !== undefined && this.token.length > 0 && this.isApiUrl(url)) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (ifNoneMatch !== null && ifNoneMatch !== undefined) {
      headers['if-none-match'] = ifNoneMatch;
    }
    return headers;
  }

  private diagnostic(message: string): void {
    this.onDiagnostic?.(message);
  }

  private async backoff(attempt: number, retryAfterSeconds: number | null): Promise<void> {
    if (retryAfterSeconds !== null) {
      await this.sleep(Math.max(retryAfterSeconds * 1000, 1000));
      return;
    }
    const base = 500 * 2 ** (attempt - 1);
    const jitter = Math.floor(this.random() * base);
    await this.sleep(base + jitter);
  }

  /**
   * Performs one GET. Retries `5xx`, network errors, and secondary rate limits.
   * Primary rate-limit exhaustion throws `rate_limited`; `404` is returned so
   * the caller can record it as a subject error and continue.
   */
  async get(url: string, options: RequestOptions = {}): Promise<GitHubResponse> {
    if (!this.isApiUrl(url)) {
      throw refusedUrl(url, this.apiBase);
    }

    let currentUrl = url;
    let redirects = 0;
    let attempt = 0;

    for (;;) {
      if (isAborted(options.signal)) {
        throw interrupted();
      }

      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
      const bridgeAbort = (): void => {
        controller.abort();
      };
      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', bridgeAbort, { once: true });
      }
      const detach = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', bridgeAbort);
      };

      let response: Response;
      try {
        response = await this.fetchImpl(currentUrl, {
          method: 'GET',
          headers: this.buildHeaders(currentUrl, options.ifNoneMatch),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        detach();
        if (isAborted(options.signal)) {
          throw interrupted();
        }
        const timedOut = controller.signal.aborted;
        if (attempt <= this.maxRetries) {
          this.diagnostic(
            `retrying ${currentUrl} after ${timedOut ? 'timeout' : 'network error'} (attempt ${attempt})`,
          );
          await this.backoff(attempt, null);
          continue;
        }
        throw networkError(
          timedOut
            ? `Request timed out after ${this.timeoutMs} ms: ${currentUrl}`
            : `Network error for ${currentUrl}: ${errorMessage(error)}`,
          { url: currentUrl },
        );
      }

      // Keep the timeout and SIGINT bridge attached until the body has been
      // read. Headers alone do not make a response complete.
      try {
        // Follow same-origin redirects ourselves. `redirect: 'manual'` means
        // the token is never attached to a URL that has not passed `isApiUrl`.
        if (REDIRECT_STATUSES.has(response.status)) {
          if (response.body !== null) {
            await response.body.cancel().catch(() => undefined);
          }
          const next = resolveRedirect(currentUrl, response.headers.get('location'));
          if (next === null) {
            throw httpError(
              response.status,
              `GitHub redirect for ${currentUrl} had no Location header`,
              { url: currentUrl },
            );
          }
          if (!this.isApiUrl(next)) {
            throw refusedUrl(next, this.apiBase);
          }
          redirects += 1;
          if (redirects > MAX_REDIRECTS) {
            throw httpError(response.status, `Too many redirects for ${url}`, { url });
          }
          currentUrl = next;
          attempt -= 1;
          continue;
        }

        const rateLimit = parseRateLimitHeaders(response.headers);
        this.lastRateLimitHeaders = rateLimit;
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');
        const link = response.headers.get('link');
        const status = response.status;

        if (status === 304) {
          return { url, status, etag, lastModified, link, rateLimit, notModified: true };
        }

        if (status === 403) {
          if (rateLimit.remaining === 0) {
            throw rateLimited(rateLimit.resetAt ?? undefined);
          }
          if (rateLimit.retryAfterSeconds !== null && attempt <= this.maxRetries) {
            this.diagnostic(`retrying ${currentUrl} after HTTP 403 (attempt ${attempt})`);
            await this.backoff(attempt, rateLimit.retryAfterSeconds);
            continue;
          }
          throw httpError(403, `GitHub returned HTTP 403 for ${currentUrl}`, { url: currentUrl });
        }

        if (status === 429) {
          if (attempt <= this.maxRetries) {
            this.diagnostic(`retrying ${currentUrl} after HTTP 429 (attempt ${attempt})`);
            await this.backoff(attempt, rateLimit.retryAfterSeconds);
            continue;
          }
          throw rateLimited(rateLimit.resetAt ?? undefined);
        }

        if (status >= 500) {
          if (attempt <= this.maxRetries) {
            this.diagnostic(`retrying ${currentUrl} after HTTP ${status} (attempt ${attempt})`);
            await this.backoff(attempt, rateLimit.retryAfterSeconds);
            continue;
          }
          throw httpError(status, `GitHub returned HTTP ${status} for ${currentUrl}`, {
            url: currentUrl,
          });
        }

        if (status === 404) {
          return { url, status, etag, lastModified, link, rateLimit, notModified: false };
        }

        if (status >= 400) {
          throw httpError(status, `GitHub returned HTTP ${status} for ${currentUrl}`, {
            url: currentUrl,
          });
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          detach();
          if (isAborted(options.signal)) {
            throw interrupted();
          }
          const timedOut = controller.signal.aborted;
          if (attempt <= this.maxRetries) {
            this.diagnostic(
              `retrying ${currentUrl} after ${timedOut ? 'timeout' : 'network error'} while reading the body (attempt ${attempt})`,
            );
            await this.backoff(attempt, null);
            continue;
          }
          throw networkError(
            timedOut
              ? `Request timed out after ${this.timeoutMs} ms: ${currentUrl}`
              : `Network error for ${currentUrl}: ${errorMessage(error)}`,
            { url: currentUrl },
          );
        }

        let payload: unknown = null;
        if (text.length > 0) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw httpError(status, `Malformed JSON response for ${currentUrl}`, {
              url: currentUrl,
            });
          }
        }
        return { url, status, etag, lastModified, link, rateLimit, notModified: false, payload };
      } finally {
        detach();
      }
    }
  }
}

const LINK_ENTRY = /<([^>]*)>\s*;\s*rel="([^"]*)"/;

/** Parses a `Link` header into a map of `rel` to URL. */
export function parseLinkHeader(header: string | null): Map<string, string> {
  const links = new Map<string, string>();
  if (header === null || header.length === 0) {
    return links;
  }
  for (const segment of header.split(',')) {
    const match = LINK_ENTRY.exec(segment.trim());
    const url = match?.[1];
    const rel = match?.[2];
    if (url !== undefined && rel !== undefined) {
      links.set(rel, url);
    }
  }
  return links;
}

export function nextPageUrl(header: string | null): string | null {
  return parseLinkHeader(header).get('next') ?? null;
}

/**
 * Whether another page should be requested: a `rel="next"` link wins, and a
 * full page is treated as "maybe more" when the header is absent.
 */
export function hasNextPage(
  linkHeader: string | null,
  itemCount: number,
  perPage: number,
): boolean {
  return nextPageUrl(linkHeader) !== null || itemCount >= perPage;
}
