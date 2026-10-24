/** Compacted-history snapshots for the diff fallback. */

import { readAllHistory, type StoredHistory } from '../store/history.js';
import { historyFollowerCounts, type FollowerCounts } from './followers.js';
import { historyRepoRecords, type RepoRecord } from './repos.js';

export interface HistorySnapshot {
  repos: RepoRecord[];
  counts: FollowerCounts;
}

/** Project one stored history day into comparable snapshots. */
export function snapshotFromHistory(history: StoredHistory, date: string): HistorySnapshot {
  return {
    repos: historyRepoRecords(history.repos.filter((row) => row.date === date)),
    counts: historyFollowerCounts(history.users.filter((row) => row.date === date)),
  };
}

export async function loadHistorySnapshot(dataDir: string, date: string): Promise<HistorySnapshot> {
  return snapshotFromHistory(await readAllHistory(dataDir), date);
}
