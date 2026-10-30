#!/usr/bin/env node
/** CLI entry point: global flags, dispatch, and exit-code mapping. */

import { realpathSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCompact } from './commands/compact.js';
import { runDashboard } from './commands/dashboard.js';
import { runDiff } from './commands/diff.js';
import { runExport } from './commands/export.js';
import { runFetch } from './commands/fetch.js';
import { renderHelpCommand, unknownCommandError } from './commands/help.js';
import { runRuns } from './commands/runs.js';
import { runTrack } from './commands/track.js';
import { runWatch } from './commands/watch.js';
import { createProcessDashboardTerminal } from './dashboard/terminal.js';
import { CliError, UsageError, toCliError } from './errors.js';
import { renderHelp } from './help.js';
import { createColors, shouldUseColor } from './output/color.js';
import { renderJson } from './output/json.js';
import { resolveOutputWidth } from './output/width.js';
import { canPrompt } from './prompts/gate.js';
import { createPrompts } from './prompts/index.js';
import { invocationSecrets, redactSecrets } from './redact.js';
import { resolvePaths, type PathOverrides } from './store/paths.js';
import type {
  CommandContext,
  CommandResult,
  OutputFormat,
  OptionBag,
  PromptApi,
  DashboardTerminal,
} from './types.js';
import { VERSION } from './version.js';

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  /** `process.stdout.columns` when available; tests usually leave it absent. */
  stdoutColumns?: number | undefined;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  home: string;
  prompts: PromptApi;
  dashboardTerminal?: DashboardTerminal | undefined;
  /** Injectable HTTP implementation, used by tests. */
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Injectable retry delay, used by tests. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

export interface RunOptions {
  /** Aborted on SIGINT. */
  signal?: AbortSignal | undefined;
  /** Fixed instant for relative references; tests use this for determinism. */
  now?: Date | undefined;
}

type ValueKind = 'required' | 'optional' | 'none';

interface OptionSpec {
  name: string;
  flags: readonly string[];
  value: ValueKind;
  repeatable?: boolean;
}

const OPTION_SPECS: readonly OptionSpec[] = [
  { name: 'config', flags: ['--config'], value: 'required' },
  { name: 'data-dir', flags: ['--data-dir'], value: 'required' },
  { name: 'format', flags: ['--format'], value: 'required' },
  { name: 'width', flags: ['--width'], value: 'required' },
  { name: 'no-color', flags: ['--no-color'], value: 'none' },
  { name: 'yes', flags: ['--yes'], value: 'none' },
  { name: 'verbose', flags: ['--verbose'], value: 'none' },
  { name: 'help', flags: ['-h', '--help'], value: 'none' },
  { name: 'version', flags: ['-V', '--version'], value: 'none' },
  { name: 'resources', flags: ['--resources'], value: 'required' },
  { name: 'dry-run', flags: ['--dry-run'], value: 'none' },
  { name: 'max-requests', flags: ['--max-requests'], value: 'required' },
  { name: 'resume', flags: ['--resume'], value: 'optional' },
  { name: 'no-compact', flags: ['--no-compact'], value: 'none' },
  { name: 'keep-raw-days', flags: ['--keep-raw-days'], value: 'required' },
  { name: 'token', flags: ['--token'], value: 'required' },
  { name: 'limit', flags: ['--limit'], value: 'required' },
  { name: 'from', flags: ['--from'], value: 'required' },
  { name: 'to', flags: ['--to'], value: 'required' },
  { name: 'subject', flags: ['--subject'], value: 'required', repeatable: true },
  { name: 'keep-days', flags: ['--keep-days'], value: 'required' },
  { name: 'view', flags: ['--view'], value: 'required' },
  { name: 'layout', flags: ['--layout'], value: 'required' },
  { name: 'metrics', flags: ['--metrics'], value: 'required' },
  { name: 'item', flags: ['--item'], value: 'required', repeatable: true },
  { name: 'no-interactive', flags: ['--no-interactive'], value: 'none' },
];

/** Flags that used to exist; keep their removal errors actionable. */
const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  '--setup': 'The --setup flag has been removed. Use: gh-track dashboard add',
};

const LONG_FLAGS = new Map<string, OptionSpec>();
const SHORT_FLAGS = new Map<string, OptionSpec>();
for (const spec of OPTION_SPECS) {
  for (const flag of spec.flags) {
    if (flag.startsWith('--')) {
      LONG_FLAGS.set(flag, spec);
    } else {
      SHORT_FLAGS.set(flag, spec);
    }
  }
}

