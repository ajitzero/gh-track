/** Result constructors shared by command implementations. */

import { UsageError } from './errors.js';
import type { CommandContext, CommandResult } from './types.js';

export function cancelled(): CommandResult {
  return {
    json: { cancelled: true },
    text: 'Cancelled.\n',
    warnings: [],
  };
}

export function requirePrompt(
  context: Pick<CommandContext, 'canPrompt'>,
  action: string,
  usage: string,
): void {
  if (!context.canPrompt) {
    throw new UsageError(`${action} requires an interactive terminal. Use: ${usage}`);
  }
}
