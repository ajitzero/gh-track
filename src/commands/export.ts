/** `gh-track export`: compacted history as JSON, JSONL, or CSV. */

import { unexpectedArgument } from '../cli-args.js';
import { isCalendarDay, relativeDay } from '../date.js';
import { noHistory, UsageError } from '../errors.js';
import { readAllHistory } from '../store/history.js';
import { subjectKey, subjectKeyOf } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  ExportRow,
  RepoHistoryRow,
  UserHistoryRow,
} from '../types.js';

const CSV_HEADER = 'date,kind,subject,stars,forks,followers';

function parseDateOption(raw: string | undefined, flag: string, now?: Date): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (isCalendarDay(raw)) {
    return raw;
  }
  const day = relativeDay(raw, now);
  if (day !== null) {
    return day;
  }
  throw new UsageError(`${flag} is not a valid calendar date or relative offset: ${raw}`);
}

function toRows(repos: readonly RepoHistoryRow[], users: readonly UserHistoryRow[]): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const row of repos) {
    rows.push({
      date: row.date,
      kind: 'repo',
      subject: row.repository,
      stars: row.stars,
      forks: row.forks,
    });
  }
  for (const row of users) {
    rows.push({
      date: row.date,
      kind: 'user',
      subject: row.account,
      followers: row.followers,
    });
  }
  return rows;
}

function subjectIdentity(row: ExportRow): string {
  return row.kind === 'repo'
    ? subjectKey({ type: 'repo', repo: row.subject })
    : subjectKey({ type: 'user', account: row.subject });
}

function compareRows(left: ExportRow, right: ExportRow): number {
  const byDate = left.date.localeCompare(right.date);
  if (byDate !== 0) {
    return byDate;
  }
  if (left.kind !== right.kind) {
    return left.kind === 'repo' ? -1 : 1;
  }
  return left.subject.toLowerCase().localeCompare(right.subject.toLowerCase());
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.kind,
        csvCell(row.subject),
        row.stars === undefined ? '' : String(row.stars),
        row.forks === undefined ? '' : String(row.forks),
        row.followers === undefined ? '' : String(row.followers),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderJsonl(rows: readonly ExportRow[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

export async function runExport(context: CommandContext): Promise<CommandResult> {
  if (context.positionals.length > 0) {
    throw unexpectedArgument(context.positionals[0], 'gh-track export');
  }

  const now = context.now ?? new Date();
  const from = parseDateOption(context.options.get('from'), '--from', now);
  const to = parseDateOption(context.options.get('to'), '--to', now);
  if (from !== undefined && to !== undefined && from > to) {
    throw new UsageError('--from must not be later than --to.');
  }
  const requested = context.options.getAll('subject').map(subjectKeyOf);
  const requestedKeys = new Set(requested);

  const history = await readAllHistory(context.paths.dataDir);
  const rows = toRows(history.repos, history.users)
    .filter((row) => {
      if (from !== undefined && row.date < from) {
        return false;
      }
      if (to !== undefined && row.date > to) {
        return false;
      }
      return requestedKeys.size === 0 || requestedKeys.has(subjectIdentity(row));
    })
    .sort(compareRows);

  if (rows.length === 0) {
    const details: Record<string, unknown> = {};
    if (from !== undefined) {
      details.from = from;
    }
    if (to !== undefined) {
      details.to = to;
    }
    if (requested.length > 0) {
      details.subjects = [...context.options.getAll('subject')];
    }
    throw noHistory(details);
  }

  const text = context.format === 'csv' ? renderCsv(rows) : renderJsonl(rows);
  return {
    json: { exportedAt: new Date().toISOString(), rows },
    text,
    warnings: [],
  };
}
