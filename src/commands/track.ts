/** `gh-track track`: manage the dashboard selection and named views. */

import { missingSubcommand, unexpectedArgument, unknownSubcommand } from '../cli-args.js';
import { loadConfig, isValidViewName, saveConfig } from '../config.js';
import { pickSelection } from '../dashboard/picker.js';
import {
  canonicalizeItems,
  mergeTracking,
  parseItems,
  parseOptionalLayout,
  toTracking,
  toViewItems,
  type SelectionItem,
} from '../dashboard/select.js';
import { emptyWatchlist, UsageError } from '../errors.js';
import { defaultMetricsFor } from '../metrics.js';
import { renderTable } from '../output/table.js';
import { classifyRangeRef, rejectPreviousTo } from '../refs.js';
import { cancelled } from '../result.js';
import { parseSubject, subjectKey, subjectKeyOf } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  DashboardLayout,
  DashboardView,
  TrackListResult,
} from '../types.js';

function validateRefs(from: string | undefined, to: string | undefined, now?: Date): void {
  if (from !== undefined) {
    classifyRangeRef(from, '--from', now);
  }
  rejectPreviousTo(to, now);
}

function itemCell(item: SelectionItem): string {
  return `${item.subject}=${item.metrics.join(',')}`;
}

function renderItems(items: readonly SelectionItem[], width?: number | undefined): string {
  return `${renderTable(
    ['SUBJECT', 'METRICS'],
    items.map((item) => [item.subject, item.metrics.join(', ')]),
    { maxWidth: width },
  )}\n`;
}

function renderSelection(config: Config, width?: number | undefined): string {
  const sections: string[] = [];

  if (config.tracking.length > 0) {
    sections.push(
      renderTable(
        ['SUBJECT', 'METRICS'],
        config.tracking.map((entry) => [entry.subject, entry.metrics.join(', ')]),
        { maxWidth: width },
      ),
    );
  } else {
    sections.push('No dashboard selection. Run `gh-track track edit` or `gh-track dashboard add`.');
  }

  if (config.views.length > 0) {
    sections.push(
      'Views:',
      renderTable(
        ['NAME', 'LAYOUT', 'FROM', 'TO', 'ITEMS'],
        config.views.map((view) => [
          view.name,
          view.layout,
          view.from,
          view.to,
          view.items.map(itemCell).join('; '),
        ]),
        { maxWidth: width },
      ),
    );
  }

  return `${sections.join('\n\n')}\n`;
}

function asResult(config: Config): TrackListResult {
  return {
    tracking: config.tracking.map((entry) => ({
      subject: entry.subject,
      metrics: [...entry.metrics],
    })),
    views: config.views.map((view) => ({
      name: view.name,
      layout: view.layout,
      from: view.from,
      to: view.to,
      items: view.items.map((item) => ({
        subject: item.subject,
        metrics: [...item.metrics],
      })),
    })),
  };
}

async function loadRequired(
  context: CommandContext,
): Promise<{ config: Config; warnings: string[] }> {
  const loaded = await loadConfig(context.paths.configPath, { required: true });
  return { config: loaded.config, warnings: [...loaded.warnings] };
}

function initialItems(config: Config): SelectionItem[] {
  if (config.tracking.length > 0) {
    return config.tracking.map((entry) => ({
      subject: entry.subject,
      metrics: [...entry.metrics],
    }));
  }
  return config.subjects.map((subject) => ({
    subject: subject.subject,
    metrics: defaultMetricsFor(subject.type),
  }));
}

