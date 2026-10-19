/** Typed domain errors and their process exit codes. */

export type ErrorCode =
  | 'usage'
  | 'config_invalid'
  | 'config_missing'
  | 'empty_watchlist'
  | 'invalid_subject'
  | 'unknown_subject'
  | 'run_not_found'
  | 'not_enough_runs'
  | 'invalid_range'
  | 'no_history'
  | 'rate_limited'
  | 'network'
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
  run_not_found: 1,
  not_enough_runs: 1,
  invalid_range: 2,
  no_history: 1,
  rate_limited: 3,
  network: 1,
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

export function httpError(status: number, message: string, details?: ErrorDetails): CliError {
  return new CliError('http_error', message, { status, ...(details ?? {}) });
}

/** A command that is registered for help but whose milestone has not landed. */
export function notImplemented(command: string, milestone: number): CliError {
  return new CliError(
    'internal',
    `The "${command}" command is not implemented yet in this build.`,
    { command, milestone },
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