const GLOBAL_OPTIONS = new Set([
  'config',
  'data-dir',
  'format',
  'width',
  'no-color',
  'yes',
  'verbose',
  'help',
  'version',
]);

const COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  fetch: new Set(['dry-run', 'max-requests', 'resume', 'no-compact', 'keep-raw-days', 'token']),
  watch: new Set(['resources']),
  runs: new Set(['limit']),
  diff: new Set(['from', 'to', 'subject']),
  compact: new Set(['dry-run', 'keep-days']),
  export: new Set(['subject', 'from', 'to']),
  dashboard: new Set([
    'view',
    'layout',
    'from',
    'to',
    'subject',
    'metrics',
    'resources',
    'token',
    'no-interactive',
  ]),
  track: new Set(['item', 'layout', 'from', 'to']),
  help: new Set(),
};

const KNOWN_COMMANDS = new Set(Object.keys(COMMAND_OPTIONS));

/** Command used when the invocation names none. */
const DEFAULT_COMMAND = 'dashboard';

type CommandRunner = (context: CommandContext) => Promise<CommandResult>;

/** Single dispatch table; `help` is handled before the table is consulted. */
const COMMAND_RUNNERS: Readonly<Record<string, CommandRunner>> = {
  fetch: runFetch,
  watch: runWatch,
  runs: runRuns,
  compact: runCompact,
  export: runExport,
  diff: runDiff,
  dashboard: runDashboard,
  track: runTrack,
};

class ParsedOptionBag implements OptionBag {
  private readonly values: Map<string, string[]>;

  constructor(values: Map<string, string[]>) {
    this.values = values;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  get(name: string): string | undefined {
    const values = this.values.get(name);
    if (values === undefined || values.length === 0) {
      return undefined;
    }
    return values[values.length - 1];
  }

  getAll(name: string): readonly string[] {
    return this.values.get(name) ?? [];
  }

  names(): IterableIterator<string> {
    return this.values.keys();
  }
}

interface ParsedArgs {
  options: Map<string, string[]>;
  positionals: string[];
}

function addOption(options: Map<string, string[]>, spec: OptionSpec, value: string): void {
  if (spec.repeatable === true) {
    const values = options.get(spec.name) ?? [];
    values.push(value);
    options.set(spec.name, values);
    return;
  }
  options.set(spec.name, [value]);
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const options = new Map<string, string[]>();
  const positionals: string[] = [];
  let index = 0;
  let endOfOptions = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      break;
    }

    if (endOfOptions) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      endOfOptions = true;
      continue;
    }

    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const flag = equals >= 0 ? token.slice(0, equals) : token;
      const inlineValue = equals >= 0 ? token.slice(equals + 1) : undefined;
      const spec = LONG_FLAGS.get(flag);
      if (spec === undefined) {
        const removed = REMOVED_FLAGS[flag];
        if (removed !== undefined) {
          throw new UsageError(removed);
        }
        throw new UsageError(`Unknown option: ${flag}`);
      }

      if (spec.value === 'none') {
        if (inlineValue !== undefined) {
          throw new UsageError(`Option ${flag} does not take a value`);
        }
        if (!options.has(spec.name)) {
          options.set(spec.name, ['']);
        }
        continue;
      }

      let value: string;
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) {
          throw new UsageError(`Option ${flag} requires a value`);
        }
        value = inlineValue;
      } else {
        const next = argv[index];
        const nextIsValue = next !== undefined && (!next.startsWith('-') || next === '-');
        if (spec.value === 'required') {
          if (!nextIsValue || next === undefined) {
            if (next !== undefined && /^-\d+[dwmy]$/i.test(next)) {
              throw new UsageError(
                `Relative offsets no longer use a leading "-": use ${next.slice(1)}.`,
              );
            }
            throw new UsageError(`Option ${flag} requires a value`);
          }
          value = next;
          index += 1;
        } else if (nextIsValue && next !== undefined) {
          value = next;
          index += 1;
        } else {
          value = '';
        }
      }

      addOption(options, spec, value);
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const spec = SHORT_FLAGS.get(token);
      if (spec === undefined) {
        throw new UsageError(`Unknown option: ${token}`);
      }
      if (spec.value !== 'none') {
        throw new UsageError(`Option ${token} requires a value`);
      }
      if (!options.has(spec.name)) {
        options.set(spec.name, ['']);
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes('-h') || argv.includes('--help');
}

