/** `gh-track dashboard`: read-only per-subject value view. */

import { unknownSubcommand } from '../cli-args.js';
import { emptyWatchlist, UsageError } from '../errors.js';
import { loadConfig, saveConfig } from '../config.js';
import { runDashboardAdd } from './dashboard-add.js';
import { pickSelection } from '../dashboard/picker.js';
import { renderDashboard } from '../dashboard/render.js';
import {
  buildDashboardRows,
  buildObservationData,
  resolveRefs,
  type ObservationSubject,
} from '../dashboard/observations.js';
import { classifyRangeRef, rejectPreviousTo } from '../refs.js';
import { defaultMetricsFor } from '../metrics.js';
import {
  parseLayout,
  resolveSelection,
  toTracking,
  type SelectionItem,
} from '../dashboard/select.js';
import { parseSubject } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  DashboardResult,
} from '../types.js';
import { cancelled } from '../result.js';

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

function observationSubjects(items: readonly SelectionItem[]): ObservationSubject[] {
  return items.map((item) => ({
    subject: item.subject,
    kind: parseSubject(item.subject).type,
  }));
}

export async function runDashboard(context: CommandContext): Promise<CommandResult> {
  const [subcommand, ...rest] = context.positionals;
  if (subcommand === 'add') {
    return runDashboardAdd({ ...context, positionals: rest });
  }
  if (subcommand !== undefined) {
    throw unknownSubcommand('dashboard', subcommand, 'gh-track dashboard add');
  }

  for (const name of ['metrics', 'resources', 'token']) {
    if (context.options.has(name)) {
      throw new UsageError(`--${name} is only valid with 'gh-track dashboard add'.`);
    }
  }

  const view = context.options.get('view');

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  const config = loaded.config;
  if (config.subjects.length === 0) {
    throw emptyWatchlist();
  }

  // Validate overrides before any prompt can write `[tracking]`.
  const layoutFlag = context.options.get('layout');
  if (layoutFlag !== undefined) {
    parseLayout(layoutFlag);
  }
  const fromFlag = context.options.get('from');
  if (fromFlag !== undefined) {
    classifyRangeRef(fromFlag, '--from');
  }
  rejectPreviousTo(context.options.get('to'));

  const firstRun =
    view === undefined &&
    config.tracking.length === 0 &&
    !context.options.has('subject');
  if (firstRun && context.canPrompt) {
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
  }

  const selection = resolveSelection(config, {
    view,
    from: context.options.get('from'),
    to: context.options.get('to'),
    layout: context.options.get('layout'),
    subjects: context.options.getAll('subject'),
  });

  const data = await buildObservationData(
    context.paths.dataDir,
    observationSubjects(selection.items),
  );
  const refs = resolveRefs(data.manifests, selection.from, selection.to);
  const rows = buildDashboardRows(data, selection.items, refs);

  const result: DashboardResult = {
    ...(selection.view === undefined ? {} : { view: selection.view }),
    layout: selection.layout,
    range: { from: selection.from, to: selection.to },
    rows,
  };

  return {
    json: result,
    text: renderDashboard(result, selection.layout, context.colors),
    warnings: [...loaded.warnings],
  };
}
