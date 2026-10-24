import assert from 'node:assert/strict';
import test from 'node:test';

import { canPrompt } from '../../src/prompts/gate.js';

test('prompts require both TTYs, table format, and no --yes', () => {
  assert.equal(
    canPrompt({ stdinIsTTY: true, stdoutIsTTY: true, format: 'table', yes: false }),
    true,
  );
});

test('any missing condition disables prompts', () => {
  assert.equal(
    canPrompt({ stdinIsTTY: false, stdoutIsTTY: true, format: 'table', yes: false }),
    false,
  );
  assert.equal(
    canPrompt({ stdinIsTTY: true, stdoutIsTTY: false, format: 'table', yes: false }),
    false,
  );
  assert.equal(
    canPrompt({ stdinIsTTY: true, stdoutIsTTY: true, format: 'json', yes: false }),
    false,
  );
  assert.equal(
    canPrompt({ stdinIsTTY: true, stdoutIsTTY: true, format: 'table', yes: true }),
    false,
  );
});
