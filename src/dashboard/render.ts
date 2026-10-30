/** Dashboard table rendering for the compact, columns, and narrow layouts. */

import {
  renderTable,
  richCell,
  truncateText,
  type CellSegment,
  type TableCell,
  type TableOptions,
} from '../output/table.js';
import { isNarrowWidth } from '../output/width.js';
import type {
  Colors,
  DashboardLayout,
  DashboardMetricValue,
  DashboardResult,
  DashboardRow,
  Metric,
} from '../types.js';
import { groupDashboardRows } from './group.js';

const METRIC_ORDER: readonly Metric[] = ['stars', 'forks', 'followers'];
const METRIC_LABELS: Readonly<Record<Metric, string>> = {
  stars: 'stars',
  forks: 'forks',
  followers: 'followers',
};

/**
 * Followers share the forks slot. The two never appear on the same row, and both
 * are the rightmost count on their row, so their count and delta edges line up.
 */
type MetricSlot = 'stars' | 'forks';
const METRIC_SLOTS: Readonly<Record<Metric, MetricSlot>> = {
  stars: 'stars',
  forks: 'forks',
  followers: 'forks',
};
const METRIC_SLOT_ORDER: readonly MetricSlot[] = ['stars', 'forks'];

function formatCount(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString();
  let output = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      output += ',';
    }
    output += digits[index];
  }
  return negative ? `-${output}` : output;
}

function formatDelta(delta: number): string {
  if (delta === 0) {
    return '(0)';
  }
  return delta > 0 ? `(+${formatCount(delta)})` : `(−${formatCount(-delta)})`;
}

function deltaPaint(colors: Colors, delta: number): (text: string) => string {
  if (delta === 0) {
    return colors.dim;
  }
  return delta > 0 ? colors.green : colors.red;
}

function displayName(row: DashboardRow): string {
  return row.subject.slice(row.subject.indexOf(':') + 1);
}

export interface DashboardRenderOptions {
  /** Add a visible cursor marker before each name in interactive mode. */
  interactive?: boolean;
  highlightedSubject?: string | undefined;
  emptyMessage?: string | undefined;
  /** Terminal width. When narrow, the dashboard stacks metrics under each name. */
  width?: number | undefined;
}

/**
 * Picks the layout actually used for output. A terminal narrower than the
 * narrow threshold switches to the stacked layout even when a view saved
 * `compact` or `columns`, which keeps saved views usable on a phone.
 */
export function resolveDashboardLayout(
  layout: DashboardLayout,
  width: number | undefined,
): DashboardLayout {
  if (layout === 'narrow' || isNarrowWidth(width)) {
    return 'narrow';
  }
  return layout;
}

function nameCell(
  row: DashboardRow,
  colors: Colors,
  label: string = displayName(row),
  nested = false,
  options: DashboardRenderOptions = {},
): TableCell {
  const paint =
    row.kind === 'repo'
      ? (text: string) => colors.bold(colors.blue(text))
      : (text: string) => colors.bold(colors.magenta(text));
  const name = nested ? `  ${label}` : label;
  if (!options.interactive) {
    return richCell([{ text: name, paint }]);
  }
  const selected = options.highlightedSubject === row.subject;
  return richCell([
    { text: selected ? '› ' : '  ', ...(selected ? { paint: colors.cyan } : {}) },
    { text: name, paint },
  ]);
}

function hasMetric(row: DashboardRow, metric: Metric): boolean {
  return Object.prototype.hasOwnProperty.call(row.metrics, metric);
}

function metricValue(row: DashboardRow, metric: Metric): DashboardMetricValue | undefined {
  return row.metrics[metric];
}

function compacted(row: DashboardRow): boolean {
  return row.to !== null && row.to.finishedAt === null;
}

