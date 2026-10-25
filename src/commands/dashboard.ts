/** `gh-track dashboard`: per-subject value view, static or interactive. */

import { unknownSubcommand } from '../cli-args.js';
import { removeConfiguredSubject, toConfigSubject } from '../config-edit.js';
import { loadConfig, saveConfig } from '../config.js';
import { runInteractiveDashboard } from '../dashboard/interactive.js';
import {
  buildDashboardRows,
  buildObservationData,
  resolveRefs,
  type ObservationSubject,
} from '../dashboard/observations.js';
import { pickSelection } from '../dashboard/picker.js';
import { renderDashboard } from '../dashboard/render.js';
import {
  parseLayout,
  resolveSelection,
  sortTracking,
  toTracking,
  type DashboardSelection,
  type SelectionItem,
} from '../dashboard/select.js';
import { emptyWatchlist, unknownSubject, UsageError } from '../errors.js';
import { defaultMetricsFor } from '../metrics.js';
import { classifyRangeRef, rejectPreviousTo } from '../refs.js';
import { USER_RESOURCES } from '../resources.js';
import { cancelled } from '../result.js';
import { forgetSubjectEtags } from '../store/etagCache.js';
import { acquireLock } from '../store/lock.js';
import { recordTrackedSince } from '../store/trackedSince.js';
import { parseSubject, subjectKey, subjectKeyOf, type ParsedSubject } from '../subjects.js';
import type {
  CommandContext,
  CommandResult,
  Config,
  DashboardResult,
  Metric,
  OptionBag,
} from '../types.js';
import { runDashboardAdd } from './dashboard-add.js';
import { runFetch } from './fetch.js';

/** A fetch invocation from the dashboard only forwards the token option. */
function fetchOptions(context: CommandContext): OptionBag {
  const token = context.options.get('token');
  return {
    has: (name) => name === 'token' && token !== undefined,
    get: (name) => (name === 'token' ? token : undefined),
    getAll: () => [],
  };
}

interface AddedSubject {
  subject: string;
  metrics: Metric[];
  /** True when a new `[[subjects]]` entry was created. */
  watched: boolean;
}