function hasVersionFlag(argv: readonly string[]): boolean {
  return argv.includes('-V') || argv.includes('--version');
}

/**
 * Extracts positional tokens while ignoring option values. Used only to find
 * the help level; unknown options are tolerated so `--help` always wins.
 */
function collectPositionals(argv: readonly string[]): string[] {
  const positionals: string[] = [];
  let index = 0;
  let endOfOptions = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      break;
    }
    if (endOfOptions) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const flag = equals >= 0 ? token.slice(0, equals) : token;
      const spec = LONG_FLAGS.get(flag);
      if (equals < 0 && spec !== undefined && spec.value === 'required') {
        index += 1;
      } else if (equals < 0 && spec !== undefined && spec.value === 'optional') {
        const next = argv[index];
        if (next !== undefined && !next.startsWith('-')) {
          index += 1;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      continue;
    }
    positionals.push(token);
  }

  return positionals;
}

function helpPath(argv: readonly string[]): string[] {
  const positionals = collectPositionals(argv);
  return positionals[0] === 'help' ? positionals.slice(1) : positionals;
}

function peekFormat(argv: readonly string[]): OutputFormat {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === '--') {
      break;
    }
    if (token === '--format') {
      value = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      value = token.slice('--format='.length);
    }
  }
  return value === 'json' ? 'json' : 'table';
}

function peekWidth(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === '--') {
      break;
    }
    if (token === '--width') {
      value = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--width=')) {
      value = token.slice('--width='.length);
    }
  }
  return value;
}

/** Help tolerates a malformed `--width`; the renderer falls back to its natural layout. */
function helpWidth(argv: readonly string[], io: CliIO): number | undefined {
  try {
    return resolveOutputWidth({
      override: peekWidth(argv),
      env: io.env,
      stdoutIsTTY: io.stdoutIsTTY,
      columns: io.stdoutColumns,
    });
  } catch {
    return undefined;
  }
}

function resolveFormat(command: string | undefined, value: string | undefined): OutputFormat {
  if (command === 'export') {
    const format = value ?? 'jsonl';
    if (format === 'json' || format === 'jsonl' || format === 'csv') {
      return format;
    }
    throw new UsageError(
      `Unsupported --format value: ${format}. Expected json, jsonl, or csv for export.`,
    );
  }

  const format = value ?? 'table';
  if (format === 'table' || format === 'json') {
    return format;
  }
  throw new UsageError(`Unsupported --format value: ${format}. Expected table or json.`);
}

function validateOptions(command: string | undefined, options: ParsedOptionBag): void {
  const allowed = command === undefined ? undefined : COMMAND_OPTIONS[command];
  for (const name of options.names()) {
    if (GLOBAL_OPTIONS.has(name)) {
      continue;
    }
    if (allowed !== undefined && allowed.has(name)) {
      continue;
    }
    const target = command === undefined ? 'this invocation' : `'${command}'`;
    throw new UsageError(`Option --${name} is not valid for ${target}`);
  }
}

function buildContext(
  io: CliIO,
  options: ParsedOptionBag,
  positionals: string[],
  format: OutputFormat,
  runOptions: RunOptions,
): CommandContext {
  const overrides: PathOverrides = {
    env: io.env,
    platform: io.platform,
    home: io.home,
    cwd: io.cwd,
  };
  const configPath = options.get('config');
  if (configPath !== undefined) {
    overrides.config = configPath;
  }
  const dataDir = options.get('data-dir');
  if (dataDir !== undefined) {
    overrides.dataDir = dataDir;
  }

  const paths = resolvePaths(overrides);
  const yes = options.has('yes');
  const outputWidth = resolveOutputWidth({
    override: options.get('width'),
    env: io.env,
    stdoutIsTTY: io.stdoutIsTTY,
    columns: io.stdoutColumns,
  });
  const colors = createColors(
    shouldUseColor({
      noColor: options.has('no-color'),
      format,
      stdoutIsTTY: io.stdoutIsTTY,
      env: io.env,
    }),
  );

  return {
    positionals,
    options,
    paths,
    format,
    colors,
    yes,
    verbose: options.has('verbose'),
    canPrompt: canPrompt({
      stdinIsTTY: io.stdinIsTTY,
      stdoutIsTTY: io.stdoutIsTTY,
      format,
      yes,
    }),
    prompts: io.prompts,
    ...(io.dashboardTerminal === undefined ? {} : { dashboardTerminal: io.dashboardTerminal }),
    outputWidth,
    env: io.env,
    signal: runOptions.signal,
    ...(runOptions.now === undefined ? {} : { now: runOptions.now }),
    fetchImpl: io.fetchImpl,
    sleepImpl: io.sleepImpl,
  };
}

