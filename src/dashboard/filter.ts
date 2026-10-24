/** Live dashboard filtering while preserving compact account/repository groups. */

import { groupDashboardRows } from './group.js';
import { repoOf } from '../subjects.js';
import type { DashboardLayout, DashboardRow } from '../types.js';

function matches(row: DashboardRow, label: string, query: string): boolean {
  const normalized = query.toLowerCase();
  if (label.toLowerCase().includes(normalized)) {
    return true;
  }
  return query.includes('/') && row.kind === 'repo' &&
    repoOf(row.subject).toLowerCase().includes(normalized);
}

/**
 * Filters dashboard rows in their rendered order. In compact layout a tracked
 * account is retained when one of its nested repositories matches; matching
 * the account itself retains its complete group.
 */
export function filterDashboardRows(
  rows: readonly DashboardRow[],
  layout: DashboardLayout,
  query: string,
): DashboardRow[] {
  if (layout === 'columns') {
    const ordered = [
      ...rows.filter((row) => row.kind === 'repo'),
      ...rows.filter((row) => row.kind === 'user'),
    ];
    return ordered.filter((row) => {
      if (query.length === 0) {
        return true;
      }
      const label = row.kind === 'repo' ? repoOf(row.subject) : row.subject.slice('user:'.length);
      return matches(row, label, query);
    });
  }

  const display = groupDashboardRows(rows);
  if (query.length === 0) {
    return display.map((item) => item.row);
  }

  const filtered: DashboardRow[] = [];
  let index = 0;
  while (index < display.length) {
    const current = display[index];
    if (current === undefined) {
      index += 1;
      continue;
    }

    if (current.row.kind !== 'user') {
      if (matches(current.row, current.label, query)) {
        filtered.push(current.row);
      }
      index += 1;
      continue;
    }

    const group = [current];
    index += 1;
    while (index < display.length && display[index]?.nested === true) {
      const child = display[index];
      if (child !== undefined) {
        group.push(child);
      }
      index += 1;
    }

    const headerMatches = matches(current.row, current.label, query);
    const matchingChildren = group.slice(1).filter((child) =>
      matches(child.row, child.label, query),
    );
    if (headerMatches) {
      filtered.push(...group.map((item) => item.row));
    } else if (matchingChildren.length > 0) {
      filtered.push(current.row, ...matchingChildren.map((child) => child.row));
    }
  }
  return filtered;
}
