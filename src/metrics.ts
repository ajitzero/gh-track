/** Canonical metric sets and parsing for dashboards and config. */

import { UsageError } from './errors.js';
import type { Metric, SubjectType } from './types.js';

export const METRIC_ORDER: Readonly<Record<SubjectType, readonly Metric[]>> = {
  user: ['followers'],
  repo: ['stars', 'forks'],
};

export const ALL_METRICS: readonly Metric[] = ['stars', 'forks', 'followers'];

const METRIC_SET = new Set<string>(ALL_METRICS);

export function isMetric(value: string): value is Metric {
  return METRIC_SET.has(value);
}

/** The default metric set for a subject kind, in canonical order. */
export function defaultMetricsFor(kind: SubjectType): Metric[] {
  return [...METRIC_ORDER[kind]];
}

/** Filters a metric collection to the canonical order for `kind`. */
export function orderMetrics(kind: SubjectType, metrics: Iterable<Metric>): Metric[] {
  const selected = new Set(metrics);
  return METRIC_ORDER[kind].filter((metric) => selected.has(metric));
}

/**
 * Parses a comma-separated metric list for one subject kind. The error message
 * names the flag and the allowed values.
 */
export function parseMetricList(value: string, kind: SubjectType, flag = '--metrics'): Metric[] {
  const allowed = METRIC_ORDER[kind];
  const parts = value.split(',').map((part) => part.trim());
  const expected = `Expected a comma-separated subset of ${allowed.join(',')}.`;
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new UsageError(`Invalid ${flag} value ${JSON.stringify(value)}. ${expected}`);
  }

  const selected = new Set<Metric>();
  for (const part of parts) {
    if (!allowed.includes(part as Metric)) {
      throw new UsageError(`Invalid ${flag} value ${JSON.stringify(value)}. ${expected}`);
    }
    selected.add(part as Metric);
  }
  return orderMetrics(kind, selected);
}
