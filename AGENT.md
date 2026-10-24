# AGENT.md

Entry point for agents and contributors. Keep this file short; the reasoning lives in `docs/`.

## What this project is

`gh-track` is a local-first CLI that fetches public GitHub REST payloads for watched accounts and repositories on demand, writes immutable timestamped snapshots, compacts old runs into a small history, and derives diffs between runs. It is built for one operator tracking their own account plus arbitrary public accounts.

**Status:** v1 is complete (M1-M6), and M8 adds the per-subject `dashboard` plus the `track` selection commands (named views and a clack setup picker). M8.1 adds `dashboard add`, which composes watch and tracking and can browse an owner's public repositories. M8.2 adds TTY navigation, live search, copy, inline add, and fetch refresh while preserving static and JSON output. The CLI implements `watch`, `fetch` (conditional requests, pagination, partial runs, and `--resume`), `runs`, `diff`, `compact`, `export`, `dashboard`, `dashboard add`, `track`, and help. The offline suite covers JSON purity on a fake TTY, rate-limit stops and resume, compaction/pruning, export formats, raw/compacted diffs, and per-subject dashboard observations. M7 (interactive first-run setup) remains post-v1.

## Read first

1. [README.md](README.md) — quickstart for users.
2. [docs/00_GOAL.md](docs/00_GOAL.md) — why, success criteria, non-goals.
3. [docs/01_ARCHITECTURE.md](docs/01_ARCHITECTURE.md) — components, storage, rate limits, failure modes.
4. [docs/02_SPEC.md](docs/02_SPEC.md) — exact CLI, config, and JSON contracts.
5. [docs/03_DECISIONS.md](docs/03_DECISIONS.md) — decisions, plan history, and open backlog.
6. [docs/04_DASHBOARD.md](docs/04_DASHBOARD.md) — dashboard design and observation model.

Do not start coding from this file alone.

## Commands

Bun is the package manager and dev runner. The shipped CLI must run on Node >= 20.

```bash
bun install
bun run dev -- --help          # runs src/cli.ts directly
bun run typecheck
bun run build                  # tsc -> dist/
node dist/cli.js --help
bun run test                   # compile tests, then node --test on dist-test/
```

There is no npm workflow. Do not add one.

## Project layout

```
src/cli.ts             entry, global flags, dispatch
src/cli-args.ts        shared CLI argument errors and parsers
src/help.ts            command registry + help renderer
src/config.ts          TOML load/validate/save
src/date.ts            UTC calendar-day helpers
src/guards.ts          runtime guards and error messages
src/metrics.ts         canonical metric sets, parsing, and ordering
src/refs.ts            `--from`/`--to` reference classification
src/result.ts          shared command result helpers
src/subjects.ts        subject parsing and canonical keys
src/errors.ts          typed errors and exit codes
src/types.ts           shared types
src/version.ts         version constant, kept in sync with package.json
src/commands/          one file per top-level command (fetch planning + dry-run lives here)
src/dashboard/         per-subject observations, selection, and rendering (M8)
src/prompts/           clack wrappers (TTY-gated)
src/github/            client, ETag cache, rate limiter, resource URL builders (no filesystem imports)
src/store/             XDG paths, state caches, run reads, run writer, manifest, history, prune
src/diff/              repo and follower diffs (M5)
src/output/            table, JSON, color
test/                  node:test fixtures, no live network
```

## Invariants

- No `bun:*` imports in `src/`. Use Node built-ins and global `fetch` only.
- `--format json` writes exactly one JSON document to stdout and nothing else. No spinners, colors, banners, or prompts. Diagnostics go to stderr.
- Interactive prompts run only when stdin and stdout are TTYs, the format is `table`, and `--yes` is absent.
- A finished run directory is immutable. Fetch writes to `runs/.tmp-<id>/` and renames it into place.
- Partial runs are resumable and never silently discarded.
- Raw runs are kept 30 days by default. Only days that have been compacted may be pruned.
- No aggregates: report exact per-repo counts, never totals or rollups.
- No database. Plain files under XDG directories.
- Runtime data never lives in the repo and is never committed.
- Config is TOML at `~/.config/gh-track/config.toml`.

## Implementation rules

- Inject `fetch` and time. Paths, config, and caches are passed explicitly; no global state.
- Errors are typed domain errors; `cli.ts` maps them to exit codes once.
- Commands return structured results; only `src/output` renders them.
- Add a dependency only with an entry in `docs/03_DECISIONS.md`.
- Tests construct payloads inline through `test/helpers/seed.ts`; no committed fixtures and no live network.

## Docs rules

- Everything under `docs/` is an Obsidian vault. Use relative Markdown links (they render on GitHub too); do not use wikilinks.
- No YAML frontmatter or H1 heading. The filename carries the title and git history carries dates. Do not add tags.
- Docs are numbered. Take the next free number and never renumber an existing doc.
- Do not create plan or scratch Markdown files in the repo. Active plans belong to the harness: OpenCode uses `~/.opencode/plan`; use the equivalent directory for Claude, Hermes, or any other agent. If a harness insists on a project-local plan directory, ignore it in `.gitignore` instead of committing it.
- Completed plans and open work are recorded in `docs/03_DECISIONS.md` under **Plan history** and **Open backlog**. There is no `docs/plans/` folder.
- If behavior changes, update `docs/02_SPEC.md` and add an entry to `docs/03_DECISIONS.md`.

## Legacy

`follow-back.js` is an unrelated scratch script. Do not wire it into the CLI, and do not delete it without asking.

## Out of scope for v1

Scheduling, required authentication, private-repo and traffic data, tracking a user's starred list, and totals/rollups.
