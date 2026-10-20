/** Dashboard selection: default tracking, saved views, and CLI overrides. */

import { noSelection, unknownSubject, unknownView, UsageError } from '../errors.js';
import { parseSubject, subjectKey } from '../subjects.js';
import type {
  Config,
  ConfigSubject,
  DashboardLayout,
  DashboardView,
  Metric,
  TrackingEntry,
  ViewItem,
} from '../types.js';

export interface SelectionItem {
  subject: string;
  metrics: Metric[];
}

export interface DashboardSelection {
  items: SelectionItem[];
  layout: DashboardLayout;
  from: string;
  to: string;
  view?: string | undefined;
}

export interface SelectionOverrides {
  view?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  layout?: string | undefined;
  subjects?: readonly string[];
}

const METRIC_ORDER: Readonly<Record<'user' | 'repo', readonly Metric[]>> = {
  user: ['followers'],
  repo: ['stars', 'forks'],
};

export function defaultMetricsFor(kind: 'user' | 'repo'): Metric[] {
  return [...METRIC_ORDER[kind]];
}

function configuredByKey(config: Config): Map<string, ConfigSubject> {
  const map = new Map<string, ConfigSubject>();
  for (const subject of config.subjects) {
    map.set(subjectKey(subject), subject);
  }
  return map;
}

/** Rewrites item subjects to the casing stored in `[[subjects]]`. */
export function canonicalizeItems(
  config: Config,
  items: readonly SelectionItem[],
): SelectionItem[] {
  const configured = configuredByKey(config);
  return items.map((item) => {
    const parsed = parseSubject(item.subject);
    const subject = configured.get(subjectKey(parsed));
    if (subject === undefined) {
      throw unknownSubject(item.subject);
    }
    return { subject: subject.subject, metrics: [...item.metrics] };
  });
}

function subjectOrder(config: Config): Map<string, number> {
  const order = new Map<string, number>();
  config.subjects.forEach((subject, index) => {
    order.set(subjectKey(subject), index);
  });
  return order;
}

