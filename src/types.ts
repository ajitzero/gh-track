/** Shared domain and command types. */

export type SubjectType = 'user' | 'repo';

/** Resources that can be fetched for a subject. */
export type Resource = 'followers' | 'repos' | 'repo';

export type OutputFormat = 'table' | 'json' | 'jsonl' | 'csv';

export type RunStatus = 'complete' | 'partial' | 'failed';

export interface ConfigDefaults {
  rawRetentionDays: number;
  tokenEnv: string;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface UserSubject {
  subject: string;
  type: 'user';
  account: string;
  resources: Resource[];
}

export interface RepoSubject {
  subject: string;
  type: 'repo';
  repo: string;
  resources: Resource[];
}

export type ConfigSubject = UserSubject | RepoSubject;

export interface Config {
  schemaVersion: 1;
  defaults: ConfigDefaults;
  subjects: ConfigSubject[];
}

export interface LastRunSummary {
  id: string;
  status: RunStatus;
  finishedAt: string;
  repos: number;
  followers: number;
}

/** One manifest request entry (§5.1). */
export interface ManifestRequestEntry {
  subject: string;
  resource: Resource;
  url: string;
  page: number;
  status: number;
  etag?: string | undefined;
  path?: string | undefined;
  sourceRun?: string | undefined;
  sourcePath?: string | undefined;
}

/** A request that has not completed yet and is retried by `--resume`. */
export interface PendingRequest {
  subject: string;
  resource: Resource;
  url: string;
  page: number;
}

export interface ManifestErrorEntry {
  subject: string;
  resource: Resource;
  url: string;
  status: number;
  code: string;
  message: string;
}

export interface ManifestStats {
  repos: number;
  followers: number;
  requests: number;
  notModified: number;
}

export interface ManifestSubject {
  subject: string;
  resources: Resource[];
}

/** `manifest.json` for one run (§5.1). */
export interface Manifest {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  subjects: ManifestSubject[];
  stats: ManifestStats;
  requests: ManifestRequestEntry[];
  pending: PendingRequest[];
  errors: ManifestErrorEntry[];
}

/** One compacted repository day (§5.4). */
export interface RepoHistoryRow {
  date: string;
  repository: string;
  stars: number;
  forks: number;
}

/** One compacted account day (§5.5). */
export interface UserHistoryRow {
  date: string;
  account: string;
  followers: number;
}

/** A day selected for compaction and its metrics (§5.10). */
export interface CompactedDay {
  date: string;
  repos: number;
  users: number;
}

/** A raw run directory removed after its day was compacted. */
export interface PrunedRun {
  id: string;
  path: string;
}

/** Result of `compact` or automatic post-fetch compaction (§5.10). */
export interface CompactionResult {
  dryRun: boolean;
  compacted: CompactedDay[];
  pruned: PrunedRun[];
}

/** One export row, shaped to match the CSV columns in §2.6. */
export interface ExportRow {
  date: string;
  kind: 'repo' | 'user';
  subject: string;
  stars?: number;
  forks?: number;
  followers?: number;
}

export interface WatchedUser {
  subject: string;
  type: 'user';
  account: string;
  resources: Resource[];
  lastRun: LastRunSummary | null;
}

export interface WatchedRepo {
  subject: string;
  type: 'repo';
  repo: string;
  resources: Resource[];
  lastRun: LastRunSummary | null;
}

export type WatchedSubject = WatchedUser | WatchedRepo;

export interface WatchListResult {
  configPath: string;
  dataDir: string;
  defaults: ConfigDefaults;
  subjects: WatchedSubject[];
}

/** Resolved XDG paths used by commands. */
export interface Paths {
  configPath: string;
  dataDir: string;
}

/** A tiny read-only view over parsed CLI options. */
export interface OptionBag {
  has(name: string): boolean;
  get(name: string): string | undefined;
  getAll(name: string): readonly string[];
}

export interface WatchAddAnswer {
  type: SubjectType;
  value: string;
}

/** Injectable prompt surface so commands stay testable. */
export interface PromptApi {
  watchAdd(): Promise<WatchAddAnswer | null>;
  selectSubject(subjects: readonly string[]): Promise<string | null>;
  confirmRemoval(subject: string): Promise<boolean | null>;
}

export interface Colors {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export interface CommandContext {
  /** Positional arguments after the top-level command. */
  positionals: string[];
  options: OptionBag;
  paths: Paths;
  format: OutputFormat;
  colors: Colors;
  yes: boolean;
  verbose: boolean;
  canPrompt: boolean;
  prompts: PromptApi;
  /** Environment used to resolve token_env and platform-specific defaults. */
  env: NodeJS.ProcessEnv;
  /** Aborted by SIGINT so long-running commands can stop gracefully. */
  signal?: AbortSignal | undefined;
  /** Injectable HTTP implementation; tests pass a fake, production uses global fetch. */
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Injectable delay used by retry backoff. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

export interface CommandResult {
  /** Machine-readable result used when --format json is active. */
  json: unknown;
  /** Human-readable result used when --format table is active. */
  text: string;
  warnings: string[];
  /** Process exit code for this command. Defaults to 0. */
  exitCode?: number | undefined;
}
