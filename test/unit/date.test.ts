import assert from 'node:assert/strict';
import test from 'node:test';

import { isRelativeDay, isValidRelativeDay, relativeDay } from '../../src/date.js';

const NOW = new Date('2026-10-24T10:30:00.000Z');

test('relative offsets resolve against a fixed instant', () => {
  assert.equal(relativeDay('1d', NOW), '2026-10-23');
  assert.equal(relativeDay('2w', NOW), '2026-10-10');
  assert.equal(relativeDay('6m', NOW), '2026-04-24');
  assert.equal(relativeDay('1y', NOW), '2025-10-24');
});

test('month and year offsets use calendar arithmetic with day clamping', () => {
  assert.equal(relativeDay('1m', new Date('2026-03-31T00:00:00.000Z')), '2026-02-28');
  assert.equal(relativeDay('1m', new Date('2024-03-31T00:00:00.000Z')), '2024-02-29');
  assert.equal(relativeDay('1y', new Date('2024-02-29T00:00:00.000Z')), '2023-02-28');
  assert.equal(relativeDay('12m', new Date('2026-10-24T00:00:00.000Z')), '2025-10-24');
  assert.equal(relativeDay('2m', new Date('2026-01-15T00:00:00.000Z')), '2025-11-15');
  assert.equal(relativeDay('2000y', NOW), '0026-10-24');
  assert.equal(relativeDay('3000y', NOW), null);
});

test('relative offsets reject malformed, non-positive, and out-of-range values', () => {
  for (const ref of [
    '0d',
    'd',
    '-1y',
    'yesterday',
    '1x',
    '1.5y',
    '1Y',
    '1d2h',
    '--1y',
    '999999999y',
  ]) {
    assert.equal(isValidRelativeDay(ref), false, ref);
  }
  assert.equal(isRelativeDay('1y'), true);
  assert.equal(isRelativeDay('-1y'), false);
  assert.equal(isRelativeDay('1x'), false);
  assert.equal(isRelativeDay('2026-10-24'), false);
});
