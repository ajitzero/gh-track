/** Removes credentials from text that may be printed to a terminal or a log. */

export const REDACTED = '[redacted]';

/** Replaces every occurrence of each secret with a fixed marker. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.replaceAll(secret, REDACTED);
    }
  }
  return output;
}

/**
 * Secrets that can be identified before the config is loaded: an explicit
 * `--token` value and the default `GH_TOKEN` environment variable.
 */
export function invocationSecrets(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const found: string[] = [];
  const envToken = env.GH_TOKEN;
  if (envToken !== undefined && envToken.length > 0) {
    found.push(envToken);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === '--') {
      break;
    }
    if (token === '--token') {
      const value = argv[index + 1];
      if (value !== undefined && value.length > 0) {
        found.push(value);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('--token=')) {
      const value = token.slice('--token='.length);
      if (value.length > 0) {
        found.push(value);
      }
    }
  }

  return [...new Set(found)];
}
