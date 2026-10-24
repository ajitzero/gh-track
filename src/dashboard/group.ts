/** Display grouping for the compact dashboard: tracked accounts own their repositories. */

import { accountOf, repoOf } from '../subjects.js';
import type { DashboardRow } from '../types.js';

export interface DashboardDisplayRow {
  row: DashboardRow;
  /** Name rendered in the NAME column. */
  label: string;
  /** True when the row is a repository nested under a tracked account. */
  nested: boolean;
}

function ownerOf(row: DashboardRow): string {
  const repo = repoOf(row.subject);
  const slash = repo.indexOf('/');
  return slash < 0 ? '' : repo.slice(0, slash).toLowerCase();
}

function repoNameOf(row: DashboardRow): string {
  const repo = repoOf(row.subject);
  const slash = repo.indexOf('/');
  return slash < 0 ? repo : repo.slice(slash + 1);
}

function plain(row: DashboardRow, label: string): DashboardDisplayRow {
  return { row, label, nested: false };
}

function nested(row: DashboardRow): DashboardDisplayRow {
  return { row, label: repoNameOf(row), nested: true };
}

function groupAnchor(
  rows: readonly DashboardRow[],
  users: ReadonlyMap<string, DashboardRow>,
): Map<string, number> {
  const anchors = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind === 'user') {
      const account = accountOf(row.subject).toLowerCase();
      if (!users.has(account)) {
        return;
      }
      anchors.set(account, Math.min(anchors.get(account) ?? index, index));
      return;
    }
    const owner = ownerOf(row);
    if (owner === '' || !users.has(owner)) {
      return;
    }
    anchors.set(owner, Math.min(anchors.get(owner) ?? index, index));
  });
  return anchors;
}

/**
 * Orders rows so a tracked account is followed by its own repositories.
 * The group sits at the earliest position of any member; repositories are
 * nested and lose their `owner/` prefix. Repositories without a tracked owner
 * are left untouched and keep their place in the selection.
 */
export function groupDashboardRows(rows: readonly DashboardRow[]): DashboardDisplayRow[] {
  const users = new Map<string, DashboardRow>();
  const repos = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    if (row.kind === 'user') {
      const account = accountOf(row.subject).toLowerCase();
      if (!users.has(account)) {
        users.set(account, row);
      }
      continue;
    }
    const owner = ownerOf(row);
    if (owner === '') {
      continue;
    }
    const group = repos.get(owner) ?? [];
    group.push(row);
    repos.set(owner, group);
  }

  const anchors = groupAnchor(rows, users);
  const display: DashboardDisplayRow[] = [];
  const emitGroup = (account: string): void => {
    const user = users.get(account);
    if (user === undefined) {
      return;
    }
    display.push(plain(user, accountOf(user.subject)));
    for (const repo of repos.get(account) ?? []) {
      display.push(nested(repo));
    }
  };

  rows.forEach((row, index) => {
    if (row.kind === 'user') {
      const account = accountOf(row.subject).toLowerCase();
      if (users.get(account) !== row || anchors.get(account) !== index) {
        return;
      }
      emitGroup(account);
      return;
    }

    const owner = ownerOf(row);
    if (!users.has(owner)) {
      display.push(plain(row, repoOf(row.subject)));
      return;
    }
    if (anchors.get(owner) === index) {
      emitGroup(owner);
    }
  });

  return display;
}