async function runEdit(context: CommandContext): Promise<CommandResult> {
  if (context.positionals.length > 1) {
    throw unexpectedArgument(context.positionals[1], 'gh-track track edit');
  }
  if (
    context.options.has('item') ||
    context.options.has('layout') ||
    context.options.has('from') ||
    context.options.has('to')
  ) {
    throw new UsageError(
      'track edit does not accept --item, --layout, --from, or --to. Use track set or track view save.',
    );
  }
  if (!context.canPrompt) {
    throw new UsageError(
      'track edit requires an interactive terminal. Use: gh-track track set --item <subject>=<metrics>',
    );
  }

  const { config, warnings } = await loadRequired(context);
  if (config.subjects.length === 0) {
    throw emptyWatchlist();
  }

  const picked = await pickSelection(context, {
    config,
    initial: {
      items: initialItems(config),
      layout: 'compact',
      from: 'previous',
      to: 'latest',
    },
    askLayout: false,
    askFrom: false,
    confirmMessage: 'Save this dashboard selection?',
    subjectMessage: 'Set up your dashboard',
  });
  if (picked === null) {
    return cancelled();
  }

  config.tracking = toTracking(config, picked.items);
  await saveConfig(context.paths.configPath, config);

  return {
    json: asResult(config),
    text: renderItems(picked.items, context.outputWidth),
    warnings,
  };
}

async function runSet(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  if (args.length > 0) {
    throw unexpectedArgument(args[0], 'gh-track track set --item <subject>=<metrics>');
  }
  const values = context.options.getAll('item');
  if (values.length === 0) {
    throw new UsageError(
      'track set requires at least one --item <subject>=<metrics>. Example: --item repo:octocat/hello-world=stars,forks',
    );
  }
  if (context.options.has('layout') || context.options.has('from') || context.options.has('to')) {
    throw new UsageError('track set only accepts --item.');
  }

  const { config, warnings } = await loadRequired(context);
  const items = canonicalizeItems(config, parseItems(values));
  config.tracking = mergeTracking(config, items);
  await saveConfig(context.paths.configPath, config);

  return {
    json: asResult(config),
    text: renderItems(items, context.outputWidth),
    warnings,
  };
}

async function runRm(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  if (args.length === 0) {
    throw new UsageError('Missing subject. Use: gh-track track rm <subject>');
  }
  if (args.length > 1) {
    throw unexpectedArgument(args[1], 'gh-track track rm <subject>');
  }
  if (
    context.options.has('item') ||
    context.options.has('layout') ||
    context.options.has('from') ||
    context.options.has('to')
  ) {
    throw new UsageError('track rm only accepts a subject.');
  }

  const parsed = parseSubject(args[0] ?? '');
  const key = subjectKey(parsed);
  const { config, warnings } = await loadRequired(context);
  const index = config.tracking.findIndex((entry) => subjectKeyOf(entry.subject) === key);
  if (index < 0) {
    throw new UsageError(`${parsed.subject} is not in the dashboard selection.`);
  }

  config.tracking.splice(index, 1);
  await saveConfig(context.paths.configPath, config);

  return {
    json: { subject: parsed.subject, removed: true },
    text: `Removed ${parsed.subject} from the dashboard selection.\n`,
    warnings,
  };
}

async function runLs(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  if (args.length > 0) {
    throw unexpectedArgument(args[0], 'gh-track track ls');
  }
  if (
    context.options.has('item') ||
    context.options.has('layout') ||
    context.options.has('from') ||
    context.options.has('to')
  ) {
    throw new UsageError('track ls does not accept selection options.');
  }

  const { config, warnings } = await loadRequired(context);
  return {
    json: asResult(config),
    text: renderSelection(config, context.outputWidth),
    warnings,
  };
}

