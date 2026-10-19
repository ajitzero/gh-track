import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from '../../src/version.js';

test('VERSION matches package.json', async () => {
  const raw = await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  assert.equal(pkg.version, VERSION);
});
