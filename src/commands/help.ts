/** `gh-track help [command...]`. */

import { UsageError } from '../errors.js';
import { renderHelp } from '../help.js';

/** One error shape for every unknown command or help path. */
export function unknownCommandError(path: readonly string[]): UsageError {
  const label = path.join(' ');
  return new UsageError(`Unknown command: ${label}`, { showUsage: true });
}

export function renderHelpCommand(path: readonly string[], width?: number | undefined): string {
  const rendered = renderHelp(path, { width });
  if (rendered === null) {
    throw unknownCommandError(path);
  }
  return rendered;
}
