/** Terminal width resolution for narrow-screen friendly output. */

import { UsageError } from '../errors.js';

/** Below this width, the dashboard stacks metrics under each subject. */
export const NARROW_TERMINAL_WIDTH = 60;

/** Smallest width the renderers honor; narrower values are clamped. */
export const MIN_TERMINAL_WIDTH = 20;

/** Largest width accepted from an override; guards against nonsense values. */
export const MAX_TERMINAL_WIDTH = 500;

export interface WidthSources {
  /** Value of `--width`, validated when present. */
  override?: string | undefined;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  /** `process.stdout.columns` when the runtime reports one. */
  columns?: number | undefined;
}

function parseWidth(raw: string, source: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TERMINAL_WIDTH) {
    throw new UsageError(
      `${source} must be an integer of at least ${MIN_TERMINAL_WIDTH}. Received ${JSON.stringify(raw)}.`,
    );
  }
  return Math.min(value, MAX_TERMINAL_WIDTH);
}

function envWidth(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.GH_TRACK_WIDTH;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  try {
    return parseWidth(raw.trim(), 'GH_TRACK_WIDTH');
  } catch {
    // A malformed environment variable is ignored; it cannot fail a command.
    return undefined;
  }
}

/**
 * Resolves the output width used to shrink tables.
 *
 * An explicit `--width` always wins, even when output is piped, and
 * `GH_TRACK_WIDTH` overrides detection for a persistent preference. Otherwise
 * a TTY reports its own width, and non-interactive output stays unbounded so
 * pipes never lose data.
 */
export function resolveOutputWidth(sources: WidthSources): number | undefined {
  const { override, env, stdoutIsTTY, columns } = sources;
  if (override !== undefined && override.trim().length > 0) {
    return parseWidth(override.trim(), '--width');
  }
  const fromEnv = envWidth(env);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (stdoutIsTTY && columns !== undefined && Number.isInteger(columns) && columns > 0) {
    return Math.max(MIN_TERMINAL_WIDTH, Math.min(columns, MAX_TERMINAL_WIDTH));
  }
  return undefined;
}

/** True when the dashboard should stack metrics instead of using a wide table. */
export function isNarrowWidth(width: number | undefined): boolean {
  return width !== undefined && width < NARROW_TERMINAL_WIDTH;
}
