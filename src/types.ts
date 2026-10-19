/** Shared domain and command types. */

export type SubjectType = 'user' | 'repo';

/** Resources that can be fetched for a subject. */
export type Resource = 'followers' | 'repos' | 'repo';

export type OutputFormat = 'table' | 'json';

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
}

export interface CommandResult {
  /** Machine-readable result used when --format json is active. */
  json: unknown;
  /** Human-readable result used when --format table is active. */
  text: string;
  warnings: string[];
}
