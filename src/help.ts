/** Single command registry and help renderer. */

export interface HelpOption {
  flags: string;
  summary: string;
}

export interface HelpArgument {
  name: string;
  summary: string;
}

export interface HelpNode {
  name: string;
  summary: string;
  usage: readonly string[];
  arguments?: readonly HelpArgument[];
  options?: readonly HelpOption[];
  examples?: readonly string[];
  children?: readonly HelpNode[];
}

export const GLOBAL_OPTIONS: readonly HelpOption[] = [
  { flags: '--config <path>', summary: 'Config file (default: XDG config path)' },
  { flags: '--data-dir <path>', summary: 'Data directory (default: XDG data path)' },
  { flags: '--format <fmt>', summary: 'table (default) or json; export also accepts jsonl/csv' },
  { flags: '--no-color', summary: 'Disable ANSI color' },
  { flags: '--yes', summary: 'Assume "yes" for confirmations; never prompt' },
  { flags: '--verbose', summary: 'Extra diagnostics on stderr' },
  { flags: '-h, --help', summary: 'Show help for the current level' },
  { flags: '-V, --version', summary: 'Print the version and exit' },
];

const FETCH: HelpNode = {
  name: 'fetch',
  summary: 'fetch and snapshot watched subjects',
  usage: ['gh-track fetch [subject...] [options]'],
  arguments: [
    { name: 'subject', summary: 'user:<login>, repo:<owner>/<name>, bare value, or GitHub URL' },
  ],
  options: [
    { flags: '--dry-run', summary: 'Print the request plan without spending quota' },
    { flags: '--max-requests <n>', summary: 'Hard cap for this run; may only lower the quota cap' },
    { flags: '--resume [<run-id>]', summary: 'Continue a partial run (default: most recent)' },
    { flags: '--no-compact', summary: 'Skip automatic compaction and pruning' },
    { flags: '--keep-raw-days <n>', summary: 'Override raw_retention_days for this run' },
    { flags: '--token <token>', summary: 'Use this token for the Authorization header' },
  ],
  examples: [
    'gh-track fetch',
    'gh-track fetch user:octocat',
    'gh-track fetch torvalds/linux --dry-run',
    'gh-track fetch https://github.com/torvalds/linux',
  ],
};

const WATCH_ADD: HelpNode = {
  name: 'add',
  summary: 'add a subject to the watchlist',
  usage: [
    'gh-track watch add user <login> [--resources <list>]',
    'gh-track watch add repo <owner/name>',
  ],
  arguments: [
    { name: 'type', summary: 'user or repo' },
    { name: 'value', summary: 'login or profile URL for user; owner/name or repository URL for repo' },
  ],
  options: [
    {
      flags: '--resources <list>',
      summary: 'Comma-separated subset of followers,repos (user only; default: both)',
    },
  ],
  examples: [
    'gh-track watch add user octocat',
    'gh-track watch add user octocat --resources followers',
    'gh-track watch add repo torvalds/linux',
  ],
};

const WATCH_LS: HelpNode = {
  name: 'ls',
  summary: 'show configured subjects and their last run',
  usage: ['gh-track watch ls [options]'],
};

const WATCH_RM: HelpNode = {
  name: 'rm',
  summary: 'remove a subject from the watchlist',
  usage: ['gh-track watch rm <subject> [--yes]'],
  arguments: [{ name: 'subject', summary: 'any accepted subject form, including a GitHub URL' }],
  examples: ['gh-track watch rm user:octocat --yes'],
};

const WATCH: HelpNode = {
  name: 'watch',
  summary: 'manage the configured watchlist',
  usage: ['gh-track watch <subcommand> [options]'],
  children: [WATCH_ADD, WATCH_LS, WATCH_RM],
};

const RUNS_LS: HelpNode = {
  name: 'ls',
  summary: 'list stored runs, newest first',
  usage: ['gh-track runs ls [--limit <n>]'],
  options: [{ flags: '--limit <n>', summary: 'Maximum number of runs (default: 20)' }],
};

const RUNS_SHOW: HelpNode = {
  name: 'show',
  summary: 'show a run manifest',
  usage: ['gh-track runs show <run-id> [options]'],
  arguments: [{ name: 'run-id', summary: 'ISO-8601 UTC run id' }],
};

const RUNS_PATHS: HelpNode = {
  name: 'paths',
  summary: 'print a run directory path',
  usage: ['gh-track runs paths <run-id> [options]'],
  arguments: [{ name: 'run-id', summary: 'ISO-8601 UTC run id' }],
};

const RUNS: HelpNode = {
  name: 'runs',
  summary: 'inspect stored runs',
  usage: ['gh-track runs <subcommand> [options]'],
  children: [RUNS_LS, RUNS_SHOW, RUNS_PATHS],
};

