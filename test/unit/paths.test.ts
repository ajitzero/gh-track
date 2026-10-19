import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  formatRunId,
  historyReposDir,
  historyUsersDir,
  isValidRunId,
  locksDir,
  resolvePaths,
  runDir,
  runsDir,
  stateDir,
  tempRunDir,
} from '../../src/store/paths.js';

test('resolves default Linux paths', () => {
  const paths = resolvePaths({ env: {}, platform: 'linux', home: '/home/az' });
  assert.equal(paths.configPath, path.join('/home/az', '.config', 'gh-track', 'config.toml'));
  assert.equal(paths.dataDir, path.join('/home/az', '.local', 'share', 'gh-track'));
});

test('honors absolute XDG variables', () => {
  const paths = resolvePaths({
    env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' },
    platform: 'linux',
    home: '/home/az',
  });
  assert.equal(paths.configPath, path.join('/cfg', 'gh-track', 'config.toml'));
  assert.equal(paths.dataDir, path.join('/data', 'gh-track'));
});

test('ignores relative XDG variables', () => {
  const paths = resolvePaths({
    env: { XDG_CONFIG_HOME: 'relative/cfg', XDG_DATA_HOME: 'relative/data' },
    platform: 'linux',
    home: '/home/az',
  });
  assert.equal(paths.configPath, path.join('/home/az', '.config', 'gh-track', 'config.toml'));
  assert.equal(paths.dataDir, path.join('/home/az', '.local', 'share', 'gh-track'));
});

test('overrides resolve against cwd and expand home', () => {
  const paths = resolvePaths({
    env: {},
    platform: 'linux',
    home: '/home/az',
    cwd: '/work',
    config: 'cfg/config.toml',
    dataDir: '~/data',
  });
  assert.equal(paths.configPath, path.join('/work', 'cfg', 'config.toml'));
  assert.equal(paths.dataDir, path.join('/home/az', 'data'));
});

test('resolves Windows paths on win32', () => {
  const paths = resolvePaths({
    env: { APPDATA: 'C:\\Users\\az\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\az\\AppData\\Local' },
    platform: 'win32',
    home: 'C:\\Users\\az',
  });
  assert.equal(
    paths.configPath,
    path.win32.join('C:\\Users\\az\\AppData\\Roaming', 'gh-track', 'config.toml'),
  );
  assert.equal(paths.dataDir, path.win32.join('C:\\Users\\az\\AppData\\Local', 'gh-track'));
});

test('falls back to Windows defaults without env variables', () => {
  const paths = resolvePaths({ env: {}, platform: 'win32', home: 'C:\\Users\\az' });
  assert.equal(
    paths.configPath,
    path.win32.join('C:\\Users\\az', 'AppData', 'Roaming', 'gh-track', 'config.toml'),
  );
  assert.equal(paths.dataDir, path.win32.join('C:\\Users\\az', 'AppData', 'Local', 'gh-track'));
});

test('derives data subpaths', () => {
  const dataDir = '/data/gh-track';
  assert.equal(runsDir(dataDir), path.join(dataDir, 'runs'));
  assert.equal(stateDir(dataDir), path.join(dataDir, 'state'));
  assert.equal(locksDir(dataDir), path.join(dataDir, 'locks'));
  assert.equal(historyReposDir(dataDir), path.join(dataDir, 'history', 'repos'));
  assert.equal(historyUsersDir(dataDir), path.join(dataDir, 'history', 'users'));
  assert.equal(runDir(dataDir, '2026-10-19T21-30-05Z'), path.join(dataDir, 'runs', '2026-10-19T21-30-05Z'));
  assert.equal(
    tempRunDir(dataDir, '2026-10-19T21-30-05Z'),
    path.join(dataDir, 'runs', '.tmp-2026-10-19T21-30-05Z'),
  );
});

test('formats and validates run ids', () => {
  assert.equal(formatRunId(new Date('2026-10-19T21:30:05.123Z')), '2026-10-19T21-30-05Z');
  assert.equal(isValidRunId('2026-10-19T21-30-05Z'), true);
  assert.equal(isValidRunId('2026-10-19'), false);
  assert.equal(isValidRunId('.tmp-2026-10-19T21-30-05Z'), false);
  assert.throws(() => runDir('/data', 'nope'));
});
