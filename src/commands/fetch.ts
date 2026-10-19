/** `gh-track fetch`: request planning and `--dry-run` output. */

import { defaultDefaults, loadConfig } from '../config.js';
import { emptyWatchlist, notImplemented, UsageError } from '../errors.js';
import { etagFor, parseEtagCache, type EtagCache } from '../github/etag.js';
import { GITHUB_API_BASE } from '../github/client.js';
import {
  effectiveMaxRequests,
  parseRateLimitState,
  quotaDerivedCap,
} from '../github/rateLimit.js';
import { followersUrl } from '../github/resources/followers.js';
import { repoUrl } from '../github/resources/repo.js';
import { reposUrl } from '../github/resources/repos.js';
import { renderTable } from '../output/table.js';
import { readStateJson, STATE_ETAGS_FILE, STATE_LIMITS_FILE } from '../store/state.js';
import { parseSubject, subjectKey } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  ConfigSubject,
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
 * Highest page number seen in the ETag cache for a paginated resource. Page 1
 * is the floor when the resource has never been fetched.
 */
function knownPageCount(cache: EtagCache, urlForPage: (page: number) => string): number {
  const prefix = urlForPage(1).replace(/page=1$/, 'page=');
  let max = 0;
  for (const url of Object.keys(cache)) {
    if (!url.startsWith(prefix)) {
      continue;
    }
    const page = Number(url.slice(prefix.length));
    if (Number.isInteger(page) && page >= 1 && page > max) {
      max = page;
    }
  }
  return max >= 1 ? max : 1;
}

function addPaginated(
  requests: PlannedRequest[],
  cache: EtagCache,
  subject: string,
  resource: Resource,
  urlForPage: (page: number) => string,
): void {
  const pages = knownPageCount(cache, urlForPage);
  for (let page = 1; page <= pages; page += 1) {
    const url = urlForPage(page);
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
  config: Awaited<ReturnType<typeof loadConfig>>;
}

async function resolveSubjects(
  context: CommandContext,
  args: readonly string[],
): Promise<ResolvedSubjects> {
  const loaded = await loadConfig(context.paths.configPath, { required: args.length === 0 });
  const warnings = loaded === null ? [] : [...loaded.warnings];

  if (args.length === 0) {
    if (loaded === null) {
      // `required: true` already threw config_missing; this keeps types honest.
      throw emptyWatchlist();
    }
    if (loaded.config.subjects.length === 0) {
      throw emptyWatchlist();
    }
    return { subjects: loaded.config.subjects.map(toPlanSubject), warnings, config: loaded };
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

  return { subjects, warnings, config: loaded };
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

export async function runFetch(context: CommandContext): Promise<CommandResult> {
  const dryRun = context.options.has('dry-run');

  if (!dryRun) {
    // The run writer, manifests, and resume land in M3.
    throw notImplemented('fetch', 3);
  }

  if (context.options.has('resume')) {
    throw new UsageError('--dry-run cannot be combined with --resume.');
  }

  const override = parseMaxRequests(context.options.get('max-requests'));
  const { subjects, warnings, config } = await resolveSubjects(context, context.positionals);

  const cache = parseEtagCache(await readStateJson(context.paths.dataDir, STATE_ETAGS_FILE));
  const plan = buildFetchPlan(subjects, cache, GITHUB_API_BASE);

  const limits = parseRateLimitState(await readStateJson(context.paths.dataDir, STATE_LIMITS_FILE));
  const tokenEnv = config?.config.defaults.tokenEnv ?? defaultDefaults().tokenEnv;
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