const DIFF: HelpNode = {
  name: 'diff',
  summary: 'compare two stored points in time',
  usage: ['gh-track diff [options]'],
  options: [
    {
      flags: '--from <ref>',
      summary: 'Start point: latest, previous, run id, YYYY-MM-DD, or -1y',
    },
    { flags: '--to <ref>', summary: 'End point: latest, run id, YYYY-MM-DD, or -1y' },
    { flags: '--subject <s>', summary: 'Repeatable; restrict to one or more subjects (or a URL)' },
  ],
  examples: [
    'gh-track diff',
    'gh-track diff --from 2026-09-01 --to latest',
    'gh-track diff --from -1y --to latest',
    'gh-track diff --subject user:octocat',
  ],
};

const COMPACT: HelpNode = {
  name: 'compact',
  summary: 'compact old runs into daily history',
  usage: ['gh-track compact [--keep-days <n>] [--dry-run]'],
  options: [
    { flags: '--keep-days <n>', summary: 'Override raw_retention_days for this invocation' },
    { flags: '--dry-run', summary: 'Report what would change without writing or deleting' },
  ],
};

const EXPORT: HelpNode = {
  name: 'export',
  summary: 'export compacted history',
  usage: ['gh-track export [--format json|jsonl|csv] [options]'],
  options: [
    { flags: '--subject <s>', summary: 'Repeatable; restrict to one or more subjects (or a URL)' },
    { flags: '--from <date|offset>', summary: 'Inclusive UTC start day (YYYY-MM-DD or -1y)' },
    { flags: '--to <date|offset>', summary: 'Inclusive UTC end day (YYYY-MM-DD or -1y)' },
  ],
  examples: [
    'gh-track export',
    'gh-track export --format json',
    'gh-track export --format csv --from 2026-09-01',
    'gh-track export --format csv --from -90d',
  ],
};

const DASHBOARD_ADD: HelpNode = {
  name: 'add',
  summary: 'add subjects to the dashboard and watch them',
  usage: [
    'gh-track dashboard add',
    'gh-track dashboard add user <login> [--resources <list>]',
    'gh-track dashboard add repo <owner/name> [--metrics <list>]',
    'gh-track dashboard add repo <owner> [--metrics <list>]',
    'gh-track dashboard add <subject> [--metrics <list>]',
  ],
  arguments: [
    { name: 'subject', summary: 'any accepted subject form (bare login, owner/name, or GitHub URL)' },
  ],
  options: [
    {
      flags: '--metrics <list>',
      summary: 'Comma-separated subset of stars,forks (repositories; default: both)',
    },
    {
      flags: '--resources <list>',
      summary: 'Comma-separated subset of followers,repos (users; default: both)',
    },
    { flags: '--token <token>', summary: "Token used when listing an owner's public repositories" },
  ],
  examples: [
    'gh-track dashboard add',
    'gh-track dashboard add user octocat',
    'gh-track dashboard add repo torvalds/linux --metrics stars',
    'gh-track dashboard add repo octocat',
  ],
};

const DASHBOARD: HelpNode = {
  name: 'dashboard',
  summary: 'show selected metrics and per-subject deltas (default command)',
  usage: ['gh-track dashboard [options]', 'gh-track [options]'],
  options: [
    { flags: '--view <name>', summary: 'Render a saved view' },
    { flags: '--from <ref>', summary: 'Baseline: previous observation, run id, day, or -1y' },
    { flags: '--to <ref>', summary: 'Current point: latest, run id, day, or -1y' },
    { flags: '--subject <s>', summary: 'Repeatable; override the selected subjects (or a URL)' },
    { flags: '--layout <fmt>', summary: 'compact (default) or columns' },
    { flags: '--no-interactive', summary: 'Print a static table even in a TTY' },
  ],
  examples: [
    'gh-track',
    'gh-track dashboard',
    'gh-track dashboard add',
    'gh-track dashboard --view my-repos',
    'gh-track dashboard --format json',
  ],
  children: [DASHBOARD_ADD],
};

const TRACK_EDIT: HelpNode = {
  name: 'edit',
  summary: 'pick dashboard subjects and metrics interactively',
  usage: ['gh-track track edit'],
};

const TRACK_SET: HelpNode = {
  name: 'set',
  summary: "set a subject's dashboard metrics",
  usage: ['gh-track track set --item <subject>=<metrics>...'],
  options: [
    { flags: '--item <s>=<m>', summary: 'Repeatable; subject and comma-separated metrics' },
  ],
  examples: [
    'gh-track track set --item repo:octocat/hello-world=stars,forks',
    'gh-track track set --item user:octocat=followers',
  ],
};

