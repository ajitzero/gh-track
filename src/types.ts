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
  /** Default dashboard selection; empty means "all subjects with defaults". */
  tracking: TrackingEntry[];
  /** Named dashboard snapshots. */
  views: DashboardView[];
}

export type Metric = 'stars' | 'forks' | 'followers';

export type DashboardLayout = 'compact' | 'columns';

/** One subject in the default dashboard selection. */
export interface TrackingEntry {
  subject: string;
  metrics: Metric[];
}

/** One subject in a saved view. */
export interface ViewItem {
  subject: string;
  metrics: Metric[];
}

/** A named, fully materialized dashboard snapshot. */
export interface DashboardView {
  name: string;
  items: ViewItem[];
  layout: DashboardLayout;
  from: string;
  to: string;
}

/** One point in a subject's observation series. */
export interface DashboardObservation {
  /** Run id for raw observations; UTC day for compacted ones. */
  id: string;
  /** UTC day used for ordering and date bounds. */
  day: string;
  /** Null for compacted observations. */
  finishedAt: string | null;
  kind: 'raw' | 'compacted';
  metrics: Partial<Record<Metric, number>>;
}

/** One metric value and its delta for a dashboard row. */
export interface DashboardMetricValue {
  value: number | null;
  from: number | null;
  delta: number | null;
}

/** One rendered dashboard row. */
export interface DashboardRow {
  kind: SubjectType;
  subject: string;
  source: DiffSource | null;
  from: DiffRefInfo | null;
  to: DiffRefInfo | null;
  metrics: Partial<Record<Metric, DashboardMetricValue>>;
}

/** `dashboard --format json` document (§5.14). */
export interface DashboardResult {
  view?: string | undefined;
  layout: DashboardLayout;
  range: { from: string; to: string };
  rows: DashboardRow[];
}

/** `track ls --format json` document (§5.15). */
export interface TrackListResult {
  tracking: TrackingEntry[];
  views: DashboardView[];
}

/** One subject written by `dashboard add`. */
export interface DashboardAddEntry {
  subject: string;
  metrics: Metric[];
  /** True when this run added the subject to `[[subjects]]`. */
  watched: boolean;
}

/** `dashboard add --format json` document. */
export interface DashboardAddResult {
  configPath: string;
  /** Subjects that were not in `[tracking]` before this run. */
  added: DashboardAddEntry[];
  /** Subjects that were already in `[tracking]`. */
  updated: DashboardAddEntry[];
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

export type DiffSource = 'raw' | 'compacted' | 'mixed';

export type RepoChange = 'changed' | 'added' | 'removed' | 'renamed';

/** The resolved endpoints reported by `diff` (§5.9). */
export interface DiffRefInfo {
  id: string;
  finishedAt: string | null;
}

/** One scalar field comparison. Numeric pairs also carry a delta. */
export interface DiffField {
  from: unknown;
  to: unknown;
  delta?: number;
}

export interface RepoDiffEntry {
  id: number | null;
  repository: string;
  previousRepository?: string | undefined;
  change: RepoChange;
  fields: Record<string, DiffField>;
}

export interface FollowerIdentity {
  login: string;
  id?: number | undefined;
}

export interface FollowerDiff {
  from: number;
  to: number;
  delta: number;
  added: FollowerIdentity[] | null;
  removed: FollowerIdentity[] | null;
  /** Present and false when the history fallback cannot provide identities. */
  identitiesAvailable?: false | undefined;
}

export interface UserDiffEntry {
  account: string;
  followers: FollowerDiff;
}

/** `diff --format json` document (§5.9). */
export interface DiffResult {
  from: DiffRefInfo;
  to: DiffRefInfo;
  source: DiffSource;
  repos: RepoDiffEntry[];
  users: UserDiffEntry[];
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

/** One selectable dashboard subject. */
export interface SubjectChoice {
  value: string;
  label: string;
  hint?: string | undefined;
}

/** Injectable prompt surface so commands stay testable. */
export interface PromptApi {
  watchAdd(): Promise<WatchAddAnswer | null>;
  selectSubject(subjects: readonly string[]): Promise<string | null>;
  confirmRemoval(subject: string): Promise<boolean | null>;
  /** Select the subject type for `dashboard add`. */
  selectAddType(): Promise<SubjectType | null>;
  /** Enter a GitHub login during `dashboard add`. */
  askUserLogin(): Promise<string | null>;
  /** Enter `owner/name` or a bare owner to browse. */
  askRepoInput(): Promise<string | null>;
  /** Enter a full `owner/name` when repository listing is unavailable. */
  askRepoName(message?: string): Promise<string | null>;
  /** Multi-select public repositories for one login. */
  selectRepos(
    login: string,
    choices: readonly SubjectChoice[],
  ): Promise<string[] | null>;
  /** Multi-select dashboard subjects, prefilled with `initial`. */
  selectSubjects(
    choices: readonly SubjectChoice[],
    initial: readonly string[],
    message?: string,
  ): Promise<string[] | null>;
  /** Multi-select metrics for one repository subject. */
  selectMetrics(
    subject: string,
    available: readonly Metric[],
    initial: readonly Metric[],
  ): Promise<Metric[] | null>;
  /** Select the render layout. */
  selectLayout(initial: DashboardLayout): Promise<DashboardLayout | null>;
  /** Select the baseline: `previous` or a `YYYY-MM-DD` date. */
  selectFrom(initial: string): Promise<string | null>;
  /** Confirm a dashboard selection before writing it. */
  confirmSelection(message: string): Promise<boolean | null>;
}

export interface Colors {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
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