function metricSegments(
  value: DashboardMetricValue,
  colors: Colors,
  compactedValue: boolean,
  label: string | null,
): { text: string; paint?: ((text: string) => string) | undefined }[] {
  if (value.value === null) {
    return [{ text: '—', paint: colors.dim }];
  }

  const segments: { text: string; paint?: ((text: string) => string) | undefined }[] = [];
  if (label !== null) {
    segments.push({ text: `${label} ` });
  }
  segments.push({ text: formatCount(value.value), paint: colors.bold });
  if (compactedValue) {
    segments.push({ text: '~', paint: colors.dim });
  }
  if (value.delta !== null) {
    segments.push({ text: ` ${formatDelta(value.delta)}`, paint: deltaPaint(colors, value.delta) });
  }
  return segments;
}

interface CompactWidths {
  count: Record<MetricSlot, number>;
  delta: Record<MetricSlot, number>;
  /** True when a compacted value is rendered, so the `~` slot must be reserved. */
  marker: boolean;
}

function compactMetrics(row: DashboardRow): Metric[] {
  return METRIC_ORDER.filter((metric) => hasMetric(row, metric));
}

/** Number fields track the widest formatted value per slot, not a fixed minimum. */
function compactWidths(rows: readonly DashboardRow[]): CompactWidths {
  const count: Record<MetricSlot, number> = { stars: 1, forks: 1 };
  const delta: Record<MetricSlot, number> = { stars: 0, forks: 0 };
  for (const row of rows) {
    for (const metric of compactMetrics(row)) {
      const value = metricValue(row, metric);
      if (value === undefined || value.value === null) {
        continue;
      }
      const slot = METRIC_SLOTS[metric];
      count[slot] = Math.max(count[slot], formatCount(value.value).length);
      if (value.delta !== null) {
        delta[slot] = Math.max(delta[slot], formatDelta(value.delta).length);
      }
    }
  }
  return { count, delta, marker: rows.some(compacted) };
}

function dashSegments(
  colors: Colors,
  countWidth: number,
  deltaWidth: number,
  marker: boolean,
): CellSegment[] {
  return [
    { text: ' '.repeat(countWidth - 1) },
    { text: '—', paint: colors.dim },
    { text: ' '.repeat((marker ? 1 : 0) + 1 + deltaWidth) },
  ];
}

function metricLineSegments(
  metric: Metric,
  value: DashboardMetricValue,
  colors: Colors,
  compactedValue: boolean,
  widths: CompactWidths,
): CellSegment[] {
  const label = METRIC_LABELS[metric];
  const slot = METRIC_SLOTS[metric];
  if (value.value === null) {
    return [
      { text: `${label} `, paint: colors.dim },
      ...dashSegments(colors, widths.count[slot], widths.delta[slot], widths.marker),
    ];
  }

  const count = formatCount(value.value);
  const segments: CellSegment[] = [
    { text: `${label} `, paint: colors.dim },
    { text: ' '.repeat(widths.count[slot] - count.length) },
    { text: count, paint: colors.bold },
  ];
  if (widths.marker) {
    segments.push(compactedValue ? { text: '~', paint: colors.dim } : { text: ' ' });
  }
  segments.push({ text: ' ' });

  if (value.delta === null) {
    segments.push({ text: ' '.repeat(widths.delta[slot]) });
  } else {
    const delta = formatDelta(value.delta);
    segments.push(
      { text: ' '.repeat(widths.delta[slot] - delta.length) },
      { text: delta, paint: deltaPaint(colors, value.delta) },
    );
  }

  return segments;
}

function nullMetricsCell(
  colors: Colors,
  widths: CompactWidths,
  metrics: readonly Metric[],
): TableCell {
  const slots =
    metrics.length === 0 ? METRIC_SLOT_ORDER : metrics.map((metric) => METRIC_SLOTS[metric]);
  return richCell(
    dashSegments(
      colors,
      Math.max(...slots.map((slot) => widths.count[slot])),
      Math.max(...slots.map((slot) => widths.delta[slot])),
      widths.marker,
    ),
  );
}

