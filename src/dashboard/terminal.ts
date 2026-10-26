/** Node TTY adapter and dependency-free clipboard support for the dashboard. */

import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';

import type { DashboardKeypress, DashboardTerminal, OpenUrlResult } from '../types.js';

interface ClipboardCommand {
  command: string;
  args: string[];
}

interface OpenCommand {
  command: string;
  args: string[];
  /** Human-readable name used in status messages. */
  opener: string;
}

function clipboardCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }
  if (platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

async function tryClipboardCommand(command: ClipboardCommand, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.command, command.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin?.on('error', () => resolve(false));
    child.stdin?.end(text, 'utf8');
  });
}

function openCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [url], opener: 'open' };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url], opener: 'start' };
  }
  return { command: 'xdg-open', args: [url], opener: 'xdg-open' };
}

interface LaunchOutcome {
  ok: boolean;
  missing: boolean;
}

async function tryOpenCommand(command: OpenCommand): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: LaunchOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.command, command.args, {
        stdio: 'ignore',
        detached: true,
      });
    } catch (error) {
      settle({ ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' });
      return;
    }
    child.once('error', (error) => {
      settle({ ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' });
    });
    // Success means the opener launched, not that the browser has closed.
    child.once('spawn', () => {
      child.unref();
      settle({ ok: true, missing: false });
    });
  });
}

/** Hands a URL to the platform opener without waiting for the browser to close. */
export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runCommand: (command: OpenCommand) => Promise<LaunchOutcome> = tryOpenCommand,
): Promise<OpenUrlResult> {
  const command = openCommand(platform, url);
  const outcome = await runCommand(command);
  return { opened: outcome.ok, opener: command.opener, missing: outcome.missing };
}

export function osc52ClipboardSequence(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return `\u001b]52;c;${encoded}\u0007`;
}

export async function copyToSystemClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  osc52?: (sequence: string) => void,
  runCommand: (command: ClipboardCommand, value: string) => Promise<boolean> = tryClipboardCommand,
): Promise<boolean> {
  for (const command of clipboardCommands(platform)) {
    if (await runCommand(command, text)) {
      return true;
    }
  }

  if (osc52 === undefined) {
    return false;
  }
  osc52(osc52ClipboardSequence(text));
  return true;
}

/** Adapter around process.stdin/stdout, constructed only for the CLI process. */
export function createProcessDashboardTerminal(): DashboardTerminal {
  let entered = false;
  return {
    get rows() {
      return process.stdout.rows ?? 24;
    },
    enter() {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      entered = true;
      try {
        process.stdin.resume();
        process.stdout.write('\u001b[?1049h\u001b[?25l\u001b[?7l');
      } catch (error) {
        try {
          this.leave();
        } catch {
          // Preserve the original terminal entry error after attempting cleanup.
        }
        throw error;
      }
    },
    leave() {
      try {
        if (entered) {
          process.stdout.write('\u001b[?7h\u001b[?25h\u001b[?1049l');
        }
      } finally {
        if (process.stdin.isTTY) {
          try {
            process.stdin.setRawMode(false);
          } finally {
            process.stdin.pause();
          }
        }
        entered = false;
      }
    },
    write(text) {
      process.stdout.write(text);
    },
    onKeypress(listener: (key: DashboardKeypress) => void) {
      const handler = (sequence: string, key: { name?: string; ctrl?: boolean }): void => {
        listener({
          name: key.name ?? sequence,
          sequence,
          ctrl: key.ctrl === true,
        });
      };
      process.stdin.on('keypress', handler);
      return () => process.stdin.removeListener('keypress', handler);
    },
    onResize(listener) {
      process.stdout.on('resize', listener);
      return () => process.stdout.removeListener('resize', listener);
    },
    async copy(text) {
      return copyToSystemClipboard(text, process.platform, (sequence) => {
        process.stdout.write(sequence);
      });
    },
    async open(url) {
      return openInBrowser(url, process.platform);
    },
  };
}
