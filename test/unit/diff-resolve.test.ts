import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  classifyRef,
  loadDiffPoints,
  resolveDiffRange,
} from '../../src/diff/resolve.js';
import { runCompaction } from '../../src/store/compact.js';
import { seedRun } from '../helpers/seed.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gh-track-diff-resolve-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function seedComplete(dataDir: string, id: string): Promise<void> {
  await seedRun(dataDir, id, 'complete', []);
}

test('refs classify into the four documented forms', () => {
  assert.equal(classifyRef('latest'), 'latest');
  assert.equal(classifyRef('previous'), 'previous');
  assert.equal(classifyRef('2026-08-01'), 'date');
  assert.equal(classifyRef('2026-08-01T10-00-00Z'), 'run');
  assert.throws(() => classifyRef('2026-02-30'), /Invalid diff reference/);
  assert.throws(() => classifyRef('yesterday'), /Invalid diff reference/);
});

test('points combine raw runs with compacted days and prefer surviving raw runs', async (t) => {
  const dataDir = await tempDir(t);
  await seedComplete(dataDir, '2026-08-01T10-00-00Z');
  await seedComplete(dataDir, '2026-08-02T10-00-00Z');
  await seedRun(dataDir, '2026-08-03T10-00-00Z', 'partial', []);

  await runCompaction(dataDir, { keepDays: 1, now: new Date('2026-08-04T12:00:00.000Z') });

  const compacted = await loadDiffPoints(dataDir);
  assert.deepEqual(
    compacted.map((point) => ({ id: point.id, kind: point.kind, day: point.day })),
    [
      { id: '2026-08-01', kind: 'compacted', day: '2026-08-01' },
      { id: '2026-08-02', kind: 'compacted', day: '2026-08-02' },
    ],
  );

  // A fresh complete run on an already-compacted day is preferred over history.
  await seedComplete(dataDir, '2026-08-02T18-00-00Z');
  const withRaw = await loadDiffPoints(dataDir);
  assert.deepEqual(
    withRaw.map((point) => ({ id: point.id, kind: point.kind })),
    [
      { id: '2026-08-01', kind: 'compacted' },
      { id: '2026-08-02T18-00-00Z', kind: 'raw' },
    ],
  );
});

test('resolveDiffRange applies latest/previous defaults and date/run references', async (t) => {
  const dataDir = await tempDir(t);
  const first = '2026-08-01T10-00-00Z';
  const second = '2026-08-02T10-00-00Z';
  await seedComplete(dataDir, first);
  await seedComplete(dataDir, second);

  const defaults = await resolveDiffRange(dataDir);
  assert.equal(defaults.from.id, first);
  assert.equal(defaults.to.id, second);

  const byRun = await resolveDiffRange(dataDir, { from: first, to: second });
  assert.equal(byRun.from.id, first);
  assert.equal(byRun.to.id, second);

  const byDate = await resolveDiffRange(dataDir, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(byDate.from.id, first);
  assert.equal(byDate.to.id, second);

  const dateFallsBack = await resolveDiffRange(dataDir, { from: '2026-08-01', to: '2026-08-05' });
  assert.equal(dateFallsBack.to.id, second);
});

test('date refs resolve to compacted days once raw runs are pruned', async (t) => {
  const dataDir = await tempDir(t);
  await seedComplete(dataDir, '2026-08-01T10-00-00Z');
  await seedComplete(dataDir, '2026-08-02T10-00-00Z');
  await runCompaction(dataDir, { keepDays: 1, now: new Date('2026-08-04T12:00:00.000Z') });

  const range = await resolveDiffRange(dataDir, { from: '2026-08-01', to: '2026-08-02' });
  assert.equal(range.from.kind, 'compacted');
  assert.equal(range.from.id, '2026-08-01');
  assert.equal(range.to.kind, 'compacted');
  assert.equal(range.to.id, '2026-08-02');
});

test('an explicit to point makes previous resolve relative to it', async (t) => {
  const dataDir = await tempDir(t);
  const first = '2026-08-01T10-00-00Z';
  const second = '2026-08-02T10-00-00Z';
  const third = '2026-08-03T10-00-00Z';
  await seedComplete(dataDir, first);
  await seedComplete(dataDir, second);
  await seedComplete(dataDir, third);

  const range = await resolveDiffRange(dataDir, { to: second });
  assert.equal(range.from.id, first);
  assert.equal(range.to.id, second);

  await assert.rejects(resolveDiffRange(dataDir, { to: first }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'not_enough_runs');
    return true;
  });
});

test('invalid references are usage errors before the run-count check', async (t) => {
  const dataDir = await tempDir(t);
  await assert.rejects(resolveDiffRange(dataDir, { from: 'yesterday' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'usage');
    return true;
  });
  await assert.rejects(resolveDiffRange(dataDir, { to: 'previous' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'usage');
    return true;
  });
});

test('fewer than two complete runs is not_enough_runs', async (t) => {
  const dataDir = await tempDir(t);
  await seedComplete(dataDir, '2026-08-01T10-00-00Z');

  await assert.rejects(resolveDiffRange(dataDir), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'not_enough_runs');
    return true;
  });
});

test('a start at or after the end is invalid_range', async (t) => {
  const dataDir = await tempDir(t);
  const first = '2026-08-01T10-00-00Z';
  const second = '2026-08-02T10-00-00Z';
  await seedComplete(dataDir, first);
  await seedComplete(dataDir, second);

  await assert.rejects(resolveDiffRange(dataDir, { from: second, to: first }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'invalid_range');
    return true;
  });
  await assert.rejects(resolveDiffRange(dataDir, { from: first, to: first }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'invalid_range');
    return true;
  });
});

test('partial runs are rejected and missing runs are run_not_found', async (t) => {
  const dataDir = await tempDir(t);
  await seedComplete(dataDir, '2026-08-01T10-00-00Z');
  await seedComplete(dataDir, '2026-08-02T10-00-00Z');
  await seedRun(dataDir, '2026-08-03T10-00-00Z', 'partial', []);

  await assert.rejects(
    resolveDiffRange(dataDir, { from: '2026-08-03T10-00-00Z' }),
    /diff requires complete runs/,
  );
  await assert.rejects(
    resolveDiffRange(dataDir, { from: '2026-07-01T10-00-00Z' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'run_not_found');
      return true;
    },
  );
});
