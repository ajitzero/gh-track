/** `gh-track fetch`: planning, `--dry-run`, live runs, and `--resume`. */

import { defaultConfig, defaultDefaults, loadConfig } from '../config.js';
import {
  emptyWatchlist,
  httpError,
  runNotFound,
  UsageError,
  toCliError,
} from '../errors.js';
import {
  GITHUB_API_BASE,
  hasNextPage,
  nextPageUrl,
  GitHubClient,
  MAX_PAGES,
} from '../github/client.js';
import { etagFor, parseEtagCache, recordEtag, resolveNotModified, type EtagCache } from '../github/etag.js';
import {
  effectiveMaxRequests,
  parseRateLimitState,
  quotaDerivedCap,
  stateFromInfo,
  type RateLimitHeaders,
} from '../github/rateLimit.js';
import { FOLLOWERS_PER_PAGE, followersUrl } from '../github/resources/followers.js';
import { REPOS_PER_PAGE, reposUrl } from '../github/resources/repos.js';
import { repoUrl } from '../github/resources/repo.js';
import { renderTable } from '../output/table.js';
import { runCompaction } from '../store/compact.js';
import { createManifest, readManifest } from '../store/manifest.js';
import {
  accountRepoPath,
  cleanupTempRuns,
  createRunWriter,
  followerPagePath,
  openRunWriter,
  repoPagePath,
  standaloneRepoPath,
  type RunWriter,
} from '../store/runWriter.js';
import { acquireLock } from '../store/lock.js';
import { latestPartialRun, readRunPayload } from '../store/runs.js';
import { readStateJson, STATE_ETAGS_FILE, STATE_LIMITS_FILE, writeStateJson } from '../store/state.js';
import { formatRunId } from '../store/paths.js';
import { parseSubject, subjectKey } from '../subjects.js';
import { VERSION } from '../version.js';
import type {
  CommandContext,
  CommandResult,
  CompactionResult,
  Config,
  ConfigSubject,
  Manifest,
  ManifestRequestEntry,
  PendingRequest,
  Resource,
  SubjectType,
} from '../types.js';

/** A subject reduced to what planning needs. */
export interface PlanSubject {
  subject: string;
  type: SubjectType;
  resources: Resource[];
  account?: string | undefined;
  repo?: string | undefined;
}

export interface PlannedRequest {
  subject: string;
  resource: Resource;
  url: string;
  page: number;
  conditional: boolean;
}

export interface FetchPlan {
  requests: PlannedRequest[];
  estimatedRequests: number;
}

const USER_DEFAULT_RESOURCES: readonly Resource[] = ['followers', 'repos'];
const REPO_DEFAULT_RESOURCES: readonly Resource[] = ['repo'];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function toPlanSubject(subject: ConfigSubject): PlanSubject {
  if (subject.type === 'user') {
    return {
      subject: subject.subject,
      type: 'user',
      account: subject.account,
      resources: [...subject.resources],
    };
  }
  return {
    subject: subject.subject,
    type: 'repo',
    repo: subject.repo,
    resources: ['repo'],
  };
}

/**
 * Page URLs known from the ETag cache, keyed by page number. URLs are compared
 * by origin, path, and every query parameter except `page`, so link-provided
 * URLs with different parameter order still count. Entries are also matched by
 * their stored source path, because GitHub's Link header can use a canonical
 * path (`/user/<id>/followers`) that differs from the URL we build.
 */
function knownPages(
  cache: EtagCache,
  urlForPage: (page: number) => string,
  pagePathFor: (page: number) => string,
): Map<number, string> {
  const pages = new Map<number, string>();
  let first: URL;
  try {
    first = new URL(urlForPage(1));
  } catch {
    return pages;
  }

  const fixedParams = new Map<string, string>();
  for (const [key, value] of first.searchParams) {
    if (key !== 'page') {
      fixedParams.set(key, value);
    }
  }

  const pageSuffix = /page-\d+\.json$/;
  const firstPath = pagePathFor(1);
  const pagePathPrefix = pageSuffix.test(firstPath)
    ? firstPath.replace(pageSuffix, 'page-')
    : null;

  for (const [url, entry] of Object.entries(cache)) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }

    if (parsed !== null && parsed.origin === first.origin && parsed.pathname === first.pathname) {
      let matches = true;
      for (const [key, value] of fixedParams) {
        if (parsed.searchParams.get(key) !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        const page = Number(parsed.searchParams.get('page'));
        if (Number.isInteger(page) && page >= 1) {
          pages.set(page, url);
        }
      }
    }

    // The source path is independent of the URL GitHub chose for the page.
    const sourcePath = entry.sourcePath;
    if (
      pagePathPrefix !== null &&
      sourcePath !== undefined &&
      sourcePath.startsWith(pagePathPrefix) &&
      sourcePath.endsWith('.json')
    ) {
      const sourcePage = Number(sourcePath.slice(pagePathPrefix.length, -'.json'.length));
      if (Number.isInteger(sourcePage) && sourcePage >= 1) {
        pages.set(sourcePage, url);
      }
    }
  }
  return pages;
}

