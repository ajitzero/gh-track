import assert from 'node:assert/strict';
import test from 'node:test';

import { copyToSystemClipboard, openInBrowser } from '../../src/dashboard/terminal.js';

test('Termux prefers termux-open and falls through termux-open-url', async () => {
  const attempts: string[] = [];
  const opened = await openInBrowser(
    'https://github.com/octocat',
    'linux',
    async (command) => {
      attempts.push(command.command);
      return command.command === 'termux-open-url'
        ? { ok: true, missing: false }
        : { ok: false, missing: true };
    },
    { TERMUX_VERSION: '0.118.0' },
  );

  assert.deepEqual(attempts, ['termux-open', 'termux-open-url']);
  assert.deepEqual(opened, { opened: true, opener: 'termux-open-url', missing: false });
});

test('Termux falls back to am when both helper scripts are missing', async () => {
  const attempts: string[] = [];
  const opened = await openInBrowser(
    'https://github.com/octocat',
    'linux',
    async (command) => {
      attempts.push(`${command.command} ${command.args.join(' ')}`);
      return command.command === 'am' ? { ok: true, missing: false } : { ok: false, missing: true };
    },
    { PREFIX: '/data/data/com.termux/files/usr' },
  );

  assert.deepEqual(attempts, [
    'termux-open https://github.com/octocat',
    'termux-open-url https://github.com/octocat',
    'am start -a android.intent.action.VIEW -d https://github.com/octocat',
  ]);
  assert.equal(opened.opened, true);
  assert.equal(opened.opener, 'am');
});

test('Termux uses termux-clipboard-set before the X11 helpers', async () => {
  const attempts: string[] = [];
  const copied = await copyToSystemClipboard(
    'https://github.com/octocat',
    'linux',
    undefined,
    async (command) => {
      attempts.push(command.command);
      return false;
    },
    { TERMUX_VERSION: '0.118.0' },
  );

  assert.equal(copied, false);
  assert.equal(attempts[0], 'termux-clipboard-set');
});

test('non-Termux Linux still uses xdg-open and wl-copy', async () => {
  const attempts: string[] = [];
  await openInBrowser(
    'https://github.com/octocat',
    'linux',
    async (command) => {
      attempts.push(command.command);
      return { ok: true, missing: false };
    },
    {},
  );
  assert.deepEqual(attempts, ['xdg-open']);

  const clipboard: string[] = [];
  await copyToSystemClipboard(
    'x',
    'linux',
    undefined,
    async (command) => {
      clipboard.push(command.command);
      return false;
    },
    {},
  );
  assert.deepEqual(clipboard, ['wl-copy', 'xclip', 'xsel']);
});
