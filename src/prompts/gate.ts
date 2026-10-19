/** Determines whether interactive prompts are allowed. */

import type { OutputFormat } from '../types.js';

export interface PromptGateInput {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  format: OutputFormat;
  yes: boolean;
}

export function canPrompt(input: PromptGateInput): boolean {
  return input.stdinIsTTY && input.stdoutIsTTY && input.format === 'table' && !input.yes;
}