const TRACK_RM: HelpNode = {
  name: 'rm',
  summary: 'remove a subject from the dashboard selection',
  usage: ['gh-track track rm <subject>'],
  arguments: [{ name: 'subject', summary: 'any accepted subject form, including a GitHub URL' }],
};

const TRACK_LS: HelpNode = {
  name: 'ls',
  summary: 'show the default selection and saved views',
  usage: ['gh-track track ls [options]'],
};

const TRACK_VIEW_SAVE: HelpNode = {
  name: 'save',
  summary: 'save a named dashboard snapshot',
  usage: ['gh-track track view save <name> [options]'],
  arguments: [{ name: 'name', summary: 'lowercase view name' }],
  options: [
    { flags: '--item <s>=<m>', summary: 'Repeatable; omit to use the picker' },
    { flags: '--layout <fmt>', summary: 'compact or columns' },
    { flags: '--from <ref>', summary: 'Baseline: previous, run id, day, or -1y' },
    { flags: '--to <ref>', summary: 'Current reference: latest, run id, day, or -1y' },
  ],
  examples: [
    'gh-track track view save my-repos --item repo:octocat/hello-world=stars',
    'gh-track track view save my-repos',
  ],
};

const TRACK_VIEW_RM: HelpNode = {
  name: 'rm',
  summary: 'remove a saved view',
  usage: ['gh-track track view rm <name>'],
  arguments: [{ name: 'name', summary: 'saved view name' }],
};

const TRACK_VIEW: HelpNode = {
  name: 'view',
  summary: 'manage saved dashboard snapshots',
  usage: ['gh-track track view <subcommand> [options]'],
  children: [TRACK_VIEW_SAVE, TRACK_VIEW_RM],
};

const TRACK: HelpNode = {
  name: 'track',
  summary: 'manage the dashboard selection',
  usage: ['gh-track track <subcommand> [options]'],
  children: [TRACK_EDIT, TRACK_SET, TRACK_RM, TRACK_LS, TRACK_VIEW],
};

const HELP: HelpNode = {
  name: 'help',
  summary: 'show help for a command',
  usage: ['gh-track help [command...]'],
  arguments: [{ name: 'command', summary: 'Command path, e.g. watch add' }],
  examples: ['gh-track help watch add'],
};

export const ROOT: HelpNode = {
  name: 'gh-track',
  summary: 'track GitHub metadata with an offline history',
  usage: ['gh-track [command] [options]'],
  children: [FETCH, WATCH, RUNS, DIFF, COMPACT, EXPORT, DASHBOARD, TRACK, HELP],
};

export function findHelpNode(path: readonly string[]): HelpNode | null {
  let node: HelpNode = ROOT;
  for (const part of path) {
    const child = node.children?.find((candidate) => candidate.name === part);
    if (child === undefined) {
      return null;
    }
    node = child;
  }
  return node;
}

function renderColumns(
  title: string,
  entries: readonly { label: string; summary: string }[],
): string {
  if (entries.length === 0) {
    return '';
  }
  const width = entries.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  const lines = entries.map(
    (entry) => `  ${entry.label.padEnd(width)}  ${entry.summary}`.replace(/\s+$/, ''),
  );
  return `${title}:\n${lines.join('\n')}`;
}

function sections(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/** Renders help for a command path. Returns null when the path is unknown. */
export function renderHelp(path: readonly string[]): string | null {
  const node = findHelpNode(path);
  if (node === null) {
    return null;
  }

  const title =
    path.length === 0
      ? `${node.name} — ${node.summary}`
      : `${['gh-track', ...path].join(' ')} — ${node.summary}`;

  const usage = `Usage:\n${node.usage.map((line) => `  ${line}`).join('\n')}`;

  const argumentSection = renderColumns(
    'Arguments',
    (node.arguments ?? []).map((argument) => ({
      label: argument.name,
      summary: argument.summary,
    })),
  );

  const optionSection = renderColumns(
    'Options',
    (node.options ?? []).map((option) => ({
      label: option.flags,
      summary: option.summary,
    })),
  );

  const childSection = renderColumns(
    path.length === 0 ? 'Commands' : 'Subcommands',
    (node.children ?? []).map((child) => ({
      label: child.name,
      summary: child.summary,
    })),
  );

  const globalSection = renderColumns(
    'Global options',
    GLOBAL_OPTIONS.map((option) => ({
      label: option.flags,
      summary: option.summary,
    })),
  );

  const exampleSection =
    node.examples !== undefined && node.examples.length > 0
      ? `Examples:\n${node.examples.map((example) => `  ${example}`).join('\n')}`
      : '';

  return `${sections([
    title,
    usage,
    argumentSection,
    optionSection,
    childSection,
    globalSection,
    exampleSection,
  ])}\n`;
}
