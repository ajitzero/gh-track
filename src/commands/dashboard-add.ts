/** `gh-track dashboard add`: add subjects to the dashboard and watchlist. */

import { unexpectedArgument } from '../cli-args.js';
import { defaultConfig, loadConfig, saveConfig } from '../config.js';
import { toConfigSubject } from '../config-edit.js';
import { sortTracking } from '../dashboard/select.js';
import { CliError, UsageError } from '../errors.js';
import { listUserRepos, type RepoListing } from '../github/repos-list.js';
import { createGitHubClient, resolveToken } from '../github/runtime.js';
import { errorMessage } from '../guards.js';
import { defaultMetricsFor, parseMetricList } from '../metrics.js';
import { USER_RESOURCES, parseResources } from '../resources.js';
import {
  parseExplicitSubject,
  parseSubject,
  subjectKey,
  subjectKeyOf,
  type ParsedSubject,
} from '../subjects.js';
import { cancelled, requirePrompt } from '../result.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  DashboardAddEntry,
  DashboardAddResult,
  Metric,
  Resource,
  SubjectChoice,
  SubjectType,
} from '../types.js';

const REPO_METRICS: readonly Metric[] = ['stars', 'forks'];

const ADD_USAGE =
  'gh-track dashboard add [user <login> | repo <owner/name> | repo <owner> | <subject>]';

interface PendingAdd {
  parsed: ParsedSubject;
  metrics: Metric[];
}

interface AppliedEntry extends DashboardAddEntry {
  changed: boolean;
}

function rejectRenderFlags(context: CommandContext): void {
  for (const name of ['view', 'subject', 'from', 'to', 'layout']) {
    if (context.options.has(name)) {
      throw new UsageError(`--${name} is only valid when rendering the dashboard.`);
    }
  }
}

function trackedMetrics(config: Config, subject: string): Metric[] | null {
  const key = subjectKeyOf(subject);
  const entry = config.tracking.find(
    (candidate) => subjectKeyOf(candidate.subject) === key,
  );
  return entry === undefined ? null : [...entry.metrics];
}

function metricsForRepo(
  config: Config,
  subject: string,
  override: readonly Metric[] | undefined,
): Metric[] {
  return override !== undefined
    ? [...override]
    : (trackedMetrics(config, subject) ?? defaultMetricsFor('repo'));
}

