/** Shared clack picker for dashboard subjects, metrics, layout, and range. */

import { summarizeLastRun } from '../store/runs.js';
import type {
  CommandContext,
  Config,
  DashboardLayout,
  Metric,
  SubjectChoice,
} from '../types.js';
import { defaultMetricsFor, type SelectionItem } from './select.js';

export interface PickerInitial {
  items: readonly SelectionItem[];
  layout: DashboardLayout;
  from: string;
  to: string;
}

export interface PickerOptions {
  config: Config;
  initial: PickerInitial;
  askLayout: boolean;
  askFrom: boolean;
  confirmMessage: string;
  subjectMessage?: string;
}

export interface PickerResult extends PickerInitial {
  items: SelectionItem[];
}

async function subjectChoices(
  context: CommandContext,
  config: Config,
): Promise<SubjectChoice[]> {
  const choices: SubjectChoice[] = [];
  for (const subject of config.subjects) {
    const lastRun = await summarizeLastRun(context.paths.dataDir, subject.subject);
    choices.push({
      value: subject.subject,
      label: subject.subject,
      hint: lastRun === null ? 'never' : `last run ${lastRun.id}`,
    });
  }
  return choices;
}

function initialMetrics(
  initial: readonly SelectionItem[],
  subject: string,
): Metric[] {
  const found = initial.find((item) => item.subject === subject);
  if (found !== undefined) {
    return [...found.metrics];
  }
  return defaultMetricsFor(subject.startsWith('user:') ? 'user' : 'repo');
}

/** Runs the picker. Returns null when the user declines; cancels throw. */
export async function pickSelection(
  context: CommandContext,
  options: PickerOptions,
): Promise<PickerResult | null> {
  const choices = await subjectChoices(context, options.config);
  const selected = await context.prompts.selectSubjects(
    choices,
    options.initial.items.map((item) => item.subject),
    options.subjectMessage,
  );
  if (selected === null) {
    return null;
  }

  const items: SelectionItem[] = [];
  for (const subject of selected) {
    if (subject.startsWith('user:')) {
      items.push({ subject, metrics: ['followers'] });
      continue;
    }
    const metrics = await context.prompts.selectMetrics(
      subject,
      ['stars', 'forks'],
      initialMetrics(options.initial.items, subject),
    );
    if (metrics === null) {
      return null;
    }
    items.push({ subject, metrics });
  }

  const layout = options.askLayout
    ? await context.prompts.selectLayout(options.initial.layout)
    : options.initial.layout;
  if (layout === null) {
    return null;
  }

  const from = options.askFrom
    ? await context.prompts.selectFrom(options.initial.from)
    : options.initial.from;
  if (from === null) {
    return null;
  }

  const accepted = await context.prompts.confirmSelection(options.confirmMessage);
  if (accepted === null || accepted === false) {
    return null;
  }

  return { items, layout, from, to: options.initial.to };
}
