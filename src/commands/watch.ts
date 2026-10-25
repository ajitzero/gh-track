/** `gh-track watch add|ls|rm`. */

import { missingSubcommand, unexpectedArgument, unknownSubcommand } from '../cli-args.js';
import { removeConfiguredSubject, toConfigSubject, upsertSubject } from '../config-edit.js';
import { loadConfig, saveConfig, defaultConfig } from '../config.js';
import { UsageError, unknownSubject } from '../errors.js';
import { renderTable } from '../output/table.js';
import { USER_RESOURCES, parseResources } from '../resources.js';
import { cancelled, requirePrompt } from '../result.js';
import { summarizeLastRuns } from '../store/runs.js';
import { recordTrackedSince } from '../store/trackedSince.js';
import { parseExplicitSubject, parseSubject, subjectKey } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  Resource,
  SubjectType,
  WatchListResult,
  WatchedSubject,
} from '../types.js';

const ADD_USAGE =
  'gh-track watch add user <login> [--resources followers,repos] or gh-track watch add repo <owner/name>';

async function addSubject(context: CommandContext, args: string[]): Promise<CommandResult> {
  let type: SubjectType;
  let value: string;

  if (args.length === 0) {
    requirePrompt(context, 'gh-track watch add', ADD_USAGE);
    const answer = await context.prompts.watchAdd();
    if (answer === null) {
      return cancelled();
    }
    type = answer.type;
    value = answer.value;
  } else {
    const requestedType = args[0];
    if (requestedType !== 'user' && requestedType !== 'repo') {
      throw new UsageError(
        requestedType === undefined
          ? `Missing subject type. Use: ${ADD_USAGE}`
          : `Unknown subject type ${JSON.stringify(requestedType)}. Use: ${ADD_USAGE}`,
      );
    }
    const requestedValue = args[1];
    if (requestedValue === undefined) {
      throw new UsageError(
        requestedType === 'user'
          ? 'Missing login. Use: gh-track watch add user <login> [--resources followers,repos]'
          : 'Missing repository. Use: gh-track watch add repo <owner/name>',
      );
    }
    if (args.length > 2) {
      throw unexpectedArgument(args[2], ADD_USAGE);
    }
    type = requestedType;
    value = requestedValue;
  }

  const resourcesValue = context.options.get('resources');
  if (type === 'repo' && resourcesValue !== undefined) {
    throw new UsageError('--resources is only valid for user subjects.');
  }

  const resources: Resource[] =
    type === 'user'
      ? resourcesValue === undefined
        ? [...USER_RESOURCES]
        : parseResources(resourcesValue)
      : ['repo'];

  const parsed = parseExplicitSubject(type, value);
  const loaded = await loadConfig(context.paths.configPath, { required: false });
  const config: Config = loaded?.config ?? defaultConfig();
  const warnings = loaded === null ? [] : [...loaded.warnings];

  const entry = toConfigSubject(parsed, resources);
  const added = upsertSubject(config, entry);
  if (added) {
    await recordTrackedSince(context.paths.dataDir, [entry.subject], new Date().toISOString());
  }

  await saveConfig(context.paths.configPath, config);

  const updated = !added;

  const action = updated ? 'Updated' : 'Added';
  const json =
    entry.type === 'user'
      ? {
          configPath: context.paths.configPath,
          subject: entry.subject,
          type: 'user',
          account: entry.account,
          resources: entry.resources,
          updated,
        }
      : {
          configPath: context.paths.configPath,
          subject: entry.subject,
          type: 'repo',
          repo: entry.repo,
          resources: entry.resources,
          updated,
        };

  return {
    json,
    text: `${action} ${entry.subject} (${entry.resources.join(', ')}).\n`,
    warnings,
  };
}