/** Adds one subject without replacing an existing resource or metric choice. */
function addSubjectToConfig(config: Config, parsed: ParsedSubject): AddedSubject {
  const key = subjectKey(parsed);
  const existing = config.subjects.find((subject) => subjectKey(subject) === key);
  let subject: string;
  let watched = false;
  if (existing === undefined) {
    const entry = toConfigSubject(parsed, parsed.type === 'user' ? USER_RESOURCES : ['repo']);
    config.subjects.push(entry);
    subject = entry.subject;
    watched = true;
  } else {
    subject = existing.subject;
  }

  const tracked = config.tracking.find((entry) => subjectKeyOf(entry.subject) === key);
  const metrics = tracked === undefined ? defaultMetricsFor(parsed.type) : [...tracked.metrics];
  if (tracked === undefined) {
    config.tracking.push({ subject, metrics });
  }
  config.tracking = sortTracking(config, config.tracking);
  return { subject, metrics, watched };
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
  const [subcommand, ...rest] = context.positionals;
  if (subcommand === 'add') {
    if (context.options.has('no-interactive')) {
      throw new UsageError('--no-interactive is only valid with `gh-track dashboard`.');
    }
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
    classifyRangeRef(fromFlag, '--from', context.now);
  }
  rejectPreviousTo(context.options.get('to'), context.now);

  const firstRun =
    view === undefined &&
    config.tracking.length === 0 &&
    !context.options.has('subject') &&
    !context.options.has('no-interactive');
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

  const selectionOverrides = {
    view,
    from: context.options.get('from'),
    to: context.options.get('to'),
    layout: context.options.get('layout'),
    subjects: context.options.getAll('subject'),
  };
  const selection = resolveSelection(config, selectionOverrides);
  let activeView = selectionOverrides.view;
  const currentOverrides = () => ({ ...selectionOverrides, view: activeView });

  const buildResult = async (selected: DashboardSelection): Promise<DashboardResult> => {
    const data = await buildObservationData(
      context.paths.dataDir,
      observationSubjects(selected.items),
    );
    const refs = resolveRefs(data.manifests, selected.from, selected.to, context.now);
    return {
      ...(selected.view === undefined ? {} : { view: selected.view }),
      layout: selected.layout,
      range: { from: selected.from, to: selected.to },
      rows: buildDashboardRows(data, selected.items, refs),
    };
  };
  const result = await buildResult(selection);

  if (
    context.canPrompt &&
    !context.options.has('no-interactive') &&
    context.dashboardTerminal !== undefined
  ) {
    const options = fetchOptions(context);
    let actionController: AbortController | null = null;
    const cancelAction = (): void => actionController?.abort();
    const withFetchSignal = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      actionController = controller;
      const abortWithParent = (): void => controller.abort();
      if (context.signal?.aborted === true) {
        controller.abort();
      } else {
        context.signal?.addEventListener('abort', abortWithParent, { once: true });
      }
      try {
        return await run(controller.signal);
      } finally {
        context.signal?.removeEventListener('abort', abortWithParent);
        if (actionController === controller) {
          actionController = null;
        }
      }
    };
    const resolveFreshSelection = async (warnings: string[]): Promise<DashboardSelection> => {
      const fresh = await loadConfig(context.paths.configPath, { required: true });
      warnings.push(...fresh.warnings);
      return resolveSelection(fresh.config, currentOverrides());
    };

    const interactive = await runInteractiveDashboard({
      result,
      layout: selection.layout,
      colors: context.colors,
      terminal: context.dashboardTerminal,
      signal: context.signal,
      cancelAction,
      refresh: async () => {
        const fetched = await withFetchSignal((signal) =>
          runFetch({ ...context, positionals: [], options, signal }),
        );
        const warnings = [...fetched.warnings];
        return {
          result: await buildResult(await resolveFreshSelection(warnings)),
          text: fetched.text,
          warnings,
          exitCode: fetched.exitCode,
        };
      },
      addSubject: async (value, onAdded) => {
        // Syntax errors are returned to the prompt so the user can edit the value.
        const parsed = parseSubject(value);
        const current = await loadConfig(context.paths.configPath, { required: true });
        const added = addSubjectToConfig(current.config, parsed);
        if (added.watched) {
          await recordTrackedSince(
            context.paths.dataDir,
            [added.subject],
            new Date().toISOString(),
          );
        }
        await saveConfig(context.paths.configPath, current.config);
        if (onAdded !== undefined) {
          const partial = resolveSelection(current.config, currentOverrides());
          onAdded(await buildResult(partial), added.subject);
        }

        const warnings = [...current.warnings];
        let text: string;
        let exitCode: number | undefined;
        try {
          const fetched = await withFetchSignal((signal) =>
            runFetch({
              ...context,
              positionals: [added.subject],
              options,
              signal,
            }),
          );
          text = `Added ${added.subject}. ${fetched.text}`;
          exitCode = fetched.exitCode;
          warnings.push(...fetched.warnings);
        } catch (error) {
          text = `Added ${added.subject}; fetch failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        return {
          result: await buildResult(await resolveFreshSelection(warnings)),
          text,
          warnings,
          ...(exitCode === undefined ? {} : { exitCode }),
          addedSubject: added.subject,
        };
      },
      deleteSubject: async (subject) => {
        const lock = await acquireLock(context.paths.dataDir);
        try {
          const current = await loadConfig(context.paths.configPath, { required: true });
          const warnings = [...current.warnings];
          const removed = removeConfiguredSubject(current.config, subject);
          if (removed === null) {
            throw unknownSubject(subject);
          }
          await forgetSubjectEtags(context.paths.dataDir, removed.subject);
          await saveConfig(context.paths.configPath, current.config);
          if (activeView !== undefined && removed.emptyViews.includes(activeView)) {
            activeView = undefined;
          }
          return {
            text: `Removed ${removed.subject}.`,
            warnings: [...warnings, ...removed.warnings],
          };
        } finally {
          await lock.release();
        }
      },
    });
    return {
      json: interactive.result,
      text: '',
      warnings: [...loaded.warnings, ...interactive.warnings],
      exitCode: interactive.exitCode,
      suppressTableOutput: true,
    };
  }

  return {
    json: result,
    text: renderDashboard(result, selection.layout, context.colors),
    warnings: [...loaded.warnings],
  };
}