function promptCancelled(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

function repoChoice(config: Config, repo: RepoListing): SubjectChoice {
  const tracked = trackedMetrics(config, `repo:${repo.fullName}`);
  const hints: string[] = [];
  if (tracked !== null) {
    hints.push(`tracked: ${tracked.join(',')}`);
  } else {
    hints.push(`★ ${repo.stars}`);
  }
  if (repo.fork) {
    hints.push('fork');
  }
  if (repo.archived) {
    hints.push('archived');
  }
  return {
    value: repo.fullName,
    label: repo.fullName,
    hint: hints.join(' · '),
  };
}

async function askRepoMetrics(
  context: CommandContext,
  config: Config,
  subject: string,
  override: readonly Metric[] | undefined,
): Promise<Metric[] | null> {
  const metrics = await context.prompts.selectMetrics(
    subject,
    REPO_METRICS,
    metricsForRepo(config, subject, override),
  );
  if (metrics === null) {
    return null;
  }
  if (metrics.length === 0) {
    throw new UsageError('Select at least one metric.');
  }
  return parseMetricList(metrics.join(','), 'repo');
}

async function manualRepo(
  context: CommandContext,
  config: Config,
  metricsOverride: readonly Metric[] | undefined,
  message?: string,
): Promise<PendingAdd[] | null> {
  const value = await context.prompts.askRepoName(message);
  if (promptCancelled(value)) {
    return null;
  }
  const parsed = parseExplicitSubject('repo', value ?? '');
  const metrics = await askRepoMetrics(context, config, parsed.subject, metricsOverride);
  if (metrics === null) {
    return null;
  }
  return [{ parsed, metrics }];
}

async function browseRepos(
  context: CommandContext,
  config: Config,
  owner: string,
  metricsOverride: readonly Metric[] | undefined,
  warnings: string[],
): Promise<PendingAdd[] | null> {
  const token = resolveToken(context, config.defaults.tokenEnv);
  const client = createGitHubClient(context, config, token, warnings);

  let repos: RepoListing[];
  try {
    repos = await listUserRepos(client, owner, context.signal);
  } catch (error) {
    if (error instanceof CliError && error.code === 'interrupted') {
      throw error;
    }
    const message = errorMessage(error);
    warnings.push(`Could not list repositories for ${owner}: ${message}. Enter one manually.`);
    return manualRepo(
      context,
      config,
      metricsOverride,
      'Could not list repositories. Enter owner/name',
    );
  }

  if (repos.length === 0) {
    warnings.push(`No public repositories found for ${owner}. Enter one manually.`);
    return manualRepo(
      context,
      config,
      metricsOverride,
      'No public repositories found. Enter owner/name',
    );
  }

  const selected = await context.prompts.selectRepos(
    owner,
    repos.map((repo) => repoChoice(config, repo)),
  );
  if (selected === null || selected.length === 0) {
    return null;
  }

  const items: PendingAdd[] = [];
  for (const fullName of selected) {
    const parsed = parseExplicitSubject('repo', fullName);
    const metrics = await askRepoMetrics(context, config, parsed.subject, metricsOverride);
    if (metrics === null) {
      return null;
    }
    items.push({ parsed, metrics });
  }
  return items;
}

async function promptUser(
  context: CommandContext,
  value: string | null,
): Promise<PendingAdd[] | null> {
  let login = value;
  if (login === null) {
    login = await context.prompts.askUserLogin();
  }
  if (promptCancelled(login)) {
    return null;
  }
  const parsed = parseExplicitSubject('user', login ?? '');
  return [{ parsed, metrics: defaultMetricsFor('user') }];
}

/** Prompts for a repository, then either takes `owner/name` or opens the picker. */
async function promptRepo(
  context: CommandContext,
  config: Config,
  metricsOverride: readonly Metric[] | undefined,
  warnings: string[],
): Promise<PendingAdd[] | null> {
  const input = await context.prompts.askRepoInput();
  if (promptCancelled(input)) {
    return null;
  }
  const raw = (input ?? '').trim();
  if (!raw.includes('/')) {
    return browseRepos(context, config, raw, metricsOverride, warnings);
  }
  const parsed = parseExplicitSubject('repo', raw);
  const metrics = await askRepoMetrics(context, config, parsed.subject, metricsOverride);
  return metrics === null ? null : [{ parsed, metrics }];
}

function explicitRepo(
  config: Config,
  parsed: ParsedSubject,
  metricsOverride: readonly Metric[] | undefined,
): PendingAdd[] {
  return [{ parsed, metrics: metricsForRepo(config, parsed.subject, metricsOverride) }];
}

async function collect(
  context: CommandContext,
  config: Config,
  metricsOverride: readonly Metric[] | undefined,
  resourcesOverride: readonly Resource[] | undefined,
  warnings: string[],
): Promise<PendingAdd[] | null> {
  const args = context.positionals;
  if (args.length > 2) {
    throw unexpectedArgument(args[2], ADD_USAGE);
  }

  const first = args[0];
  const second = args[1];

  const rejectUserMetrics = (type: SubjectType): void => {
    if (type === 'user' && metricsOverride !== undefined) {
      throw new UsageError('--metrics is only valid for repositories.');
    }
    if (type === 'repo' && resourcesOverride !== undefined) {
      throw new UsageError('--resources is only valid for user subjects.');
    }
  };

  if (first === undefined) {
    requirePrompt(
      context,
      'gh-track dashboard add',
      'gh-track dashboard add user <login> or gh-track dashboard add repo <owner/name>',
    );
    const type = await context.prompts.selectAddType();
    if (type === null) {
      return null;
    }
    rejectUserMetrics(type);

    if (type === 'user') {
      return promptUser(context, null);
    }

    return promptRepo(context, config, metricsOverride, warnings);
  }

  if (first === 'user') {
    rejectUserMetrics('user');
    if (second !== undefined) {
      return promptUser(context, second);
    }
    requirePrompt(
      context,
      'gh-track dashboard add user',
      'gh-track dashboard add user <login>',
    );
    return promptUser(context, null);
  }

  if (first === 'repo') {
    rejectUserMetrics('repo');
    if (second === undefined) {
      requirePrompt(
        context,
        'gh-track dashboard add repo',
        'gh-track dashboard add repo <owner/name>',
      );
      return promptRepo(context, config, metricsOverride, warnings);
    }

    if (second.includes('/')) {
      return explicitRepo(config, parseExplicitSubject('repo', second), metricsOverride);
    }

    requirePrompt(
      context,
      'gh-track dashboard add repo <owner>',
      'gh-track dashboard add repo <owner/name>',
    );
    return browseRepos(context, config, second, metricsOverride, warnings);
  }

  const parsed = parseSubject(first);
  rejectUserMetrics(parsed.type);
  if (parsed.type === 'user') {
    return [{ parsed, metrics: defaultMetricsFor('user') }];
  }
  return explicitRepo(config, parsed, metricsOverride);
}

function applyAdds(
  config: Config,
  items: readonly PendingAdd[],
  resourcesOverride: readonly Resource[] | undefined,
): { added: AppliedEntry[]; updated: AppliedEntry[] } {
  const added: AppliedEntry[] = [];
  const updated: AppliedEntry[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const key = subjectKey(item.parsed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const subjectIndex = config.subjects.findIndex(
      (subject) => subjectKey(subject) === key,
    );
    let watched = false;
    let storedSubject = item.parsed.subject;

    if (subjectIndex < 0) {
      const resources: readonly Resource[] =
        item.parsed.type === 'user' ? (resourcesOverride ?? USER_RESOURCES) : ['repo'];
      const entry = toConfigSubject(item.parsed, resources);
      config.subjects.push(entry);
      watched = true;
      storedSubject = entry.subject;
    } else {
      const existing = config.subjects[subjectIndex];
      if (existing === undefined) {
        continue;
      }
      storedSubject = existing.subject;
      if (existing.type === 'user' && resourcesOverride !== undefined) {
        existing.resources = [...resourcesOverride];
      }
    }

    const trackingIndex = config.tracking.findIndex(
      (entry) => subjectKeyOf(entry.subject) === key,
    );
    const metrics = [...item.metrics];
    const previous = trackingIndex < 0 ? null : config.tracking[trackingIndex]?.metrics;
    const changed =
      previous === null ||
      previous === undefined ||
      previous.length !== metrics.length ||
      previous.some((metric, index) => metric !== metrics[index]);

    const entry = { subject: storedSubject, metrics };
    if (trackingIndex < 0) {
      config.tracking.push(entry);
      added.push({ subject: storedSubject, metrics, watched, changed: true });
    } else {
      config.tracking[trackingIndex] = entry;
      updated.push({ subject: storedSubject, metrics, watched, changed });
    }
  }

  config.tracking = sortTracking(config, config.tracking);
  return { added, updated };
}

function renderText(added: readonly AppliedEntry[], updated: readonly AppliedEntry[]): string {
  const lines: string[] = [];
  for (const entry of added) {
    const watching = entry.watched ? '; now watching' : '';
    lines.push(`Added ${entry.subject} (${entry.metrics.join(', ')})${watching}.`);
  }
  for (const entry of updated) {
    if (!entry.changed) {
      lines.push(`Already tracked ${entry.subject} (${entry.metrics.join(', ')}).`);
      continue;
    }
    const watching = entry.watched ? '; now watching' : '';
    lines.push(`Updated ${entry.subject} (${entry.metrics.join(', ')})${watching}.`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export async function runDashboardAdd(context: CommandContext): Promise<CommandResult> {
  rejectRenderFlags(context);

  const metricsValue = context.options.get('metrics');
  const metricsOverride =
    metricsValue === undefined ? undefined : parseMetricList(metricsValue, 'repo');
  const resourcesValue = context.options.get('resources');
  const resourcesOverride =
    resourcesValue === undefined ? undefined : parseResources(resourcesValue);

  const loaded = await loadConfig(context.paths.configPath, { required: false });
  const config = loaded?.config ?? defaultConfig();
  const warnings = loaded === null ? [] : [...loaded.warnings];

  const items = await collect(context, config, metricsOverride, resourcesOverride, warnings);
  if (items === null || items.length === 0) {
    return cancelled();
  }

  const applied = applyAdds(config, items, resourcesOverride);
  await saveConfig(context.paths.configPath, config);

  const result: DashboardAddResult = {
    configPath: context.paths.configPath,
    added: applied.added.map(({ subject, metrics, watched }) => ({ subject, metrics, watched })),
    updated: applied.updated.map(({ subject, metrics, watched }) => ({ subject, metrics, watched })),
  };

  return {
    json: result,
    text: renderText(applied.added, applied.updated),
    warnings,
  };
}
