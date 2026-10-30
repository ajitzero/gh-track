import assert from 'node:assert/strict';
import test from 'node:test';

import { createColors } from '../../src/output/color.js';
import { renderTable, richCell } from '../../src/output/table.js';

const visible = (line: string): number => line.replace(/\u001b\[[0-9;]*m/g, '').length;

test('maxWidth leaves a table that already fits untouched', () => {
  const table = renderTable(['NAME', 'VALUE'], [['repo', '12']], { maxWidth: 40 });
  assert.equal(table, 'NAME  VALUE\nrepo  12');
});

test('maxWidth shrinks the widest column and ends a cut cell with an ellipsis', () => {
  const table = renderTable(['NAME', 'VALUE'], [['a-very-long-repository-name', '1234']], {
    maxWidth: 24,
  });
  const lines = table.split('\n');
  assert.ok(lines.every((line) => visible(line) <= 24));
  assert.match(lines[1] ?? '', /…/);
});

test('maxWidth narrows only the flexible columns', () => {
  const table = renderTable(['NAME', 'VALUE'], [['a-very-long-repository-name', '1234']], {
    maxWidth: 24,
    flex: [0],
  });
  const [header, first = ''] = table.split('\n');
  assert.match(header ?? '', /VALUE$/);
  assert.match(first, /… {2}1234$/);
});

test('styled cells keep their color when truncated', () => {
  const colors = createColors(true);
  const table = renderTable(
    ['NAME', 'VALUE'],
    [
      [
        richCell([
          { text: 'octocat/hello-world', paint: (text) => colors.bold(colors.blue(text)) },
        ]),
        '12',
      ],
    ],
    { maxWidth: 20 },
  );
  const first = table.split('\n')[1] ?? '';
  assert.match(first, /\u001b\[1m\u001b\[94m/);
  assert.match(first, /…/);
  assert.ok(visible(first) <= 20);
});

test('a table narrower than the sum of its headers still fits', () => {
  const table = renderTable(
    ['SUBJECT', 'RESOURCE', 'PAGE', 'CONDITIONAL'],
    [['repo:octocat/hello-world', 'followers', '1', 'yes']],
    { maxWidth: 20 },
  );
  assert.ok(table.split('\n').every((line) => visible(line) <= 20));
});
