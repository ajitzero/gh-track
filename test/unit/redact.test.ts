import assert from 'node:assert/strict';
import test from 'node:test';

import { invocationSecrets, redactSecrets } from '../../src/redact.js';

test('redactSecrets replaces every occurrence of each secret', () => {
  const text = 'token secret-token rejected: secret-token';
  assert.equal(redactSecrets(text, ['secret-token']), 'token [redacted] rejected: [redacted]');
  assert.equal(redactSecrets('nothing to hide', ['']), 'nothing to hide');
});

test('invocationSecrets finds --token in both forms and GH_TOKEN', () => {
  assert.deepEqual(invocationSecrets(['fetch', '--token', 'one'], {}), ['one']);
  assert.deepEqual(
    invocationSecrets(['fetch', '--token=two', '--token', 'two'], { GH_TOKEN: 'env-token' }),
    ['env-token', 'two'],
  );
});

test('invocationSecrets stops at -- and skips empty values', () => {
  assert.deepEqual(invocationSecrets(['fetch', '--', '--token', 'ignored'], {}), []);
  assert.deepEqual(invocationSecrets(['fetch', '--token=', '--token', ''], {}), []);
});