function compactRows(
  result: DashboardResult,
  colors: Colors,
  options: DashboardRenderOptions,
): TableCell[][] {
  const widths = compactWidths(result.rows);
  const rows: TableCell[][] = [];

  for (const display of groupDashboardRows(result.rows)) {
    const row = display.row;
    const metrics = compactMetrics(row);
    const anyValue = metrics.some((metric) => {
      const value = metricValue(row, metric);
      return value !== undefined && value.value !== null;
    });

    if (metrics.length === 0 || !anyValue) {
      rows.push([
        nameCell(row, colors, display.label, display.nested, options),
        nullMetricsCell(colors, widths, metrics),
        sinceCell(row, colors),
      ]);
      continue;
    }

    const segments: CellSegment[] = [];
    for (const metric of metrics) {
      const value = metricValue(row, metric);
      if (value === undefined) {
        continue;
      }
      if (segments.length > 0) {
        segments.push({ text: '  ' });
      }
      segments.push(...metricLineSegments(metric, value, colors, compacted(row), widths));
    }

    rows.push([
      nameCell(row, colors, display.label, display.nested, options),
      richCell(segments),
      sinceCell(row, colors),
    ]);
  }

  return rows;
}

function columnCell(row: DashboardRow, metric: Metric, colors: Colors): TableCell {
  if (!hasMetric(row, metric)) {
    return '';
  }
  const value = metricValue(row, metric);
  if (value === undefined) {
    return '';
  }
  return richCell(metricSegments(value, colors, compacted(row), null));
}

function sinceCell(row: DashboardRow, colors: Colors): TableCell {
  if (row.from === null) {
    return richCell([{ text: '—', paint: colors.dim }]);
  }
  const segments = [{ text: row.from.id.slice(0, 10), paint: colors.dim }];
  if (row.from.finishedAt === null) {
    segments.push({ text: '~', paint: colors.dim });
  }
  return richCell(segments);
}

function section(
  title: string,
  rows: readonly DashboardRow[],
  metrics: readonly Metric[],
  colors: Colors,
  options: DashboardRenderOptions,
): string {
  const heading =
    title === 'Repositories' ? colors.bold(colors.blue(title)) : colors.bold(colors.magenta(title));
  const headers: TableCell[] = [
    'NAME',
    ...metrics.map((metric) => METRIC_LABELS[metric].toUpperCase()),
    'SINCE',
  ];
  const body: TableCell[][] = rows.map((row) => [
    nameCell(row, colors, displayName(row), false, options),
    ...metrics.map((metric) => columnCell(row, metric, colors)),
    sinceCell(row, colors),
  ]);
  return `${heading}\n${renderTable(headers, body, compactTableOptions(options))}`;
}

function unionMetrics(rows: readonly DashboardRow[]): Metric[] {
  return METRIC_ORDER.filter((metric) => rows.some((row) => hasMetric(row, metric)));
}

function sinceText(row: DashboardRow): string {
  if (row.from === null) {
    return '—';
  }
  return `${row.from.id.slice(0, 10)}${row.from.finishedAt === null ? '~' : ''}`;
}

function paintName(row: DashboardRow, colors: Colors, text: string): string {
  return row.kind === 'repo' ? colors.bold(colors.blue(text)) : colors.bold(colors.magenta(text));
}

/**
 * One subject per block: `name` and `since` share the first line, every metric
 * follows on its own indented line. Fits a phone-sized terminal because the
 * widest fixed content is a metric line, not the whole table.
 */
