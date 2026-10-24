/** Interactive list controller for the dashboard TTY mode. */

import { filterDashboardRows } from './filter.js';
import { renderDashboard } from './render.js';
import { accountOf, repoOf } from '../subjects.js';
import type {
  Colors,
  DashboardKeypress,
  DashboardLayout,
  DashboardResult,
  DashboardRow,
  DashboardTerminal,
} from '../types.js';

export interface DashboardRefreshResult {
  result: DashboardResult;
  text: string;
  warnings: string[];
  exitCode?: number | undefined;
  /** Present after an add, so the controller can highlight the new row. */
  addedSubject?: string | undefined;
}

export interface InteractiveDashboardOptions {
  result: DashboardResult;
  layout: DashboardLayout;
  colors: Colors;
  terminal: DashboardTerminal;
  signal?: AbortSignal | undefined;
  /** Aborts an in-flight refresh or add fetch. */
  cancelAction?: (() => void) | undefined;
  refresh(): Promise<DashboardRefreshResult>;
  /**
   * Adds and fetches one subject. `onAdded` fires as soon as the subject is in
   * the selection, so the table can show it before the fetch finishes.
   */
  addSubject?(
    value: string,
    onAdded?: (result: DashboardResult, subject: string) => void,
  ): Promise<DashboardRefreshResult>;
}

export interface InteractiveDashboardResult {
  result: DashboardResult;
  warnings: string[];
  exitCode?: number | undefined;
}

/** One key + label pair in the footer. Keys render white, labels dim. */
interface Hint {
  key: string;
  label: string;
}

const MAIN_HINTS: readonly Hint[] = [
  { key: 'r', label: 'refresh' },
  { key: '↑↓/j k', label: 'move' },
  { key: '/', label: 'search' },
  { key: 'c', label: 'copy' },
  { key: 'a', label: 'add' },
  { key: 'q', label: 'quit' },
];

const SEARCH_HINTS: readonly Hint[] = [
  { key: 'type', label: 'filter' },
  { key: '↑↓', label: 'move' },
  { key: 'enter', label: 'keep' },
  { key: 'esc', label: 'clear' },
];

const ADD_HINTS: readonly Hint[] = [
  { key: 'type', label: 'a user, repo, or URL' },
  { key: '↑↓', label: 'move' },
  { key: 'enter', label: 'add' },
  { key: 'esc', label: 'cancel' },
];

function hintLine(colors: Colors, hints: readonly Hint[]): string {
  const separator = colors.dim(' · ');
  return hints
    .map((hint) => `${colors.white(hint.key)}${colors.dim(` ${hint.label}`)}`)
    .join(separator);
}

export function githubUrlForRow(row: DashboardRow): string {
  if (row.kind === 'user') {
    return `https://github.com/${encodeURIComponent(accountOf(row.subject))}`;
  }
  const [owner = '', name = ''] = repoOf(row.subject).split('/');
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function printable(key: DashboardKeypress): string | null {
  if (key.ctrl || key.name === 'escape' || key.name === 'return' || key.name === 'backspace') {
    return null;
  }
  if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
    return null;
  }
  return key.sequence.length > 0 && !/[\u0000-\u001f\u007f]/.test(key.sequence)
    ? key.sequence
    : null;
}

type InputMode = 'none' | 'search' | 'add';

