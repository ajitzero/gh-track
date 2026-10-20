/** NO_COLOR-aware ANSI helpers. */

import type { Colors, OutputFormat } from '../types.js';

const RESET = '\u001b[0m';

export interface ColorDecisionInput {
  noColor: boolean;
  format: OutputFormat;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function shouldUseColor(input: ColorDecisionInput): boolean {
  if (input.noColor || input.env.NO_COLOR !== undefined) {
    return false;
  }
  return input.format === 'table' && input.stdoutIsTTY;
}

export function createColors(enabled: boolean): Colors {
  const wrap = (code: string) => (text: string) =>
    enabled ? `\u001b[${code}m${text}${RESET}` : text;

  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    blue: wrap('94'),
    magenta: wrap('95'),
  };
}