function emit(
  result: CommandResult,
  format: OutputFormat,
  io: CliIO,
  secrets: readonly string[],
): void {
  for (const warning of result.warnings) {
    io.stderr(`${redactSecrets(warning, secrets)}\n`);
  }
  if (format === 'json') {
    io.stdout(redactSecrets(renderJson(result.json), secrets));
    return;
  }
  if (result.suppressTableOutput === true) {
    return;
  }
  const text = result.text.endsWith('\n') ? result.text : `${result.text}\n`;
  io.stdout(redactSecrets(text, secrets));
}

function renderError(
  error: CliError,
  format: OutputFormat,
  verbose: boolean,
  io: CliIO,
  secrets: readonly string[],
  width?: number | undefined,
): void {
  if (format === 'json') {
    const body: Record<string, unknown> = {
      code: error.code,
      message: error.message,
    };
    if (error.details !== undefined) {
      body.details = error.details;
    }
    io.stderr(redactSecrets(renderJson({ error: body }), secrets));
    return;
  }

  io.stderr(redactSecrets(`gh-track: ${error.code}: ${error.message}\n`, secrets));
  if (error instanceof UsageError && error.showUsage) {
    const help = renderHelp([], { width });
    if (help !== null) {
      io.stderr(help);
    }
  }
  if (verbose && error.stack !== undefined) {
    io.stderr(redactSecrets(`${error.stack}\n`, secrets));
  }
}

export async function run(
  argv: readonly string[],
  io: CliIO,
  runOptions: RunOptions = {},
): Promise<number> {
  let format = peekFormat(argv);
  const verbose = argv.includes('--verbose');
  const secrets = invocationSecrets(argv, io.env);
  const renderWidth = helpWidth(argv, io);

  try {
    if (hasHelpFlag(argv)) {
      const path = helpPath(argv);
      const rendered = renderHelp(path, { width: renderWidth });
      if (rendered === null) {
        throw unknownCommandError(path);
      }
      io.stdout(rendered);
      return 0;
    }

    if (hasVersionFlag(argv)) {
      io.stdout(`gh-track ${VERSION}\n`);
      return 0;
    }

    const parsed = parseArgv(argv);
    const options = new ParsedOptionBag(parsed.options);
    const requestedCommand = parsed.positionals[0];
    const command = requestedCommand ?? DEFAULT_COMMAND;
    const rest = requestedCommand === undefined ? [] : parsed.positionals.slice(1);

    if (requestedCommand !== undefined && !KNOWN_COMMANDS.has(requestedCommand)) {
      throw unknownCommandError([requestedCommand]);
    }

    validateOptions(command, options);
    format = resolveFormat(command, options.get('format'));

    if (command === 'help') {
      io.stdout(renderHelpCommand(rest, renderWidth));
      return 0;
    }

    const runner = COMMAND_RUNNERS[command];
    if (runner === undefined) {
      throw new CliError('internal', `Unhandled command: ${command}`);
    }

    const context = buildContext(io, options, rest, format, runOptions);
    const result = await runner(context);
    emit(result, format, io, secrets);
    return result.exitCode ?? 0;
  } catch (error) {
    const cliError = toCliError(error);
    renderError(cliError, format, verbose, io, secrets, renderWidth);
    return cliError.exitCode;
  }
}

function createProcessIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdoutColumns: process.stdout.columns,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: os.homedir(),
    prompts: createPrompts(),
    dashboardTerminal: createProcessDashboardTerminal(),
  };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      controller.abort();
      return;
    }
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  void run(process.argv.slice(2), createProcessIO(), { signal: controller.signal }).then(
    (code) => {
      process.removeListener('SIGINT', onSigint);
      process.exitCode = code;
    },
    (error: unknown) => {
      process.removeListener('SIGINT', onSigint);
      process.stderr.write('gh-track: internal: unexpected failure\n');
      if (error instanceof Error && error.stack !== undefined) {
        const secrets = invocationSecrets(process.argv, process.env);
        process.stderr.write(`${redactSecrets(error.stack, secrets)}\n`);
      }
      process.exitCode = 1;
    },
  );
}
