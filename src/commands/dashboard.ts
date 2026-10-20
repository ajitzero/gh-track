/** `gh-track dashboard`: read-only per-subject value view. */

import { configMissing, emptyWatchlist, UsageError } from '../errors.js';
import { loadConfig, saveConfig } from '../config.js';
import { pickSelection } from '../dashboard/picker.js';
import { renderDashboard } from '../dashboard/render.js';
import {
  buildDashboardRows,
  buildObservationData,
  classifyRangeRef,
  resolveRefs,
  type ObservationSubject,
} from '../dashboard/observations.js';
import {
  defaultMetricsFor,
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

function cancelled(): CommandResult {
  return {
    json: { cancelled: true },
    text: 'Cancelled.\n',
    warnings: [],
  };
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

function observationSubjects(items: readonly SelectionItem[]): ObservationSubject[] {
  return items.map((item) => ({
    subject: item.subject,
    kind: parseSubject(item.subject).type,
  }));
}

export async function runDashboard(context: CommandContext): Promise<CommandResult> {
  if (context.positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument ${JSON.stringify(context.positionals[0])}. Use: gh-track dashboard`,
    );
  }

  const setup = context.options.has('setup');
  const view = context.options.get('view');
  if (setup && view !== undefined) {
    throw new UsageError('--setup and --view cannot be combined.');
  }

  const loaded = await loadConfig(context.paths.configPath, { required: true });
  if (loaded === null) {
    throw configMissing(context.paths.configPath);
  }
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
  const toFlag = context.options.get('to');
  if (toFlag !== undefined && classifyRangeRef(toFlag, '--to') === 'previous') {
    throw new UsageError('--to cannot be "previous"; use latest, a run id, or YYYY-MM-DD.');
  }

  const firstRun =
    !setup &&
    view === undefined &&
    config.tracking.length === 0 &&
    !context.options.has('subject');
  if (setup || firstRun) {
    if (!context.canPrompt) {
      if (setup) {
        throw new UsageError(
          '--setup requires an interactive terminal. Use: gh-track track set --item <subject>=<metrics>',
        );
      }
      // No selection and no prompts: render every subject with defaults.
    } else {
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