function sortTracking(config: Config, entries: TrackingEntry[]): TrackingEntry[] {
  const order = subjectOrder(config);
  entries.sort((left, right) => {
    const leftIndex = order.get(subjectKey(parseSubject(left.subject))) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(subjectKey(parseSubject(right.subject))) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
  return entries;
}

export function parseLayout(value: string | undefined): DashboardLayout {
  if (value === undefined) {
    return 'compact';
  }
  if (value !== 'compact' && value !== 'columns') {
    throw new UsageError(
      `Unsupported --layout value: ${value}. Expected compact or columns.`,
    );
  }
  return value;
}

function itemFor(
  subject: ConfigSubject,
  view: DashboardView | undefined,
  tracking: readonly TrackingEntry[],
): SelectionItem {
  const key = subjectKey(subject);
  const fromView = view?.items.find(
    (item) => subjectKey(parseSubject(item.subject)) === key,
  );
  if (fromView !== undefined) {
    return { subject: fromView.subject, metrics: [...fromView.metrics] };
  }
  const fromTracking = tracking.find(
    (item) => subjectKey(parseSubject(item.subject)) === key,
  );
  if (fromTracking !== undefined) {
    return { subject: fromTracking.subject, metrics: [...fromTracking.metrics] };
  }
  return { subject: subject.subject, metrics: defaultMetricsFor(subject.type) };
}

function dedupeItems(items: readonly SelectionItem[]): SelectionItem[] {
  const seen = new Set<string>();
  const result: SelectionItem[] = [];
  for (const item of items) {
    const key = subjectKey(parseSubject(item.subject));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Resolves the effective selection from config and CLI overrides. */
export function resolveSelection(
  config: Config,
  overrides: SelectionOverrides,
): DashboardSelection {
  const view = overrides.view === undefined
    ? undefined
    : config.views.find((candidate) => candidate.name === overrides.view);
  if (overrides.view !== undefined && view === undefined) {
    throw unknownView(overrides.view);
  }

  const configured = configuredByKey(config);
  let items: SelectionItem[];
  if (overrides.subjects !== undefined && overrides.subjects.length > 0) {
    items = overrides.subjects.map((value) => {
      const parsed = parseSubject(value);
      const subject = configured.get(subjectKey(parsed));
      if (subject === undefined) {
        throw unknownSubject(value);
      }
      return itemFor(subject, view, config.tracking);
    });
  } else if (view !== undefined) {
    items = view.items.map((item) => ({ subject: item.subject, metrics: [...item.metrics] }));
  } else if (config.tracking.length > 0) {
    items = config.tracking.map((item) => ({ subject: item.subject, metrics: [...item.metrics] }));
  } else {
    items = config.subjects.map((subject) => ({
      subject: subject.subject,
      metrics: defaultMetricsFor(subject.type),
    }));
  }

  items = dedupeItems(items);
  if (items.length === 0) {
    throw noSelection(
      'No dashboard subjects are selected. Use `gh-track track set --item <subject>=<metrics>` or `gh-track dashboard --setup`.',
    );
  }

  return {
    items,
    layout: parseLayout(overrides.layout ?? view?.layout),
    from: overrides.from ?? view?.from ?? 'previous',
    to: overrides.to ?? view?.to ?? 'latest',
    view: view?.name,
  };
}

/** Parses a repeatable `--item <subject>=<metrics>` value. */
export function parseItem(value: string): SelectionItem {
  const equals = value.indexOf('=');
  if (equals <= 0 || equals === value.length - 1) {
    throw new UsageError(
      `Invalid --item value ${JSON.stringify(value)}. Expected <subject>=<metrics>, for example repo:octocat/hello-world=stars,forks.`,
    );
  }

  const parsed = parseSubject(value.slice(0, equals));
  const allowed = defaultMetricsFor(parsed.type);
  const selected = new Set<Metric>();
  for (const part of value.slice(equals + 1).split(',')) {
    const metric = part.trim();
    if (!allowed.includes(metric as Metric)) {
      throw new UsageError(
        `Invalid metric ${JSON.stringify(metric)} for ${parsed.subject}. Expected a subset of ${allowed.join(',')}.`,
      );
    }
    selected.add(metric as Metric);
  }

  return {
    subject: parsed.subject,
    metrics: allowed.filter((metric) => selected.has(metric)),
  };
}

export function parseItems(values: readonly string[]): SelectionItem[] {
  const seen = new Set<string>();
  const items: SelectionItem[] = [];
  for (const value of values) {
    const item = parseItem(value);
    const key = subjectKey(parseSubject(item.subject));
    if (seen.has(key)) {
      throw new UsageError(`Duplicate --item for ${item.subject}.`);
    }
    seen.add(key);
    items.push(item);
  }
  return items;
}

/** Replaces the default tracking selection wholesale, in subject order. */
export function toTracking(config: Config, items: readonly SelectionItem[]): TrackingEntry[] {
  return sortTracking(
    config,
    items.map((item) => ({ subject: item.subject, metrics: [...item.metrics] })),
  );
}

/** Sets or replaces individual tracking entries, preserving the rest. */
export function mergeTracking(
  config: Config,
  items: readonly SelectionItem[],
): TrackingEntry[] {
  const next = config.tracking.map((entry) => ({
    subject: entry.subject,
    metrics: [...entry.metrics],
  }));
  for (const item of items) {
    const key = subjectKey(parseSubject(item.subject));
    const index = next.findIndex(
      (entry) => subjectKey(parseSubject(entry.subject)) === key,
    );
    const entry: TrackingEntry = { subject: item.subject, metrics: [...item.metrics] };
    if (index >= 0) {
      next[index] = entry;
    } else {
      next.push(entry);
    }
  }
  return sortTracking(config, next);
}

export function toViewItems(items: readonly SelectionItem[]): ViewItem[] {
  return items.map((item) => ({ subject: item.subject, metrics: [...item.metrics] }));
}