async function listSubjects(context: CommandContext, args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    throw unexpectedArgument(args[0], 'gh-track watch ls');
  }

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  const summaries = await summarizeLastRuns(
    context.paths.dataDir,
    loaded.config.subjects.map((subject) => subject.subject),
  );
  const watched: WatchedSubject[] = loaded.config.subjects.map((subject) => {
    const lastRun = summaries.get(subject.subject) ?? null;
    if (subject.type === 'user') {
      return {
        subject: subject.subject,
        type: 'user',
        account: subject.account,
        resources: [...subject.resources],
        lastRun,
      };
    }
    return {
      subject: subject.subject,
      type: 'repo',
      repo: subject.repo,
      resources: ['repo'],
      lastRun,
    };
  });
  const result: WatchListResult = {
    configPath: context.paths.configPath,
    dataDir: context.paths.dataDir,
    defaults: { ...loaded.config.defaults },
    subjects: watched,
  };

  const text =
    watched.length === 0
      ? "No subjects configured. Run 'gh-track watch add user <login>' or 'gh-track watch add repo <owner/name>'.\n"
      : `${renderTable(
          ['SUBJECT', 'TYPE', 'RESOURCES', 'LAST RUN', 'STATUS', 'FINISHED', 'REPOS', 'FOLLOWERS'],
          watched.map((subject) => [
            subject.subject,
            subject.type,
            subject.resources.join(','),
            subject.lastRun === null ? 'never' : subject.lastRun.id,
            subject.lastRun === null ? '' : subject.lastRun.status,
            subject.lastRun === null ? '' : subject.lastRun.finishedAt,
            subject.lastRun === null ? '' : String(subject.lastRun.repos),
            subject.lastRun === null ? '' : String(subject.lastRun.followers),
          ]),
        )}\n`;

  return { json: result, text, warnings: [...loaded.warnings] };
}

async function removeSubject(context: CommandContext, args: string[]): Promise<CommandResult> {
  if (args.length > 1) {
    throw unexpectedArgument(args[1], 'gh-track watch rm <subject>');
  }

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  const config = loaded.config;
  const warnings = [...loaded.warnings];

  let requested = args[0];
  if (requested === undefined) {
    if (!context.canPrompt) {
      throw new UsageError('Missing subject. Use: gh-track watch rm <subject> --yes');
    }
    if (config.subjects.length === 0) {
      throw new UsageError(
        "The watchlist is empty. Use 'gh-track watch add user <login>' or 'gh-track watch add repo <owner/name>'.",
      );
    }
    const selected = await context.prompts.selectSubject(
      config.subjects.map((subject) => subject.subject),
    );
    if (selected === null) {
      return cancelled();
    }
    requested = selected;
  }

  const parsed = parseSubject(requested);
  const key = subjectKey(parsed);
  const index = config.subjects.findIndex((subject) => subjectKey(subject) === key);
  if (index < 0) {
    throw unknownSubject(requested);
  }
  const existing = config.subjects[index];
  if (existing === undefined) {
    throw unknownSubject(requested);
  }

  if (args[0] !== undefined && !context.yes) {
    if (!context.canPrompt) {
      throw new UsageError(
        `Refusing to remove ${existing.subject} without confirmation. Use: gh-track watch rm ${existing.subject} --yes`,
      );
    }
    const accepted = await context.prompts.confirmRemoval(existing.subject);
    if (accepted === null || accepted === false) {
      return cancelled();
    }
  }

  const removed = removeConfiguredSubject(config, existing.subject);
  if (removed === null) {
    throw unknownSubject(requested);
  }
  warnings.push(...removed.warnings);

  await saveConfig(context.paths.configPath, config);

  return {
    json: {
      configPath: context.paths.configPath,
      subject: existing.subject,
      removed: true,
    },
    text: `Removed ${existing.subject}.\n`,
    warnings,
  };
}

export async function runWatch(context: CommandContext): Promise<CommandResult> {
  const [subcommand, ...args] = context.positionals;

  if (subcommand !== 'add' && context.options.has('resources')) {
    throw new UsageError('--resources is only valid for watch add user.');
  }

  if (subcommand === 'add') {
    return addSubject(context, args);
  }
  if (subcommand === 'ls') {
    return listSubjects(context, args);
  }
  if (subcommand === 'rm') {
    return removeSubject(context, args);
  }
  if (subcommand === undefined) {
    throw missingSubcommand('watch', 'gh-track watch add|ls|rm');
  }
  throw unknownSubcommand('watch', subcommand, 'gh-track watch add|ls|rm');
}
