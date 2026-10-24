/** Consistent CLI argument and subcommand errors. */

import { UsageError } from './errors.js';

export function missingSubcommand(group: string, usage: string): UsageError {
  return new UsageError(`Missing ${group} subcommand. Use: ${usage}`);
}

export function unknownSubcommand(group: string, name: string, usage: string): UsageError {
  return new UsageError(`Unknown ${group} subcommand: ${name}. Use: ${usage}`);
}

export function unexpectedArgument(argument: string | undefined, usage?: string): UsageError {
  const suffix = usage === undefined ? '' : ` Use: ${usage}`;
  return new UsageError(`Unexpected argument ${JSON.stringify(argument)}.${suffix}`);
}

export function invalidOption(flag: string, target: string): UsageError {
  return new UsageError(`${flag} is not valid for ${target}`);
}

/**
 * Parses a positive-integer option. Returns `fallback` when the flag is absent;
 * with no fallback, absence returns undefined.
 */
export function positiveIntegerOption(
  raw: string | undefined,
  flag: string,
  fallback?: number,
): number | undefined {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a positive integer.`);
  }
  return value;
}