function renderNarrow(
  result: DashboardResult,
  colors: Colors,
  options: DashboardRenderOptions,
): string {
  const width = options.width;
  const lines: string[] = [];

  for (const display of groupDashboardRows(result.rows)) {
    const row = display.row;
    const selected = options.highlightedSubject === row.subject;
    const marker = options.interactive ? (selected ? '› ' : '  ') : '';
    const indent = display.nested ? '  ' : '';
    const since = sinceText(row);
    const name = `${indent}${display.label}`;
    const budget =
      width === undefined ? undefined : Math.max(1, width - marker.length - since.length - 1);
    const shown = budget === undefined ? name : truncateText(name, budget);
    const gap =
      width === undefined ? 2 : Math.max(1, width - marker.length - shown.length - since.length);
    lines.push(
      `${selected && options.interactive ? colors.cyan(marker) : marker}${paintName(row, colors, shown)}${' '.repeat(gap)}${colors.dim(since)}`,
    );

    const metrics = compactMetrics(row);
    const metricIndent = `${indent}  `;
    if (metrics.length === 0) {
      continue;
    }
    for (const metric of metrics) {
      const value = metricValue(row, metric);
      if (value === undefined) {
        continue;
      }
      const label = `${colors.dim(`${METRIC_LABELS[metric]} `)}`;
      if (value.value === null) {
        lines.push(`${metricIndent}${label}${colors.dim('—')}`);
        continue;
      }
      let line = `${metricIndent}${label}${colors.bold(formatCount(value.value))}`;
      if (compacted(row)) {
        line += colors.dim('~');
      }
      if (value.delta !== null) {
        line += ` ${deltaPaint(colors, value.delta)(formatDelta(value.delta))}`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

function compactTableOptions(
  options: DashboardRenderOptions,
  align?: readonly ('left' | 'right')[],
  headerAlign?: readonly ('left' | 'right')[],
): TableOptions {
  return {
    ...(align === undefined ? {} : { align }),
    ...(headerAlign === undefined ? {} : { headerAlign }),
    maxWidth: options.width,
    flex: [0],
  };
}

function renderCompact(
  result: DashboardResult,
  colors: Colors,
  options: DashboardRenderOptions,
): string {
  return renderTable(
    ['NAME', 'METRICS', 'SINCE'],
    compactRows(result, colors, options),
    compactTableOptions(options, ['left', 'right', 'left'], ['left', 'left', 'left']),
  );
}

function renderColumns(
  result: DashboardResult,
  colors: Colors,
  options: DashboardRenderOptions,
): string {
  const repos = result.rows.filter((row) => row.kind === 'repo');
  const users = result.rows.filter((row) => row.kind === 'user');
  const sections: string[] = [];

  if (repos.length > 0) {
    sections.push(section('Repositories', repos, unionMetrics(repos), colors, options));
  }
  if (users.length > 0) {
    sections.push(section('Accounts', users, unionMetrics(users), colors, options));
  }

  return sections.join('\n\n');
}

export function renderDashboard(
  result: DashboardResult,
  layout: DashboardLayout,
  colors: Colors,
  options: DashboardRenderOptions = {},
): string {
  const label =
    result.view === undefined ? 'gh-track dashboard' : `gh-track dashboard — ${result.view}`;
  const range = `(from ${result.range.from} to ${result.range.to})`;
  const heading = `${label} ${range}`;
  const narrow = layout === 'narrow' || isNarrowWidth(options.width);
  const headingLines = narrow
    ? [colors.dim(label), colors.dim(range)]
    : options.width === undefined || heading.length <= options.width
      ? [colors.dim(heading)]
      : range.length + 2 <= options.width
        ? [colors.dim(label), colors.dim(range)]
        : [colors.dim(truncateText(heading, options.width))];
  const lines = [...headingLines, ''];

  if (result.rows.length === 0) {
    lines.push(colors.dim(options.emptyMessage ?? 'No observations.'));
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    layout === 'narrow'
      ? renderNarrow(result, colors, options)
      : layout === 'columns'
        ? renderColumns(result, colors, options)
        : renderCompact(result, colors, options),
  );

  if (result.rows.some((row) => compacted(row) || row.from?.finishedAt === null)) {
    lines.push('', colors.dim('~ compacted history'));
  }

  return `${lines.join('\n')}\n`;
}
