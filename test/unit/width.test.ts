import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNarrowWidth,
  MAX_TERMINAL_WIDTH,
  MIN_TERMINAL_WIDTH,
  resolveOutputWidth,
} from '../../src/output/width.js';

test('GH_TRACK_WIDTH overrides the detected TTY width', () => {
  const width = resolveOutputWidth({
    env: { GH_TRACK_WIDTH: '30' },
    stdoutIsTTY: true,
    columns: 72,
  });
  assert.equal(width, 30);
});

test('--width wins over both the environment and the TTY', () => {
  assert.equal(
    resolveOutputWidth({
      override: '50',
      env: { GH_TRACK_WIDTH: '30' },
      stdoutIsTTY: true,
      columns: 120,
    }),
    50,
  );
});

test('non-interactive output stays unbounded unless env or --width asks for a width', () => {
  assert.equal(resolveOutputWidth({ env: {}, stdoutIsTTY: false }), undefined);
  assert.equal(resolveOutputWidth({ env: { GH_TRACK_WIDTH: '44' }, stdoutIsTTY: false }), 44);
  assert.equal(resolveOutputWidth({ override: '60', env: {}, stdoutIsTTY: false }), 60);
});

test('--width wins even when the terminal reports another width', () => {
  assert.equal(
    resolveOutputWidth({ override: '50', env: {}, stdoutIsTTY: true, columns: 120 }),
    50,
  );
});

test('nonsense widths are clamped or rejected', () => {
  assert.equal(
    resolveOutputWidth({ override: '5000', env: {}, stdoutIsTTY: false }),
    MAX_TERMINAL_WIDTH,
  );
  assert.equal(resolveOutputWidth({ env: {}, stdoutIsTTY: true, columns: 5 }), MIN_TERMINAL_WIDTH);
  assert.throws(
    () => resolveOutputWidth({ override: 'wide', env: {}, stdoutIsTTY: false }),
    /--width must be an integer/,
  );
  assert.throws(
    () => resolveOutputWidth({ override: '10', env: {}, stdoutIsTTY: false }),
    /--width must be an integer/,
  );
});

test('a malformed GH_TRACK_WIDTH is ignored', () => {
  assert.equal(
    resolveOutputWidth({ env: { GH_TRACK_WIDTH: 'nope' }, stdoutIsTTY: false }),
    undefined,
  );
});

test('narrow detection uses the threshold', () => {
  assert.equal(isNarrowWidth(undefined), false);
  assert.equal(isNarrowWidth(40), true);
  assert.equal(isNarrowWidth(59), true);
  assert.equal(isNarrowWidth(60), false);
  assert.equal(isNarrowWidth(120), false);
});
