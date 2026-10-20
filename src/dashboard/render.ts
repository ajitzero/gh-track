/** Dashboard table rendering for the compact and columns layouts. */

import { renderTable, richCell, type TableCell } from '../output/table.js';
import type {
  Colors,
  DashboardLayout,
  DashboardMetricValue,
  DashboardResult,
  DashboardRow,
  Metric,
} from '../types.js';

const METRIC_ORDER: readonly Metric[] = ['stars', 'forks', 'followers'];
const METRIC_LABELS: Readonly<Record<Metric, string>> = {
  stars: 'stars',
  forks: 'forks',
  followers: 'followers',
};

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
  const name = row.subject.slice(row.subject.indexOf(':') + 1);
  return row.kind === 'user' ? `@${name}` : name;
}

function nameCell(row: DashboardRow, colors: Colors): TableCell {
  const paint = row.kind === 'repo'
    ? (text: string) => colors.bold(colors.blue(text))
    : (text: string) => colors.bold(colors.magenta(text));
  return richCell([{ text: displayName(row), paint }]);
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

function metricsCell(row: DashboardRow, colors: Colors): TableCell {
  const segments: { text: string; paint?: ((text: string) => string) | undefined }[] = [];
  const metrics = METRIC_ORDER.filter((metric) => hasMetric(row, metric));

  if (metrics.every((metric) => metricValue(row, metric)?.value === null)) {
    return richCell([{ text: '—', paint: colors.dim }]);
  }

  metrics.forEach((metric, index) => {
    const value = metricValue(row, metric);
    if (value === undefined) {
      return;
    }
    if (index > 0) {
      segments.push({ text: ' · ', paint: colors.dim });
    }
    segments.push(...metricSegments(value, colors, compacted(row), METRIC_LABELS[metric]));
  });

  if (segments.length === 0) {
    return richCell([{ text: '—', paint: colors.dim }]);
  }
  return richCell(segments);
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

function section(title: string, rows: readonly DashboardRow[], metrics: readonly Metric[], colors: Colors): string {
  const heading = title === 'Repositories'
    ? colors.bold(colors.blue(title))
    : colors.bold(colors.magenta(title));
  const headers: TableCell[] = [
    'NAME',
    ...metrics.map((metric) => METRIC_LABELS[metric].toUpperCase()),
    'SINCE',
  ];
  const body: TableCell[][] = rows.map((row) => [
    nameCell(row, colors),
    ...metrics.map((metric) => columnCell(row, metric, colors)),
    sinceCell(row, colors),
  ]);
  return `${heading}\n${renderTable(headers, body)}`;
}

function unionMetrics(rows: readonly DashboardRow[]): Metric[] {
  return METRIC_ORDER.filter((metric) => rows.some((row) => hasMetric(row, metric)));
}

function renderCompact(result: DashboardResult, colors: Colors): string {
  const rows = result.rows.map((row): TableCell[] => [
    nameCell(row, colors),
    metricsCell(row, colors),
    sinceCell(row, colors),
  ]);
  return renderTable(['NAME', 'METRICS', 'SINCE'], rows);
}

function renderColumns(result: DashboardResult, colors: Colors): string {
  const repos = result.rows.filter((row) => row.kind === 'repo');
  const users = result.rows.filter((row) => row.kind === 'user');
  const sections: string[] = [];

  if (repos.length > 0) {
    sections.push(section('Repositories', repos, unionMetrics(repos), colors));
  }
  if (users.length > 0) {
    sections.push(section('Accounts', users, unionMetrics(users), colors));
  }

  return sections.join('\n\n');
}

export function renderDashboard(
  result: DashboardResult,
  layout: DashboardLayout,
  colors: Colors,
): string {
  const label = result.view === undefined ? 'gh-track dashboard' : `gh-track dashboard — ${result.view}`;
  const range = `(from ${result.range.from} to ${result.range.to})`;
  const lines = [colors.dim(`${label} ${range}`), ''];

  if (result.rows.length === 0) {
    lines.push(colors.dim('No observations.'));
    return `${lines.join('\n')}\n`;
  }

  lines.push(layout === 'columns' ? renderColumns(result, colors) : renderCompact(result, colors));

  if (result.rows.some((row) => compacted(row) || row.from?.finishedAt === null)) {
    lines.push('', colors.dim('~ compacted history'));
  }

  return `${lines.join('\n')}\n`;
}
