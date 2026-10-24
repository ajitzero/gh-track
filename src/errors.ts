/** Typed domain errors and their process exit codes. */

export type ErrorCode =
  | 'usage'
  | 'config_invalid'
  | 'config_missing'
  | 'empty_watchlist'
  | 'invalid_subject'
  | 'unknown_subject'
  | 'unknown_view'
  | 'no_selection'
  | 'run_not_found'
  | 'not_enough_runs'
  | 'invalid_range'
  | 'no_history'
  | 'rate_limited'
  | 'network'
  | 'refused_url'
  | 'http_error'
  | 'io_error'
  | 'locked'
  | 'interrupted'
  | 'internal';

export type ErrorDetails = Record<string, unknown>;

const EXIT_CODES: Record<ErrorCode, number> = {
  usage: 2,
  config_invalid: 2,
  config_missing: 2,
  empty_watchlist: 2,
  invalid_subject: 2,
  unknown_subject: 2,
  unknown_view: 2,
  no_selection: 2,
  run_not_found: 1,
  not_enough_runs: 1,
  invalid_range: 2,
  no_history: 1,
  rate_limited: 3,
  network: 1,
  refused_url: 1,
  http_error: 1,
  io_error: 1,
  locked: 1,
  interrupted: 130,
  internal: 1,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, exitCode?: number) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode ?? EXIT_CODES[code];
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface UsageErrorOptions {
  details?: ErrorDetails;
  /** Print root usage to stderr after the message in table mode. */
  showUsage?: boolean;
}

export class UsageError extends CliError {
  readonly showUsage: boolean;

  constructor(message: string, options: UsageErrorOptions = {}) {
    super('usage', message, options.details);
    this.name = 'UsageError';
    this.showUsage = options.showUsage ?? false;
  }
}

export function configInvalid(message: string, details?: ErrorDetails): CliError {
  return new CliError('config_invalid', message, details);
}

export function configMissing(path: string): CliError {
  return new CliError('config_missing', `Config file not found: ${path}`, { path });
}

export function invalidSubject(input: string): CliError {
  return new CliError('invalid_subject', `Invalid subject: ${JSON.stringify(input)}`, { input });
}

export function unknownSubject(subject: string): CliError {
  return new CliError('unknown_subject', `Subject is not in the watchlist: ${subject}`, { subject });
}

export function unknownView(name: string): CliError {
  return new CliError('unknown_view', `Dashboard view not found: ${name}`, { view: name });
}

export function noSelection(message: string, details?: ErrorDetails): CliError {
  return new CliError('no_selection', message, details);
}

export function emptyWatchlist(): CliError {
  return new CliError(
    'empty_watchlist',
    "The watchlist is empty. Add a subject with 'gh-track watch add user <login>' or 'gh-track watch add repo <owner/name>'.",
  );
}

export function rateLimited(resumeAfter?: string): CliError {
  const message =
    resumeAfter === undefined
      ? 'Rate limit exhausted'
      : `Rate limit exhausted; resume after ${resumeAfter}`;
  return new CliError(
    'rate_limited',
    message,
    resumeAfter === undefined ? undefined : { resumeAfter },
  );
}

export function networkError(message: string, details?: ErrorDetails): CliError {
  return new CliError('network', message, details);
}

/** A URL outside the configured API origin. Permanent: never worth a retry. */
export function refusedUrl(url: string, apiBase: string): CliError {
  return new CliError(
    'refused_url',
    `Refusing to request a URL outside ${apiBase}: ${url}`,
    { url },
  );
}

export function httpError(status: number, message: string, details?: ErrorDetails): CliError {
  return new CliError('http_error', message, { status, ...(details ?? {}) });
}

export function githubUserNotFound(login: string): CliError {
  return new CliError('http_error', `GitHub user not found: ${login}`, { login, status: 404 });
}

export function runNotFound(runId: string): CliError {
  return new CliError('run_not_found', `Run not found: ${runId}`, { runId });
}

export function noHistory(details?: ErrorDetails): CliError {
  return new CliError(
    'no_history',
    'No compacted history matches the requested filters. Run `gh-track compact` after data ages out of the raw window.',
    details,
  );
}

export function notEnoughRuns(details?: ErrorDetails): CliError {
  return new CliError(
    'not_enough_runs',
    'At least two complete runs are required for a diff.',
    details,
  );
}

export function invalidRange(details?: ErrorDetails): CliError {
  return new CliError('invalid_range', '--from must resolve to a point before --to.', details);
}

export function locked(lockPath: string, pid: number): CliError {
  return new CliError(
    'locked',
    `Another fetch is already running (pid ${pid}). Wait for it to finish or remove ${lockPath}.`,
    { path: lockPath, pid },
  );
}

export function interrupted(): CliError {
  return new CliError('interrupted', 'Interrupted');
}

export function ioError(message: string, details?: ErrorDetails): CliError {
  return new CliError('io_error', message, details);
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return new CliError('internal', error.message);
  }
  return new CliError('internal', 'Unexpected error');
}
