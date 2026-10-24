/** Shared GitHub auth and client construction for commands that call the API. */

import type { CommandContext, Config } from '../types.js';
import { VERSION } from '../version.js';
import { GitHubClient } from './client.js';

/** `--token` wins, then the env var named by `defaults.token_env`. */
export function resolveToken(context: CommandContext, tokenEnv: string): string | undefined {
  const explicit = context.options.get('token');
  if (explicit !== undefined) {
    return explicit;
  }
  if (tokenEnv.length === 0) {
    return undefined;
  }
  const fromEnv = context.env[tokenEnv];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Builds a client configured from the command context and config defaults. */
export function createGitHubClient(
  context: CommandContext,
  config: Config,
  token: string | undefined,
  warnings: string[],
): GitHubClient {
  return new GitHubClient({
    token,
    timeoutMs: config.defaults.requestTimeoutMs,
    maxRetries: config.defaults.maxRetries,
    userAgent: `gh-track/${VERSION}`,
    fetchImpl: context.fetchImpl,
    sleep: context.sleepImpl,
    onDiagnostic: (message) => {
      if (context.verbose) {
        warnings.push(message);
      }
    },
  });
}
