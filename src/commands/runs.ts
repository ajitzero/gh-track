/** `gh-track runs ls|show|paths`. */

import {
  invalidOption,
  missingSubcommand,
  positiveIntegerOption,
  unexpectedArgument,
  unknownSubcommand,
} from '../cli-args.js';
import { runNotFound, UsageError } from '../errors.js';
import { renderTable } from '../output/table.js';
import { readManifest } from '../store/manifest.js';
import { runDir } from '../store/paths.js';
import { listManifests } from '../store/runs.js';
import type { CommandContext, CommandResult, Manifest } from '../types.js';

const RUNS_USAGE = 'gh-track runs ls|show|paths';

async function listRuns(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  if (args.length > 0) {
    throw unexpectedArgument(args[0], 'gh-track runs ls');
  }
  const limit = positiveIntegerOption(context.options.get('limit'), '--limit', 20) ?? 20;
  const manifests = await listManifests(context.paths.dataDir, limit);

  const rows = manifests.map((manifest) => ({
    id: manifest.id,
    status: manifest.status,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    subjects: manifest.subjects.length,
    repos: manifest.stats.repos,
    followers: manifest.stats.followers,
    requests: manifest.stats.requests,
    notModified: manifest.stats.notModified,
  }));

  const text =
    rows.length === 0
      ? 'No runs stored.\n'
      : `${renderTable(
          ['ID', 'STATUS', 'FINISHED', 'SUBJECTS', 'REPOS', 'FOLLOWERS', 'REQUESTS'],
          rows.map((row) => [
            row.id,
            row.status,
            row.finishedAt ?? row.startedAt,
            String(row.subjects),
            String(row.repos),
            String(row.followers),
            String(row.requests),
          ]),
        )}\n`;

  return { json: { runs: rows }, text, warnings: [] };
}

async function requireRun(
  context: CommandContext,
  args: readonly string[],
  usage: string,
): Promise<Manifest> {
  if (args.length === 0) {
    throw new UsageError(`Missing run id. Use: ${usage}`);
  }
  if (args.length > 1) {
    throw unexpectedArgument(args[1], usage);
  }
  const id = args[0];
  const manifest = id === undefined ? null : await readManifest(context.paths.dataDir, id);
  if (manifest === null) {
    throw runNotFound(id ?? '');
  }
  return manifest;
}

function renderManifest(manifest: Manifest): string {
  const lines = [
    `Run: ${manifest.id}`,
    `Status: ${manifest.status}`,
    `Started: ${manifest.startedAt}`,
    `Finished: ${manifest.finishedAt ?? 'never'}`,
    `Subjects: ${manifest.subjects.length}`,
  ];
  for (const subject of manifest.subjects) {
    lines.push(`  ${subject.subject} (${subject.resources.join(', ')})`);
  }
  lines.push(
    `Requests: ${manifest.stats.requests}`,
    `Not modified: ${manifest.stats.notModified}`,
    `Repos: ${manifest.stats.repos}`,
    `Followers: ${manifest.stats.followers}`,
    `Pending: ${manifest.pending.length}`,
    `Errors: ${manifest.errors.length}`,
  );
  return `${lines.join('\n')}\n`;
}

async function showRun(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  const manifest = await requireRun(context, args, 'gh-track runs show <run-id>');
  return { json: manifest, text: renderManifest(manifest), warnings: [] };
}

async function showPath(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  const manifest = await requireRun(context, args, 'gh-track runs paths <run-id>');
  const directory = runDir(context.paths.dataDir, manifest.id);
  return {
    json: { path: directory },
    text: `${directory}\n`,
    warnings: [],
  };
}

export async function runRuns(context: CommandContext): Promise<CommandResult> {
  const [subcommand, ...args] = context.positionals;

  if (subcommand === 'ls') {
    return listRuns(context, args);
  }
  if (subcommand === 'show' || subcommand === 'paths') {
    if (context.options.has('limit')) {
      throw invalidOption('--limit', `'gh-track runs ${subcommand}'`);
    }
    return subcommand === 'show' ? showRun(context, args) : showPath(context, args);
  }
  if (subcommand === undefined) {
    throw missingSubcommand('runs', RUNS_USAGE);
  }
  throw unknownSubcommand('runs', subcommand, RUNS_USAGE);
}
