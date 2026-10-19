/** XDG path resolution and run-path helpers. */

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface PathOverrides {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  config?: string;
  dataDir?: string;
}

export interface ResolvedPaths {
  configPath: string;
  dataDir: string;
}

type PathImpl = typeof path.posix;

function pathImpl(platform: NodeJS.Platform): PathImpl {
  return platform === 'win32' ? path.win32 : path.posix;
}

function absoluteEnvPath(value: string | undefined, impl: PathImpl): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return impl.isAbsolute(value) ? value : undefined;
}

function expandHome(value: string, home: string, impl: PathImpl): string {
  if (value === '~') {
    return home;
  }
  if (value.startsWith(`~${impl.sep}`)) {
    return impl.join(home, value.slice(2));
  }
  return value;
}

function resolveOverride(value: string, home: string, cwd: string, impl: PathImpl): string {
  return impl.resolve(cwd, expandHome(value, home, impl));
}

function configHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  impl: PathImpl,
): string {
  if (platform === 'win32') {
    const appData = absoluteEnvPath(env.APPDATA, impl);
    return appData ?? impl.join(home, 'AppData', 'Roaming');
  }
  return absoluteEnvPath(env.XDG_CONFIG_HOME, impl) ?? impl.join(home, '.config');
}

function dataHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  impl: PathImpl,
): string {
  if (platform === 'win32') {
    const localAppData = absoluteEnvPath(env.LOCALAPPDATA, impl);
    return localAppData ?? impl.join(home, 'AppData', 'Local');
  }
  return absoluteEnvPath(env.XDG_DATA_HOME, impl) ?? impl.join(home, '.local', 'share');
}

/**
 * Resolves config and data locations.
 *
 * Data:   --data-dir -> $XDG_DATA_HOME/gh-track -> ~/.local/share/gh-track
 * Config: --config   -> $XDG_CONFIG_HOME/gh-track/config.toml -> ~/.config/gh-track/config.toml
 */
export function resolvePaths(overrides: PathOverrides = {}): ResolvedPaths {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? os.homedir();
  const cwd = overrides.cwd ?? process.cwd();
  const impl = pathImpl(platform);

  const configPath =
    overrides.config !== undefined
      ? resolveOverride(overrides.config, home, cwd, impl)
      : impl.join(configHome(env, platform, home, impl), 'gh-track', 'config.toml');

  const dataDir =
    overrides.dataDir !== undefined
      ? resolveOverride(overrides.dataDir, home, cwd, impl)
      : impl.join(dataHome(env, platform, home, impl), 'gh-track');

  return { configPath, dataDir };
}

export function runsDir(dataDir: string): string {
  return path.join(dataDir, 'runs');
}

export function stateDir(dataDir: string): string {
  return path.join(dataDir, 'state');
}

export function locksDir(dataDir: string): string {
  return path.join(dataDir, 'locks');
}

export function historyDir(dataDir: string): string {
  return path.join(dataDir, 'history');
}

export function historyReposDir(dataDir: string): string {
  return path.join(historyDir(dataDir), 'repos');
}

export function historyUsersDir(dataDir: string): string {
  return path.join(historyDir(dataDir), 'users');
}

export function runDir(dataDir: string, id: string): string {
  assertRunId(id);
  return path.join(runsDir(dataDir), id);
}

export function tempRunDir(dataDir: string, id: string): string {
  assertRunId(id);
  return path.join(runsDir(dataDir), `.tmp-${id}`);
}

const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function assertRunId(id: string): void {
  if (!isValidRunId(id)) {
    throw new Error(`Invalid run id: ${id}`);
  }
}

/** Formats a Date as an ISO-8601 UTC run id, e.g. 2026-10-19T21-30-05Z. */
export function formatRunId(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(':', '-') + 'Z';
}

/** Creates a directory with the private mode used for runtime data. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