async function saveView(context: CommandContext, args: readonly string[]): Promise<CommandResult> {
  const name = args[0];
  if (name === undefined) {
    throw new UsageError('Missing view name. Use: gh-track track view save <name>');
  }
  if (args.length > 1) {
    throw unexpectedArgument(args[1], 'gh-track track view save <name>');
  }
  if (!isValidViewName(name)) {
    throw new UsageError(
      `Invalid view name ${JSON.stringify(name)}. Use lowercase letters, digits, - and _, starting with a letter or digit.`,
    );
  }

  const { config, warnings } = await loadRequired(context);
  if (config.subjects.length === 0) {
    throw emptyWatchlist();
  }

  const existing = config.views.find((view) => view.name === name);
  const layoutFlag = parseOptionalLayout(context.options.get('layout'));
  const fromFlag = context.options.get('from');
  const toFlag = context.options.get('to');
  validateRefs(fromFlag, toFlag, context.now);

  const itemValues = context.options.getAll('item');
  let items: SelectionItem[];
  let layout: DashboardLayout;
  let from: string;
  let to: string;

  if (itemValues.length > 0) {
    items = canonicalizeItems(config, parseItems(itemValues));
    layout = layoutFlag ?? existing?.layout ?? 'compact';
    from = fromFlag ?? existing?.from ?? 'previous';
    to = toFlag ?? existing?.to ?? 'latest';
  } else {
    if (!context.canPrompt) {
      throw new UsageError(
        'track view save needs --item in non-interactive mode. Example: gh-track track view save my-repos --item repo:octocat/hello-world=stars',
      );
    }
    const initial: Pick<DashboardView, 'items' | 'layout' | 'from' | 'to'> = existing ?? {
      items: toViewItems(initialItems(config)),
      layout: 'compact',
      from: fromFlag ?? 'previous',
      to: toFlag ?? 'latest',
    };
    const picked = await pickSelection(context, {
      config,
      initial: {
        items: initial.items.map((item) => ({
          subject: item.subject,
          metrics: [...item.metrics],
        })),
        layout: initial.layout,
        from: initial.from,
        to: initial.to,
      },
      askLayout: layoutFlag === undefined,
      askFrom: fromFlag === undefined,
      confirmMessage: `Save view ${name}?`,
      subjectMessage: `Set up view ${name}`,
    });
    if (picked === null) {
      return cancelled();
    }
    items = picked.items;
    layout = layoutFlag ?? picked.layout;
    from = fromFlag ?? picked.from;
    to = toFlag ?? picked.to;
  }

  const view: DashboardView = {
    name,
    items: toViewItems(items),
    layout,
    from,
    to,
  };
  const index = config.views.findIndex((candidate) => candidate.name === name);
  if (index >= 0) {
    config.views[index] = view;
  } else {
    config.views.push(view);
    config.views.sort((left, right) => left.name.localeCompare(right.name));
  }
  await saveConfig(context.paths.configPath, config);

  return {
    json: { view },
    text: `Saved view ${name}.\n`,
    warnings,
  };
}

async function removeView(
  context: CommandContext,
  args: readonly string[],
): Promise<CommandResult> {
  const name = args[0];
  if (name === undefined) {
    throw new UsageError('Missing view name. Use: gh-track track view rm <name>');
  }
  if (args.length > 1) {
    throw unexpectedArgument(args[1], 'gh-track track view rm <name>');
  }
  if (
    context.options.has('item') ||
    context.options.has('layout') ||
    context.options.has('from') ||
    context.options.has('to')
  ) {
    throw new UsageError('track view rm only accepts a view name.');
  }

  const { config, warnings } = await loadRequired(context);
  const index = config.views.findIndex((view) => view.name === name);
  if (index < 0) {
    throw new UsageError(`Dashboard view not found: ${name}`);
  }
  config.views.splice(index, 1);
  await saveConfig(context.paths.configPath, config);

  return {
    json: { name, removed: true },
    text: `Removed view ${name}.\n`,
    warnings,
  };
}

export async function runTrack(context: CommandContext): Promise<CommandResult> {
  const [subcommand, ...args] = context.positionals;

  if (subcommand === 'edit') {
    return runEdit(context);
  }
  if (subcommand === 'set') {
    return runSet(context, args);
  }
  if (subcommand === 'rm') {
    return runRm(context, args);
  }
  if (subcommand === 'ls') {
    return runLs(context, args);
  }
  if (subcommand === 'view') {
    const [viewCommand, ...viewArgs] = args;
    if (viewCommand === 'save') {
      return saveView(context, viewArgs);
    }
    if (viewCommand === 'rm') {
      return removeView(context, viewArgs);
    }
    if (viewCommand === undefined) {
      throw missingSubcommand('track view', 'gh-track track view save|rm');
    }
    throw unknownSubcommand('track view', viewCommand, 'gh-track track view save|rm');
  }
  if (subcommand === undefined) {
    throw missingSubcommand('track', 'gh-track track edit|set|rm|ls|view');
  }
  throw unknownSubcommand('track', subcommand, 'gh-track track edit|set|rm|ls|view');
}
