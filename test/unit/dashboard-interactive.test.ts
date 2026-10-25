import assert from 'node:assert/strict';
import test from 'node:test';

import { githubUrlForRow, runInteractiveDashboard } from '../../src/dashboard/interactive.js';
import { copyToSystemClipboard } from '../../src/dashboard/terminal.js';
import { createColors } from '../../src/output/color.js';
import type {
  DashboardKeypress,
  DashboardResult,
  DashboardRow,
  DashboardTerminal,
} from '../../src/types.js';

const rows: DashboardRow[] = [
  {
    kind: 'user',
    subject: 'user:octocat',
    source: null,
    from: null,
    to: null,
    metrics: { followers: { value: null, from: null, delta: null } },
  },
  {
    kind: 'repo',
    subject: 'repo:other/tool',
    source: null,
    from: null,
    to: null,
    metrics: { stars: { value: null, from: null, delta: null } },
  },
];

const result: DashboardResult = {
  layout: 'columns',
  range: { from: 'previous', to: 'latest' },
  rows,
};

class FakeTerminal implements DashboardTerminal {
  readonly rows = 10;
  readonly output: string[] = [];
  readonly copied: string[] = [];
  entered = 0;
  left = 0;
  private keyListener: ((key: DashboardKeypress) => void) | undefined;

  constructor(private readonly keys: DashboardKeypress[]) {}

  enter(): void {
    this.entered += 1;
  }
  leave(): void {
    this.left += 1;
  }
  write(text: string): void {
    this.output.push(text);
  }
  onKeypress(listener: (key: DashboardKeypress) => void): () => void {
    this.keyListener = listener;
    for (const key of this.keys) {
      listener(key);
    }
    return () => {
      this.keyListener = undefined;
    };
  }
  onResize(): () => void {
    return () => undefined;
  }
  async copy(text: string): Promise<boolean> {
    this.copied.push(text);
    return true;
  }
}

function key(name: string, sequence = name): DashboardKeypress {
  return { name, sequence, ctrl: false };
}

test('arrows and Vim keys navigate, and c copies the selected GitHub URL', async () => {
  const terminal = new FakeTerminal([
    key('down'),
    key('up'),
    key('j'),
    key('k'),
    key('G'),
    key('c'),
    key('q'),
  ]);
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
  });

  assert.deepEqual(terminal.copied, ['https://github.com/other/tool']);
  assert.ok(terminal.output.some((text) => text.includes('› other/tool')));
  assert.equal(terminal.entered, 1);
  assert.equal(terminal.left, 1);
});

test('/ filters as keys are typed and Enter keeps the visible filter', async () => {
  const terminal = new FakeTerminal([key('/', '/'), key('o'), key('c'), key('return'), key('q')]);
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
  });

  const searchFrames = terminal.output.filter((text) => text.includes('/ oc'));
  assert.ok(searchFrames.length > 0);
  assert.ok(searchFrames.every((text) => text.includes('octocat')));
  assert.ok(searchFrames.every((text) => !text.includes('other/tool')));
});

test('j and k remain ordinary searchable characters while entering a query', async () => {
  const terminal = new FakeTerminal([key('/', '/'), key('j'), key('k'), key('escape'), key('q')]);
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
  });

  assert.ok(terminal.output.some((text) => text.includes('/ jk')));
});

test('r refreshes in place and keeps the same highlighted subject', async () => {
  const terminal = new FakeTerminal([key('down'), key('r'), key('q')]);
  let refreshes = 0;
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => {
      refreshes += 1;
      return { result, text: 'Run complete.\n', warnings: ['warning'] };
    },
  });

  assert.equal(refreshes, 1);
  assert.ok(terminal.output.some((text) => text.includes('Run complete.')));
  assert.ok(terminal.output.at(-1)?.includes('› other/tool'));
});

