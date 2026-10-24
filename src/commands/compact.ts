/** `gh-track compact`: roll old raw runs into daily history and prune them. */

import { positiveIntegerOption, unexpectedArgument } from '../cli-args.js';
import { defaultDefaults, loadConfig } from '../config.js';
import { renderTable } from '../output/table.js';
import { runCompaction } from '../store/compact.js';
import { acquireLock } from '../store/lock.js';
import type { CommandContext, CommandResult, CompactionResult } from '../types.js';

function renderSummary(result: CompactionResult): string {
  const verb = result.dryRun ? 'Would compact' : 'Compacted';
  const pruneVerb = result.dryRun ? 'would prune' : 'pruned';
  const lines = [
    `${verb} ${result.compacted.length} day(s); ${pruneVerb} ${result.pruned.length} run(s).`,
  ];
  if (result.compacted.length > 0) {
    lines.push(
      renderTable(
        ['DATE', 'REPOS', 'USERS'],
        result.compacted.map((day) => [day.date, String(day.repos), String(day.users)]),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runCompact(context: CommandContext): Promise<CommandResult> {
  if (context.positionals.length > 0) {
    throw unexpectedArgument(context.positionals[0], 'gh-track compact');
  }

  const override = positiveIntegerOption(context.options.get('keep-days'), '--keep-days');
  const loaded = await loadConfig(context.paths.configPath, { required: false });
  const keepDays =
    override ?? loaded?.config.defaults.rawRetentionDays ?? defaultDefaults().rawRetentionDays;
  const dryRun = context.options.has('dry-run');

  const compact = async (): Promise<CompactionResult> =>
    runCompaction(context.paths.dataDir, { keepDays, dryRun });

  // A dry run writes nothing, including a lock file.
  let result: CompactionResult;
  if (dryRun) {
    result = await compact();
  } else {
    const lock = await acquireLock(context.paths.dataDir);
    try {
      result = await compact();
    } finally {
      await lock.release();
    }
  }

  return {
    json: result,
    text: renderSummary(result),
    warnings: loaded === null ? [] : [...loaded.warnings],
  };
}
