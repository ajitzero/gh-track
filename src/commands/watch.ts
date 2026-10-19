/** `gh-track watch add|ls|rm`. */

import { loadConfig, saveConfig, defaultConfig } from '../config.js';
import { UsageError, unknownSubject } from '../errors.js';
import { renderTable } from '../output/table.js';
import { summarizeLastRun } from '../store/runs.js';
import { parseExplicitSubject, parseSubject, subjectKey } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  ConfigSubject,
  Resource,
  SubjectType,
  WatchListResult,
  WatchedSubject,
} from '../types.js';

const USER_RESOURCES: readonly Resource[] = ['followers', 'repos'];
const USER_RESOURCE_SET = new Set<string>(USER_RESOURCES);

const ADD_USAGE =
  'gh-track watch add user <login> [--resources followers,repos] or gh-track watch add repo <owner/name>';

function cancelled(): CommandResult {
  return {
    json: { cancelled: true },
    text: 'Cancelled.\n',
    warnings: [],
  };
}

function parseResources(value: string): Resource[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new UsageError(
      `Invalid --resources value ${JSON.stringify(value)}. Expected a comma-separated subset of followers,repos.`,
    );
  }

  const resources = new Set<Resource>();
  for (const part of parts) {
    if (!USER_RESOURCE_SET.has(part)) {
      throw new UsageError(
        `Invalid --resources value ${JSON.stringify(value)}. Expected a comma-separated subset of followers,repos.`,
      );
    }
    resources.add(part as Resource);
  }
  return USER_RESOURCES.filter((resource) => resources.has(resource));
}

async function addSubject(context: CommandContext, args: string[]): Promise<CommandResult> {
  let type: SubjectType;
  let value: string;

  if (args.length === 0) {
    if (!context.canPrompt) {
      throw new UsageError(`Missing arguments. Use: ${ADD_USAGE}`);
    }
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
      throw new UsageError(`Unexpected argument ${JSON.stringify(args[2])}. Use: ${ADD_USAGE}`);
    }
    type = requestedType;
    value = requestedValue;
  }

  const resourcesValue = context.options.get('resources');
  if (type === 'repo' && resourcesValue !== undefined) {
    throw new UsageError('--resources is only valid for user subjects.');
  }

  const resources = type === 'user'
    ? resourcesValue === undefined
      ? [...USER_RESOURCES]
      : parseResources(resourcesValue)
    : (['repo'] as Resource[]);

  const parsed = parseExplicitSubject(type, value);
  const loaded = await loadConfig(context.paths.configPath, { required: false });
  const config: Config = loaded?.config ?? defaultConfig();
  const warnings = loaded === undefined || loaded === null ? [] : [...loaded.warnings];

  const entry: ConfigSubject =
    parsed.type === 'user'
      ? {
          subject: parsed.subject,
          type: 'user',
          account: parsed.account,
          resources,
        }
      : {
          subject: parsed.subject,
          type: 'repo',
          repo: parsed.repo,
          resources,
        };

  const key = subjectKey(entry);
  const existingIndex = config.subjects.findIndex((subject) => subjectKey(subject) === key);
  const updated = existingIndex >= 0;
  if (updated) {
    config.subjects[existingIndex] = entry;
  } else {
    config.subjects.push(entry);
  }

  await saveConfig(context.paths.configPath, config);

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

async function toWatched(dataDir: string, subject: ConfigSubject): Promise<WatchedSubject> {
  const lastRun = await summarizeLastRun(dataDir, subject.subject);
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
}

async function listSubjects(
  context: CommandContext,
  args: string[],
): Promise<CommandResult> {
  if (args.length > 0) {
    throw new UsageError(`Unexpected argument ${JSON.stringify(args[0])}. Use: gh-track watch ls`);
  }

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  if (loaded === null) {
    throw new UsageError('Config file is required for watch ls.');
  }

  const watched = await Promise.all(
    loaded.config.subjects.map((subject) => toWatched(context.paths.dataDir, subject)),
  );
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
          ['SUBJECT', 'TYPE', 'RESOURCES', 'LAST RUN'],
          watched.map((subject) => [
            subject.subject,
            subject.type,
            subject.resources.join(','),
            subject.lastRun === null ? 'never' : subject.lastRun.id,
          ]),
        )}\n`;

  return { json: result, text, warnings: [...loaded.warnings] };
}

async function removeSubject(
  context: CommandContext,
  args: string[],
): Promise<CommandResult> {
  if (args.length > 1) {
    throw new UsageError(`Unexpected argument ${JSON.stringify(args[1])}. Use: gh-track watch rm <subject>`);
  }

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  if (loaded === null) {
    throw new UsageError('Config file is required for watch rm.');
  }
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

  config.subjects.splice(index, 1);
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
    throw new UsageError('Missing watch subcommand. Use: gh-track watch add|ls|rm');
  }
  throw new UsageError(`Unknown watch subcommand: ${subcommand}. Use: gh-track watch add|ls|rm`);
}