test('Ctrl-C during refresh cancels it, restores the terminal, and returns 130', async () => {
  let listener: ((key: DashboardKeypress) => void) | undefined;
  let left = 0;
  let cancelled = 0;
  let finishRefresh: (() => void) | undefined;
  const terminal: DashboardTerminal = {
    rows: 10,
    enter: () => undefined,
    leave: () => {
      left += 1;
    },
    write: () => undefined,
    onKeypress: (callback) => {
      listener = callback;
      callback(key('r'));
      setTimeout(() => listener?.({ name: 'c', sequence: '\u0003', ctrl: true }), 0);
      return () => undefined;
    },
    onResize: () => () => undefined,
    copy: async () => true,
  };

  const running = runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    cancelAction: () => {
      cancelled += 1;
      finishRefresh?.();
    },
    refresh: () =>
      new Promise((resolve) => {
        finishRefresh = () => resolve({ result, text: '', warnings: [] });
      }),
  });
  const completed = await running;

  assert.equal(cancelled, 1);
  assert.equal(left, 1);
  assert.equal(completed.exitCode, 130);
});

function chars(value: string): DashboardKeypress[] {
  return [...value].map((character) => key(character, character));
}

const NEW_ROW: DashboardRow = {
  kind: 'user',
  subject: 'user:new-user',
  source: null,
  from: null,
  to: null,
  metrics: { followers: { value: 3, from: null, delta: null } },
};

test('a collects a subject, adds it, and highlights the new row', async () => {
  const terminal = new FakeTerminal([key('a'), ...chars('new-user'), key('return'), key('q')]);
  let asked = '';
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    addSubject: async (value, onAdded) => {
      asked = value;
      onAdded?.({ ...result, rows: [...rows, NEW_ROW] }, 'user:new-user');
      return {
        result: { ...result, rows: [...rows, NEW_ROW] },
        text: 'Added user:new-user. Run complete.',
        warnings: [],
        addedSubject: 'user:new-user',
      };
    },
  });

  assert.equal(asked, 'new-user');
  assert.ok(terminal.output.some((text) => text.includes('add: new-user')));
  assert.ok(
    terminal.output.some(
      (text) => text.includes('Added user:new-user. Fetching') && text.includes('› new-user'),
    ),
  );
  assert.ok(terminal.output.some((text) => text.includes('Added user:new-user. Run complete.')));
  assert.ok(terminal.output.at(-1)?.includes('› new-user'));
});

test('escape cancels add input without adding a subject', async () => {
  const terminal = new FakeTerminal([key('a'), ...chars('new-user'), key('escape'), key('q')]);
  let called = false;
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    addSubject: async () => {
      called = true;
      return { result, text: '', warnings: [] };
    },
  });

  assert.equal(called, false);
  assert.ok(terminal.output.some((text) => text.includes('add: new-user')));
});

test('an invalid subject keeps the add prompt open and shows the error', async () => {
  const terminal = new FakeTerminal([
    key('a'),
    ...chars('bad'),
    key('return'),
    key('escape'),
    key('q'),
  ]);
  let attempts = 0;
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    addSubject: async () => {
      attempts += 1;
      throw new Error('Invalid subject value: "bad"');
    },
  });

  assert.equal(attempts, 1);
  const addFrames = terminal.output.filter((text) => text.includes('add: bad'));
  assert.ok(addFrames.some((text) => text.includes('Invalid subject value')));
  assert.ok(addFrames.some((text) => text.includes('esc cancel')));
});

test('a is a search character while the filter box is open', async () => {
  const terminal = new FakeTerminal([key('/', '/'), key('a'), key('return'), key('q')]);
  let called = false;
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    addSubject: async () => {
      called = true;
      return { result, text: '', warnings: [] };
    },
  });

  assert.equal(called, false);
  const searchFrames = terminal.output.filter((text) => text.includes('/ a'));
  assert.ok(searchFrames.length > 0);
  assert.ok(searchFrames.every((text) => !text.includes('other/tool')));
});