/** Runs until Escape/q/Ctrl-C, always restoring raw and alternate-screen state. */
export async function runInteractiveDashboard(
  options: InteractiveDashboardOptions,
): Promise<InteractiveDashboardResult> {
  const { terminal, colors } = options;
  let result = options.result;
  const warnings: string[] = [];
  let query = '';
  let input = '';
  let mode: InputMode = 'none';
  let status = '';
  let busy = false;
  let busyAction: 'refresh' | 'copy' | 'add' | null = null;
  let stopped = options.signal?.aborted === true;
  let exitCode: number | undefined;
  let selectedIndex = 0;
  const queued: DashboardKeypress[] = [];
  let waiting: ((key: DashboardKeypress | null) => void) | null = null;

  const activeQuery = (): string => (mode === 'search' ? input : query);
  const rows = (): DashboardRow[] =>
    filterDashboardRows(result.rows, options.layout, activeQuery());
  const selected = (): DashboardRow | undefined => {
    const list = rows();
    return selectedIndex < 0 ? undefined : list[selectedIndex];
  };
  const clampSelection = (preferredSubject?: string): void => {
    const list = rows();
    if (list.length === 0) {
      selectedIndex = -1;
      return;
    }
    if (preferredSubject !== undefined) {
      const found = list.findIndex((row) => row.subject === preferredSubject);
      if (found >= 0) {
        selectedIndex = found;
        return;
      }
    }
    selectedIndex = Math.max(0, Math.min(selectedIndex, list.length - 1));
  };

  const draw = (): void => {
    clampSelection(selected()?.subject);
    const visibleRows = rows();
    const highlighted = selected();
    const view: DashboardResult = { ...result, rows: visibleRows };
    const filter = activeQuery();
    const rendered = renderDashboard(view, options.layout, colors, {
      interactive: true,
      highlightedSubject: highlighted?.subject,
      ...(filter.length > 0 && visibleRows.length === 0
        ? { emptyMessage: 'No matching items.' }
        : {}),
    });
    const lines = rendered.replace(/\n$/, '').split('\n');
    const cursorLine = lines.findIndex((line) => line.includes('› '));
    const contentHeight = Math.max(1, terminal.rows - 3);
    const start = cursorLine < 0
      ? 0
      : Math.max(0, Math.min(cursorLine - Math.floor(contentHeight / 2), lines.length - contentHeight));
    const viewport = lines.slice(start, start + contentHeight);
    while (viewport.length < contentHeight) {
      viewport.push('');
    }

    const inlineStatus = status.length > 0 ? colors.dim(`  ${status}`) : '';
    const statusLine = mode === 'search'
      ? `${colors.cyan(`/ ${input}`)}${inlineStatus}`
      : mode === 'add'
        ? `${colors.cyan(`add: ${input}`)}${inlineStatus}`
        : status.length > 0
          ? colors.dim(status)
          : '';
    const hints = hintLine(
      colors,
      mode === 'search' ? SEARCH_HINTS : mode === 'add' ? ADD_HINTS : MAIN_HINTS,
    );
    terminal.write(`\u001b[H\u001b[2J${viewport.join('\n')}\n${statusLine}\n${hints}`);
  };

  const cancelFetch = (): void => {
    if (busyAction === 'refresh' || busyAction === 'add') {
      options.cancelAction?.();
    }
  };
  const enqueue = (key: DashboardKeypress): void => {
    if (stopped) {
      return;
    }
    if (busy) {
      if (key.ctrl && key.name === 'c') {
        stopped = true;
        exitCode = 130;
        cancelFetch();
      } else if (mode === 'none' && key.name === 'q') {
        stopped = true;
        if (busyAction === 'refresh' || busyAction === 'add') {
          exitCode = 130;
        }
        cancelFetch();
      }
      return;
    }
    if (waiting !== null) {
      const resume = waiting;
      waiting = null;
      resume(key);
    } else {
      queued.push(key);
    }
  };
  const nextKey = (): Promise<DashboardKeypress | null> => {
    const key = queued.shift();
    if (key !== undefined) {
      return Promise.resolve(key);
    }
    if (stopped) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
  const onAbort = (): void => {
    stopped = true;
    exitCode = 130;
    cancelFetch();
    const resume = waiting;
    waiting = null;
    resume?.(null);
  };

  if (stopped) {
    return { result, warnings, exitCode: 130 };
  }

  let removeKeypress: (() => void) | undefined;
  let removeResize: (() => void) | undefined;
  let entered = false;
  try {
    terminal.enter();
    entered = true;
    removeKeypress = terminal.onKeypress(enqueue);
    removeResize = terminal.onResize(draw);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    draw();

    while (!stopped) {
      const key = await nextKey();
      if (key === null) {
        break;
      }
      status = '';
      const list = rows();
      const move = (delta: number): void => {
        if (list.length > 0) {
          selectedIndex = Math.max(0, Math.min(list.length - 1, selectedIndex + delta));
        }
      };
      const first = (): void => {
        selectedIndex = list.length > 0 ? 0 : -1;
      };
      const last = (): void => {
        selectedIndex = list.length - 1;
      };

      if (key.ctrl && key.name === 'c') {
        stopped = true;
        exitCode = 130;
        cancelFetch();
        break;
      }

      if (mode !== 'none') {
        if (key.name === 'backspace') {
          input = input.slice(0, -1);
          if (mode === 'search') {
            selectedIndex = 0;
          }
        } else if (key.name === 'up') {
          move(-1);
        } else if (key.name === 'down') {
          move(1);
        } else if (key.name === 'escape') {
          if (mode === 'search') {
            query = '';
          }
          input = '';
          mode = 'none';
          selectedIndex = 0;
        } else if (key.name === 'return') {
          if (mode === 'search') {
            query = input;
            mode = 'none';
          } else if (options.addSubject === undefined) {
            status = 'Adding is unavailable.';
            input = '';
            mode = 'none';
          } else {
            const target = input.trim();
            if (target.length === 0) {
              status = 'Enter a user or repository.';
            } else {
              busy = true;
              busyAction = 'add';
              status = `Adding ${target}…`;
              draw();
              try {
                const added = await options.addSubject(target, (partial, subject) => {
                  result = partial;
                  mode = 'none';
                  input = '';
                  query = '';
                  status = `Added ${subject}. Fetching…`;
                  clampSelection(subject);
                  draw();
                });
                result = added.result;
                warnings.push(...added.warnings);
                status = oneLine(added.text);
                query = '';
                input = '';
                mode = 'none';
                clampSelection(added.addedSubject);
              } catch (error) {
                status = oneLine(error instanceof Error ? error.message : String(error));
              } finally {
                busy = false;
                busyAction = null;
              }
              clampSelection();
              draw();
              continue;
            }
          }
        } else {
          const value = printable(key);
          if (value !== null) {
            input += value;
            if (mode === 'search') {
              selectedIndex = 0;
            }
          }
        }
        clampSelection();
        draw();
        continue;
      }

      if (key.name === 'q') {
        stopped = true;
      } else if (key.name === 'escape') {
        if (query.length > 0) {
          query = '';
          selectedIndex = 0;
        } else {
          stopped = true;
        }
      } else if (key.name === '/' || key.sequence === '/') {
        query = '';
        input = '';
        mode = 'search';
        selectedIndex = 0;
      } else if (key.name === 'a' && options.addSubject !== undefined) {
        input = '';
        mode = 'add';
      } else if (key.name === 'up' || key.name === 'k') {
        move(-1);
      } else if (key.name === 'down' || key.name === 'j') {
        move(1);
      } else if (key.name === 'home' || key.name === 'g') {
        first();
      } else if (key.name === 'end' || key.sequence === 'G') {
        last();
      } else if (key.name === 'r') {
        busy = true;
        busyAction = 'refresh';
        status = 'Fetching…';
        draw();
        const previousSubject = selected()?.subject;
        try {
          const refreshed = await options.refresh();
          result = refreshed.result;
          warnings.push(...refreshed.warnings);
          status = oneLine(refreshed.text) ||
            (refreshed.exitCode === 0 || refreshed.exitCode === undefined
              ? 'Fetch complete.'
              : `Fetch exited with status ${refreshed.exitCode}.`);
        } catch (error) {
          status = oneLine(error instanceof Error ? error.message : String(error));
        } finally {
          busy = false;
          busyAction = null;
        }
        clampSelection(previousSubject);
      } else if (key.name === 'c') {
        const item = selected();
        if (item === undefined) {
          status = 'No item selected.';
        } else {
          busy = true;
          busyAction = 'copy';
          status = 'Copying…';
          draw();
          try {
            const copied = await terminal.copy(githubUrlForRow(item));
            status = copied ? `Copied ${githubUrlForRow(item)}` : 'Clipboard unavailable.';
          } catch (error) {
            status = oneLine(error instanceof Error ? error.message : String(error));
          } finally {
            busy = false;
            busyAction = null;
          }
        }
      }

      clampSelection();
      if (!stopped) {
        draw();
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    removeKeypress?.();
    removeResize?.();
    if (entered) {
      terminal.leave();
    }
  }

  return { result, warnings, exitCode };
}