function addPaginated(
  requests: PlannedRequest[],
  cache: EtagCache,
  subject: string,
  resource: Resource,
  urlForPage: (page: number) => string,
): void {
  const login = subjectLogin(subject);
  const pagePathFor: (page: number) => string =
    resource === 'followers'
      ? (page) => followerPagePath(login, page)
      : (page) => repoPagePath(login, page);

  const pages = knownPages(cache, urlForPage, pagePathFor);
  let max = 1;
  for (const page of pages.keys()) {
    if (page > max) {
      max = page;
    }
  }

  for (let page = 1; page <= max; page += 1) {
    const url = pages.get(page) ?? urlForPage(page);
    requests.push({ subject, resource, url, page, conditional: etagFor(cache, url) !== undefined });
  }
}

/** Builds the ordered request plan for a set of subjects. */
export function buildFetchPlan(
  subjects: readonly PlanSubject[],
  cache: EtagCache,
  apiBase: string = GITHUB_API_BASE,
): FetchPlan {
  const requests: PlannedRequest[] = [];

  for (const subject of subjects) {
    for (const resource of subject.resources) {
      if (subject.type === 'user' && resource === 'followers') {
        const login = subject.account;
        if (login === undefined) {
          continue;
        }
        addPaginated(requests, cache, subject.subject, 'followers', (page) =>
          followersUrl(apiBase, login, page),
        );
      } else if (subject.type === 'user' && resource === 'repos') {
        const login = subject.account;
        if (login === undefined) {
          continue;
        }
        addPaginated(requests, cache, subject.subject, 'repos', (page) =>
          reposUrl(apiBase, login, page),
        );
      } else if (subject.type === 'repo' && resource === 'repo') {
        const repo = subject.repo;
        if (repo === undefined) {
          continue;
        }
        const url = repoUrl(apiBase, repo);
        requests.push({
          subject: subject.subject,
          resource: 'repo',
          url,
          page: 1,
          conditional: etagFor(cache, url) !== undefined,
        });
      }
    }
  }

  return { requests, estimatedRequests: requests.length };
}

interface ResolvedSubjects {
  subjects: PlanSubject[];
  warnings: string[];
  config: Config | null;
}

async function resolveSubjects(
  context: CommandContext,
  args: readonly string[],
): Promise<ResolvedSubjects> {
  const loaded = await loadConfig(context.paths.configPath, { required: args.length === 0 });
  const warnings = loaded === null ? [] : [...loaded.warnings];

  if (args.length === 0) {
    if (loaded === null) {
      throw emptyWatchlist();
    }
    if (loaded.config.subjects.length === 0) {
      throw emptyWatchlist();
    }
    return { subjects: loaded.config.subjects.map(toPlanSubject), warnings, config: loaded.config };
  }

  const configured = new Map<string, ConfigSubject>();
  for (const subject of loaded?.config.subjects ?? []) {
    configured.set(subjectKey(subject), subject);
  }

  const subjects: PlanSubject[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const parsed = parseSubject(arg);
    const key = subjectKey(parsed);
    if (seen.has(key)) {
      warnings.push(`Duplicate subject ${parsed.subject}; ignoring the repeat.`);
      continue;
    }
    seen.add(key);

    const match = configured.get(key);
    if (match !== undefined) {
      subjects.push(toPlanSubject(match));
      continue;
    }
    subjects.push(
      parsed.type === 'user'
        ? {
            subject: parsed.subject,
            type: 'user',
            account: parsed.account,
            resources: [...USER_DEFAULT_RESOURCES],
          }
        : {
            subject: parsed.subject,
            type: 'repo',
            repo: parsed.repo,
            resources: [...REPO_DEFAULT_RESOURCES],
          },
    );
  }

  return { subjects, warnings, config: loaded?.config ?? null };
}

