import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDashboard } from '../../src/dashboard/render.js';
import { createColors } from '../../src/output/color.js';
import { renderTable, richCell } from '../../src/output/table.js';
import type { DashboardResult } from '../../src/types.js';

const RESULT: DashboardResult = {
  layout: 'compact',
  range: { from: 'previous', to: 'latest' },
  rows: [
    {
      kind: 'repo',
      subject: 'repo:octocat/hello-world',
      source: 'raw',
      from: { id: '2026-10-01T10-00-00Z', finishedAt: '2026-10-01T10:00:00.000Z' },
      to: { id: '2026-10-05T10-00-00Z', finishedAt: '2026-10-05T10:00:00.000Z' },
      metrics: {
        stars: { value: 1204, from: 1180, delta: 24 },
        forks: { value: 4, from: 5, delta: -1 },
      },
    },
    {
      kind: 'user',
      subject: 'user:octocat',
      source: 'compacted',
      from: null,
      to: { id: '2026-09-01', finishedAt: null },
      metrics: {
        followers: { value: 1204, from: 1204, delta: 0 },
      },
    },
    {
      kind: 'repo',
      subject: 'repo:never/fetched',
      source: null,
      from: null,
      to: null,
      metrics: {
        stars: { value: null, from: null, delta: null },
      },
    },
  ],
};

test('compact rendering uses blue repos, purple accounts, and delta colors', () => {
  const colors = createColors(true);
  const text = renderDashboard(RESULT, 'compact', colors);
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');

  assert.match(text, /\u001b\[1m\u001b\[94m  hello-world/);
  assert.match(text, /\u001b\[1m\u001b\[95moctocat/);
  assert.match(text, /\u001b\[1m1,204/);
  assert.match(text, /\u001b\[32m\(\+24\)/);
  assert.match(text, /\u001b\[31m\(−1\)/);
  assert.match(text, /\u001b\[2m\(0\)/);
  assert.match(text, /1,204\u001b\[0m\u001b\[2m~/);
  assert.match(text, /\u001b\[2m~ compacted history/);
  assert.match(plain, /never\/fetched\s+—/);
  assert.doesNotMatch(plain, /@octocat/);
  assert.doesNotMatch(plain, /octocat\/hello-world/);
  assert.match(plain, /octocat\s+followers\s+1,204~\s+\(0\)/);
  assert.match(plain, /\n  hello-world\s+stars\s+1,204 {2}\(\+24\)/);
  assert.match(plain, /\n\s+forks\s+4\s+\(−1\)/);
  assert.ok(plain.indexOf('\noctocat') < plain.indexOf('hello-world'));
});

test('columns rendering groups repositories and accounts', () => {
  const result: DashboardResult = { ...RESULT, layout: 'columns' };
  const text = renderDashboard(result, 'columns', createColors(true));
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');

  assert.match(plain, /Repositories\n/);
  assert.match(plain, /Accounts\n/);
  assert.match(plain, /octocat\/hello-world/);
  assert.doesNotMatch(plain, /\n  hello-world/);
  assert.match(plain, /STARS/);
  assert.match(plain, /FORKS/);
  assert.match(plain, /FOLLOWERS/);
});

test('no-color rendering has no ANSI and keeps the compacted marker', () => {
  const text = renderDashboard(RESULT, 'compact', createColors(false));
  assert.equal(/\u001b\[[0-9;]*m/.test(text), false);
  assert.match(text, /1,204~/);
  assert.match(text, /~ compacted history/);
});

test('compact widths expand instead of truncating large values', () => {
  const result: DashboardResult = {
    layout: 'compact',
    range: { from: 'previous', to: 'latest' },
    rows: [
      {
        kind: 'repo',
        subject: 'repo:big/numbers',
        source: 'raw',
        from: { id: '2026-10-01T10-00-00Z', finishedAt: '2026-10-01T10:00:00.000Z' },
        to: { id: '2026-10-02T10-00-00Z', finishedAt: '2026-10-02T10:00:00.000Z' },
        metrics: {
          stars: { value: 1234567, from: 1, delta: 1234566 },
        },
      },
    ],
  };
  const plain = renderDashboard(result, 'compact', createColors(false));
  assert.match(plain, /stars\s+1,234,567\s+\(\+1,234,566\)/);
});

test('right alignment keeps styled leading padding and headers can differ', () => {
  const colors = createColors(true);
  const table = renderTable(
    ['NAME', 'VALUE'],
    [
      ['a', richCell([{ text: '12', paint: colors.bold }])],
      ['b', richCell([{ text: '1,204', paint: colors.bold }])],
    ],
    { align: ['left', 'right'], headerAlign: ['left', 'left'] },
  );
  const [header, first = ''] = table.split('\n');
  assert.equal(header, 'NAME  VALUE');
  assert.match(first, /\s{3}\u001b\[1m12\u001b\[0m$/);
  assert.equal(first.replace(/\u001b\[[0-9;]*m/g, ''), 'a        12');
  assert.equal(first, first.trimEnd());
});

test('styled cells are measured by their plain text', () => {
  const colors = createColors(true);
  const table = renderTable(
    ['NAME', 'VALUE'],
    [
      [
        richCell([
          { text: 'repo', paint: (value) => colors.bold(colors.blue(value)) },
        ]),
        richCell([
          { text: '12', paint: colors.bold },
          { text: ' (+1)', paint: colors.green },
        ]),
      ],
      ['much-longer-name', '7'],
    ],
  );
  const lines = table.split('\n');
  const header = lines[0] ?? '';
  const first = lines[1] ?? '';
  const plainFirst = first.replace(/\u001b\[[0-9;]*m/g, '');
  assert.equal(plainFirst.indexOf('12'), header.indexOf('VALUE'));
  assert.equal(plainFirst.indexOf('12'), 'much-longer-name'.length + 2);
});
