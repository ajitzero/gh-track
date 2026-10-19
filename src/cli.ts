#!/usr/bin/env node
/** CLI entry point: global flags, dispatch, and exit-code mapping. */

import { realpathSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderHelpCommand } from './commands/help.js';
import { runCompact } from './commands/compact.js';
import { runExport } from './commands/export.js';
import { runFetch } from './commands/fetch.js';
import { runRuns } from './commands/runs.js';
import { runWatch } from './commands/watch.js';
import {
  CliError,
  UsageError,
  notImplemented,
  toCliError,
} from './errors.js';
import { renderHelp } from './help.js';
import { createColors, shouldUseColor } from './output/color.js';
import { renderJson } from './output/json.js';
import { createPrompts } from './prompts/index.js';
import { canPrompt } from './prompts/gate.js';
import { resolvePaths, type PathOverrides } from './store/paths.js';
import type {
  CommandContext,
  CommandResult,
  OutputFormat,
  OptionBag,
  PromptApi,
} from './types.js';
import { VERSION } from './version.js';

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  home: string;
  prompts: PromptApi;
  /** Injectable HTTP implementation, used by tests. */
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Injectable retry delay, used by tests. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
}

export interface RunOptions {
  /** Aborted on SIGINT. */
  signal?: AbortSignal | undefined;
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
];

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
  'no-color',
  'yes',
  'verbose',
  'help',
  'version',
]);

const COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  fetch: new Set([
    'dry-run',
    'max-requests',
    'resume',
    'no-compact',
    'keep-raw-days',
    'token',
  ]),
  watch: new Set(['resources']),
  runs: new Set(['limit']),
  diff: new Set(['from', 'to', 'subject']),
  compact: new Set(['dry-run', 'keep-days']),
  export: new Set(['subject', 'from', 'to']),
  help: new Set(),
};

const KNOWN_COMMANDS = new Set(Object.keys(COMMAND_OPTIONS));

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
  signal: AbortSignal | undefined,
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
    env: io.env,
    signal,
    fetchImpl: io.fetchImpl,
    sleepImpl: io.sleepImpl,
  };
}

function emit(result: CommandResult, format: OutputFormat, io: CliIO): void {
  for (const warning of result.warnings) {
    io.stderr(`${warning}\n`);
  }
  if (format === 'json') {
    io.stdout(renderJson(result.json));
    return;
  }
  io.stdout(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
}

function renderError(
  error: CliError,
  format: OutputFormat,
  verbose: boolean,
  io: CliIO,
): void {
  if (format === 'json') {
    const body: Record<string, unknown> = {
      code: error.code,
      message: error.message,
    };
    if (error.details !== undefined) {
      body.details = error.details;
    }
    io.stderr(renderJson({ error: body }));
    return;
  }

  io.stderr(`gh-track: ${error.code}: ${error.message}\n`);
  if (error instanceof UsageError && error.showUsage) {
    const help = renderHelp([]);
    if (help !== null) {
      io.stderr(help);
    }
  }
  if (verbose && error.stack !== undefined) {
    io.stderr(`${error.stack}\n`);
  }
}

export async function run(
  argv: readonly string[],
  io: CliIO,
  runOptions: RunOptions = {},
): Promise<number> {
  let format = peekFormat(argv);
  const verbose = argv.includes('--verbose');

  try {
    if (hasHelpFlag(argv)) {
      const path = helpPath(argv);
      const rendered = renderHelp(path);
      if (rendered === null) {
        throw new UsageError(`Unknown command: ${path.join(' ')}`, { showUsage: true });
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
    const command = parsed.positionals[0];
    const rest = parsed.positionals.slice(1);

    if (command !== undefined && !KNOWN_COMMANDS.has(command)) {
      throw new UsageError(`Unknown command: ${command}`, { showUsage: true });
    }

    validateOptions(command, options);
    format = resolveFormat(command, options.get('format'));

    if (command === undefined) {
      io.stdout(renderHelp([]) ?? '');
      return 0;
    }

    if (command === 'help') {
      io.stdout(renderHelpCommand(rest));
      return 0;
    }

    if (command === 'watch') {
      const context = buildContext(io, options, rest, format, runOptions.signal);
      const result = await runWatch(context);
      emit(result, format, io);
      return result.exitCode ?? 0;
    }

    if (command === 'fetch') {
      const context = buildContext(io, options, rest, format, runOptions.signal);
      const result = await runFetch(context);
      emit(result, format, io);
      return result.exitCode ?? 0;
    }

    if (command === 'runs') {
      const context = buildContext(io, options, rest, format, runOptions.signal);
      const result = await runRuns(context);
      emit(result, format, io);
      return result.exitCode ?? 0;
    }

    if (command === 'compact') {
      const context = buildContext(io, options, rest, format, runOptions.signal);
      const result = await runCompact(context);
      emit(result, format, io);
      return result.exitCode ?? 0;
    }

    if (command === 'export') {
      const context = buildContext(io, options, rest, format, runOptions.signal);
      const result = await runExport(context);
      emit(result, format, io);
      return result.exitCode ?? 0;
    }

    throw notImplemented(command, 5);
  } catch (error) {
    const cliError = toCliError(error);
    renderError(cliError, format, verbose, io);
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
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: os.homedir(),
    prompts: createPrompts(),
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
        process.stderr.write(`${error.stack}\n`);
      }
      process.exitCode = 1;
    },
  );
}
