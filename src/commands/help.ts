/** `gh-track help [command...]`. */

import { UsageError } from '../errors.js';
import { renderHelp } from '../help.js';

export function renderHelpCommand(path: readonly string[]): string {
  const rendered = renderHelp(path);
  if (rendered === null) {
    const topic = path.length === 0 ? '' : `: ${path.join(' ')}`;
    throw new UsageError(`Unknown help topic${topic}`);
  }
  return rendered;
}