function resolveToken(context: CommandContext, tokenEnv: string): string | undefined {
  const explicit = context.options.get('token');
  if (explicit !== undefined) {
    return explicit;
  }
  if (tokenEnv.length === 0) {
    return undefined;
  }
  const fromEnv = context.env[tokenEnv];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

function parseMaxRequests(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError('--max-requests must be a positive integer.');
  }
  return value;
}

function parseKeepRawDays(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError('--keep-raw-days must be a positive integer.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

function renderPlanText(plan: FetchPlan, cap: number): string {
  if (plan.requests.length === 0) {
    return `Dry run: no requests planned; effective cap ${cap}.\n`;
  }
  const table = renderTable(
    ['SUBJECT', 'RESOURCE', 'PAGE', 'CONDITIONAL'],
    plan.requests.map((request) => [
      request.subject,
      request.resource,
      String(request.page),
      request.conditional ? 'yes' : 'no',
    ]),
  );
  return `Dry run: ${plan.requests.length} request(s) planned; effective cap ${cap}.\n\n${table}\n`;
}

async function runDryRun(context: CommandContext): Promise<CommandResult> {
  if (context.options.has('resume')) {
    throw new UsageError('--dry-run cannot be combined with --resume.');
  }

  const override = parseMaxRequests(context.options.get('max-requests'));
  const { subjects, warnings, config } = await resolveSubjects(context, context.positionals);

  const cache = parseEtagCache(await readStateJson(context.paths.dataDir, STATE_ETAGS_FILE));
  const plan = buildFetchPlan(subjects, cache, GITHUB_API_BASE);

  const limits = parseRateLimitState(await readStateJson(context.paths.dataDir, STATE_LIMITS_FILE));
  const tokenEnv = config?.defaults.tokenEnv ?? defaultDefaults().tokenEnv;
  const hasToken = resolveToken(context, tokenEnv) !== undefined;
  const nowMs = Date.now();
  const quota = quotaDerivedCap(limits, hasToken, nowMs);
  const cap = effectiveMaxRequests(limits, { hasToken, nowMs, override });
  if (override !== undefined && override > quota) {
    warnings.push(`--max-requests ${override} exceeds the quota-derived cap ${quota}; using ${quota}.`);
  }

  return {
    json: {
      dryRun: true,
      effectiveMaxRequests: cap,
      estimatedRequests: plan.estimatedRequests,
      plan: plan.requests,
    },
    text: renderPlanText(plan, cap),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

function subjectLogin(subject: string): string {
  return subject.slice('user:'.length);
}

function subjectRepo(subject: string): string {
  return subject.slice('repo:'.length);
}

function payloadPathFor(request: PendingRequest): string {
  if (request.resource === 'followers') {
    return followerPagePath(subjectLogin(request.subject), request.page);
  }
  if (request.resource === 'repos') {
    return repoPagePath(subjectLogin(request.subject), request.page);
  }
  return standaloneRepoPath(subjectRepo(request.subject));
}

function nextRequestFor(
  request: PendingRequest,
  link: string | null,
  itemCount: number,
  apiBase: string,
): PendingRequest | null {
  if (request.resource === 'followers' || request.resource === 'repos') {
    // Spec §9: never follow more than MAX_PAGES pages for one resource.
    if (request.page >= MAX_PAGES) {
      return null;
    }
    const perPage = request.resource === 'followers' ? FOLLOWERS_PER_PAGE : REPOS_PER_PAGE;
    if (!hasNextPage(link, itemCount, perPage)) {
      return null;
    }
    const login = subjectLogin(request.subject);
    const url =
      nextPageUrl(link) ??
      (request.resource === 'followers'
        ? followersUrl(apiBase, login, request.page + 1)
        : reposUrl(apiBase, login, request.page + 1));
    return { subject: request.subject, resource: request.resource, url, page: request.page + 1 };
  }
  return null;
}

function pageKey(request: PendingRequest): string {
  return `${request.subject}\u0000${request.resource}\u0000${request.page}`;
}

function dedupePending(requests: readonly PendingRequest[]): PendingRequest[] {
  const seen = new Set<string>();
  const pending: PendingRequest[] = [];
  for (const request of requests) {
    if (seen.has(request.url)) {
      continue;
    }
    seen.add(request.url);
    pending.push(request);
  }
  return pending;
}

async function expandRepos(writer: RunWriter, login: string, payload: unknown): Promise<void> {
  if (!Array.isArray(payload)) {
    return;
  }
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const fullName = (entry as { full_name?: unknown }).full_name;
    if (typeof fullName === 'string' && fullName.length > 0) {
      await writer.writePayload(accountRepoPath(login, fullName), entry);
    }
  }
}

async function recountStats(writer: RunWriter, manifest: Manifest): Promise<void> {
  let repos = 0;
  let followers = 0;
  let notModified = 0;
  for (const entry of manifest.requests) {
    if (entry.status === 304) {
      notModified += 1;
    }
    if (entry.path === undefined) {
      continue;
    }
    if (entry.resource === 'repo') {
      repos += 1;
      continue;
    }
    if (entry.resource === 'followers' || entry.resource === 'repos') {
      let payload: unknown = null;
      try {
        payload = await writer.readPayload(entry.path);
      } catch {
        payload = null;
      }
      if (Array.isArray(payload)) {
        if (entry.resource === 'followers') {
          followers += payload.length;
        } else {
          repos += payload.length;
        }
      }
    }
  }
  manifest.stats = { repos, followers, requests: manifest.requests.length, notModified };
}

interface RunOutcome {
  manifest: Manifest;
  interrupted: boolean;
  resumeAfter: string | null;
}

async function executeRun(
  context: CommandContext,
  writer: RunWriter,
  manifest: Manifest,
  queue: readonly PendingRequest[],
  config: Config,
  token: string | undefined,
  warnings: string[],
): Promise<RunOutcome> {
  const dataDir = context.paths.dataDir;
  const cache = parseEtagCache(await readStateJson(dataDir, STATE_ETAGS_FILE));
  const limits = parseRateLimitState(await readStateJson(dataDir, STATE_LIMITS_FILE));
  const override = parseMaxRequests(context.options.get('max-requests'));
  const nowMs = Date.now();
  const quota = quotaDerivedCap(limits, token !== undefined, nowMs);
  const cap = effectiveMaxRequests(limits, { hasToken: token !== undefined, nowMs, override });
  if (override !== undefined && override > quota) {
    warnings.push(`--max-requests ${override} exceeds the quota-derived cap ${quota}; using ${quota}.`);
  }

  const client = new GitHubClient({
    token,
    timeoutMs: config.defaults.requestTimeoutMs,
    maxRetries: config.defaults.maxRetries,
    userAgent: `gh-track/${VERSION}`,
    fetchImpl: context.fetchImpl,
    sleep: context.sleepImpl,
    onDiagnostic: (message) => {
      if (context.verbose) {
        warnings.push(message);
      }
    },
  });

  const pendingQueue: PendingRequest[] = [...queue];
  const scheduled = new Set<string>(pendingQueue.map((request) => pageKey(request)));
  const processed = new Set<string>();
  const failed: PendingRequest[] = [];
  let lastRateLimit: RateLimitHeaders | null = null;
  let stopped: 'cap' | 'rate' | 'interrupt' | null = null;
  let resumeAfter: string | null = null;
  let made = 0;

  const enqueueNextPage = (
    request: PendingRequest,
    link: string | null,
    itemCount: number,
  ): void => {
    const next = nextRequestFor(request, link, itemCount, client.apiBase);
    if (next === null) {
      return;
    }
    const key = pageKey(next);
    if (!scheduled.has(key)) {
      scheduled.add(key);
      pendingQueue.push(next);
    }
  };

  while (pendingQueue.length > 0) {
    if (context.signal?.aborted === true) {
      stopped = 'interrupt';
      break;
    }
    if (made >= cap) {
      stopped = 'cap';
      break;
    }

    const request = pendingQueue.shift();
    if (request === undefined) {
      break;
    }
    if (processed.has(request.url)) {
      continue;
    }
    processed.add(request.url);
    made += 1;

    // A resumed request that succeeds replaces any error recorded earlier.
    manifest.errors = manifest.errors.filter((entry) => entry.url !== request.url);

    const cachedEtag = cache[request.url]?.etag ?? null;

    try {
      const response = await client.get(request.url, {
        ifNoneMatch: cachedEtag,
        signal: context.signal,
      });
      lastRateLimit = response.rateLimit;
      const checkedAt = new Date().toISOString();
      const relativePath = payloadPathFor(request);

      if (response.status === 304) {
        const entry = cache[request.url];
        if (entry === undefined) {
          throw httpError(304, `Received 304 without a cached validator: ${request.url}`, {
            url: request.url,
          });
        }
        const resolved = await resolveNotModified(entry, (runId, relativePath2) =>
          readRunPayload(dataDir, runId, relativePath2),
        );
        await writer.writePayload(relativePath, resolved.payload);
        if (request.resource === 'repos') {
          await expandRepos(writer, subjectLogin(request.subject), resolved.payload);
        }
        manifest.requests.push({
          subject: request.subject,
          resource: request.resource,
          url: request.url,
          page: request.page,
          status: 304,
          etag: entry.etag,
          path: relativePath,
          sourceRun: resolved.sourceRun,
          sourcePath: resolved.sourcePath,
        });
        recordEtag(cache, request.url, {
          etag: entry.etag,
          lastModified: entry.lastModified ?? null,
          status: 304,
          checkedAt,
          sourceRun: writer.id,
          sourcePath: relativePath,
        });

        // A 304 has no body, so pagination continues from the copied payload.
        // Without this, a full unchanged page 1 would hide every later page.
        enqueueNextPage(
          request,
          response.link,
          Array.isArray(resolved.payload) ? resolved.payload.length : 0,
        );
      } else if (response.status === 200) {
        const payload = response.payload ?? null;
        await writer.writePayload(relativePath, payload);
        if (request.resource === 'repos') {
          await expandRepos(writer, subjectLogin(request.subject), payload);
        }
        const entry: ManifestRequestEntry = {
          subject: request.subject,
          resource: request.resource,
          url: request.url,
          page: request.page,
          status: 200,
          path: relativePath,
        };
        if (response.etag !== null) {
          entry.etag = response.etag;
          recordEtag(cache, request.url, {
            etag: response.etag,
            lastModified: response.lastModified,
            status: 200,
            checkedAt,
            sourceRun: writer.id,
            sourcePath: relativePath,
          });
        } else {
          delete cache[request.url];
        }
        manifest.requests.push(entry);

        const itemCount = Array.isArray(payload) ? payload.length : 0;
        enqueueNextPage(request, response.link, itemCount);
      } else if (response.status === 404) {
        manifest.errors.push({
          subject: request.subject,
          resource: request.resource,
          url: request.url,
          status: 404,
          code: 'http_error',
          message: 'Not Found',
        });
      }
    } catch (error) {
      const cliError = toCliError(error);
      if (cliError.code === 'interrupted') {
        pendingQueue.unshift(request);
        stopped = 'interrupt';
        break;
      }
      if (cliError.code === 'rate_limited') {
        const detail = cliError.details?.resumeAfter;
        resumeAfter = typeof detail === 'string' ? detail : null;
        pendingQueue.unshift(request);
        stopped = 'rate';
        break;
      }
      manifest.errors.push({
        subject: request.subject,
        resource: request.resource,
        url: request.url,
        status: typeof cliError.details?.status === 'number' ? cliError.details.status : 0,
        code: cliError.code,
        message: cliError.message,
      });
      failed.push(request);
    }
  }

  manifest.status = stopped === null && failed.length === 0 ? 'complete' : 'partial';
  manifest.pending = dedupePending([...failed, ...pendingQueue]);
  manifest.finishedAt = new Date().toISOString();

  await recountStats(writer, manifest);
  await writer.writeManifest(manifest);
  await writer.promote();

  await writeStateJson(dataDir, STATE_ETAGS_FILE, cache);
  if (lastRateLimit !== null) {
    const state = stateFromInfo(lastRateLimit, new Date().toISOString());
    if (state !== null) {
      await writeStateJson(dataDir, STATE_LIMITS_FILE, state);
    }
  }

  return { manifest, interrupted: stopped === 'interrupt', resumeAfter };
}

function runSummary(manifest: Manifest): Record<string, unknown> {
  return {
    id: manifest.id,
    status: manifest.status,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    stats: manifest.stats,
  };
}

function buildRunResult(
  outcome: RunOutcome,
  warnings: string[],
  compaction: CompactionResult | null,
): CommandResult {
  const { manifest } = outcome;
  const complete = manifest.status === 'complete';

  const json = complete
    ? {
        run: runSummary(manifest),
        compaction: {
          compactedDays: compaction?.compacted.length ?? 0,
          prunedRuns: compaction?.pruned.length ?? 0,
        },
        pending: [],
        resumeAfter: null,
      }
    : {
        run: runSummary(manifest),
        compaction: null,
        pending: manifest.pending,
        resumeAfter: outcome.resumeAfter,
      };

  const stats = manifest.stats;
  let text: string;
  if (complete) {
    text = `Run ${manifest.id} complete: ${stats.requests} request(s), ${stats.notModified} not modified; ${stats.repos} repo(s), ${stats.followers} follower(s).\n`;
    if (compaction !== null && (compaction.compacted.length > 0 || compaction.pruned.length > 0)) {
      text += `Compacted ${compaction.compacted.length} day(s); pruned ${compaction.pruned.length} run(s).\n`;
    }
  } else {
    text = `Run ${manifest.id} ${manifest.status}: ${manifest.pending.length} pending. Resume with 'gh-track fetch --resume ${manifest.id}'.\n`;
    if (outcome.resumeAfter !== null) {
      text += `Rate limit exhausted; resume after ${outcome.resumeAfter}.\n`;
    }
  }

  const exitCode = complete ? 0 : outcome.interrupted ? 130 : 3;
  return { json, text, warnings, exitCode };
}

async function runLive(
  context: CommandContext,
  keepRawDays: number | undefined,
): Promise<CommandResult> {
  const resumeRequested = context.options.has('resume');
  const resumeValue = context.options.get('resume') ?? '';
  const warnings: string[] = [];

  const loaded = await loadConfig(context.paths.configPath, { required: false });
  const config = loaded?.config ?? defaultConfig();
  if (loaded !== null) {
    warnings.push(...loaded.warnings);
  }
  const token = resolveToken(context, config.defaults.tokenEnv);

  const lock = await acquireLock(context.paths.dataDir);
  try {
    let writer: RunWriter;
    let manifest: Manifest;
    let queue: PendingRequest[];

    if (resumeRequested) {
      const existing =
        resumeValue === ''
          ? await latestPartialRun(context.paths.dataDir)
          : await readManifest(context.paths.dataDir, resumeValue);
      if (existing === null) {
        throw runNotFound(resumeValue === '' ? 'latest partial' : resumeValue);
      }
      if (existing.status !== 'partial') {
        throw new UsageError(
          `Run ${existing.id} is ${existing.status}; only partial runs can be resumed.`,
        );
      }
      if (context.positionals.length > 0) {
        warnings.push('Subject arguments are ignored with --resume; using the run pending list.');
      }
      manifest = existing;
      queue = dedupePending(existing.pending);
      writer = await openRunWriter(context.paths.dataDir, existing.id);
    } else {
      const resolved = await resolveSubjects(context, context.positionals);
      warnings.push(...resolved.warnings);
      await cleanupTempRuns(context.paths.dataDir);

      const startedAt = new Date();
      const id = formatRunId(startedAt);
      manifest = createManifest(
        id,
        startedAt.toISOString(),
        resolved.subjects.map((subject) => ({
          subject: subject.subject,
          resources: [...subject.resources],
        })),
      );
      writer = await createRunWriter(context.paths.dataDir, id);

      const cache = parseEtagCache(
        await readStateJson(context.paths.dataDir, STATE_ETAGS_FILE),
      );
      const plan = buildFetchPlan(resolved.subjects, cache, GITHUB_API_BASE);
      queue = dedupePending(
        plan.requests.map((request) => ({
          subject: request.subject,
          resource: request.resource,
          url: request.url,
          page: request.page,
        })),
      );
    }

    try {
      const outcome = await executeRun(context, writer, manifest, queue, config, token, warnings);

      let compaction: CompactionResult | null = null;
      if (outcome.manifest.status === 'complete' && !context.options.has('no-compact')) {
        compaction = await runCompaction(context.paths.dataDir, {
          keepDays: keepRawDays ?? config.defaults.rawRetentionDays,
          now: new Date(),
        });
      }
      return buildRunResult(outcome, warnings, compaction);
    } catch (error) {
      await writer.discard();
      throw error;
    }
  } finally {
    await lock.release();
  }
}

export async function runFetch(context: CommandContext): Promise<CommandResult> {
  const keepRawDays = parseKeepRawDays(context.options.get('keep-raw-days'));
  if (context.options.has('dry-run')) {
    return runDryRun(context);
  }
  return runLive(context, keepRawDays);
}