test('d removes the highlighted row through the callback', async () => {
  const terminal = new FakeTerminal([key('down'), key('d'), key('q')]);
  const removed: string[] = [];
  const completed = await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    deleteSubject: async (subject) => {
      removed.push(subject);
      return { text: `Removed ${subject}.`, warnings: ['cache cleared'] };
    },
  });

  assert.deepEqual(removed, ['repo:other/tool']);
  assert.deepEqual(completed.warnings, ['cache cleared']);
  const finalFrame = (terminal.output.at(-1) ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(finalFrame.includes('Removed repo:other/tool.'));
  assert.ok(finalFrame.includes('octocat'));
  assert.ok(!finalFrame.includes('› other/tool'));
});

test('deleting an account leaves its tracked repositories un-nested', async () => {
  const nestedRows: DashboardRow[] = [
    {
      kind: 'user',
      subject: 'user:octocat',
      source: null,
      from: null,
      to: null,
      metrics: { followers: { value: 2, from: null, delta: null } },
    },
    {
      kind: 'repo',
      subject: 'repo:octocat/demo',
      source: null,
      from: null,
      to: null,
      metrics: { stars: { value: 5, from: null, delta: null } },
    },
  ];
  const nestedResult: DashboardResult = {
    layout: 'compact',
    range: { from: 'previous', to: 'latest' },
    rows: nestedRows,
  };
  const terminal = new FakeTerminal([key('d'), key('q')]);
  await runInteractiveDashboard({
    result: nestedResult,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result: nestedResult, text: '', warnings: [] }),
    deleteSubject: async (subject) => ({ text: `Removed ${subject}.`, warnings: [] }),
  });

  const finalFrame = (terminal.output.at(-1) ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(finalFrame.includes('› octocat/demo'));
  assert.ok(!finalFrame.includes('  demo'));
});

test('a failed delete keeps the row and shows the error', async () => {
  const terminal = new FakeTerminal([key('d'), key('q')]);
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(false),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
    deleteSubject: async () => {
      throw new Error('cannot write config');
    },
  });

  const finalFrame = (terminal.output.at(-1) ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(finalFrame.includes('cannot write config'));
  assert.ok(finalFrame.includes('› octocat'));
});

test('footer renders shortcut keys white and labels dim', async () => {
  const terminal = new FakeTerminal([key('q')]);
  await runInteractiveDashboard({
    result,
    layout: 'compact',
    colors: createColors(true),
    terminal,
    refresh: async () => ({ result, text: '', warnings: [] }),
  });

  const frame = terminal.output[0] ?? '';
  assert.match(frame, /\u001b\[97mr\u001b\[0m\u001b\[2m refresh\u001b\[0m/);
  assert.match(frame, /\u001b\[97ma\u001b\[0m\u001b\[2m add\u001b\[0m/);
  assert.match(frame, /\u001b\[97md\u001b\[0m\u001b\[2m delete\u001b\[0m/);
  assert.match(frame, /\u001b\[97mq\u001b\[0m\u001b\[2m quit\u001b\[0m/);
  const plain = frame.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(plain, /\/ search · a add · c copy · d delete · ↑↓\/j k move · q quit · r refresh/);
});

test('GitHub URLs distinguish account and repository rows', () => {
  assert.equal(githubUrlForRow(rows[0]!), 'https://github.com/octocat');
  assert.equal(githubUrlForRow(rows[1]!), 'https://github.com/other/tool');
});

test('clipboard falls back to an OSC 52 terminal sequence', async () => {
  const output: string[] = [];
  const copied = await copyToSystemClipboard(
    'https://github.com/octocat',
    'linux',
    (sequence) => output.push(sequence),
    async () => false,
  );

  assert.equal(copied, true);
  assert.deepEqual(output, ['\u001b]52;c;aHR0cHM6Ly9naXRodWIuY29tL29jdG9jYXQ=\u0007']);
});
